import { describe, expect, it, vi } from 'vitest';
import type { HistoryRepository, TextOutputPort, TextPostProcessor, TranscriptionProvider } from './ports';
import { getScenarioReadinessError, runRecordingWorkflow } from './recording-workflow';
import { applyOverlayTextFlags, type OverlayStepStatus } from './OverlaySteps';
import { canDisableScenarioStep, createStep, createVoiceAnswerScenario, createClaudeCodeScenario, createSelectedTextSpeechScenario, normalizeScenario, validateScenario, type ScenarioStepType } from './scenario';

function configuredStep(type: ScenarioStepType) {
  const step = createStep(type);
  if (step.postprocessing) step.postprocessing.prompt = 'Обработай текст';
  return step;
}

function createDependencies(overrides: Partial<Parameters<typeof runRecordingWorkflow>[1]> = {}) {
  const updates: unknown[] = [];
  const history: HistoryRepository = {
    add: async () => ({ id: 'entry-1', timestamp: 1 }),
    update: async (_id, value) => { updates.push(value); return null; },
    list: async () => [],
  };
  const transcription: TranscriptionProvider = {
    transcribe: async () => ({
      text: 'Распознанный текст',
      segments: [{ start: 0, end: 1, text: 'Распознанный текст' }],
    }),
  };
  const postProcessor: TextPostProcessor = { process: async text => text };
  const output: TextOutputPort = { copy: vi.fn(async () => {}), paste: vi.fn(async () => {}) };
  const dependencies: Parameters<typeof runRecordingWorkflow>[1] = {
    history,
    transcription,
    postProcessor,
    output,
    getSettings: () => ({
      historyMaxItems: 10,
      provider: 'groq',
      groqApiKey: 'gsk_test_key',
      postProcessEnabled: false,
      postProcessProvider: 'gemini',
      geminiApiKey: 'AIzaSy_test_key',
      geminiPrompt: 'Обработай текст',
      autoPasteActiveWindow: true,
    }),
    fragments: [],
    getFragmentOffset: () => 0,
    setFragmentOffset: vi.fn(),
    snapshotFragments: () => [],
    decodeAudio: async () => ({ duration: 1 } as AudioBuffer),
    cut: () => new Blob(['wav'], { type: 'audio/wav' }),
    onStage: vi.fn(),
    onText: vi.fn(),
  };
  return { dependencies: { ...dependencies, ...overrides }, updates, output };
}

describe('recording workflow', () => {
  it('delivers Claude text to both output steps without audio decoding or API transcription', async () => {
    const scenario = createClaudeCodeScenario();
    const decodeAudio = vi.fn(), transcribe = vi.fn();
    const { dependencies, output } = createDependencies({ initialText: 'Текст Claude', decodeAudio,
      transcription: { transcribe }, getSettings: () => ({ historyMaxItems: 10, provider: 'none', groqApiKey: '',
        postProcessProvider: 'none', geminiApiKey: '', scenarios: [scenario], activeScenarioId: scenario.id }) });
    expect(await runRecordingWorkflow(new Blob(), dependencies)).toEqual({ status: 'success', text: 'Текст Claude' });
    expect(output.copy).toHaveBeenCalledWith('Текст Claude', -1);
    expect(output.paste).toHaveBeenCalledWith('Текст Claude', false);
    expect(decodeAudio).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('keeps the parallel Claude recording and its text in history', async () => {
    const scenario = createClaudeCodeScenario();
    const audio = new Blob([new Uint8Array(2000)], { type: 'audio/wav' });
    const { dependencies } = createDependencies({ initialText: 'Текст Claude',
      getSettings: () => ({ historyMaxItems: 10, provider: 'none', groqApiKey: '',
        postProcessProvider: 'none', geminiApiKey: '', scenarios: [scenario], activeScenarioId: scenario.id }) });
    const add = vi.spyOn(dependencies.history, 'add');
    expect(await runRecordingWorkflow(audio, dependencies)).toEqual({ status: 'success', text: 'Текст Claude' });
    const [entry] = add.mock.calls[0];
    expect(entry.audioBlob).toBe(audio);
    expect(entry.text).toBe('Текст Claude');
    expect(entry.steps?.find(step => step.type === 'claudeCode')?.text).toBe('Текст Claude');
  });
  function fullRecordingSettings() {
    const scenario = { id: 'full', name: 'Full', steps: [createStep('startRecording'), createStep('transcribe'), createStep('paste')] };
    scenario.steps[1].transcription!.retranscribeFullRecording = true;
    return { historyMaxItems: 10, provider: 'groq' as const, groqApiKey: 'test',
      postProcessProvider: 'gemini' as const, geminiApiKey: 'test', scenarios: [scenario], activeScenarioId: scenario.id };
  }

  it('sends the original full audio once and replaces live text without concatenation', async () => {
    const original = new Blob([new Uint8Array(2000)]);
    const transcribe = vi.fn(async () => ({ text: 'Итоговый текст.', segments: [{ start: 0, end: 10, text: 'Итоговый текст.' }] }));
    const { dependencies, output } = createDependencies({
      getSettings: fullRecordingSettings, transcription: { transcribe },
      decodeAudio: async () => ({ duration: 10 } as AudioBuffer),
      liveTranscript: { throughSeconds: 10, segments: [{ start: 0, end: 10, text: 'Предварительный текст' }] },
    });
    expect(await runRecordingWorkflow(original, dependencies)).toEqual({ status: 'success', text: 'Итоговый текст.' });
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(original, undefined);
    expect(output.paste).toHaveBeenCalledWith('Итоговый текст.', false);
    expect(dependencies.fragments).toHaveLength(1);
    expect(dependencies.fragments[0].audioBlob).toBe(original);
  });

  it('keeps editor exclusions at their absolute times after full recognition', async () => {
    const original = new Blob([new Uint8Array(2000)]);
    const transcribe = vi.fn(async () => ({ text: 'Начало удалить конец', segments: [
      { start: 0, end: 2, text: 'Начало' }, { start: 2, end: 3, text: 'удалить' }, { start: 3, end: 4, text: 'конец' },
    ] }));
    const { dependencies } = createDependencies({ getSettings: fullRecordingSettings, transcription: { transcribe },
      fragments: [{ audioBlob: new Blob(['part']), start: 2, end: 4,
        transcript: { text: 'Старое', segments: [] }, removedRanges: [{ start: 0, end: 1 }] }],
      getFragmentOffset: () => 4, decodeAudio: async () => ({ duration: 4 } as AudioBuffer),
    });
    expect(await runRecordingWorkflow(original, dependencies)).toEqual({ status: 'success', text: 'Начало конец' });
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(original, undefined);
    expect(dependencies.fragments[0].removedRanges).toEqual([{ start: 2, end: 3 }]);
  });

  it('reports full recognition errors without substituting live text', async () => {
    const { dependencies, output } = createDependencies({ getSettings: fullRecordingSettings,
      transcription: { transcribe: async () => { throw new Error('API failed'); } },
      liveTranscript: { throughSeconds: 1, segments: [{ start: 0, end: 1, text: 'Предварительный текст' }] },
    });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).toEqual({ status: 'error', message: 'API failed' });
    expect(output.paste).not.toHaveBeenCalled();
  });

  it('discards a full recognition response after cancellation', async () => {
    const controller = new AbortController();
    const { dependencies, output } = createDependencies({ getSettings: fullRecordingSettings, signal: controller.signal,
      transcription: { transcribe: async () => { controller.abort(); return { text: 'Поздний ответ', segments: [] }; } },
    });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).toEqual({ status: 'cancelled' });
    expect(output.paste).not.toHaveBeenCalled();
  });

  it.each([false, true])('passes the focus preference to sequential and grouped paste steps: %s', async returnFocus => {
    const first = { ...createStep('paste'), returnFocusToOriginalWindow: returnFocus };
    const second = { ...createStep('paste'), parallelGroup: 'outputs', returnFocusToOriginalWindow: !returnFocus };
    const scenario = { id: 'focus', name: 'Focus', steps: [createStep('startRecording'), createStep('transcribe'),
      first, { ...createStep('copy'), parallelGroup: 'outputs' }, second] };
    const { dependencies, output } = createDependencies();
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    expect((await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).status).toBe('success');
    expect(output.paste).toHaveBeenNthCalledWith(1, 'Распознанный текст', returnFocus);
    expect(output.paste).toHaveBeenNthCalledWith(2, 'Распознанный текст', !returnFocus);
  });

  it('runs transcription, transformations, playback and delivery while result storage is blocked', async () => {
    const scenario = {
      id: 'blocked-results', name: 'Blocked results',
      steps: ['startRecording', 'transcribe', 'postprocess', 'speak', 'transcribe', 'paste']
        .map(type => configuredStep(type as ScenarioStepType)),
    };
    const synthesized = new Blob(['speech']);
    const speech = { synthesize: vi.fn(async () => synthesized), play: vi.fn(async () => {}) };
    const transcribe = vi.fn(async () => ({ text: 'Текст', segments: [{ start: 0, end: 1, text: 'Текст' }] }));
    const process = vi.fn(async () => 'Ответ');
    const { dependencies, output, updates } = createDependencies({ speech, transcription: { transcribe }, postProcessor: { process } });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const originalUpdate = dependencies.history.update;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    dependencies.history.update = async (id, value) => { await blocked; return originalUpdate(id, value); };
    let complete = false;
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)
      .then(result => { complete = true; return result; });
    try {
      await vi.waitFor(() => expect(output.paste).toHaveBeenCalledWith('Текст', false));
      expect(transcribe).toHaveBeenCalledTimes(2);
      expect(process).toHaveBeenCalledWith('Текст', undefined);
      expect(speech.play).toHaveBeenCalledWith(synthesized, undefined, expect.anything());
      expect(complete).toBe(false);
      expect(updates).toEqual([]);
    } finally { release(); }
    expect(await running).toEqual({ status: 'success', text: 'Текст' });
    expect(updates[0]).toEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'postprocess', status: 'pending' }),
    ]) }));
    expect(updates).toContainEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'speak', status: 'running', audioBlob: synthesized }),
    ]) }));
    expect(updates.at(-1)).toEqual({ status: 'success' });
  });

  it('does not rewrite previously transcribed fragments individually', async () => {
    const fragments = [0, 1, 2].map(start => ({
      audioBlob: new Blob(['fragment']), start, end: start + 1, removedRanges: [],
      transcript: { text: `${start}`, segments: [{ start: 0, end: 1, text: `${start}` }] },
    }));
    const transcribe = vi.fn();
    const { dependencies, updates } = createDependencies({
      fragments, getFragmentOffset: () => 3, decodeAudio: async () => ({ duration: 3 } as AudioBuffer),
      transcription: { transcribe },
    });
    expect((await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).status).toBe('success');
    expect(transcribe).not.toHaveBeenCalled();
    expect(updates.filter(update => 'fragments' in (update as object))).toHaveLength(2);
  });

  it('continues delivery after result storage fails', async () => {
    const { dependencies, output } = createDependencies();
    dependencies.history.update = vi.fn().mockRejectedValue(new Error('Storage unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies))
        .toEqual({ status: 'success', text: 'Распознанный текст' });
      expect(output.paste).toHaveBeenCalledWith('Распознанный текст', false);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('runs sequential output without waiting for status storage and flushes it before completion', async () => {
    const scenario = {
      id: 'slow-history', name: 'Slow history',
      steps: ['startRecording', 'transcribe', 'copy', 'paste'].map(type => configuredStep(type as ScenarioStepType)),
    };
    const { dependencies, output, updates } = createDependencies();
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const originalUpdate = dependencies.history.update;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    dependencies.history.update = async (id, value) => {
      if (value.steps?.some(step => step.type === 'copy' && step.status === 'running')) await blocked;
      return originalUpdate(id, value);
    };
    let completed = false;
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)
      .then(result => { completed = true; return result; });
    try {
      await vi.waitFor(() => expect(output.paste).toHaveBeenCalledWith('Распознанный текст', false));
      expect(output.copy).toHaveBeenCalledTimes(1);
      expect(completed).toBe(false);
    } finally {
      release();
    }
    expect(await running).toEqual({ status: 'success', text: 'Распознанный текст' });
    expect(updates.at(-1)).toEqual({ status: 'success' });
    expect(updates.at(-2)).toEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'copy', status: 'success' }),
      expect.objectContaining({ type: 'paste', status: 'success' }),
    ]) }));
  });

  it('starts the next transformation while parallel action statuses are being saved', async () => {
    const scenario = {
      id: 'parallel-slow-history', name: 'Parallel slow history',
      steps: ['startRecording', 'transcribe', 'copy', 'paste', 'postprocess'].map(type => configuredStep(type as ScenarioStepType)),
    };
    scenario.steps[2].parallelGroup = scenario.steps[3].parallelGroup = 'outputs';
    const process = vi.fn(async text => `${text}!`);
    const { dependencies, output } = createDependencies({ postProcessor: { process } });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const originalUpdate = dependencies.history.update;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    dependencies.history.update = async (id, value) => {
      if (value.steps?.some(step => step.type === 'copy' && step.status === 'running')) await blocked;
      return originalUpdate(id, value);
    };
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    try {
      await vi.waitFor(() => expect(process).toHaveBeenCalledWith('Распознанный текст', undefined));
      expect(output.copy).toHaveBeenCalledTimes(1);
      expect(output.paste).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect(await running).toEqual({ status: 'success', text: 'Распознанный текст!' });
  });

  it('flushes pending statuses on cancellation without starting the next output', async () => {
    const controller = new AbortController();
    const scenario = {
      id: 'cancel-slow-history', name: 'Cancel slow history',
      steps: ['startRecording', 'transcribe', 'copy', 'paste'].map(type => configuredStep(type as ScenarioStepType)),
    };
    const output = { copy: vi.fn(async () => { controller.abort(); }), paste: vi.fn(async () => {}) };
    const { dependencies, updates } = createDependencies({ output, signal: controller.signal });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const originalUpdate = dependencies.history.update;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    dependencies.history.update = async (id, value) => {
      if (value.steps?.some(step => step.type === 'copy' && step.status === 'running')) await blocked;
      return originalUpdate(id, value);
    };
    let completed = false;
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)
      .then(result => { completed = true; return result; });
    try {
      await vi.waitFor(() => expect(output.copy).toHaveBeenCalledOnce());
      expect(output.paste).not.toHaveBeenCalled();
      expect(completed).toBe(false);
    } finally { release(); }
    expect(await running).toEqual({ status: 'cancelled' });
    expect(updates.at(-1)).toEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'copy', status: 'success' }),
      expect.objectContaining({ type: 'paste', status: 'pending' }),
    ]) }));
  });

  it('rejects an unselected speech provider before any processing starts', async () => {
    const scenario = createVoiceAnswerScenario();
    scenario.steps.find(step => step.type === 'speak')!.speechProvider = 'none';
    const speech = { synthesize: vi.fn(), play: vi.fn() };
    const { dependencies } = createDependencies({ speech });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies))
      .toEqual({ status: 'error', message: 'Провайдер озвучки не выбран.' });
    expect(speech.synthesize).not.toHaveBeenCalled();
  });
  it('shows the spoken text in the overlay only when the speech step asks for it', async () => {
    for (const show of [false, true]) {
      const scenario = createVoiceAnswerScenario();
      scenario.steps.find(step => step.type === 'speak')!.showTextInOverlay = show;
      const onSteps = vi.fn();
      const speech = { synthesize: vi.fn(async () => new Blob(['a'])), play: vi.fn(async () => {}) };
      const { dependencies } = createDependencies({ onSteps, speech, postProcessor: { process: async () => 'Готовый ответ' } });
      const settings = dependencies.getSettings();
      dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
      expect((await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).status).toBe('success');
      const bodies = onSteps.mock.calls.flatMap(([steps]) => applyOverlayTextFlags(steps as OverlayStepStatus[], scenario.steps).map(step => step.body));
      expect(bodies.includes('Готовый ответ')).toBe(show);
    }
  });
  it('shows the selected text being read in the overlay only when the speech step asks for it', async () => {
    for (const show of [true, false]) {
      const scenario = createSelectedTextSpeechScenario();
      scenario.steps.find(step => step.type === 'speak')!.showTextInOverlay = show;
      const onSteps = vi.fn(), onText = vi.fn();
      const speech = { synthesize: vi.fn(async () => new Blob(['a'])), play: vi.fn(async () => {}) };
      const { dependencies } = createDependencies({ initialText: 'Выделенный текст', onSteps, onText, speech });
      const settings = dependencies.getSettings();
      dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
      expect((await runRecordingWorkflow(new Blob(), dependencies)).status).toBe('success');
      const bodies = onSteps.mock.calls.flatMap(([steps]) => applyOverlayTextFlags(steps as OverlayStepStatus[], scenario.steps).map(step => step.body));
      expect(bodies.includes('Выделенный текст')).toBe(show);
      expect(onText).not.toHaveBeenCalledWith('Выделенный текст');
    }
  });
  it('synthesizes the processed answer, saves its audio, and waits for playback to finish', async () => {
    const scenario = createVoiceAnswerScenario();
    const speechSettings = { voiceId: 'voice', language: 'ru-RU', rate: 1.3, pitch: .8, volume: .4 };
    scenario.steps.find(step => step.type === 'speak')!.speechSettings = speechSettings;
    const audio = new Blob(['generated audio'], { type: 'audio/wav' });
    let finish!: () => void;
    const speech = { synthesize: vi.fn(async () => audio), play: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const { dependencies, output, updates } = createDependencies({ speech, postProcessor: { process: async () => 'Готовый ответ' } });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    let completed = false;
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(speech.play).toHaveBeenCalledWith(audio, undefined, speechSettings));
    expect(speech.synthesize).toHaveBeenCalledWith('Готовый ответ', undefined, speechSettings);
    expect(completed).toBe(false);
    expect(output.copy).not.toHaveBeenCalled();
    expect(output.paste).not.toHaveBeenCalled();
    expect(updates).toContainEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'speak', status: 'running', audioBlob: audio }),
    ]) }));
    finish();
    expect(await running).toEqual({ status: 'success', text: 'Готовый ответ' });
    expect(updates).toContainEqual(expect.objectContaining({ steps: expect.arrayContaining([
      expect.objectContaining({ type: 'postprocess', status: 'success', text: 'Готовый ответ' }),
    ]) }));
  });

  it('reports system speech failure without playing audio', async () => {
    const scenario = createVoiceAnswerScenario();
    const speech = { synthesize: vi.fn(async () => { throw new Error('Голос не установлен'); }), play: vi.fn() };
    const { dependencies } = createDependencies({ speech });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).toEqual({ status: 'error', message: 'Озвучка: Голос не установлен' });
    expect(speech.play).not.toHaveBeenCalled();
  });
  it('starts grouped actions together and waits for both before continuing', async () => {
    let finishCopy!: () => void;
    let finishPaste!: () => void;
    const onSteps = vi.fn();
    const { dependencies, output } = createDependencies({ onSteps });
    const copy = { ...createStep('copy'), parallelGroup: 'delivery' };
    const paste = { ...createStep('paste'), parallelGroup: 'delivery' };
    const after = createStep('copy');
    const scenario = { id: 'parallel', name: 'Parallel', steps: [createStep('startRecording'), createStep('transcribe'), copy, paste, after] };
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    output.copy = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishCopy = resolve; }))
      .mockResolvedValue(undefined);
    output.paste = vi.fn(() => new Promise<void>(resolve => { finishPaste = resolve; }));
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    await vi.waitFor(() => expect(output.paste).toHaveBeenCalledTimes(1));
    expect(output.copy).toHaveBeenCalledTimes(1);
    expect(onSteps).toHaveBeenCalledWith([
      expect.objectContaining({ id: copy.id, status: 'running' }), expect.objectContaining({ id: paste.id, status: 'running' }),
    ]);
    finishCopy();
    await vi.waitFor(() => expect(onSteps).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: copy.id, status: 'success' }), expect.objectContaining({ id: paste.id, status: 'running' }),
    ]));
    expect(output.copy).toHaveBeenCalledTimes(1);
    finishPaste();
    expect((await running).status).toBe('success');
    expect(output.copy).toHaveBeenCalledTimes(2);
  });

  it('keeps a parallel sibling running after an action failure', async () => {
    const onSteps = vi.fn();
    const { dependencies, output } = createDependencies({ onSteps });
    const scenario = { id: 'parallel-error', name: 'Parallel', steps: [createStep('startRecording'), createStep('transcribe'),
      { ...createStep('copy'), parallelGroup: 'delivery' }, { ...createStep('paste'), parallelGroup: 'delivery' }] };
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    output.copy = vi.fn(async () => { throw new Error('copy failed'); });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result.status).toBe('error');
    expect(output.paste).toHaveBeenCalledTimes(1);
    expect(onSteps).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: 'error', error: 'copy failed' }), expect.objectContaining({ status: 'success' }),
    ]);
  });
  it('retains an action error beside the next running action', async () => {
    const onSteps = vi.fn();
    const { dependencies, output } = createDependencies({ onSteps });
    const scenario = { id: 'delivery-error', name: 'Delivery',
      steps: ['startRecording', 'transcribe', 'copy', 'paste'].map(type => createStep(type as ScenarioStepType)) };
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    output.copy = vi.fn(async () => { throw new Error('Clipboard unavailable'); });
    expect((await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies)).status).toBe('error');
    expect(onSteps).toHaveBeenCalledWith([
      expect.objectContaining({ status: 'error', error: 'Clipboard unavailable' }),
      expect.objectContaining({ status: 'running' }),
    ]);
    expect(onSteps).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: 'error', error: 'Clipboard unavailable' }),
      expect.objectContaining({ status: 'success' }),
    ]);
  });
  it('applies the current text flag: a change during a run shows at once', () => {
    const speak = { ...createStep('speak'), showTextInOverlay: true };
    const copy = { ...createStep('copy'), showTextInOverlay: true };
    const steps: OverlayStepStatus[] = [
      { id: speak.id, title: 'Озвучка', status: 'running', body: 'Текст', speech: true },
      { id: copy.id, title: 'В буфер обмена', status: 'success', body: 'Текст' },
    ];
    expect(applyOverlayTextFlags(steps, [speak, copy])).toEqual(steps);
    speak.showTextInOverlay = false; copy.showTextInOverlay = false;
    // Speech keeps its row (the controls) without the text while it speaks, and is not listed otherwise;
    // an action keeps its row without the text.
    expect(applyOverlayTextFlags(steps, [speak, copy])).toEqual([{ ...steps[0], body: undefined }, { ...steps[1], body: undefined }]);
    expect(applyOverlayTextFlags([{ ...steps[0], status: 'success' }], [speak])).toEqual([]);
    expect(applyOverlayTextFlags([{ ...steps[0], status: 'error', error: 'Сбой' }], [speak]))
      .toEqual([{ ...steps[0], status: 'error', error: 'Сбой', body: undefined }]);
  });
  it('shows both delivery steps while retaining actual sequential execution and completed statuses', async () => {
    let releaseCopy!: () => void;
    const onSteps = vi.fn();
    const onStepStatus = vi.fn();
    const { dependencies, output } = createDependencies({ onSteps, onStepStatus });
    const scenario = { id: 'delivery', name: 'Delivery',
      steps: ['startRecording', 'transcribe', 'copy', 'paste'].map(type => createStep(type as ScenarioStepType)) };
    scenario.steps[2].showTextInOverlay = true;
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    output.copy = vi.fn(() => new Promise<void>(resolve => { releaseCopy = resolve; }));
    const running = runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    await vi.waitFor(() => expect(output.copy).toHaveBeenCalled());
    expect(output.paste).not.toHaveBeenCalled();
    expect(onStepStatus).toHaveBeenLastCalledWith({ id: scenario.steps[2].id, type: 'copy', status: 'running' });
    expect(onSteps).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: 'В буфер обмена', status: 'running' }),
      expect.objectContaining({ title: 'Вставить в поле', status: 'pending' }),
    ]);
    releaseCopy();
    expect((await running).status).toBe('success');
    // The overlay shows the copy step's text and hides the paste step's (flag off).
    const shown = onSteps.mock.calls.map(([steps]) => applyOverlayTextFlags(steps as OverlayStepStatus[], scenario.steps));
    expect(shown).toContainEqual([
      expect.objectContaining({ status: 'success', body: 'Распознанный текст' }),
      expect.objectContaining({ status: 'running', body: undefined }),
    ]);
    expect(onSteps).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: 'success' }), expect.objectContaining({ status: 'success' }),
    ]);
    expect(onStepStatus).toHaveBeenLastCalledWith({ id: scenario.steps[3].id, type: 'paste', status: 'success' });
  });
  it('reuses live recognition and sends only the remaining audio', async () => {
    const transcribe = vi.fn(async () => ({ text: 'Хвост', segments: [{ start: 0, end: 1, text: 'Хвост' }] }));
    const cut = vi.fn(() => new Blob(['wav']));
    const { dependencies, output } = createDependencies({
      transcription: { transcribe }, cut,
      decodeAudio: async () => ({ duration: 10 } as AudioBuffer),
      liveTranscript: { throughSeconds: 8, segments: [{ start: 1, end: 7, text: 'Начало' }] },
    });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result).toEqual({ status: 'success', text: 'Начало Хвост' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(cut).toHaveBeenCalledWith(expect.anything(), [{ start: 8, end: 10 }]);
    expect(output.paste).toHaveBeenCalledWith('Начало Хвост', false);
    expect(dependencies.onStage).toHaveBeenCalledWith('Вставка в активное поле...');
  });

  it('does not send audio again when live recognition covers the recording', async () => {
    const transcribe = vi.fn();
    const { dependencies } = createDependencies({
      transcription: { transcribe },
      liveTranscript: { throughSeconds: 1, segments: [{ start: 0, end: 1, text: 'Готово' }] },
    });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies))
      .toEqual({ status: 'success', text: 'Готово' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('keeps edited fragments when reusing the live suffix', async () => {
    const fragments = [{ audioBlob: new Blob(['saved']), start: 0, end: 2,
      transcript: { text: 'Оставить Удалить', segments: [
        { start: 0, end: 1, text: 'Оставить' }, { start: 1, end: 2, text: 'Удалить' },
      ] }, removedRanges: [{ start: 1, end: 2 }] }];
    const { dependencies } = createDependencies({ fragments, getFragmentOffset: () => 2,
      decodeAudio: async () => ({ duration: 4 } as AudioBuffer),
      liveTranscript: { throughSeconds: 4, segments: [
        { start: 0, end: 1, text: 'Оставить' }, { start: 2, end: 4, text: 'Дальше' },
      ] },
    });
    expect(await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies))
      .toEqual({ status: 'success', text: 'Оставить Дальше' });
    expect(fragments[0].removedRanges).toEqual([{ start: 1, end: 2 }]);
  });
  it.each([0, -1, -2, -3, -25])('passes clipboard history level %i to the native output', async level => {
    const scenario = {
      id: 'clipboard-level', name: 'Clipboard level',
      steps: [createStep('startRecording'), createStep('transcribe'),
        { ...createStep('copy'), clipboardHistoryLevel: level }, createStep('paste')],
    };
    const { dependencies, output } = createDependencies();
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result.status).toBe('success');
    expect(output.copy).toHaveBeenCalledWith('Распознанный текст', level);
    expect(output.paste).toHaveBeenCalledWith('Распознанный текст', false);
  });

  it('allows disabling only steps whose input and output types match', () => {
    expect(canDisableScenarioStep(createStep('postprocess'))).toBe(true);
    expect(canDisableScenarioStep(createStep('copy'))).toBe(true);
    expect(canDisableScenarioStep(createStep('paste'))).toBe(true);
    expect(canDisableScenarioStep(createStep('transcribe'))).toBe(false);
    expect(canDisableScenarioStep(createStep('startRecording'))).toBe(false);
  });

  it('keeps old saved steps enabled and repairs invalid disabled transformations', () => {
    const rawScenario = {
      id: 'migration', name: 'Migration',
      steps: [
        { id: 'trigger', type: 'startRecording', output: 'audio' },
        { id: 'transcribe', type: 'transcribe', output: 'text', enabled: false },
        { id: 'postprocess', type: 'postprocess', output: 'text', enabled: false },
        { id: 'paste', type: 'paste', output: 'text' },
      ],
    };
    const scenario = normalizeScenario(rawScenario)!;
    expect(scenario.steps.map(step => step.enabled)).toEqual([true, true, false, true]);
    expect(validateScenario(scenario)).toBeNull();
  });

  it('skips disabled actions and transformations while preserving the configured order', async () => {
    const scenario = {
      id: 'disabled', name: 'Disabled',
      steps: [createStep('startRecording'), createStep('transcribe'),
        { ...createStep('postprocess'), enabled: false }, { ...createStep('copy'), enabled: false }, createStep('paste')],
    };
    const calls: string[] = [];
    const { dependencies } = createDependencies({
      output: {
        copy: async text => { calls.push(`copy:${text}`); },
        paste: async text => { calls.push(`paste:${text}`); },
      },
      postProcessor: { process: async text => { calls.push(`postprocess:${text}`); return 'Обработанный текст'; } },
    });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });

    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(calls).toEqual(['paste:Распознанный текст']);
    expect(result).toEqual({ status: 'success', text: 'Распознанный текст' });
  });

  it.each([
    ['copy', 'paste'],
    ['paste', 'copy'],
    ['copy', 'postprocess', 'paste'],
    [],
  ] satisfies ScenarioStepType[][])('executes text steps in configured order: %j', async (...textSteps) => {
    const scenario = {
      id: 'ordered', name: 'Ordered',
      steps: ['startRecording', 'transcribe', ...textSteps].map(type => configuredStep(type as ScenarioStepType)),
    };
    const calls: string[] = [];
    const { dependencies } = createDependencies({
      output: {
        copy: async text => { calls.push(`copy:${text}`); },
        paste: async text => { calls.push(`paste:${text}`); },
      },
      postProcessor: { process: async text => { calls.push(`postprocess:${text}`); return 'Обработанный текст'; } },
    });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });

    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    let expectedText = 'Распознанный текст';
    const expectedCalls = textSteps.map(type => {
      const call = `${type}:${expectedText}`;
      if (type === 'postprocess') expectedText = 'Обработанный текст';
      return call;
    });
    expect(calls).toEqual(expectedCalls);
    expect(result).toEqual({ status: 'success', text: expectedText });
  });

  it('normalizes saved terminal actions into pass-through text actions', () => {
    const scenario = normalizeScenario({
      id: 'saved', name: 'Saved',
      steps: [createStep('startRecording'), createStep('transcribe'),
        { ...createStep('paste'), output: 'void' }, { ...createStep('copy'), output: 'void' }],
    });
    expect(scenario?.steps.slice(2).map(step => step.output)).toEqual(['text', 'text']);
    expect(validateScenario(scenario!)).toBeNull();
  });

  it('continues after a failed pass-through action and retains its error in history', async () => {
    const scenario = {
      id: 'failure', name: 'Failure',
      steps: [createStep('startRecording'), createStep('transcribe'), createStep('paste'), createStep('copy')],
    };
    const copy = vi.fn(async () => {});
    const { dependencies, updates } = createDependencies({
      output: { copy, paste: async () => { throw new Error('Нет активного поля'); } },
    });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result.status).toBe('error');
    expect(copy).toHaveBeenCalledWith('Распознанный текст', -1);
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'error', errorStep: 'Вставка в активное поле', errorMessage: 'Нет активного поля',
    }));
    expect(updates.at(-1)).toEqual(expect.objectContaining({
      status: 'error',
      steps: expect.arrayContaining([
        expect.objectContaining({ type: 'paste', status: 'error', errorMessage: 'Нет активного поля' }),
        expect.objectContaining({ type: 'copy', status: 'success' }),
      ]),
    }));
    expect(result).toEqual({ status: 'error', message: 'Сценарий завершён с ошибками: Вставка в активное поле: Нет активного поля' });
  });

  it('continues through multiple action failures and transformations without losing input or errors', async () => {
    const scenario = {
      id: 'multiple-errors', name: 'Multiple errors',
      steps: ['startRecording', 'transcribe', 'copy', 'paste', 'postprocess'].map(type => configuredStep(type as ScenarioStepType)),
    };
    let copies = 0;
    const paste = vi.fn(async () => { throw new Error('Вставка недоступна'); });
    const copy = vi.fn(async () => { if (++copies === 1) throw new Error('Буфер занят'); });
    const process = vi.fn(async text => `${text}!`);
    const { dependencies, updates } = createDependencies({ output: { copy, paste }, postProcessor: { process } });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(process).toHaveBeenCalledWith('Распознанный текст', undefined);
    expect(paste).toHaveBeenCalledWith('Распознанный текст', false);
    expect(dependencies.onText).toHaveBeenLastCalledWith('Распознанный текст!');
    expect(result).toEqual({ status: 'error', message: 'Сценарий завершён с ошибками: Буфер обмена: Буфер занят; Вставка в активное поле: Вставка недоступна' });
    expect(updates.at(-1)).toEqual(expect.objectContaining({
      status: 'error', steps: expect.arrayContaining([
        expect.objectContaining({ type: 'copy', status: 'error', errorMessage: 'Буфер занят' }),
        expect.objectContaining({ type: 'paste', status: 'error', errorMessage: 'Вставка недоступна' }),
        expect.objectContaining({ type: 'postprocess', status: 'success' }),
      ]),
    }));
  });

  it('stops after a transformation failure even when input and output types match', async () => {
    const scenario = {
      id: 'transform-error', name: 'Transform error',
      steps: ['startRecording', 'transcribe', 'postprocess', 'copy'].map(type => configuredStep(type as ScenarioStepType)),
    };
    const { dependencies, output } = createDependencies({ postProcessor: { process: async () => { throw new Error('Ошибка модели'); } } });
    const settings = dependencies.getSettings();
    dependencies.getSettings = () => ({ ...settings, scenarios: [scenario], activeScenarioId: scenario.id });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result).toEqual({ status: 'error', message: 'Пост-процессинг текста: Ошибка модели' });
    expect(output.copy).not.toHaveBeenCalled();
  });

  it('transcribes and pastes through injected services, then marks history successful', async () => {
    const { dependencies, updates, output } = createDependencies();
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);

    expect(result).toEqual({ status: 'success', text: 'Распознанный текст' });
    expect(output.paste).toHaveBeenCalledWith('Распознанный текст', false);
    expect(updates).toContainEqual({ status: 'success' });
  });

  it('records transcription failures and returns an error without calling the text output', async () => {
    const { dependencies, updates, output } = createDependencies({
      transcription: { transcribe: async () => { throw new Error('Провайдер недоступен'); } },
    });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);

    expect(result).toEqual({ status: 'error', message: 'Провайдер недоступен' });
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'error', errorStep: 'Транскрибация текста', errorMessage: 'Провайдер недоступен',
    }));
    expect(output.paste).not.toHaveBeenCalled();
  });

  it('rejects transcription immediately when provider is not ready or not selected', async () => {
    const { dependencies, output } = createDependencies({
      getSettings: () => ({
        historyMaxItems: 10,
        provider: 'none',
        groqApiKey: '',
        postProcessEnabled: false,
        postProcessProvider: 'gemini',
        geminiApiKey: '',
        autoPasteActiveWindow: true,
      }),
    });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result).toEqual({ status: 'error', message: 'Провайдер транскрибации не выбран в настройках.' });
    expect(output.paste).not.toHaveBeenCalled();
  });

  it('rejects scenario immediately when postProcessProvider is not ready', async () => {
    const { dependencies, output } = createDependencies({
      getSettings: () => ({
        historyMaxItems: 10,
        provider: 'groq',
        groqApiKey: 'gsk_valid',
        postProcessEnabled: true,
        postProcessProvider: 'gemini',
        geminiApiKey: '',
        autoPasteActiveWindow: true,
      }),
    });
    const result = await runRecordingWorkflow(new Blob([new Uint8Array(1000)]), dependencies);
    expect(result).toEqual({ status: 'error', message: 'Провайдер Gemini не готов: не указан API ключ.' });
    expect(output.paste).not.toHaveBeenCalled();
  });

  it('correctly calculates scenario readiness errors', () => {
    expect(getScenarioReadinessError({ provider: 'none', groqApiKey: '', postProcessEnabled: false, postProcessProvider: 'none', geminiApiKey: '' }))
      .toBe('Провайдер транскрибации не выбран в настройках.');
    expect(getScenarioReadinessError({ provider: 'groq', groqApiKey: '', postProcessEnabled: false, postProcessProvider: 'none', geminiApiKey: '' }))
      .toBe('Провайдер Groq не готов: не указан API ключ.');
    expect(getScenarioReadinessError({ provider: 'groq', groqApiKey: 'gsk_123', postProcessEnabled: true, postProcessProvider: 'gemini', geminiApiKey: '' }))
      .toBe('Провайдер Gemini не готов: не указан API ключ.');
    expect(getScenarioReadinessError({ provider: 'groq', groqApiKey: 'gsk_123', postProcessEnabled: true, postProcessProvider: 'gemini', geminiApiKey: 'AIzaSy123', scenarios: [createVoiceAnswerScenario()], activeScenarioId: 'voice-answer-scenario' }))
      .toBeNull();
  });
});
