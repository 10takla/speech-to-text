import { expect, it, vi } from 'vitest';
import { defaultSettings, normalizeSettings } from './config';
import { createDefaultScenario, createStep, validateScenario, appendScenarioCopy } from './scenario';
import { walkScenarioSteps } from './scenario-tree';
import { runRecordingWorkflow, getScenarioReadinessError, type RecordingWorkflowDependencies } from './recording-workflow';
import type { HistoryItem } from './history-db';
import { normalizeSpeechProviders } from './speech-provider-settings';

function fixture() {
  const scenario = createDefaultScenario();
  const main = scenario.steps[1]; main.transcription!.apiKey = 'test'; main.transcription!.model = 'main';
  const other = createStep('transcribe'); other.transcription!.apiKey = 'test'; other.transcription!.model = 'other';
  main.parallelBranches = [[other, createStep('paste')]];
  scenario.steps = [scenario.steps[0], main, createStep('copy')];
  const settings = { ...defaultSettings(), groqApiKey: 'test', scenarios: [scenario], activeScenarioId: scenario.id };
  let history: HistoryItem = { id: 'history', timestamp: 1 };
  const calls: string[] = [];
  const dependencies: RecordingWorkflowDependencies = {
    getSettings: () => settings,
    history: {
      add: async data => { history = { ...history, ...structuredClone(data) }; return history; },
      update: async (_id, data) => { history = { ...history, ...structuredClone(data) }; return history; },
      list: async () => [history],
    },
    transcription: { transcribe: vi.fn(async () => ({ text: 'Fallback', segments: [] })) },
    postProcessor: { process: vi.fn(async text => text) },
    output: { copy: vi.fn(async text => { calls.push(`copy:${text}`); }), paste: vi.fn(async text => { calls.push(`paste:${text}`); }) },
    fragments: [], getFragmentOffset: () => 0, setFragmentOffset: () => {}, snapshotFragments: () => [],
    decodeAudio: async () => ({ duration: 1 } as AudioBuffer), cut: () => new Blob(['chunk']),
    onStage: vi.fn(), onText: vi.fn(), onSteps: vi.fn(), onStepStatus: vi.fn(),
  };
  return { scenario, main, other, settings, dependencies, calls, history: () => history };
}
const audio = () => new Blob([new Uint8Array(1000)]);

it('applies full final recognition independently to recording branches', async () => {
  const f = fixture();
  f.main.transcription!.retranscribeFullRecording = true;
  f.dependencies.liveTranscript = { segments: [{ start: 0, end: 1, text: 'Основной live' }], throughSeconds: 1 };
  f.dependencies.liveTranscriptForStep = () => ({ segments: [{ start: 0, end: 1, text: 'Ветка live' }], throughSeconds: 1 });
  const inputs: Blob[] = [];
  f.dependencies.transcriptionForStep = () => ({ transcribe: async blob => {
    inputs.push(blob); return { text: 'Полный итог', segments: [] };
  } });
  const original = audio();
  expect((await runRecordingWorkflow(original, f.dependencies)).status).toBe('success');
  expect(inputs).toEqual([original]);
  expect(f.calls).toEqual(['copy:Полный итог', 'paste:Ветка live']);
});

it.each([false, true])('passes a branch paste focus preference to the native output: %s', async returnFocus => {
  const f = fixture();
  const paste = f.main.parallelBranches![0].find(step => step.type === 'paste')!;
  paste.returnFocusToOriginalWindow = returnFocus;
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('success');
  expect(f.dependencies.output.paste).toHaveBeenCalledWith('Fallback', returnFocus);
});

it('decodes and cuts shared recording audio once per run, keeping every branch transcription independent', async () => {
  const f = fixture();
  const third = createStep('transcribe'); third.transcription!.apiKey = 'test';
  f.other.parallelBranches = [[third, createStep('copy')]];
  const decodeAudio = vi.fn(f.dependencies.decodeAudio);
  const cut = vi.fn(f.dependencies.cut);
  const transcribe = vi.fn(async () => ({ text: 'Текст', segments: [{ start: 0, end: 1, text: 'Текст' }] }));
  f.dependencies.decodeAudio = decodeAudio;
  f.dependencies.cut = cut;
  f.dependencies.transcriptionForStep = () => ({ transcribe });
  const recording = audio();
  for (let run = 1; run <= 2; run++) {
    f.dependencies.fragments = [];
    expect((await runRecordingWorkflow(recording, f.dependencies)).status).toBe('success');
    expect(decodeAudio).toHaveBeenCalledTimes(run);
    expect(cut).toHaveBeenCalledTimes(run);
    expect(transcribe).toHaveBeenCalledTimes(run * 3);
  }
});

it('keeps different branch audio cuts distinct when live transcript coverage differs', async () => {
  const f = fixture();
  f.dependencies.decodeAudio = vi.fn(async () => ({ duration: 2 } as AudioBuffer));
  f.dependencies.cut = vi.fn((_buffer, ranges) => new Blob([JSON.stringify(ranges)]));
  f.dependencies.liveTranscript = { segments: [{ start: 0, end: 1, text: 'Live' }], throughSeconds: 1 };
  const inputs = new Map<string, string>();
  f.dependencies.transcriptionForStep = step => ({ transcribe: async blob => {
    inputs.set(step.id, await blob.text());
    return { text: 'Текст', segments: [{ start: 0, end: 1, text: 'Текст' }] };
  } });
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('success');
  expect(f.dependencies.decodeAudio).toHaveBeenCalledTimes(1);
  expect(inputs.get(f.main.id)).toBe(JSON.stringify([{ start: 1, end: 2 }]));
  expect(inputs.get(f.other.id)).toBe(JSON.stringify([{ start: 0, end: 2 }]));
});

it('keeps queued tree snapshots immutable while storage is blocked', async () => {
  const f = fixture();
  const saved: Partial<HistoryItem>[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.dependencies.history.update = async (_id, data) => { await blocked; saved.push(data); return null; };
  let complete = false;
  const running = runRecordingWorkflow(audio(), f.dependencies).then(result => { complete = true; return result; });
  try {
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(complete).toBe(false);
    expect(saved).toEqual([]);
  } finally { release(); }
  expect((await running).status).toBe('success');
  expect(saved[0].steps?.find(step => step.id === f.main.id)?.status).toBe('running');
  expect(saved[0].steps?.find(step => step.id === f.other.id)?.status).toBe('pending');
  expect(saved.at(-1)?.steps?.every(step => step.status === 'success')).toBe(true);
});

it.each([false, true])('retains synthesized speech when playback fails (tree: %s)', async tree => {
  const f = fixture(); delete f.main.parallelBranches;
  const speech = createStep('speak');
  if (tree) speech.parallelBranches = [[createStep('copy')]];
  f.scenario.steps = [f.scenario.steps[0], f.main, speech];
  f.dependencies.speech = {
    synthesize: async () => new Blob(['saved speech'], { type: 'audio/wav' }),
    play: async () => { throw new Error('Ошибка воспроизведения'); },
  };
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('error');
  const saved = f.history().steps?.find(step => step.id === speech.id);
  expect(saved?.status).toBe('error');
  expect(await saved?.audioBlob?.text()).toBe('saved speech');
});

it('selects speech providers independently for parallel branches and saves both audio results', async () => {
  const f = fixture(); delete f.main.parallelBranches;
  const first = createStep('speak'), other = createStep('speak');
  first.speechProvider = 'gemini'; first.speechProviders = normalizeSpeechProviders();
  first.speechProviders.gemini = { apiKey: 'test', model: 'gemini-flash-tts', voice: 'Kore', style: '', volume: 1 };
  other.speechProvider = 'piper'; other.speechProviders = normalizeSpeechProviders(); other.speechProviders.piper.voice = 'ru-test';
  first.parallelBranches = [[other]];
  f.scenario.steps = [f.scenario.steps[0], f.main, first];
  const calls: string[] = [];
  f.dependencies.speechForStep = step => ({
    synthesize: async text => { calls.push(`${step.speechProvider}:${text}`); return new Blob([step.id]); },
    play: async () => {},
  });
  f.dependencies.speech = { synthesize: vi.fn(), play: vi.fn() };
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('success');
  expect(calls).toEqual(['gemini:Fallback', 'piper:Fallback']);
  expect(f.dependencies.speech.synthesize).not.toHaveBeenCalled();
  expect(f.history().steps?.filter(step => step.type === 'speak').every(step => step.status === 'success' && step.audioBlob instanceof Blob)).toBe(true);
});

it('starts both transcriptions before either resolves and continues each with its own output', async () => {
  const f = fixture();
  const started: string[] = [];
  const finish = new Map<string, (text: string) => void>();
  f.dependencies.transcriptionForStep = step => ({ transcribe: () => {
    const model = step.transcription!.model; started.push(model);
    return new Promise(resolve => finish.set(model, text => resolve({ text, segments: [{ start: 0, end: 1, text }] })));
  } });
  let complete = false;
  const running = runRecordingWorkflow(audio(), f.dependencies).then(result => { complete = true; return result; });
  await vi.waitFor(() => expect(started).toEqual(['main', 'other']));
  finish.get('main')!('Первый');
  await vi.waitFor(() => expect(f.calls).toContain('copy:Первый'));
  expect(f.calls).not.toContain('paste:Первый'); expect(complete).toBe(false);
  finish.get('other')!('Второй');
  expect(await running).toEqual({ status: 'success', text: 'Первый' });
  expect(f.calls).toEqual(['copy:Первый', 'paste:Второй']);
  expect(f.history().steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: f.main.id, text: 'Первый', status: 'success' }),
    expect.objectContaining({ id: f.other.id, text: 'Второй', status: 'success' }),
  ]));
  expect(f.history().text).toBe('Первый');
});

it('lets an independent branch complete after a transformation fails in its sibling', async () => {
  const f = fixture();
  f.dependencies.transcriptionForStep = step => ({ transcribe: async () => {
    if (step.id === f.main.id) throw new Error('Ошибка первой модели');
    return { text: 'Второй', segments: [{ start: 0, end: 1, text: 'Второй' }] };
  } });
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('error');
  expect(f.calls).toEqual(['paste:Второй']);
  expect(f.history().steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: f.main.id, status: 'error' }), expect.objectContaining({ id: f.other.id, status: 'success' }),
  ]));
});

it('preserves nested branches through normalization and gives copies unique step IDs', () => {
  const f = fixture();
  const post = createStep('postprocess'); post.postprocessing!.prompt = 'Ответь';
  f.other.parallelBranches = [[createStep('transcribe'), post]];
  expect(validateScenario(f.scenario)).toBeNull();
  const normalized = normalizeSettings(f.settings).scenarios.find(item => item.id === f.scenario.id)!;
  expect(normalized.steps[1].parallelBranches![0][0].parallelBranches![0][1].postprocessing!.prompt).toBe('Ответь');
  const copy = appendScenarioCopy([], normalized);
  const originalIds = new Set([...walkScenarioSteps(normalized.steps)].map(step => step.id));
  expect([...walkScenarioSteps(copy.steps)].every(step => !originalIds.has(step.id))).toBe(true);
  expect(new Set([...walkScenarioSteps(copy.steps)].map(step => step.id)).size).toBe([...walkScenarioSteps(copy.steps)].length);
});

it('checks provider readiness and input types in every branch', () => {
  const f = fixture();
  f.other.transcription!.apiKey = '';
  expect(getScenarioReadinessError(f.settings)).toContain('API ключ');
  f.main.parallelBranches = [[createStep('postprocess')]];
  expect(validateScenario(f.scenario)).toContain('принимает тип');
});

it('cancels all branches without starting their output actions', async () => {
  const f = fixture();
  const abort = new AbortController(); f.dependencies.signal = abort.signal;
  let started = 0;
  f.dependencies.transcriptionForStep = () => ({ transcribe: async (_audio, signal) => {
    started++;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const running = runRecordingWorkflow(audio(), f.dependencies);
  await vi.waitFor(() => expect(started).toBe(2)); abort.abort();
  expect(await running).toEqual({ status: 'cancelled' }); expect(f.calls).toEqual([]);
});

it('uses each live transcript only for its corresponding recording branch', async () => {
  const f = fixture();
  f.dependencies.liveTranscript = { segments: [{ start: 0, end: 1, text: 'Первый live' }], throughSeconds: 1 };
  f.dependencies.liveTranscriptForStep = step => step.id === f.other.id
    ? { segments: [{ start: 0, end: 1, text: 'Второй live' }], throughSeconds: 1 } : undefined;
  expect((await runRecordingWorkflow(audio(), f.dependencies)).status).toBe('success');
  expect(f.calls).toEqual(['copy:Первый live', 'paste:Второй live']);
  expect(f.dependencies.transcription.transcribe).not.toHaveBeenCalled();
});

it('runs text transformations on the same input with independent settings and returns the spoken main answer', async () => {
  const f = fixture();
  delete f.main.parallelBranches;
  const mainPost = createStep('postprocess');
  mainPost.postprocessing!.apiKey = 'key'; mainPost.postprocessing!.prompt = 'Первый промпт';
  const otherPost = createStep('postprocess');
  otherPost.postprocessing!.apiKey = 'key'; otherPost.postprocessing!.prompt = 'Второй промпт';
  mainPost.parallelBranches = [[otherPost, createStep('copy')]];
  f.scenario.steps = [f.scenario.steps[0], f.main, mainPost, createStep('speak')];
  f.dependencies.transcriptionForStep = () => ({ transcribe: async () => ({ text: 'Вопрос', segments: [{ start: 0, end: 1, text: 'Вопрос' }] }) });
  const calls: string[] = [];
  const finish = new Map<string, (text: string) => void>();
  f.dependencies.postProcessorForStep = step => ({ process: text => {
    calls.push(`${step.postprocessing!.prompt}:${text}`);
    return new Promise(resolve => finish.set(step.id, resolve));
  } });
  const synthesize = vi.fn(async () => new Blob(['answer']));
  f.dependencies.speech = { synthesize, play: vi.fn(async () => {}) };
  const running = runRecordingWorkflow(audio(), f.dependencies);
  await vi.waitFor(() => expect(calls).toEqual(['Первый промпт:Вопрос', 'Второй промпт:Вопрос']));
  finish.get(otherPost.id)!('Второй ответ');
  await vi.waitFor(() => expect(f.calls).toContain('copy:Второй ответ'));
  expect(synthesize).not.toHaveBeenCalled();
  finish.get(mainPost.id)!('Первый ответ');
  expect(await running).toEqual({ status: 'success', text: 'Первый ответ' });
  expect(synthesize).toHaveBeenCalledWith('Первый ответ', undefined, expect.anything());
});

it('keeps pass-through groups parallel inside a branch and waits for the whole group before continuing', async () => {
  const f = fixture();
  const copy = { ...createStep('copy'), parallelGroup: 'side-actions' };
  const paste = { ...createStep('paste'), parallelGroup: 'side-actions' };
  const post = createStep('postprocess'); post.postprocessing!.apiKey = 'key'; post.postprocessing!.prompt = 'Обработай';
  f.main.parallelBranches = [[f.other, copy, paste, post]];
  f.dependencies.transcriptionForStep = step => ({ transcribe: async () => ({
    text: step.id === f.main.id ? 'Первый' : 'Второй', segments: [{ start: 0, end: 1, text: step.id === f.main.id ? 'Первый' : 'Второй' }],
  }) });
  let finishCopy!: () => void; let finishPaste!: () => void;
  f.dependencies.output.copy = vi.fn(async text => {
    f.calls.push(`copy:${text}`);
    if (text === 'Второй') await new Promise<void>(resolve => { finishCopy = resolve; });
  });
  f.dependencies.output.paste = vi.fn(async text => {
    f.calls.push(`paste:${text}`); await new Promise<void>(resolve => { finishPaste = resolve; });
  });
  const process = vi.fn(async text => text);
  f.dependencies.postProcessorForStep = () => ({ process });
  const running = runRecordingWorkflow(audio(), f.dependencies);
  await vi.waitFor(() => expect(f.calls).toEqual(expect.arrayContaining(['copy:Первый', 'copy:Второй', 'paste:Второй'])));
  expect(process).not.toHaveBeenCalled(); finishCopy();
  await Promise.resolve(); expect(process).not.toHaveBeenCalled(); finishPaste();
  expect((await running).status).toBe('success');
  expect(process).toHaveBeenCalledWith('Второй', undefined);
});

it('runs a transformation beside a pass-through group on the original input without waiting for either side', async () => {
  const f = fixture();
  delete f.main.parallelBranches;
  const copy = { ...createStep('copy'), parallelGroup: 'delivery' };
  const paste = { ...createStep('paste'), parallelGroup: 'delivery' };
  const post = createStep('postprocess'); post.postprocessing!.apiKey = 'key'; post.postprocessing!.prompt = 'Ответь';
  copy.parallelBranches = [[post, createStep('paste')]];
  f.scenario.steps = [f.scenario.steps[0], f.main, copy, paste];
  expect(validateScenario(f.scenario)).toBeNull();
  const restored = normalizeSettings(f.settings).scenarios.find(item => item.id === f.scenario.id)!;
  expect(restored.steps[2].parallelBranches![0][0].id).toBe(post.id);
  let finishCopy!: () => void; let finishPost!: (text: string) => void;
  f.dependencies.transcriptionForStep = () => ({ transcribe: async () => ({ text: 'Вопрос', segments: [{ start: 0, end: 1, text: 'Вопрос' }] }) });
  f.dependencies.output.copy = vi.fn(async text => {
    f.calls.push(`copy:${text}`); await new Promise<void>(resolve => { finishCopy = resolve; });
  });
  const process = vi.fn((_text: string) => new Promise<string>(resolve => { finishPost = resolve; }));
  f.dependencies.postProcessorForStep = () => ({ process });
  let complete = false;
  const running = runRecordingWorkflow(audio(), f.dependencies).then(result => { complete = true; return result; });
  await vi.waitFor(() => {
    expect(f.calls).toEqual(['copy:Вопрос', 'paste:Вопрос']);
    expect(process).toHaveBeenCalledWith('Вопрос', undefined);
  });
  finishPost('Ответ');
  await vi.waitFor(() => expect(f.calls).toContain('paste:Ответ'));
  expect(complete).toBe(false);
  finishCopy();
  expect(await running).toEqual({ status: 'success', text: 'Вопрос' });
});
