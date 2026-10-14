import {
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_API_KEY,
  DEFAULT_GROQ_MODEL,
} from './defaults';
import type { GeminiGenerationSettings } from './provider-models';

export type ScenarioDataType = 'trigger' | 'audio' | 'text' | 'void';
export type ScenarioStepType = 'startRecording' | 'transcribe' | 'postprocess' | 'copy' | 'paste';
export type ScenarioStepCategory = 'source' | 'transformation' | 'action';
export type ScenarioStartSound = 'chime' | 'beep' | 'none';
export type ScenarioSoundProfile = 'default' | 'soft';
export type ScenarioInsertSound = 'chord' | 'click' | 'none';
export type ClipboardHistoryLevel = number;
export const DEFAULT_CLIPBOARD_HISTORY_LEVEL: ClipboardHistoryLevel = -1;

export function normalizeClipboardHistoryLevel(value: unknown): ClipboardHistoryLevel {
  return typeof value === 'number' && Number.isSafeInteger(value) && value <= 0
    ? value : DEFAULT_CLIPBOARD_HISTORY_LEVEL;
}

export interface ScenarioSoundSettingsDefaults {
  enabled: boolean;
  profile: ScenarioSoundProfile;
  insert: ScenarioInsertSound;
}

export const DEFAULT_SCENARIO_SOUND_SETTINGS: ScenarioSoundSettingsDefaults = {
  enabled: true,
  profile: 'default',
  insert: 'chord',
};

export interface ScenarioStep {
  id: string;
  type: ScenarioStepType;
  output: ScenarioDataType;
  enabled: boolean;
  hotkey?: string;
  hotkeyPause?: string;
  microphoneId?: string;
  sound?: ScenarioStartSound;
  soundEnabled?: boolean;
  soundProfile?: ScenarioSoundProfile;
  soundSuccess?: ScenarioInsertSound;
  clipboardHistoryLevel?: ClipboardHistoryLevel;
  transcription?: TranscriptionStepSettings;
  postprocessing?: PostprocessingStepSettings;
}

export interface TranscriptionStepSettings {
  provider: 'groq' | 'none';
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  language: string;
  responseFormat: 'verbose_json' | 'json' | 'text';
  liveTranscriptionEnabled: boolean;
  liveSilenceDurationMs: number;
  liveMaxChunkDurationSeconds: number;
  liveChunkOverlapSeconds: number;
}

export interface PostprocessingStepSettings {
  provider: 'gemini' | 'none';
  apiKey: string;
  model: string;
  prompt: string;
  generationConfig?: GeminiGenerationSettings;
}

export interface ScenarioStepSettingsDefaults {
  transcription: TranscriptionStepSettings;
  postprocessing: PostprocessingStepSettings;
}

export interface Scenario {
  id: string;
  name: string;
  steps: ScenarioStep[];
}

export interface ScenarioStepContract {
  type: ScenarioStepType;
  category: ScenarioStepCategory;
  title: string;
  input: ScenarioDataType;
  outputs: readonly ScenarioDataType[];
}

export const DEFAULT_SCENARIO_STEP_SETTINGS: ScenarioStepSettingsDefaults = {
  transcription: {
    provider: 'groq', apiKey: DEFAULT_GROQ_API_KEY, model: DEFAULT_GROQ_MODEL,
    prompt: '', temperature: 0, language: 'ru', responseFormat: 'verbose_json',
    liveTranscriptionEnabled: true,
    liveSilenceDurationMs: 700, liveMaxChunkDurationSeconds: 9, liveChunkOverlapSeconds: 0.5,
  },
  postprocessing: {
    provider: 'gemini', apiKey: DEFAULT_GEMINI_API_KEY, model: DEFAULT_GEMINI_MODEL, prompt: '',
  },
};

export const SCENARIO_STEP_CONTRACTS: readonly ScenarioStepContract[] = [
  { type: 'startRecording', category: 'source', title: 'Запись', input: 'trigger', outputs: ['audio'] },
  { type: 'transcribe', category: 'transformation', title: 'Транскрибация', input: 'audio', outputs: ['text'] },
  { type: 'postprocess', category: 'transformation', title: 'Постобработка', input: 'text', outputs: ['text'] },
  { type: 'copy', category: 'action', title: 'В буфер обмена', input: 'text', outputs: ['text'] },
  { type: 'paste', category: 'action', title: 'Вставить в поле', input: 'text', outputs: ['text'] },
];

const dataTypeLabels: Record<ScenarioDataType, string> = {
  trigger: 'Триггер',
  audio: 'Аудио',
  text: 'Текст',
  void: 'Нет выхода',
};

export function scenarioDataTypeLabel(type: ScenarioDataType): string {
  return dataTypeLabels[type];
}

export function createDefaultScenario(
  includePostprocessing = false,
  _delivery: 'copy' | 'paste' = 'paste',
  hotkey = 'Control+Digit1',
  sound: ScenarioStartSound = 'chime',
  stepSettings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
  hotkeyPause = 'Control+Digit2',
): Scenario {
  const steps: ScenarioStep[] = [
    { ...createStep('startRecording', hotkey, sound, stepSettings, soundSettings, hotkeyPause), id: 'default-step-start' },
    { ...createStep('transcribe', hotkey, sound, stepSettings), id: 'default-step-transcribe' },
    { ...createStep('postprocess', hotkey, sound, stepSettings), id: 'default-step-postprocess', enabled: includePostprocessing },
    { ...createStep('copy'), id: 'default-step-copy' },
    { ...createStep('paste', hotkey, sound, stepSettings, soundSettings), id: 'default-step-paste' },
  ];
  return { id: 'default-scenario', name: 'Стандартный сценарий', steps };
}

export function createStep(
  type: ScenarioStepType,
  hotkey = 'Control+Digit1',
  sound: ScenarioStartSound = 'chime',
  settings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
  hotkeyPause = 'Control+Digit2',
): ScenarioStep {
  const contract = getScenarioStepContract(type);
  const step: ScenarioStep = { id: createId(), type, output: contract.outputs[0], enabled: true };
  if (type === 'startRecording') {
    step.hotkey = hotkey;
    step.hotkeyPause = hotkeyPause;
    step.sound = sound;
    step.soundEnabled = soundSettings.enabled;
    step.soundProfile = soundSettings.profile;
  }
  if (type === 'paste') step.soundSuccess = soundSettings.insert;
  if (type === 'copy') step.clipboardHistoryLevel = DEFAULT_CLIPBOARD_HISTORY_LEVEL;
  if (type === 'transcribe') step.transcription = { ...settings.transcription };
  if (type === 'postprocess') step.postprocessing = { ...settings.postprocessing };
  return step;
}

export function getScenarioStepContract(type: ScenarioStepType): ScenarioStepContract {
  const contract = SCENARIO_STEP_CONTRACTS.find(item => item.type === type);
  if (!contract) throw new Error(`Неизвестный шаг сценария: ${type}`);
  return contract;
}

export function canDisableScenarioStep(step: ScenarioStep): boolean {
  return getScenarioStepContract(step.type).input === step.output;
}

export function validateScenario(scenario: Scenario): string | null {
  if (!scenario.name.trim()) return 'Укажите название сценария.';
  if (scenario.steps.length < 2) return 'Добавьте триггер записи и транскрибацию.';
  if (scenario.steps[0].type !== 'startRecording') return 'Первым шагом должен быть триггер записи.';

  const seenTypes = new Set<ScenarioStepType>();
  const seenIds = new Set<string>();
  let availableInput: ScenarioDataType = 'trigger';

  for (const [index, step] of scenario.steps.entries()) {
    if (seenIds.has(step.id)) return 'У шагов сценария должны быть разные идентификаторы.';
    seenIds.add(step.id);
    if (seenTypes.has(step.type)) return `Шаг «${getScenarioStepContract(step.type).title}» можно добавить только один раз.`;
    seenTypes.add(step.type);

    const contract = getScenarioStepContract(step.type);
    if (!step.enabled && !canDisableScenarioStep(step)) {
      return `Шаг «${contract.title}» нельзя отключить: его вход и выход имеют разные типы.`;
    }
    if (contract.input !== availableInput) {
      return `Шаг ${index + 1} «${contract.title}» принимает тип «${scenarioDataTypeLabel(contract.input)}», а предыдущий шаг выдаёт «${scenarioDataTypeLabel(availableInput)}».`;
    }
    if (!contract.outputs.includes(step.output)) {
      return `Шаг ${index + 1} «${contract.title}» не выдаёт тип «${scenarioDataTypeLabel(step.output)}».`;
    }
    availableInput = step.output;
  }

  if (!seenTypes.has('transcribe')) return 'Добавьте транскрибацию.';
  return null;
}

export function normalizeScenarios(
  value: unknown,
  fallback: Scenario,
  hotkey = 'Control+Digit1',
  sound: ScenarioStartSound = 'chime',
  stepSettings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
): Scenario[] {
  if (!Array.isArray(value)) return [fallback];
  const scenarios = value
    .map(item => normalizeScenario(item, hotkey, sound, stepSettings, soundSettings))
    .filter((item): item is Scenario => item !== null);
  return scenarios.length ? scenarios : [fallback];
}

export function normalizeScenario(
  value: unknown,
  defaultHotkey = 'Control+Digit1',
  defaultSound: ScenarioStartSound = 'chime',
  stepSettings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
): Scenario | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !Array.isArray(value.steps)) {
    return null;
  }

  const steps = value.steps
    .map(item => normalizeStep(item, defaultHotkey, defaultSound, stepSettings, soundSettings))
    .filter((step): step is ScenarioStep => step !== null);
  if (steps.length !== value.steps.length) return null;
  if (!steps.some(step => step.type === 'startRecording')) {
    steps.unshift(createStep('startRecording', defaultHotkey, defaultSound, stepSettings, soundSettings));
  }
  return { id: value.id, name: value.name, steps };
}

export function isScenarioStepType(value: string): value is ScenarioStepType {
  return SCENARIO_STEP_CONTRACTS.some(item => item.type === value);
}

function normalizeStep(
  value: unknown,
  defaultHotkey: string,
  defaultSound: ScenarioStartSound,
  defaults: ScenarioStepSettingsDefaults,
  soundDefaults: ScenarioSoundSettingsDefaults,
): ScenarioStep | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.type !== 'string' || !isScenarioStepType(value.type)) {
    return null;
  }
  const contract = getScenarioStepContract(value.type);
  const output = typeof value.output === 'string' && contract.outputs.includes(value.output as ScenarioDataType)
    ? value.output as ScenarioDataType
    : contract.outputs[0];
  const candidate: ScenarioStep = {
    id: value.id,
    type: value.type,
    output,
    enabled: value.enabled !== false,
  };
  const step: ScenarioStep = candidate.enabled || canDisableScenarioStep(candidate)
    ? candidate
    : { ...candidate, enabled: true };
  if (step.type === 'startRecording') {
    step.hotkey = typeof value.hotkey === 'string' ? value.hotkey : defaultHotkey;
    step.microphoneId = typeof value.microphoneId === 'string' ? value.microphoneId : '';
    step.hotkeyPause = typeof value.hotkeyPause === 'string' ? value.hotkeyPause : undefined;
    step.sound = isScenarioStartSound(value.sound) ? value.sound : defaultSound;
    step.soundEnabled = typeof value.soundEnabled === 'boolean' ? value.soundEnabled : soundDefaults.enabled;
    step.soundProfile = value.soundProfile === 'soft' || value.soundProfile === 'default'
      ? value.soundProfile
      : soundDefaults.profile;
  }
  if (step.type === 'paste') {
    step.soundSuccess = value.soundSuccess === 'chord' || value.soundSuccess === 'click' || value.soundSuccess === 'none'
      ? value.soundSuccess
      : soundDefaults.insert;
  }
  if (step.type === 'copy') step.clipboardHistoryLevel = normalizeClipboardHistoryLevel(value.clipboardHistoryLevel);
  if (step.type === 'transcribe') step.transcription = normalizeTranscriptionSettings(value.transcription, defaults.transcription);
  if (step.type === 'postprocess') step.postprocessing = normalizePostprocessingSettings(value.postprocessing, defaults.postprocessing);
  return step;
}

function normalizeTranscriptionSettings(value: unknown, defaults: TranscriptionStepSettings): TranscriptionStepSettings {
  if (!isRecord(value)) return { ...defaults };
  return {
    provider: value.provider === 'none' ? 'none' : 'groq',
    apiKey: stringValue(value.apiKey, defaults.apiKey),
    model: stringValue(value.model, defaults.model),
    prompt: stringValue(value.prompt, defaults.prompt),
    temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : defaults.temperature,
    language: stringValue(value.language, defaults.language),
    responseFormat: value.responseFormat === 'json' || value.responseFormat === 'text' ? value.responseFormat : 'verbose_json',
    liveTranscriptionEnabled: typeof value.liveTranscriptionEnabled === 'boolean'
      ? value.liveTranscriptionEnabled : defaults.liveTranscriptionEnabled,
    liveSilenceDurationMs: numberValue(value.liveSilenceDurationMs, defaults.liveSilenceDurationMs),
    liveMaxChunkDurationSeconds: numberValue(value.liveMaxChunkDurationSeconds, defaults.liveMaxChunkDurationSeconds),
    liveChunkOverlapSeconds: numberValue(value.liveChunkOverlapSeconds, defaults.liveChunkOverlapSeconds),
  };
}

function normalizePostprocessingSettings(value: unknown, defaults: PostprocessingStepSettings): PostprocessingStepSettings {
  if (!isRecord(value)) return { ...defaults };
  return {
    provider: value.provider === 'none' ? 'none' : 'gemini',
    apiKey: stringValue(value.apiKey, defaults.apiKey),
    model: stringValue(value.model, defaults.model),
    prompt: stringValue(value.prompt, defaults.prompt),
    generationConfig: normalizeGenerationConfig(value.generationConfig),
  };
}

function normalizeGenerationConfig(value: unknown): GeminiGenerationSettings | undefined {
  if (!isRecord(value)) return undefined;
  const result: GeminiGenerationSettings = {};
  for (const key of ['temperature', 'topP', 'topK', 'maxOutputTokens'] as const) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) continue;
    if (key === 'temperature' && number >= 0
      || key === 'topP' && number >= 0 && number <= 1
      || (key === 'topK' || key === 'maxOutputTokens') && Number.isInteger(number) && number >= 1) result[key] = number;
  }
  return result;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function isScenarioStartSound(value: unknown): value is ScenarioStartSound {
  return value === 'chime' || value === 'beep' || value === 'none';
}

function createId(): string {
  return crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
