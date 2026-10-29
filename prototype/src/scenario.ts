import {
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_API_KEY,
  DEFAULT_GROQ_MODEL,
} from './defaults';
import type { GeminiGenerationSettings } from './provider-models';
import { normalizeGoogleCloudSettings, type GoogleCloudSettings } from './google-cloud/settings';
import { normalizeGeminiTranscriptionSettings, type GeminiTranscriptionSettings } from './gemini-transcription/settings';
import { VOICE_TRANSCRIPTION_PROMPT, VOICE_INPUT_CLEANUP_PROMPT, VOICE_ANSWER_PROMPT } from './scenario-prompts';
import { DEFAULT_AFTER_STOP_MS, normalizeAfterStopMs } from './recording-stop';
import { AUTO_SPEECH_LANGUAGE, normalizeSpeechSettings, type SystemSpeechSettings } from './speech-settings';
import { normalizeSpeechProvider, normalizeSpeechProviders, speechConfigurationError, type SpeechProvider, type SpeechProviderSettings } from './speech-provider-settings';

export type ScenarioDataType = 'trigger' | 'audio' | 'text' | 'void';
export type ScenarioStepType = 'startRecording' | 'claudeCode' | 'selectedText' | 'transcribe' | 'postprocess' | 'copy' | 'paste' | 'speak';
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
  parallelGroup?: string;
  parallelBranches?: ScenarioStep[][];
  showTextInOverlay?: boolean;
  speechProvider?: SpeechProvider;
  speechSettings?: SystemSpeechSettings;
  speechProviders?: SpeechProviderSettings;
  hotkey?: string;
  hotkeyPause?: string;
  // Own stop key of a recording source; absent: the start key also stops.
  hotkeyStop?: string;
  microphoneId?: string;
  afterStopMs?: number;
  // Claude Code: show the interim transcript from its prompt in the overlay.
  liveTranscription?: boolean;
  sound?: ScenarioStartSound;
  soundEnabled?: boolean;
  soundProfile?: ScenarioSoundProfile;
  soundSuccess?: ScenarioInsertSound;
  clipboardHistoryLevel?: ClipboardHistoryLevel;
  returnFocusToOriginalWindow?: boolean;
  transcription?: TranscriptionStepSettings;
  postprocessing?: PostprocessingStepSettings;
}

export interface TranscriptionStepSettings {
  provider: 'groq' | 'google-cloud' | 'gemini' | 'none';
  googleCloud?: GoogleCloudSettings;
  geminiTranscription?: GeminiTranscriptionSettings;
  apiKey: string;
  model: string;
  prompt: string;
  temperature: number;
  language: string;
  responseFormat: 'verbose_json' | 'json' | 'text';
  liveTranscriptionEnabled: boolean;
  retranscribeFullRecording: boolean;
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

export type ScenarioTemplateId = 'default-scenario' | 'voice-answer-scenario' | 'selected-text-speech-scenario';

export interface Scenario {
  templateId?: ScenarioTemplateId;
  id: string;
  name: string;
  enabled?: boolean;
  // Cancels this scenario's runs; see scenarioCancelHotkey.
  hotkeyCancel?: string;
  triggerClaim?: { key: string; order: number };
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
    prompt: '', temperature: 0, language: 'auto', responseFormat: 'verbose_json',
    liveTranscriptionEnabled: true,
    retranscribeFullRecording: false,
    liveSilenceDurationMs: 700, liveMaxChunkDurationSeconds: 9, liveChunkOverlapSeconds: 0.5,
  },
  postprocessing: {
    provider: 'gemini', apiKey: DEFAULT_GEMINI_API_KEY, model: DEFAULT_GEMINI_MODEL, prompt: '',
  },
};

export const SCENARIO_STEP_CONTRACTS: readonly ScenarioStepContract[] = [
  { type: 'claudeCode', category: 'source', title: 'Claude Code', input: 'trigger', outputs: ['text'] },
  { type: 'selectedText', category: 'source', title: 'Выделенный текст', input: 'trigger', outputs: ['text'] },
  { type: 'startRecording', category: 'source', title: 'Запись', input: 'trigger', outputs: ['audio'] },
  { type: 'transcribe', category: 'transformation', title: 'Транскрибация', input: 'audio', outputs: ['text'] },
  { type: 'postprocess', category: 'transformation', title: 'Постобработка', input: 'text', outputs: ['text'] },
  { type: 'copy', category: 'action', title: 'В буфер обмена', input: 'text', outputs: ['text'] },
  { type: 'paste', category: 'action', title: 'Вставить в поле', input: 'text', outputs: ['text'] },
  { type: 'speak', category: 'transformation', title: 'Озвучка', input: 'text', outputs: ['audio'] },
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
  hotkey = 'Control+Shift+KeyD',
  sound: ScenarioStartSound = 'chime',
  stepSettings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
  hotkeyPause = 'Control+Alt+KeyD',
): Scenario {
  const steps: ScenarioStep[] = [
    { ...createStep('startRecording', hotkey, sound, stepSettings, soundSettings, hotkeyPause), id: 'default-step-start' },
    { ...createStep('transcribe', hotkey, sound, stepSettings), id: 'default-step-transcribe' },
    { ...createStep('postprocess', hotkey, sound, stepSettings), id: 'default-step-postprocess', enabled: includePostprocessing },
    { ...createStep('copy'), id: 'default-step-copy', parallelGroup: 'default-delivery' },
    { ...createStep('paste', hotkey, sound, stepSettings, soundSettings), id: 'default-step-paste', parallelGroup: 'default-delivery' },
  ];
  steps[1].transcription!.prompt ||= VOICE_TRANSCRIPTION_PROMPT;
  steps[2].postprocessing!.prompt ||= VOICE_INPUT_CLEANUP_PROMPT;
  return { templateId: 'default-scenario', id: 'default-scenario', name: 'Голосовой ввод', enabled: true, steps };
}

export function createVoiceAnswerScenario(settings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS): Scenario {
  const steps = (['startRecording', 'transcribe', 'postprocess', 'speak'] as const).map(type => createStep(type, undefined, undefined, settings));
  steps.forEach(step => { step.id = `voice-answer-${step.type}`; });
  steps[1].transcription!.prompt ||= VOICE_TRANSCRIPTION_PROMPT;
  steps[2].postprocessing!.prompt = VOICE_ANSWER_PROMPT;
  steps[0].hotkey = 'Control+Shift+KeyR';
  return { templateId: 'voice-answer-scenario', id: 'voice-answer-scenario', name: 'Голосовой ответ', enabled: false, steps };
}

// Reads the selected text aloud: the selection of any Windows application becomes the speech.
export function createSelectedTextSpeechScenario(): Scenario {
  const steps = (['selectedText', 'speak'] as const).map(type => createStep(type));
  steps.forEach(step => { step.id = `selected-text-speech-${step.type}`; });
  // Neural Edge voices read selections far better than the system engine.
  steps[1].speechProvider = 'edge';
  return { templateId: 'selected-text-speech-scenario', id: 'selected-text-speech-scenario', name: 'Озвучка выделенного текста', enabled: false, steps };
}

export function createClaudeCodeScenario(): Scenario {
  const voiceInput = createDefaultScenario();
  const steps = [
    { ...createStep('claudeCode'), id: 'claude-code-test-step' },
    ...voiceInput.steps.slice(2).map(step => ({ ...step, id: `claude-code-${step.type}` })),
  ];
  return { id: 'claude-code-test', name: 'Claude Code', enabled: false, steps };
}

export function appendScenarioCopy(scenarios: Scenario[], source: Scenario): Scenario {
  const base = `${source.name} — копия`;
  const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
  let name = base;
  let suffix = 2;
  while (scenarios.some(item => normalize(item.name) === normalize(name))) name = `${base} ${suffix++}`;
  const copy: Scenario = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    name,
  };
  renewStepIds(copy.steps);
  // A copy retains settings, but cannot inherit ownership of the original's trigger.
  delete copy.triggerClaim;
  scenarios.push(copy);
  return copy;
}

export function scenarioTemplates(): Scenario[] {
  return [createDefaultScenario(), createVoiceAnswerScenario(), createSelectedTextSpeechScenario()];
}

export function isScenarioTemplate(scenario: Pick<Scenario, 'id'>): boolean {
  return scenario.id === 'default-scenario' || scenario.id === 'voice-answer-scenario' || scenario.id === 'selected-text-speech-scenario';
}

function renewStepIds(steps: ScenarioStep[]): void {
  steps.forEach(step => {
    step.id = crypto.randomUUID();
    step.parallelBranches?.forEach(renewStepIds);
  });
}

export function appendScenarioFromTemplate(scenarios: Scenario[], templateId: ScenarioTemplateId): Scenario {
  const template = scenarioTemplates().find(item => item.id === templateId)!;
  let name = template.name, suffix = 2;
  const normalize = (value: string) => value.trim().toLocaleLowerCase('ru');
  while (scenarios.some(item => normalize(item.name) === normalize(name))) name = `${template.name} ${suffix++}`;
  const scenario = { ...template, id: crypto.randomUUID(), name, enabled: false };
  renewStepIds(scenario.steps);
  scenarios.push(scenario);
  return scenario;
}

export function resetScenarioToTemplate(scenario: Scenario): boolean {
  const template = scenarioTemplates().find(item => item.id === (scenario.templateId ?? scenario.id));
  if (!template) return false;
  const restoreSteps = (defaults: ScenarioStep[], existing: ScenarioStep[]): ScenarioStep[] => {
    const used = new Set<ScenarioStep>();
    return defaults.map((step, index) => {
      const atIndex = existing[index];
      const previous = atIndex?.type === step.type && !used.has(atIndex) ? atIndex
        : existing.find(item => item.type === step.type && !used.has(item));
      const branches = step.parallelBranches?.map((lane, branchIndex) =>
        restoreSteps(lane, previous?.parallelBranches?.[branchIndex] ?? []));
      const id = previous?.id ?? crypto.randomUUID();
      if (previous) {
        used.add(previous);
        // Existing controls and pipeline actions keep references to this step.
        Object.keys(previous).forEach(key => Reflect.deleteProperty(previous, key));
      }
      const restored = Object.assign(previous ?? {}, step, { id }) as ScenarioStep;
      if (branches) restored.parallelBranches = branches;
      return restored;
    });
  };
  scenario.steps = restoreSteps(template.steps, scenario.steps);
  scenario.templateId = template.templateId;
  delete scenario.triggerClaim;
  return true;
}

export function canResetScenarioToTemplate(scenario: Scenario): boolean {
  const template = scenarioTemplates().find(item => item.id === (scenario.templateId ?? scenario.id));
  if (!template) return false;
  const canonical = (value: Scenario) => {
    const normalizeLane = (steps: ScenarioStep[]): unknown[] => {
      const groups = new Map<string, number>();
      return steps.map(({ id: _id, parallelGroup, parallelBranches, ...step }) => {
        if (parallelGroup && !groups.has(parallelGroup)) groups.set(parallelGroup, groups.size);
        return { ...step, parallelGroup: parallelGroup ? groups.get(parallelGroup) : undefined,
          parallelBranches: parallelBranches?.length ? parallelBranches.map(normalizeLane) : undefined };
      });
    };
    return JSON.stringify({ count: value.steps.length, steps: normalizeLane(normalizeScenario(value)?.steps ?? value.steps) }, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  };
  return canonical(scenario) !== canonical(template);
}

export const DEFAULT_CANCEL_HOTKEY = 'Escape';

export function scenarioCancelHotkey(scenario: Pick<Scenario, 'hotkeyCancel'> | undefined): string {
  return scenario?.hotkeyCancel || DEFAULT_CANCEL_HOTKEY;
}

// Steps that start a scenario on a hotkey.
export function isTriggerStep(step: { type: ScenarioStepType }): boolean {
  return step.type === 'startRecording' || step.type === 'claudeCode' || step.type === 'selectedText';
}

export function createStep(
  type: ScenarioStepType,
  hotkey = 'Control+Shift+KeyD',
  sound: ScenarioStartSound = 'chime',
  settings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
  hotkeyPause = 'Control+Alt+KeyD',
): ScenarioStep {
  const contract = getScenarioStepContract(type);
  const step: ScenarioStep = { id: createId(), type, output: contract.outputs[0], enabled: true };
  // Actions and speech may show their text in the overlay: off for actions, on for speech.
  if (contract.category === 'action') step.showTextInOverlay = false;
  if (type === 'speak') step.showTextInOverlay = true;
  if (type === 'claudeCode') { step.hotkey = 'Control+Shift+KeyD'; step.afterStopMs = DEFAULT_AFTER_STOP_MS; step.liveTranscription = true; }
  if (type === 'selectedText') step.hotkey = 'Control+Shift+KeyS';
  if (type === 'startRecording') {
    step.afterStopMs = DEFAULT_AFTER_STOP_MS;
    step.hotkey = hotkey;
    step.hotkeyPause = hotkeyPause;
    step.sound = sound;
    step.soundEnabled = soundSettings.enabled;
    step.soundProfile = soundSettings.profile;
  }
  if (type === 'paste') {
    step.soundSuccess = soundSettings.insert;
    step.returnFocusToOriginalWindow = false;
  }
  if (type === 'copy') step.clipboardHistoryLevel = DEFAULT_CLIPBOARD_HISTORY_LEVEL;
  if (type === 'transcribe') step.transcription = structuredClone(settings.transcription);
  if (type === 'postprocess') step.postprocessing = { ...settings.postprocessing };
  if (type === 'speak') { step.speechProvider = 'system'; step.speechSettings = { ...normalizeSpeechSettings(), language: AUTO_SPEECH_LANGUAGE }; }
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
  if (!scenario.steps.length) return 'Добавьте источник записи.';
  if (scenario.steps.length < 2 && scenario.steps[0].type !== 'claudeCode' && scenario.steps[0].type !== 'selectedText') return 'Добавьте триггер записи и транскрибацию.';
  if (getScenarioStepContract(scenario.steps[0].type).category !== 'source') return 'Первым шагом должен быть источник записи.';

  const seenTypes = new Set<ScenarioStepType>();
  const seenIds = new Set<string>();
  const validateLane = (steps: ScenarioStep[], input: ScenarioDataType): string | null => {
    let availableInput: ScenarioDataType = input;

    for (const [index, step] of steps.entries()) {
      if (seenIds.has(step.id)) return 'У шагов сценария должны быть разные идентификаторы.';
      seenIds.add(step.id);
      seenTypes.add(step.type);

      const contract = getScenarioStepContract(step.type);
      if (step.parallelBranches?.length) {
        if (contract.category === 'source') return 'Ветки доступны после источника данных.';
        for (const branch of step.parallelBranches) {
          if (!branch.length) return 'Ветка не должна быть пустой.';
          if (branch.some(item => getScenarioStepContract(item.type).category === 'source')) return 'Источник записи может быть только в начале сценария.';
          const problem = validateLane(branch, availableInput);
          if (problem) return problem;
        }
      }
      if (step.enabled && step.type === 'speak') {
        const problem = speechConfigurationError(step.speechProvider, step.speechProviders);
        if (problem) return problem;
      }
      if (step.parallelGroup && contract.category !== 'action') return 'Параллельная группа может содержать только сквозные действия.';
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
    return null;
  };
  const problem = validateLane(scenario.steps, 'trigger');
  if (problem) return problem;

  if (!seenTypes.has('transcribe') && !seenTypes.has('claudeCode') && !seenTypes.has('selectedText')) return 'Добавьте транскрибацию.';
  return null;
}

export function normalizeScenarios(
  value: unknown,
  fallback: Scenario,
  hotkey = 'Control+Shift+KeyD',
  sound: ScenarioStartSound = 'chime',
  stepSettings: ScenarioStepSettingsDefaults = DEFAULT_SCENARIO_STEP_SETTINGS,
  soundSettings: ScenarioSoundSettingsDefaults = DEFAULT_SCENARIO_SOUND_SETTINGS,
): Scenario[] {
  if (!Array.isArray(value)) return [fallback];
  const scenarios = value
    .map(item => normalizeScenario(item, hotkey, sound, stepSettings, soundSettings))
    .filter((item): item is Scenario => item !== null);
  return scenarios.length || !value.length ? scenarios : [fallback];
}

export function normalizeScenario(
  value: unknown,
  defaultHotkey = 'Control+Shift+KeyD',
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
  if (!steps.some(step => getScenarioStepContract(step.type).category === 'source')) {
    steps.unshift(createStep('startRecording', defaultHotkey, defaultSound, stepSettings, soundSettings));
  }
  const scenario: Scenario = { id: value.id, name: value.name, enabled: value.enabled !== false, steps };
  if (typeof value.hotkeyCancel === 'string' && value.hotkeyCancel) scenario.hotkeyCancel = value.hotkeyCancel;
  const templateId = value.templateId ?? value.id;
  if (templateId === 'default-scenario' || templateId === 'voice-answer-scenario' || templateId === 'selected-text-speech-scenario') scenario.templateId = templateId;
  if (isRecord(value.triggerClaim) && typeof value.triggerClaim.key === 'string'
    && typeof value.triggerClaim.order === 'number' && Number.isSafeInteger(value.triggerClaim.order) && value.triggerClaim.order >= 0) {
    scenario.triggerClaim = { key: value.triggerClaim.key, order: value.triggerClaim.order };
  }
  return scenario;
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
  depth = 0,
): ScenarioStep | null {
  if (depth > 32) return null;
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
    ...(typeof value.parallelGroup === 'string' && value.parallelGroup ? { parallelGroup: value.parallelGroup } : {}),
  };
  const step: ScenarioStep = candidate.enabled || canDisableScenarioStep(candidate)
    ? candidate
    : { ...candidate, enabled: true };
  if (value.parallelBranches !== undefined) {
    if (!Array.isArray(value.parallelBranches) || contract.category === 'source') return null;
    const branches: ScenarioStep[][] = [];
    for (const lane of value.parallelBranches) {
      if (!Array.isArray(lane) || !lane.length) return null;
      const steps = lane.map(item => normalizeStep(item, defaultHotkey, defaultSound, defaults, soundDefaults, depth + 1));
      if (steps.some(item => item === null)) return null;
      branches.push(steps as ScenarioStep[]);
    }
    if (branches.length) step.parallelBranches = branches;
  }
  if (contract.category === 'action') step.showTextInOverlay = value.showTextInOverlay === true;
  // Speech shows the text it reads unless the step says otherwise.
  if (step.type === 'speak') step.showTextInOverlay = value.showTextInOverlay !== false;
  if (step.type === 'selectedText') step.hotkey = typeof value.hotkey === 'string' ? value.hotkey : 'Control+Shift+KeyS';
  // An empty own stop key is kept: the editor shows it as missing rather than switching back.
  if ((step.type === 'claudeCode' || step.type === 'startRecording') && typeof value.hotkeyStop === 'string') {
    step.hotkeyStop = value.hotkeyStop;
  }
  if (step.type === 'claudeCode') {
    step.hotkey = typeof value.hotkey === 'string' ? value.hotkey : 'Control+Shift+KeyD';
    step.afterStopMs = normalizeAfterStopMs(value.afterStopMs);
    step.liveTranscription = value.liveTranscription !== false;
  }
  if (step.type === 'startRecording') {
    step.afterStopMs = normalizeAfterStopMs(value.afterStopMs);
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
    step.returnFocusToOriginalWindow = value.returnFocusToOriginalWindow === true;
    step.soundSuccess = value.soundSuccess === 'chord' || value.soundSuccess === 'click' || value.soundSuccess === 'none'
      ? value.soundSuccess
      : soundDefaults.insert;
  }
  if (step.type === 'copy') step.clipboardHistoryLevel = normalizeClipboardHistoryLevel(value.clipboardHistoryLevel);
  if (step.type === 'transcribe') step.transcription = normalizeTranscriptionSettings(value.transcription, defaults.transcription);
  if (step.type === 'postprocess') step.postprocessing = normalizePostprocessingSettings(value.postprocessing, defaults.postprocessing);
  if (step.type === 'speak') {
    step.speechProvider = normalizeSpeechProvider(value.speechProvider);
    step.speechSettings = normalizeSpeechSettings(isRecord(value.speechSettings) ? value.speechSettings : undefined);
    step.speechProviders = normalizeSpeechProviders(value.speechProviders);
  }
  return step;
}

function normalizeTranscriptionSettings(value: unknown, defaults: TranscriptionStepSettings): TranscriptionStepSettings {
  if (!isRecord(value)) return { ...defaults };
  return {
    provider: value.provider === 'none' || value.provider === 'google-cloud' || value.provider === 'gemini' ? value.provider : 'groq',
    ...(isRecord(value.googleCloud) ? { googleCloud: normalizeGoogleCloudSettings(value.googleCloud) } : {}),
    ...(isRecord(value.geminiTranscription) ? { geminiTranscription: normalizeGeminiTranscriptionSettings(value.geminiTranscription) } : {}),
    apiKey: stringValue(value.apiKey, defaults.apiKey),
    model: stringValue(value.model, defaults.model),
    prompt: stringValue(value.prompt, defaults.prompt),
    temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : defaults.temperature,
    language: stringValue(value.language, defaults.language),
    responseFormat: value.responseFormat === 'json' || value.responseFormat === 'text' ? value.responseFormat : 'verbose_json',
    liveTranscriptionEnabled: typeof value.liveTranscriptionEnabled === 'boolean'
      ? value.liveTranscriptionEnabled : defaults.liveTranscriptionEnabled,
    retranscribeFullRecording: value.retranscribeFullRecording === true,
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
