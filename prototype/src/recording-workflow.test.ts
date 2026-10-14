import { describe, expect, it, vi } from 'vitest';
import type { HistoryRepository, TextOutputPort, TextPostProcessor, TranscriptionProvider } from './ports';
import { getScenarioReadinessError, runRecordingWorkflow } from './recording-workflow';
import { canDisableScenarioStep, createStep, normalizeScenario, validateScenario, type ScenarioStepType } from './scenario';

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
    expect(output.paste).toHaveBeenCalledWith('Распознанный текст');
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
      steps: ['startRecording', 'transcribe', ...textSteps].map(type => createStep(type as ScenarioStepType)),
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
      steps: ['startRecording', 'transcribe', 'copy', 'paste', 'postprocess'].map(type => createStep(type as ScenarioStepType)),
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
    expect(paste).toHaveBeenCalledWith('Распознанный текст');
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
      steps: ['startRecording', 'transcribe', 'postprocess', 'copy'].map(type => createStep(type as ScenarioStepType)),
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
    expect(output.paste).toHaveBeenCalledWith('Распознанный текст');
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
    expect(getScenarioReadinessError({ provider: 'groq', groqApiKey: 'gsk_123', postProcessEnabled: true, postProcessProvider: 'gemini', geminiApiKey: 'AIzaSy123' }))
      .toBeNull();
  });
});
