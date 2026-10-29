import { getSpeechMarks, type SpeechMark } from './speech-playback-control';
import type { RecordingWorkflowDependencies, RecordingWorkflowResult } from './recording-workflow';
import type { Scenario, ScenarioStep } from './scenario';
import { getScenarioStepContract, isTriggerStep, normalizeClipboardHistoryLevel } from './scenario';
import { walkScenarioSteps } from './scenario-tree';
import type { HistoryItem, HistoryStep } from './history-db';
import type { OverlayStepStatus } from './OverlaySteps';
import { errorMessage } from './error-message';

type Data = { type: 'audio'; audio: Blob; recording: boolean } | { type: 'text'; text: string };
type Prepare = (audio: Blob, dependencies: RecordingWorkflowDependencies) => Promise<RecordingWorkflowResult>;

export async function runScenarioTree(audio: Blob, scenario: Scenario, dependencies: RecordingWorkflowDependencies,
  prepareRecording: Prepare): Promise<RecordingWorkflowResult> {
  const { signal } = dependencies;
  const steps = [...walkScenarioSteps(scenario.steps)];
  const states = new Map<string, HistoryStep>(steps.map(step => [step.id, {
    id: step.id, type: step.type, title: getScenarioStepContract(step.type).title,
    status: !step.enabled ? 'skipped' : isTriggerStep(step) ? 'success' : 'pending',
    ...((step.type === 'claudeCode' || step.type === 'selectedText') && dependencies.initialText !== undefined ? { text: dependencies.initialText } : {}),
  }]));
  const mainTranscribe = scenario.steps.find(step => step.type === 'transcribe');
  const snapshot = () => steps.map(step => states.get(step.id)!);
  // Branches read the same recording; decode and encode identical cuts once per run.
  let decodedRecording: Promise<AudioBuffer> | undefined;
  const cuts = new WeakMap<AudioBuffer, Map<string, Blob>>();
  const decodeAudio: RecordingWorkflowDependencies['decodeAudio'] = blob => blob === audio
    ? decodedRecording ??= dependencies.decodeAudio(blob)
    : dependencies.decodeAudio(blob);
  const cut: RecordingWorkflowDependencies['cut'] = (buffer, ranges) => {
    let cached = cuts.get(buffer);
    if (!cached) cuts.set(buffer, cached = new Map());
    const key = JSON.stringify(ranges);
    let blob = cached.get(key);
    if (!blob) { blob = dependencies.cut(buffer, ranges); cached.set(key, blob); }
    return blob;
  };
  let entry: HistoryItem | undefined;
  try { entry = await dependencies.history.add({ ...(audio.size ? { audioBlob: audio } : {}), ...(dependencies.initialText !== undefined ? { text: dependencies.initialText } : {}), scenarioName: scenario.name, steps: snapshot(), status: 'recorded' }, dependencies.getSettings().historyMaxItems); }
  catch (error) { console.warn('Не удалось сохранить историю:', error); }
  let writes = Promise.resolve();
  const save = (updates: Partial<HistoryItem> = {}) => {
    if (!entry) return;
    const data = { ...updates, steps: snapshot() };
    writes = writes.then(async () => { await dependencies.history.update(entry!.id, data).catch(console.warn); });
  };
  const visible = new Map<string, OverlayStepStatus>();
  const errors: string[] = [];
  let mainText = '';
  const publish = () => dependencies.onSteps?.([...visible.values()]);
  const mark = (step: ScenarioStep, status: 'running' | 'success' | 'error', text?: string, error?: string,
    updates: Partial<HistoryItem> = {}) => {
    const state = { ...states.get(step.id)!, status, errorMessage: error };
    if (text !== undefined) state.text = text;
    states.set(step.id, state);
    dependencies.onStepStatus?.({ id: step.id, type: step.type, status });
    // Speech keeps the text it reads (its result is audio). Speech and actions offer their text;
    // the overlay shows it by the step's current flag (applyOverlayTextFlags).
    const category = getScenarioStepContract(step.type).category;
    const shown = step.type === 'speak' || category === 'action' || category === 'transformation';
    visible.set(step.id, { id: step.id, title: state.title, status, error,
      body: shown ? text ?? (step.type === 'speak' ? visible.get(step.id)?.body : undefined) : undefined });
    publish(); save(updates);
  };
  const abort = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };

  const transcribeRecording = async (step: ScenarioStep, input: Extract<Data, { type: 'audio' }>) => {
    const primary = step.id === mainTranscribe?.id;
    const fragments = primary ? dependencies.fragments : dependencies.fragments.map(fragment => ({
      ...fragment, removedRanges: fragment.removedRanges.map(range => ({ ...range })), transcript: null,
    }));
    let offset = dependencies.getFragmentOffset();
    const source = scenario.steps[0];
    const preparation: Scenario = { ...scenario, steps: [{ ...source }, { ...step, parallelBranches: undefined }] };
    const result = await prepareRecording(input.audio, {
      ...dependencies,
      skipActions: undefined,
      decodeAudio, cut,
      transcription: dependencies.transcriptionForStep?.(step) ?? dependencies.transcription,
      getSettings: () => ({ ...dependencies.getSettings(), scenarios: [preparation], activeScenarioId: preparation.id,
        provider: step.transcription?.provider ?? dependencies.getSettings().provider,
        googleCloud: step.transcription?.googleCloud ?? dependencies.getSettings().googleCloud,
        geminiTranscription: step.transcription?.geminiTranscription ?? dependencies.getSettings().geminiTranscription,
        groqApiKey: step.transcription?.apiKey ?? dependencies.getSettings().groqApiKey,
      }),
      fragments,
      liveTranscript: primary ? dependencies.liveTranscript : dependencies.liveTranscriptForStep?.(step),
      getFragmentOffset: () => offset,
      setFragmentOffset: value => { offset = value; if (primary) dependencies.setFragmentOffset(value); },
      snapshotFragments: () => fragments.map(fragment => ({
        start: fragment.start, end: fragment.end, text: fragment.transcript?.text ?? '', audioBlob: fragment.audioBlob,
        segments: fragment.transcript?.segments ?? [], removedRanges: fragment.removedRanges,
      })),
      onStage: () => {}, onSteps: () => {}, onStepStatus: () => {},
      onText: text => { if (primary) dependencies.onText(text); },
      history: {
        add: async () => entry ?? { id: 'unsaved', timestamp: Date.now() },
        list: limit => dependencies.history.list(limit),
        update: async (_id, updates) => {
          if (primary) {
            const { steps: _steps, status: _status, errorMessage: _message, errorStep: _error, ...data } = updates;
            // The tree owns step statuses; preparation-only status writes carry no new data.
            if (Object.keys(data).length) save(data);
          }
          return null;
        },
      },
    });
    abort();
    if (result.status === 'error') throw new Error(result.message);
    if (result.status !== 'success') throw new DOMException('Aborted', 'AbortError');
    return result.text;
  };

  const execute = async (step: ScenarioStep, input: Data, primary: boolean): Promise<Data | null> => {
    abort();
    if (!step.enabled) return input;
    try {
      let output = input;
      if (step.type === 'transcribe') {
        if (input.type !== 'audio') throw new Error('Транскрибации требуется аудио.');
        const text = input.recording ? await transcribeRecording(step, input)
          : (await (dependencies.transcriptionForStep?.(step) ?? dependencies.transcription).transcribe(input.audio, signal)).text;
        output = { type: 'text', text };
      } else if (step.type === 'postprocess') {
        if (input.type !== 'text') throw new Error('Постобработке требуется текст.');
        output = { type: 'text', text: await (dependencies.postProcessorForStep?.(step) ?? dependencies.postProcessor).process(input.text, signal) };
      } else if (step.type === 'speak') {
        if (input.type !== 'text') throw new Error('Озвучке требуется текст.');
        const speech = dependencies.speechForStep?.(step) ?? dependencies.speech;
        if (!speech) throw new Error('Провайдер озвучки недоступен.');
        const { speak } = speech;
        const run = <T>(operation: () => Promise<T>) => dependencies.runAction ? dependencies.runAction(step, operation) : operation();
        // The speech is kept with its text and, when the provider sent them, the marks of its words.
        const keepAudio = (audio: Blob, speechMarks: readonly SpeechMark[] = []) => {
          states.set(step.id, { ...states.get(step.id)!, audioBlob: audio, text: input.text, ...(speechMarks.length ? { speechMarks: [...speechMarks] } : {}) });
          save();
        };
        const audio = speak ? await run(() => speak(input.text, signal, audio => keepAudio(audio, getSpeechMarks()))) : await speech.synthesize(input.text, signal, step.speechSettings);
        abort(); if (!speak) keepAudio(audio);
        if (!speak) await run(() => speech.play(audio, signal, step.speechSettings));
        output = { type: 'audio', audio, recording: false };
      } else if (step.type === 'copy' || step.type === 'paste') {
        if (input.type !== 'text') throw new Error('Действию требуется текст.');
        const action = () => step.type === 'copy'
          ? dependencies.output.copy(input.text, normalizeClipboardHistoryLevel(step.clipboardHistoryLevel))
          : dependencies.output.paste(input.text, step.returnFocusToOriginalWindow === true);
        await (dependencies.runAction ? dependencies.runAction(step, action) : action());
        if (step.type === 'paste' && !signal?.aborted) dependencies.onInsertSound?.();
      }
      abort();
      const text = output.type === 'text' ? output.text : undefined;
      mark(step, 'success', text, undefined, primary && text !== undefined ? { text } : undefined);
      if (primary && text !== undefined) { mainText = text; dependencies.onText(text); }
      return output;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = errorMessage(error);
      dependencies.skipActions?.([step.id]);
      mark(step, 'error', undefined, message);
      errors.push(`${getScenarioStepContract(step.type).title}: ${message}`);
      return getScenarioStepContract(step.type).category === 'action' ? input : null;
    }
  };

  const start = (step: ScenarioStep | undefined, input: Data) => {
    if (step?.enabled) mark(step, 'running', input.type === 'text' ? input.text : undefined);
  };
  const runGroup = async (items: ScenarioStep[], begin: number, end: number, input: Data, primary: boolean): Promise<Data | null> => {
    if (end - begin > 1) {
      const pending: Promise<Data | null>[] = [];
      for (let index = begin; index < end; index++) pending.push(execute(items[index], input, primary));
      await Promise.all(pending);
      abort();
      for (let index = begin; index < end; index++) {
        if (states.get(items[index].id)!.status !== 'error') visible.delete(items[index].id);
      }
      return input;
    }
    const step = items[begin];
    const output = await execute(step, input, primary);
    if (output && states.get(step.id)!.status !== 'error' && end < items.length) visible.delete(step.id);
    return output;
  };
  const lane = async (items: ScenarioStep[], input: Data, primary: boolean, started = false, begin = 0): Promise<Data | null> => {
    // Sequential steps need no copied tails or nested promise trees.
    for (let cursor = begin; cursor < items.length;) {
      abort();
      const step = items[cursor];
      if (isTriggerStep(step)) { cursor++; started = false; continue; }
      if (!started) start(step, input);
      started = false;
      let end = cursor + 1;
      if (step.parallelGroup && getScenarioStepContract(step.type).category === 'action') {
        while (end < items.length && items[end].parallelGroup === step.parallelGroup
          && getScenarioStepContract(items[end].type).category === 'action') end++;
      }
      const branches: ScenarioStep[][] = [];
      // Publish every head before invoking any group or transformation work.
      for (let index = cursor; index < end; index++) {
        if (index > cursor) start(items[index], input);
        if (items[index].parallelBranches) branches.push(...items[index].parallelBranches!);
      }
      for (const branch of branches) start(branch[0], input);
      if (branches.length) {
        const own = async () => {
          const output = await runGroup(items, cursor, end, input, primary);
          if (output) return lane(items, output, primary, false, end);
          dependencies.skipActions?.([...walkScenarioSteps(items.slice(end))].map(item => item.id));
          return null;
        };
        const results = await Promise.allSettled([own(), ...branches.map(branch => lane(branch, input, false, true))]);
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        return results[0].status === 'fulfilled' ? results[0].value : null;
      }
      const output = await runGroup(items, cursor, end, input, primary);
      if (!output) {
        dependencies.skipActions?.([...walkScenarioSteps(items.slice(end))].map(item => item.id));
        return null;
      }
      input = output;
      cursor = end;
    }
    abort();
    return input;
  };

  dependencies.onStage('Выполнение сценария…');
  let result: Data | null = null;
  try { result = await lane(scenario.steps, dependencies.initialText === undefined ? { type: 'audio', audio, recording: true } : { type: 'text', text: dependencies.initialText }, true); }
  catch (error) {
    if (!signal?.aborted) errors.push(errorMessage(error));
  }
  await writes;
  if (signal?.aborted) {
    // A step that was still running is not "running" forever in the history.
    for (const [id, state] of states) if (state.status === 'running') states.set(id, { ...state, status: 'cancelled' });
    save(); await writes;
    return { status: 'cancelled' };
  }
  if (errors.length) {
    save({ status: 'error', errorMessage: errors.join('; ') }); await writes;
    return { status: 'error', message: errors.join('; ') };
  }
  save({ status: 'success' }); await writes;
  return { status: 'success', text: result?.type === 'text' ? result.text : mainText };
}
