import '@strudel/repl/repl-component.mjs';
import { getAudioContext, soundMap } from '@strudel/webaudio';
import { Pattern, silence, strudelScope } from '@strudel/core';
import { addWidget, setSliderWidgets, sliderValues } from '@strudel/codemirror';
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { captureRange } from './capture';
import { commitSpec } from './commit';
import { FormatError, formatCode, mapOffset } from './format';
import { LARGE_CHANGE_CHARS, diffSegments, type DiffGranularity } from './diff';
import { diagnoseFix, noRequestReason, trayFix, type TrayFix } from './fixTarget';
import { InstructionBox } from './instructionBox';
import { InstructionHistory } from './instructionHistory';
import { FAULT_KINDS, MockProvider, type FaultKind } from './mockProvider';
import { STARTER_CODE } from './options';
import { reasonLabel, runRequest } from './pipeline';
import type { Mode, OptionRequest, Provider } from './provider';
import { RemoteProvider, modelForMode, type RemoteSettings } from './remoteProvider';
import { COMMON_DRUMS, summariseLoaded, summariseSounds } from './soundSummary';
import { Quantizer } from './quantize';
import { isRangeIntact, mapRange, splice, type Capture, type Edit, type Range } from './splice';
import { initialState, slotCount, transition, type Effect, type Slot, type SlotCard, type Tray, type TrayEvent, type TrayState } from './trayMachine';
import { Validator, WorkerBackend, type WorkerLike } from './validator';
import { editorSliderField, holdEffects, sliderIdMap } from './widgets';

// --- Strudel wiring -------------------------------------------------------------------------

const host = document.createElement('strudel-editor') as HTMLElement & { editor: any; settings: any };
host.setAttribute('code', STARTER_CODE);
document.getElementById('editor-wrap')!.append(host);

// connectedCallback creates the StrudelMirror synchronously.
const mirror = host.editor; // StrudelMirror (@strudel/codemirror/codemirror.mjs)
const view: EditorView = mirror.editor; // CodeMirror EditorView
const scheduler = mirror.repl.scheduler; // Cyclist (@strudel/core/cyclist.mjs)
mirror.setLineWrappingEnabled(true); // long chains wrap instead of scrolling sideways
const quantizer = new Quantizer(scheduler);

const statusEl = document.getElementById('status')!;
const trayEl = document.getElementById('tray')!;
const actionsEl = document.getElementById('actions')!;

document.getElementById('play')!.addEventListener('click', () => mirror.evaluate());
document.getElementById('stop')!.addEventListener('click', () => mirror.stop());

// --- Providers --------------------------------------------------------------------------------

/** The mock stays available offline (its minimal fix only balances brackets and quotes). */
const mockProvider = new MockProvider({ seed: Date.now() >>> 0, ...devMockOptions() });

export interface Choice {
  id: string;
  label: string;
  disabled?: boolean;
}

/** What the header select and Alt+P cycle through. `?provider=mock|claude|gemini&model=…` picks the first one. */
const CHOICES: Choice[] = [
  { id: 'mock', label: 'mock' },
  { id: 'claude:claude-haiku-5-5', label: 'claude · haiku 5.5' },
  { id: 'claude:claude-sonnet-5-5', label: 'claude · sonnet 5.5' },
  { id: 'gemini:gemini-3.5-flash-lite', label: 'gemini · 3.5 flash-lite' },
  { id: 'gemini:gemini-3.8-flash', label: 'gemini · 3.8 flash' },
  { id: 'gemini:gemini-4-argon', label: 'gemini · 4 argon' },
];

const query = new URLSearchParams(location.search);
if (query.get('key')) {
  localStorage.setItem('shaper_access_key', query.get('key')!.trim());
}
/** `?effort=low|medium|high&thinking=off|adaptive&strategy=single|parallel`: leave unset for the server's defaults. */
const remoteSettings = (): RemoteSettings => ({
  ...(query.get('effort') ? { effort: query.get('effort') as RemoteSettings['effort'] } : {}),
  ...(query.get('thinking') ? { thinking: query.get('thinking') as RemoteSettings['thinking'] } : {}),
  ...(query.get('strategy') ? { strategy: query.get('strategy') as RemoteSettings['strategy'] } : {}),
});
/** The loaded sounds, summarised once prebake has filled the soundMap. */
let baseSoundSummary: string | undefined;
/** The sound names present after prebake; anything added later came from the user's samples() calls. */
let baselineSounds = new Set<string>();
/** The prebaked summary plus whatever the buffer's samples() calls have loaded so far (it changes after an evaluation). */
const soundSummary = (): string | undefined => {
  if (baseSoundSummary === undefined) return undefined;
  const loaded = soundMap.get();
  const entries = Object.keys(loaded)
    .filter((name) => !baselineSounds.has(name))
    .sort()
    .map((name) => {
      const bank = loaded[name]?.data?.samples;
      return { name, count: Array.isArray(bank) ? bank.length : undefined };
    });
  const extra = summariseLoaded(entries);
  return extra ? `${baseSoundSummary}\n${extra}` : baseSoundSummary;
};

function makeProvider(id: string): Provider {
  if (id === 'mock') return mockProvider;
  const [name, model] = id.split(':');
  // Shape uses the selected model; ⌘J / ⌘⇧J use ?fixModel= / ?rewriteModel=, else the proxy's per-mode default.
  return new RemoteProvider({
    provider: name,
    model,
    modelFor: modelForMode(query, model),
    sounds: soundSummary,
    settings: remoteSettings,
    accessKey: () => localStorage.getItem('shaper_access_key')?.trim() || undefined,
  });
}

function initialChoice(): string {
  const p = query.get('provider');
  if (p === 'claude') return `claude:${query.get('model') ?? 'claude-haiku-5-5'}`;
  if (p === 'gemini') return `gemini:${query.get('model') ?? 'gemini-3.8-flash'}`;
  return 'mock';
}

let providerId = initialChoice();
if (!CHOICES.some((c) => c.id === providerId)) {
  console.warn(`[shaper] unknown provider/model "${providerId}"`);
  CHOICES.push({ id: providerId, label: providerId.replace(':', ' · ') });
}
let provider: Provider = makeProvider(providerId);

const providerSelect = document.getElementById('provider') as HTMLSelectElement;

function renderChoices() {
  providerSelect.innerHTML = CHOICES.map((c) => {
    const disabledAttr = c.disabled ? ' disabled' : '';
    const label = c.disabled ? `${c.label} (disabled)` : c.label;
    return `<option value="${c.id}"${disabledAttr}>${label}</option>`;
  }).join('');
  providerSelect.value = providerId;
}

renderChoices();

const accessKeyBtn = document.getElementById('access-key-btn') as HTMLButtonElement | null;
let serverRequiresKey = false;

function updateKeyButton() {
  if (!accessKeyBtn) return;
  const key = localStorage.getItem('shaper_access_key');
  if (key) {
    accessKeyBtn.textContent = '🔒 Key Set';
    accessKeyBtn.title = 'Site Access Key configured (click to change or remove)';
  } else if (serverRequiresKey) {
    accessKeyBtn.textContent = '🔑 Key Required';
    accessKeyBtn.title = 'Site Access Key is required by the server (click to enter)';
  } else {
    accessKeyBtn.textContent = '🔑 Key';
    accessKeyBtn.title = 'Configure Site Access Key';
  }
}
updateKeyButton();

accessKeyBtn?.addEventListener('click', () => {
  const current = localStorage.getItem('shaper_access_key') ?? '';
  const entered = window.prompt('Enter site access key / password to enable AI models:', current);
  if (entered !== null) {
    if (entered.trim()) {
      localStorage.setItem('shaper_access_key', entered.trim());
    } else {
      localStorage.removeItem('shaper_access_key');
    }
    updateKeyButton();
    warmedUp = false;
    if (gestured) void warmUp();
  }
});

// Check which models are enabled by the deployed backend environment variables
fetch('/api/models')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (!data) return;
    if (data.requiresAccessKey) {
      serverRequiresKey = true;
      updateKeyButton();
    }
    if (!data.providers) return;
    for (const choice of CHOICES) {
      if (choice.id === 'mock') continue;
      const [prov] = choice.id.split(':');
      choice.disabled = !data.providers[prov];
    }
    renderChoices();
  })
  .catch(() => {});

providerSelect.addEventListener('change', () => {
  switchProvider(providerSelect.value);
  view.focus();
});

/** Applies to the next request (R regenerates with it). No automatic fallback: switching is the user's call. */
function switchProvider(id: string) {
  providerId = id;
  provider = makeProvider(id);
  providerSelect.value = id;
  const url = new URL(location.href);
  if (id === 'mock') {
    url.searchParams.delete('provider');
    url.searchParams.delete('model');
  } else {
    const [name, model] = id.split(':');
    url.searchParams.set('provider', name);
    url.searchParams.set('model', model);
  }
  window.history.replaceState(null, '', url);
  warmedUp = false;
  if (gestured) void warmUp();
  render();
}

function cycleProvider() {
  const available = CHOICES.filter((c) => !c.disabled);
  if (available.length <= 1) return;
  const currentIdx = available.findIndex((c) => c.id === providerId);
  const nextChoice = available[(currentIdx + 1) % available.length];
  switchProvider(nextChoice.id);
}

// Warm-up (`?warmup=0` turns it off): after the first user gesture, one cheap request with the real
// system prompt and schema, so the grammar compile and the prompt-cache write don't land on the
// first real request. See NOTES.md (milestone 4) for whether it matters.
const warmupEnabled = query.get('warmup') !== '0';
let warmedUp = false;
let gestured = false;
async function warmUp() {
  if (!warmupEnabled || warmedUp || !(provider instanceof RemoteProvider)) return;
  warmedUp = true;
  const model = provider.model;
  await Promise.resolve(mirror.prebaked).catch(() => {});
  const accessKey = localStorage.getItem('shaper_access_key')?.trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (accessKey) headers['x-access-key'] = accessKey;
  const res = await fetch('/api/warmup', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, sounds: soundSummary()?.slice(0, 16_000), ...remoteSettings() }),
  })
    .then((r) => r.json())
    .catch((err) => ({ ok: false, message: String(err) }));
  console.log('[shaper] warm-up', model, res);
}
const onFirstGesture = () => {
  window.removeEventListener('keydown', onFirstGesture, true);
  window.removeEventListener('mousedown', onFirstGesture, true);
  gestured = true;
  void warmUp();
};
window.addEventListener('keydown', onFirstGesture, true);
window.addEventListener('mousedown', onFirstGesture, true);

/**
 * Dev only: `?faultRate=0.5&fault=syntax&retryFails=1&seed=123` turns on the mock's faulty mode.
 * `__shaper.mock` changes faultRate / faultKind / retryFails on the fly.
 */
function devMockOptions() {
  if (!import.meta.env.DEV) return {};
  const q = new URLSearchParams(location.search);
  const fault = q.get('fault') as FaultKind | null;
  if (fault && !FAULT_KINDS.includes(fault)) console.warn(`[shaper] unknown fault kind "${fault}"; one of ${FAULT_KINDS.join(', ')}`);
  return {
    ...(q.has('seed') ? { seed: Number(q.get('seed')) } : {}),
    faultRate: Math.min(1, Math.max(0, Number(q.get('faultRate') ?? 0) || 0)),
    faultKind: fault && FAULT_KINDS.includes(fault) ? fault : undefined,
    retryFails: q.get('retryFails') === '1',
  };
}

// --- Validation -------------------------------------------------------------------------------

// Options are checked in a worker (its own realm: see src/sandbox.ts) before they reach a card.
const backend = new WorkerBackend(
  () => new Worker(new URL('./validator.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
);
const validator = new Validator({
  backend,
  hasSound: (key) => key in soundMap.get(), // read only
  cps: () => scheduler.cps,
});
// The live scope is complete (and soundMap filled) once prebake has run. Names the worker can't load
// (webaudio, draw, codemirror, hydra, soundfonts, midi) become stubs there. Checks wait for this.
Promise.resolve(mirror.prebaked)
  .catch((err: unknown) => console.error('[shaper] prebake failed', err))
  .then(() => {
    backend.init(liveScope());
    baselineSounds = new Set(Object.keys(soundMap.get()));
    baseSoundSummary = summariseSounds([...baselineSounds]);
  });

/** A few loaded drum names for unknown-sample feedback. */
const soundHint = () => {
  const loaded = soundMap.get();
  return COMMON_DRUMS.filter((d) => d in loaded).slice(0, 8).join(' ');
};

/** The names live code can call: the worker stubs the ones it can't load, and the model reference is filtered by them. */
function liveScope() {
  const methods = Object.getOwnPropertyNames(Pattern.prototype).filter(
    (name) => typeof Object.getOwnPropertyDescriptor(Pattern.prototype, name)?.value === 'function',
  );
  // Only names live code can actually call: user code resolves against globalThis, and some scope
  // entries never reach it (density, plywith, plyforeach are exported twice inside core, so
  // `export *` drops them). Stubbing those would let the worker accept code the live repl rejects.
  const globals = Object.keys(strudelScope).filter((name) => (globalThis as any)[name] !== undefined);
  return { globals, methods };
}

// --- Audio on the first keypress ---------------------------------------------------------------

// superdough's initAudioOnFirstClick only listens for mousedown, so starting with Ctrl+Enter or
// Cmd+K was silent. Resume inside the key gesture, then hand superdough the mousedown it waits for
// so its one-shot initAudio (worklets) still runs exactly once.
function unlockAudio(e: Event) {
  window.removeEventListener('keydown', unlockAudio, true);
  document.removeEventListener('mousedown', unlockAudio, true);
  if (e.type !== 'keydown') return;
  getAudioContext().resume();
  document.dispatchEvent(new MouseEvent('mousedown'));
}
window.addEventListener('keydown', unlockAudio, true);
document.addEventListener('mousedown', unlockAudio, true);

// --- Evaluation -------------------------------------------------------------------------------

/** True during the synchronous start of our own repl.evaluate, when it emits `pending: true`. */
let ownEval = false;

// Widgets (see src/widgets.ts): while an audition evaluates, afterEval's slider and block widget
// dispatches are held back, so widgets stay where the editor text has them.
let auditioning = false;
/** Editor slider id → its id in the auditioned code, while an option is playing. */
let sliderMap: Map<string, string> | null = null;
const sliderField = editorSliderField(setSliderWidgets);
view.dispatch({ effects: StateEffect.appendConfig.of([sliderField, holdEffects([setSliderWidgets, addWidget], () => auditioning)]) });
// A slider drag posts the editor's id; while auditioning, the playing code reads the slider under its own id.
window.addEventListener('message', (e) => {
  if (e.data?.type !== 'cm-slider' || !sliderMap) return;
  const id = sliderMap.get(e.data.id);
  if (id && id !== e.data.id) sliderValues[id] = e.data.value;
});

/**
 * Serialises evaluations and drops any that were superseded while waiting, so rapid key presses
 * can't land out of order. Resolves true if the code evaluated (or was superseded), false on error.
 * Our evaluations are quantized (see quantize.ts); outside ones are not.
 */
let evalChain: Promise<unknown> = Promise.resolve();
let evalGeneration = 0;
function evaluateCode(code: string, label: string, audition?: { range: Range }): Promise<boolean> {
  const generation = ++evalGeneration;
  const result = evalChain.then(async () => {
    if (generation !== evalGeneration) return true;
    const before = clockSnapshot();
    // Note: repl.evaluate also sets repl.state.code (and so isDirty) to this code, which during an
    // audition is the spliced option, not the editor text. Nothing reads them yet; a "dirty"
    // indicator built on them would be wrong while auditioning.
    quantizer.armed = true;
    ownEval = true;
    // afterEval runs inside repl.evaluate, so the hold covers its widget dispatches.
    auditioning = !!audition;
    sliderMap = audition ? sliderIdMap(view.state.field(sliderField), audition.range, code.length - view.state.doc.length) : null;
    let evaluation: Promise<unknown>;
    try {
      evaluation = mirror.repl.evaluate(code);
    } finally {
      ownEval = false;
    }
    // repl.evaluate swallows errors: returns the pattern on success, undefined on failure.
    const pattern = await evaluation.finally(() => {
      quantizer.armed = false;
      auditioning = false;
    });
    logSwap(label, before, clockSnapshot());
    return pattern !== undefined;
  });
  evalChain = result;
  return result;
}

/**
 * Fix modes on code that doesn't evaluate: what was playing when the tray opened, and the tempo.
 * 0/Esc swap back to it (quantized, through the same queue as evaluations), since evaluating the
 * broken original would fail and leave the last auditioned fix playing.
 */
let snapshot: { pattern: any; cps: number } | null = null;

function restoreSnapshot(): Promise<unknown> {
  const generation = ++evalGeneration;
  const result = evalChain.then(() => {
    if (generation !== evalGeneration || !snapshot) return true;
    const before = clockSnapshot();
    if (snapshot.cps !== scheduler.cps) scheduler.setCps(snapshot.cps);
    quantizer.swapTo(snapshot.pattern);
    mirror.drawer?.invalidate?.(scheduler);
    logSwap('original (restored)', before, clockSnapshot());
    return true;
  });
  evalChain = result;
  return result;
}

// Outside evaluations (Ctrl/Alt+Enter, the Play button) reset the tray. Signal: the element's
// `update` event. Its detail is the whole repl state, so watch for the `pending` false→true edge,
// which repl.evaluate emits synchronously on entry (repl.mjs:227).
let wasPending = false;
let outsidePending = false;
let wasStarted = false;
/** The editor text of the last outside evaluation and its error, for ⌘J (only while the text is unchanged). */
let lastOutsideEval: { code: string; error?: string } | null = null;
host.addEventListener('update', (e) => {
  const st = (e as CustomEvent).detail;
  if (st.pending && !wasPending) outsidePending = !ownEval;
  if (!st.pending && wasPending) {
    // A failed outside eval leaves the old pattern playing, so the tray is still right.
    if (outsidePending && !st.evalError) send({ type: 'externalEval' });
    if (outsidePending) lastOutsideEval = { code: mirror.code, error: st.evalError?.message };
    outsidePending = false;
  }
  if (wasStarted && !st.started) quantizer.settle(true); // stop() resets lastEnd to 0
  wasPending = !!st.pending;
  wasStarted = !!st.started;
});

// --- Timing instrumentation -------------------------------------------------------------------

interface ClockSnapshot {
  audioTime: number;
  cycle: number; // scheduler.now()
  queuedUntil: number; // scheduler.lastEnd: events up to this cycle are already scheduled
  anchorCycle: number;
  anchorSeconds: number;
  cps: number;
  started: boolean;
}

function clockSnapshot(): ClockSnapshot {
  return {
    audioTime: scheduler.getTime(),
    cycle: scheduler.now(),
    queuedUntil: scheduler.lastEnd,
    anchorCycle: scheduler.num_cycles_at_cps_change,
    anchorSeconds: scheduler.seconds_at_cps_change,
    cps: scheduler.cps,
    started: scheduler.started,
  };
}

export const swapLog: Array<Record<string, unknown>> = [];

function logSwap(label: string, a: ClockSnapshot, b: ClockSnapshot) {
  // The scheduler places event onsets at (cycle - anchorCycle) / cps + anchorSeconds.
  // If the anchor and cps are untouched and the clock kept running, the grid didn't move.
  const anchorKept = a.anchorCycle === b.anchorCycle && a.anchorSeconds === b.anchorSeconds && a.cps === b.cps;
  // The new pattern is first heard at the quantized boundary, or from lastEnd when immediate.
  const landsAt = quantizer.pending?.at ?? b.queuedUntil;
  const entry = {
    label,
    swap: quantizer.mode,
    started: `${a.started}→${b.started}`,
    cycleBefore: +a.cycle.toFixed(4),
    cycleAfter: +b.cycle.toFixed(4),
    evalMs: +((b.audioTime - a.audioTime) * 1000).toFixed(1),
    takesEffectAtCycle: +landsAt.toFixed(4),
    takesEffectInMs: +(((landsAt - b.cycle) / b.cps) * 1000).toFixed(1),
    anchorKept,
  };
  swapLog.push(entry);
  console.log('[shaper] swap', entry);
}

// --- Highlighting -----------------------------------------------------------------------------

// Uses StrudelMirror.reconfigureExtension rather than updateSettings so nothing is persisted.
const highlightWasEnabled = () => host.settings?.isPatternHighlightingEnabled !== false;
const setHighlight = (on: boolean) => mirror.reconfigureExtension('isPatternHighlightingEnabled', on);
let pauseGeneration = 0;

async function resumeHighlight() {
  // Wait until the original is actually sounding: before the boundary the option is still playing,
  // and its haps carry locations from the spliced code, not the editor text.
  const generation = pauseGeneration;
  await quantizer.landed();
  if (generation === pauseGeneration && highlightWasEnabled()) setHighlight(true);
}

// --- Tray state -------------------------------------------------------------------------------

let state: TrayState = initialState;
let liveRange: Range | null = null; // the captured range, carried through edits made outside it
let requestSeq = 0;
let controller: AbortController | null = null;
interface Timing {
  requestId: number;
  firstMs?: number; // first card shown (validated)
  lastMs?: number; // last slot settled
  rawFirstMs?: number; // first option from the provider
  rawLastMs?: number;
  provider?: string;
}
let timing: Timing | null = null;

async function send(event: TrayEvent) {
  const t = transition(state, event);
  state = t.state;
  render();
  for (const effect of t.effects) await run(effect);
  if (state.kind === 'committed') {
    await send({ type: 'commitDone' });
  }
}

async function run(effect: Effect) {
  switch (effect.type) {
    case 'startRequest':
      controller?.abort();
      controller = new AbortController();
      void streamOptions(effect, controller.signal);
      return;
    case 'abortRequest':
      if (controller) console.log('[shaper] request aborted');
      controller?.abort();
      controller = null;
      return;
    case 'pauseHighlight':
      pauseGeneration++;
      setHighlight(false);
      return;
    case 'resumeHighlight':
      // After the original has been re-evaluated, so StrudelMirror.miniLocations match the editor again.
      void resumeHighlight();
      return;
    case 'auditionOption': {
      const code = splice(view.state.doc.toString(), liveRange!, effect.code);
      const ok = await evaluateCode(code, `option ${effect.slot}`, { range: liveRange! });
      if (!ok) await send({ type: 'evalFailed', slot: effect.slot });
      return;
    }
    case 'evaluateEditor':
      await evaluateCode(mirror.code, 'original');
      return;
    case 'snapshotPlaying':
      // Nothing playing yet: an audition will start the clock, and going back means silence.
      snapshot = { pattern: scheduler.started ? quantizer.playing() : silence, cps: scheduler.cps };
      return;
    case 'restoreSnapshot':
      await restoreSnapshot();
      return;
    case 'commit':
      view.dispatch(commitSpec(liveRange!, effect.code));
      mirror.flash();
      liveRange = null;
      return;
  }
}

async function streamOptions(effect: Extract<Effect, { type: 'startRequest' }>, signal: AbortSignal) {
  const { requestId, mode, instruction, capture, fix } = effect;
  const range = liveRange ?? capture.range;
  const req: OptionRequest = {
    mode,
    buffer: view.state.doc.toString(),
    selection: { ...range, text: capture.text },
    instruction,
    // Fix modes: the diagnosed error. Shape: the live repl's, as context.
    error: mode === 'shape' ? mirror.repl.state.evalError?.message : fix?.error,
    ...(fix?.errorAt ? { errorAt: fix.errorAt } : {}),
    cps: scheduler.cps,
  };
  const startedAt = performance.now();
  const times: Timing = (timing = { requestId });
  render();
  await runRequest(
    {
      provider,
      validator,
      soundHint,
      getBuffer: () => view.state.doc.toString(),
      getRange: () => liveRange ?? capture.range,
      emit: (event) => {
        const ms = performance.now() - startedAt;
        if (event.type === 'optionArrived') {
          times.rawFirstMs ??= ms;
          times.rawLastMs = ms;
        }
        if (event.type === 'optionValidated') times.firstMs ??= ms;
        if (event.type === 'optionValidated' || event.type === 'optionDropped') times.lastMs = ms;
        if (event.type === 'requestDone') {
          console.log('[shaper] request timing', { ...times, stats: event.stats, error: event.error });
        }
        soakLog?.push(event);
        send(event);
      },
    },
    requestId,
    req,
    slotCount(mode),
    signal,
    fix?.context,
  );
}

// --- Capture ----------------------------------------------------------------------------------

const history = new InstructionHistory();
const box = new InstructionBox(view, history);

function startCapture(mode: Mode) {
  if (state.kind === 'committed') return;
  if (mode !== 'shape') return void startFix(mode);
  const range = captureRange(view.state);
  if (range.from === range.to) {
    statusEl.textContent = 'Nothing to capture here. Select some code or move to a line with code.';
    return;
  }
  const buffer = view.state.doc.toString();
  const cap: Capture = { range, text: buffer.slice(range.from, range.to), buffer };
  box.open(range, (instruction) => submit(cap, mode, instruction));
}

/**
 * ⌘J / ⌘⇧J: find what is broken (the error's expression, else the selection or cursor line), only
 * because the user asked. A minimal fix of code that runs sends nothing. Takes a few ms in the worker.
 */
async function startFix(mode: Exclude<Mode, 'shape'>) {
  const buffer = view.state.doc.toString();
  const sel = view.state.selection.main;
  const selection = sel.empty ? null : captureRange(view.state);
  const liveError = lastOutsideEval?.code === buffer ? lastOutsideEval.error : undefined;
  statusEl.textContent = 'checking the code…';
  let diagnosis;
  try {
    diagnosis = await diagnoseFix({ state: view.state, selection, validator, liveError });
  } catch (err) {
    console.error('[shaper] diagnosis failed', err);
    statusEl.textContent = `couldn't check the code: ${String((err as Error)?.message ?? err)}`;
    return;
  }
  console.log('[shaper] fix target', diagnosis);
  if (view.state.doc.toString() !== buffer) {
    statusEl.textContent = 'The code changed while it was being checked. Press ⌘/Ctrl+J again.';
    return;
  }
  const reason = noRequestReason(diagnosis, mode);
  if (reason) {
    statusEl.textContent = reason;
    return;
  }
  const { range } = diagnosis;
  if (range.from === range.to) {
    statusEl.textContent = 'Nothing to capture here. Select some code or move to a line with code.';
    return;
  }
  const cap: Capture = { range, text: buffer.slice(range.from, range.to), buffer };
  const fix = trayFix(diagnosis);
  // Minimal fix goes straight to the tray; intent rewrite asks for an instruction (empty is fine).
  if (mode === 'fix-minimal') submit(cap, mode, '', fix);
  else box.open(range, (instruction) => submit(cap, mode, instruction, fix));
}

function submit(cap: Capture, mode: Mode, instruction: string, fix?: TrayFix) {
  if (!isRangeIntact(view.state.doc.toString(), cap.range, cap.text)) {
    statusEl.textContent = 'The selection changed while the box was open. Press ⌘/Ctrl+K again.';
    return;
  }
  history.add(instruction);
  liveRange = cap.range;
  send({ type: 'request', requestId: ++requestSeq, capture: cap, mode, instruction, ...(fix ? { fix } : {}) });
  trayEl.focus();
}

// Stale guard: carry the range through edits elsewhere; any edit inside it makes the options stale.
view.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || state.kind !== 'tray' || state.stale || !liveRange) return;
      const edits: Edit[] = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
        edits.push({ fromA, toA, insertedLength: inserted.length }),
      );
      const mapped = mapRange(liveRange, edits);
      if (mapped && isRangeIntact(update.state.doc.toString(), mapped, state.capture.text)) {
        liveRange = mapped;
      } else {
        // Defer: dispatching from inside an update listener is not allowed.
        queueMicrotask(() => send({ type: 'stale' }));
      }
    }),
  ),
});

// --- Keys -------------------------------------------------------------------------------------

function toggleSwapTiming() {
  quantizer.cycleMode();
  render();
}

/** ⌘/Ctrl+⇧F: reformat the whole buffer as one undoable edit. Strings and comments are never touched. */
async function formatBuffer() {
  if (state.kind === 'tray') {
    statusEl.textContent = 'Close the options (Esc) before formatting.';
    return;
  }
  const before = view.state.doc.toString();
  try {
    const after = await formatCode(before);
    if (view.state.doc.toString() !== before) return; // edited while Prettier loaded
    if (after === before) {
      statusEl.textContent = 'Already formatted.';
      return;
    }
    // Replace only the span that differs, so the scroll position and undo stay local.
    let from = 0;
    while (from < before.length && before[from] === after[from]) from++;
    let endB = before.length;
    let endA = after.length;
    while (endB > from && endA > from && before[endB - 1] === after[endA - 1]) {
      endB--;
      endA--;
    }
    const head = mapOffset(before, view.state.selection.main.head, after);
    view.dispatch({
      changes: { from, to: endB, insert: after.slice(from, endA) },
      selection: { anchor: head },
      annotations: isolateHistory.of('full'),
      userEvent: 'input.shaper.format',
      scrollIntoView: true,
    });
    statusEl.textContent = 'Formatted. ⌘/Ctrl+Z undoes it.';
  } catch (err) {
    statusEl.textContent =
      err instanceof FormatError ? `Can't format yet: ${err.message}` : `Couldn't format: ${String((err as Error)?.message ?? err)}`;
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault();
      e.stopPropagation();
      void formatBuffer();
      return;
    }
    // Capture phase, so CodeMirror's own Ctrl-K (emacs deleteToLineEnd on macOS) never sees it.
    if (mod && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      startCapture('shape');
      return;
    }
    if (mod && !e.altKey && e.code === 'KeyJ') {
      e.preventDefault();
      e.stopPropagation();
      startCapture(e.shiftKey ? 'fix-rewrite' : 'fix-minimal');
      return;
    }
    if (box.contains(e.target)) return;
    // Alt+digits work from the editor. e.code, because on macOS Alt+1 types "¡".
    if (e.altKey && !mod && !e.shiftKey) {
      const digit = /^Digit([0-4])$/.exec(e.code);
      if (digit && state.kind === 'tray') {
        e.preventDefault();
        e.stopPropagation();
        send({ type: 'audition', slot: Number(digit[1]) as Slot });
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        toggleSwapTiming();
      } else if (e.code === 'KeyP') {
        e.preventDefault();
        e.stopPropagation();
        cycleProvider();
      }
      return;
    }
    // Esc goes back to the original (and then closes) from anywhere, unless CodeMirror has a popup open.
    if (e.key === 'Escape' && !mod && state.kind === 'tray' && !document.querySelector('.cm-tooltip-autocomplete')) {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'escape' });
    }
  },
  true,
);

trayEl.addEventListener('keydown', (e) => {
  if (state.kind !== 'tray' || e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd+R etc. to the browser
  if (/^[0-4]$/.test(e.key)) {
    send({ type: 'audition', slot: Number(e.key) as Slot });
  } else if (e.key === 'Enter') {
    send({ type: 'enter' });
  } else if (e.key === 'r' || e.key === 'R') {
    send({ type: 'regenerate', requestId: ++requestSeq });
  } else if (e.key === 't' || e.key === 'T') {
    toggleSwapTiming();
  } else {
    return;
  }
  e.preventDefault();
});

trayEl.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  const card = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
  if (button) {
    if (!button.disabled) void trayAction(button.dataset.action!);
  } else if (card) send({ type: 'audition', slot: Number(card.dataset.slot) as Slot });
  trayEl.focus();
});

/** The tray's touch buttons (shown on narrow screens): the same events as 0, Enter, R, T and Esc. */
async function trayAction(action: string) {
  if (action === 'original') send({ type: 'audition', slot: 0 });
  else if (action === 'accept') send({ type: 'enter' });
  else if (action === 'regenerate') send({ type: 'regenerate', requestId: ++requestSeq });
  else if (action === 'swap') toggleSwapTiming();
  // Esc goes back to the original first, so press it until the tray is gone.
  else if (action === 'close') while (state.kind === 'tray') await send({ type: 'escape' });
}

// The start actions for touch screens. Taking no focus on press keeps the editor's selection and cursor line.
actionsEl.addEventListener('mousedown', (e) => e.preventDefault());
actionsEl.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')?.dataset.action;
  if (action === 'format') void formatBuffer();
  else if (action) startCapture(action as Mode);
});

// --- Render -----------------------------------------------------------------------------------

const KEYS_HINT = '⌘/Ctrl+K shape · ⌘/Ctrl+J fix · ⌘/Ctrl+⇧J rewrite · ⌘/Ctrl+⇧F format · Alt+P provider';

function render() {
  // As the keys: nothing starts mid-commit, and formatting waits for the tray to close.
  for (const b of actionsEl.querySelectorAll('button')) {
    b.disabled = state.kind === 'committed' || (b.dataset.action === 'format' && state.kind === 'tray');
  }
  const swap = `swap: ${quantizer.mode} (T)`;
  if (state.kind !== 'tray') {
    statusEl.textContent = `${KEYS_HINT} · ${swap.replace('(T)', '(Alt+T)')}`;
    // Check focus before hiding: hiding a focused element moves focus to <body>.
    const hadFocus = trayEl.contains(document.activeElement);
    trayEl.hidden = true;
    if (hadFocus) view.focus();
    return;
  }
  const tray = state;
  trayEl.hidden = false;
  trayEl.classList.toggle('is-stale', tray.stale);

  const broken = !!tray.fix?.broken;
  const original = card(0, ['original', tray.heard === 0 ? 'heard' : ''], broken ? 'original (broken)' : 'original', codeHtml(tray.capture.text), {
    title: tray.fix?.error ? `${tray.fix.error}${broken ? '\n0/Esc go back to what was playing before ⌘J.' : ''}` : undefined,
  });
  // A minimal fix shows the exact characters it changed; elsewhere a word diff reads better.
  const granularity: DiffGranularity = tray.mode === 'fix-minimal' ? 'char' : 'word';
  const options = tray.slots
    .map((s, i) => ({ s, slot: i + 1 }))
    // A minimal fix usually has one option: don't show the unused second slot as "no option".
    .filter(({ s, slot }) => !(tray.mode === 'fix-minimal' && slot > 1 && s.status === 'empty'))
    .map(({ s, slot }) => slotCard(slot, s, tray.heard, tray.capture.text, granularity));

  const times = timing?.requestId === tray.requestId ? timing : null; // never show the previous request's times
  const ms = (v?: number) => (v === undefined ? '…' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
  const count = (pred: (s: SlotCard) => boolean) => tray.slots.filter(pred).length;
  const checked = tray.validationMs.filter((v) => v > 0); // identical/duplicate never reach the evaluator
  const stats = tray.stats;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const usage = stats?.tokens
    ? `tokens ${k(stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite)} in (${k(stats.tokens.cacheRead)} cached) / ${k(stats.tokens.output)} out` +
      (stats.costUsd !== undefined ? ` · $${stats.costUsd.toFixed(4)}` : '') +
      (stats.calls > 1 ? ` · ${stats.calls} calls` : '')
    : null;
  const fixing = tray.fix?.error ? `${tray.mode === 'fix-minimal' ? 'fixing' : 'rewriting'}: ${tray.fix.error.slice(0, 80)}${tray.fix.errorAt?.line ? ` (line ${tray.fix.errorAt.line})` : ''}` : null;
  const status = [
    fixing,
    `provider: ${times?.provider ?? providerLabel(tray.mode, stats?.model)}`,
    `first ${ms(times?.firstMs)}`,
    `last ${tray.done ? ms(times?.lastMs) : '…'}`,
    `${count((s) => s.status === 'ready')} ok · ${count((s) => !!s.retried)} retried · ${count((s) => s.status === 'dropped')} dropped`,
    checked.length
      ? `validation ${(checked.reduce((a, b) => a + b, 0) / checked.length).toFixed(1)} ms avg / ${Math.max(...checked).toFixed(1)} ms max`
      : 'validation …',
    usage,
    tray.heard === 0 ? 'audition: off (original)' : `audition: on (option ${tray.heard})`,
    swap,
  ]
    .filter(Boolean)
    .join(' · ');
  const hint = tray.stale
    ? '<span class="stale">Selection changed — options are stale. Playing the original. Esc to close.</span>'
    : '1–4 audition (Alt+1–4 from the editor) · 0/Esc original · Enter commit · R regenerate · Esc again closes';
  const error =
    (tray.error ? ` · <span class="stale">${escapeHtml(tray.error)}</span>` : '') +
    (tray.bufferError ? ` · <span class="stale" title="${escapeHtml(tray.bufferError)}">buffer has an error: ${escapeHtml(tray.bufferError.slice(0, 80))}</span>` : '');
  trayEl.innerHTML = `${trayActions(tray)}<div class="meta">${escapeHtml(status)}${error}</div><div class="meta">${hint}</div><div class="cards">${original}${options.join('')}</div>`;
  statusEl.textContent = `${KEYS_HINT} · ${swap.replace('(T)', '(Alt+T)')}`;
}

/** Disabled where the key does nothing (Enter with nothing auditioned only closes; Close covers that). */
function trayActions(tray: Tray) {
  const button = (action: string, label: string, title: string, disabled = false) =>
    `<button type="button" tabindex="-1" data-action="${action}" title="${title}"${disabled ? ' disabled' : ''}>${label}</button>`;
  return `<div class="actions">${[
    button('original', 'Original', 'Back to the original (0)', tray.heard === 0),
    button('accept', 'Accept', 'Accept the option playing (Enter)', tray.heard === 0 || tray.stale),
    button('regenerate', 'Regenerate', 'Regenerate (R)', tray.stale),
    button('swap', `Swap: ${quantizer.mode}`, 'Swap timing (T)'),
    button('close', 'Close', 'Close (Esc)'),
  ].join('')}</div>`;
}

/** The provider, and for a remote one the model that answered (or will: a fix mode may use another). */
function providerLabel(mode: Mode = 'shape', answered?: string) {
  if (provider instanceof RemoteProvider) {
    const name = provider.name.split(' · ')[0];
    if (answered) return `${name} · ${answered.replace(/^(claude|gemini)-/, '')}`;
    if (mode !== 'shape') return `${name} · ${modelForMode(query, provider.model)(mode)?.replace(/^(claude|gemini)-/, '') ?? `${mode} default`}`;
  }
  if (!(provider instanceof MockProvider) || provider.faultRate === 0) return provider.name;
  return `${provider.name} (faults ${Math.round(provider.faultRate * 100)}%${provider.faultKind ? ` ${provider.faultKind}` : ''}${provider.retryFails ? ', retries fail' : ''})`;
}

const placeholder = (text: string) => `<span class="placeholder">${escapeHtml(text)}</span>`;

function slotCard(slot: number, s: SlotCard, heard: Slot, original: string, granularity: DiffGranularity) {
  const classes = [s.status, slot === heard ? 'heard' : ''];
  const why = s.drop ? reasonLabel(s.drop.reason, s.drop.message) : '';
  switch (s.status) {
    case 'pending':
      return card(slot, classes, '…', placeholder('waiting for option'));
    case 'validating':
      return card(slot, classes, s.retried ? 'replacement' : '…', placeholder('validating…'), { title: s.drop?.message });
    case 'retrying':
      return card(slot, classes, '…', placeholder(`retrying… (${why})`), { title: s.drop?.message });
    case 'dropped':
      return card(slot, classes, 'dropped', placeholder(`dropped: ${why}`), { title: s.drop?.message });
    case 'empty':
      return card(slot, classes, '—', placeholder('no option'));
    case 'ready':
    case 'failed': {
      const label = s.status === 'failed' ? `${s.option!.label} (failed)` : s.option!.label;
      const badges = (s.warnings ?? []).map((w) => (w === 'empty' ? 'empty' : `unknown sample: ${(s.unknownSounds ?? []).join(', ')}`));
      if (s.checkedAlone) badges.push('checked alone');
      if (granularity === 'char' && (s.changeSize ?? 0) > LARGE_CHANGE_CHARS) badges.push('large change');
      if (s.retried) badges.push('retried');
      const title = [
        s.retried && s.drop ? `Retried after ${why}: ${s.drop.message}` : '',
        s.checkedAlone ? 'The buffer itself fails to evaluate, so this option was checked on its own. Auditioning it plays the whole buffer, which may fail.' : '',
        s.changeSize !== undefined && granularity === 'char' ? `${s.changeSize} characters changed` : '',
      ]
        .filter(Boolean)
        .join('\n') || undefined;
      return card(slot, classes, label, diffHtml(original, s.option!.code, granularity), { badges, title });
    }
  }
}

function card(slot: number, classes: string[], label: string, body: string, extra: { title?: string; badges?: string[] } = {}) {
  const title = extra.title ? ` title="${escapeHtml(extra.title)}"` : '';
  const badges = (extra.badges ?? []).map((b) => `<span class="badge${b === 'retried' || b === 'checked alone' ? ' info' : ''}">${escapeHtml(b)}</span>`).join('');
  return `<div class="card ${classes.join(' ')}" data-slot="${slot}"${title}><b>${slot}</b> ${escapeHtml(label)}${badges}<code>${body}</code></div>`;
}

function diffHtml(before: string, after: string, granularity: DiffGranularity = 'word') {
  const cls = granularity === 'char' ? ' class="char"' : '';
  return diffSegments(before, after, granularity)
    .map(({ kind, text, shown }) => (kind === 'same' ? codeHtml(text) : `<${kind}${cls}>${codeHtml(shown ?? text)}</${kind}>`))
    .join('');
}

/** Escaped code with line-break opportunities before each `.method`, so narrow cards wrap at calls, not mid-token. */
function codeHtml(code: string) {
  return escapeHtml(code).replace(/\.(?=[A-Za-z_$])/g, '<wbr>.');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

render();

// --- Measurement ------------------------------------------------------------------------------

/**
 * Presses random ready slots (and 0) at random gaps while tapping the scheduler's own queries, then
 * checks every onset that played against what the sequence of swaps should have produced.
 * Run from the console with the tray open and options ready: `await __shaper.measure(12)`.
 * `{ validate: true }` validates 4 options per batch in the background, back to back, the whole time
 * (every other batch in a buffer with setcps(1)), and checks the live session is untouched.
 * `measure(0, { validate: true, holdMs: 20000 })` measures validation alone; the tray needn't be open.
 */
async function measure(
  swaps = 12,
  { minGapMs = 300, maxGapMs = 900, validate = false, holdMs = 2500 }: { minGapMs?: number; maxGapMs?: number; validate?: boolean; holdMs?: number } = {},
) {
  if (!scheduler.started) throw new Error('Press Play first.');
  if (swaps > 0 && state.kind !== 'tray') throw new Error('Open the tray and wait for options.');
  const before = liveSnapshot();
  const loadController = new AbortController();
  const load = validate ? validationLoad(loadController.signal) : null;
  type Onset = { cycle: number; key: string; s: string };
  const played: Onset[] = [];
  const toOnsets = (haps: any[]): Onset[] =>
    haps
      .filter((h) => h.hasOnset())
      .map((h) => ({ cycle: h.whole.begin.valueOf(), s: String(h.value?.s), key: `${h.whole.begin.valueOf().toFixed(6)} ${JSON.stringify(h.value)}` }));
  let windowStart: number | null = null;
  let windowEnd = 0;

  const queryArc = Pattern.prototype.queryArc;
  Pattern.prototype.queryArc = function (begin: number, end: number, controls: any = {}) {
    const haps = queryArc.call(this, begin, end, controls);
    if (controls?.cyclist === 'cyclist') {
      windowStart ??= begin;
      windowEnd = end;
      played.push(...toOnsets(haps));
    }
    return haps;
  };
  const segments: Array<{ at: number; pattern: any; label: string; pressCycle: number }> = [];
  const initial = scheduler.pattern;
  const setPattern = scheduler.setPattern;
  let label = '';
  scheduler.setPattern = (p: any, autostart?: boolean) => {
    const r = setPattern(p, autostart);
    const pending = quantizer.pending;
    segments.push({ at: pending?.at ?? scheduler.lastEnd, pattern: pending?.next ?? p, label, pressCycle: scheduler.now() });
    return r;
  };

  try {
    const rand = Math.random;
    for (let i = 0; i < swaps; i++) {
      await new Promise((r) => setTimeout(r, minGapMs + rand() * (maxGapMs - minGapMs)));
      if (state.kind !== 'tray') break;
      const tray = state;
      const ready = tray.slots.flatMap((s, j) => (s.status === 'ready' ? [j + 1] : []));
      const choices = [0, ...ready].filter((slot) => slot !== tray.heard);
      const slot = choices[Math.floor(rand() * choices.length)] as Slot;
      label = `key ${slot}`;
      await send({ type: 'audition', slot });
    }
    await new Promise((r) => setTimeout(r, holdMs)); // let the last swap land and play a while
  } finally {
    loadController.abort();
    Pattern.prototype.queryArc = queryArc;
    scheduler.setPattern = setPattern;
  }
  const validation = load ? await load : null;
  const isolation = compareSnapshots(before, liveSnapshot(), swaps === 0);

  // Later presses before the same boundary replace earlier ones: keep the last per boundary.
  const landed = segments.filter((s, i) => segments[i + 1]?.at !== s.at);
  const start = windowStart!;
  const end = windowEnd;
  const expected: Onset[] = [];
  const pieces = [{ at: -Infinity, pattern: initial }, ...landed];
  pieces.forEach((piece, i) => {
    const from = Math.max(piece.at, start);
    const to = Math.min(pieces[i + 1]?.at ?? Infinity, end);
    if (to > from) expected.push(...toOnsets(queryArc.call(piece.pattern, from, to, {})));
  });
  const count = (list: Onset[]) => list.reduce((m, o) => m.set(o.key, (m.get(o.key) ?? 0) + 1), new Map<string, number>());
  const want = count(expected);
  const got = count(played);
  const missing = [...want].filter(([k, n]) => (got.get(k) ?? 0) < n).map(([k]) => k);
  const extra = [...got].filter(([k, n]) => (want.get(k) ?? 0) < n).map(([k]) => k);
  const kicks = played.filter((o) => o.s === 'bd').map((o) => o.cycle).sort((a, b) => a - b);
  const kickGapsSec = [...new Set(kicks.slice(1).map((k, i) => +((k - kicks[i]) / scheduler.cps).toFixed(6)))];

  const table = segments.map((s) => ({
    key: s.label,
    swap: quantizer.mode,
    pressCycle: +s.pressCycle.toFixed(4),
    landsAt: +s.at.toFixed(4),
    onBeat: Number.isInteger(+(s.at * quantizer.beatsPerCycle).toFixed(9)),
    msUntilAudible: +(((s.at - s.pressCycle) / scheduler.cps) * 1000).toFixed(0),
    landed: landed.includes(s),
  }));
  console.table(table);
  const summary = {
    swaps: segments.length,
    landed: landed.length,
    window: [+start.toFixed(3), +end.toFixed(3)],
    onsetsPlayed: played.length,
    onsetsExpected: expected.length,
    missing: missing.length,
    extra: extra.length,
    kicks: kicks.length,
    kickGapsSec,
    ...(validation ? { validation } : {}),
    isolation,
  };
  console.log('[shaper] measure', summary);
  return { table, summary, missing, extra };
}

// --- Validation harnesses ----------------------------------------------------------------------

const LINES = ['s("bd*4")', 's("hh*8").gain(0.6)', 'note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)'];

/** What validation must never change. */
function liveSnapshot() {
  const sounds = Object.keys(soundMap.get()).sort().join('|');
  let hash = 0;
  for (let i = 0; i < sounds.length; i++) hash = (Math.imul(hash, 31) + sounds.charCodeAt(i)) | 0;
  return {
    cps: scheduler.cps,
    anchorCycle: scheduler.num_cycles_at_cps_change,
    anchorSeconds: scheduler.seconds_at_cps_change,
    pattern: scheduler.pattern,
    editor: view.state.doc.toString(),
    soundCount: Object.keys(soundMap.get()).length,
    soundHash: hash,
    protoKeys: Object.getOwnPropertyNames(Pattern.prototype).length,
    setcps: (globalThis as any).setcps,
  };
}

function compareSnapshots(a: ReturnType<typeof liveSnapshot>, b: ReturnType<typeof liveSnapshot>, comparePattern: boolean) {
  return {
    cps: `${a.cps} → ${b.cps}`,
    anchorKept: a.anchorCycle === b.anchorCycle && a.anchorSeconds === b.anchorSeconds,
    ...(comparePattern ? { patternKept: a.pattern === b.pattern } : {}),
    editorKept: a.editor === b.editor,
    soundMapKept: a.soundCount === b.soundCount && a.soundHash === b.soundHash,
    sounds: b.soundCount,
    prototypeKept: a.protoKeys === b.protoKeys,
    liveSetcpsKept: a.setcps === b.setcps,
  };
}

/** Validates batches of 4 faulty-mock options against the current buffer, back to back, until aborted. */
async function validationLoad(signal: AbortSignal) {
  const mock = new MockProvider({ seed: 1, minDelayMs: 0, maxDelayMs: 0, faultRate: 0.5 });
  const times: number[] = [];
  let batches = 0;
  let setcps1Batches = 0;
  while (!signal.aborted) {
    let buffer = view.state.doc.toString();
    if (batches % 2) {
      buffer = buffer.replace(/setcps\([^)]*\)/, 'setcps(1)');
      if (buffer.includes('setcps(1)')) setcps1Batches++;
    }
    const text = LINES[batches % LINES.length];
    batches++;
    const from = buffer.indexOf(text);
    if (from < 0) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    const range = { from, to: from + text.length };
    const req: OptionRequest = { mode: 'shape', buffer, selection: { ...range, text }, instruction: '', cps: scheduler.cps };
    const accepted = [];
    for await (const option of mock.generateOptions(req, signal)) {
      const r = await validator.validate(buffer, range, option, accepted);
      if (r.ms > 0) times.push(r.ms);
      if (r.ok) accepted.push(option);
    }
  }
  const sorted = [...times].sort((x, y) => x - y);
  const round = (v: number) => +v.toFixed(2);
  return {
    batches,
    setcps1Batches,
    checks: times.length,
    msAvg: round(times.reduce((x, y) => x + y, 0) / (times.length || 1)),
    msP95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    msMax: round(sorted.at(-1) ?? 0),
    timeouts: backend.respawns,
  };
}

/** The open tray's slots (a function, so TypeScript doesn't keep `state` narrowed across awaits). */
const traySlots = (): SlotCard[] => (state.kind === 'tray' ? state.slots : []);

/** Pipeline events seen while a soak runs. */
let soakLog: TrayEvent[] | null = null;

const waitFor = async (cond: () => boolean, timeoutMs = 15000) => {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error('soak: timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * Exit-criteria run: `await __shaper.soak({ requests: 30, faultRate: 0.5 })`. Requests options for the
 * kick, hi-hat and bass lines in turn through the real tray, auditions every card that appears
 * through the live repl, and reports how each injected fault was handled. Needs Play.
 */
async function soak({ requests = 30, faultRate = 0.5, retryFails = false, seed = 1 } = {}) {
  if (!scheduler.started) throw new Error('Press Play first.');
  const mock = new MockProvider({ seed, faultRate, retryFails, minDelayMs: 50, maxDelayMs: 200 });
  const savedProvider = provider;
  const savedMode = quantizer.mode;
  provider = mock;
  quantizer.mode = 'immediate'; // auditions don't need to wait for the beat here
  soakLog = [];
  let auditions = 0;
  let failedCards = 0;
  try {
    for (let i = 0; i < requests; i++) {
      while (state.kind === 'tray') await send({ type: 'escape' });
      const doc = view.state.doc.toString();
      const text = LINES[i % LINES.length];
      const from = doc.indexOf(text);
      if (from < 0) throw new Error(`soak: "${text}" is not in the editor`);
      const cap: Capture = { range: { from, to: from + text.length }, text, buffer: doc };
      liveRange = cap.range;
      const requestId = ++requestSeq;
      await send({ type: 'request', requestId, capture: cap, mode: 'shape', instruction: '' });
      await waitFor(() => state.kind === 'tray' && state.requestId === requestId && state.done);
      const ready = traySlots().flatMap((s, j) => (s.status === 'ready' ? [j + 1] : []));
      for (const slot of ready) {
        await send({ type: 'audition', slot: slot as Slot });
        auditions++;
      }
      failedCards += traySlots().filter((s) => s.status === 'failed').length;
    }
    while (state.kind === 'tray') await send({ type: 'escape' });
  } finally {
    provider = savedProvider;
    quantizer.mode = savedMode;
  }
  const log = soakLog;
  soakLog = null;

  // Follow each option through its events: what happened to it, and to its replacement.
  const optionAt = new Map<string, string>(); // `${requestId}:${slot}` → option id currently in that slot
  const outcome = new Map<string, string>(); // option id → outcome
  const replacementOf = new Map<string, string>(); // failed option id → its replacement's id
  for (const e of log) {
    if (!('slot' in e) || !('requestId' in e)) continue;
    const key = `${e.requestId}:${e.slot}`;
    if (e.type === 'optionArrived') {
      const previous = optionAt.get(key);
      if (previous && outcome.get(previous)?.startsWith('retried')) replacementOf.set(previous, e.option.id);
      optionAt.set(key, e.option.id);
      continue;
    }
    const id = optionAt.get(key)!;
    if (e.type === 'optionValidated') outcome.set(id, e.warnings.length ? `warned (${e.warnings.join(', ')})` : 'accepted');
    if (e.type === 'optionRetrying') outcome.set(id, `retried after ${reasonLabel(e.reason, e.message)}`);
    if (e.type === 'optionDropped') outcome.set(id, `dropped for good: ${reasonLabel(e.reason, e.message)}`);
  }
  const byKind: Record<string, Record<string, number>> = {};
  for (const f of mock.faultLog) {
    let result = outcome.get(f.optionId) ?? 'not reached (aborted)';
    const replacement = replacementOf.get(f.optionId);
    if (replacement) result += ` → replacement ${outcome.get(replacement) ?? '?'}`;
    byKind[f.kind] ??= {};
    byKind[f.kind][result] = (byKind[f.kind][result] ?? 0) + 1;
  }
  const hard = new Set(['syntax', 'unknown-function', 'runtime']);
  const hardFaultsAccepted = mock.faultLog.filter((f) => hard.has(f.kind) && outcome.get(f.optionId)?.match(/^(accepted|warned)/)).length;
  const summary = {
    requests,
    faultRate,
    retryFails,
    options: log.filter((e) => e.type === 'optionArrived').length,
    faults: mock.faultLog.length,
    kindsSeen: Object.keys(byKind).length,
    auditions,
    failedCards,
    hardFaultsAccepted,
  };
  console.log('[shaper] soak', summary);
  console.table(Object.entries(byKind).flatMap(([kind, results]) => Object.entries(results).map(([result, n]) => ({ kind, result, n }))));
  return { summary, byKind };
}

// Debug handle for poking at things from the console.
Object.assign(window, {
  __shaper: {
    mirror,
    view,
    scheduler,
    quantizer,
    swapLog,
    send,
    measure,
    soak,
    validator,
    backend,
    get mock() {
      return mockProvider;
    },
    switchProvider,
    sliderValues,
    get sliderMap() {
      return sliderMap;
    },
    getState: () => state,
    /** Dev: the live scope and sound names, for src/generated/scope.json and sounds.json (npm run build:reference). */
    dumpScope: () => ({ ...liveScope(), sounds: Object.keys(soundMap.get()).sort() }),
    saveScope: async () => {
      await mirror.prebaked;
      const res = await fetch('/__shaper/scope', { method: 'POST', body: JSON.stringify({ ...liveScope(), sounds: Object.keys(soundMap.get()).sort() }) });
      return res.json();
    },
    audioContext: () => getAudioContext(),
    get provider() {
      return provider;
    },
    set provider(p: Provider) {
      provider = p;
    },
  },
});
