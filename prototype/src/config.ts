export type OverlayState = 'idle' | 'recording' | 'transcribing' | 'editing' | 'error';
import { isAndroid, androidCall } from './android-runtime';
import { refreshScenarioTriggerClaims } from './scenario-triggers';
import { VOICE_TRANSCRIPTION_PROMPT, LEGACY_VOICE_TRANSCRIPTION_PROMPT, LEGACY_MULTILINGUAL_TRANSCRIPTION_PROMPT, LEGACY_VOICE_INPUT_CLEANUP_PROMPT, LEGACY_VOICE_ANSWER_PROMPT, VOICE_INPUT_CLEANUP_PROMPT, VOICE_ANSWER_PROMPT } from './scenario-prompts';
import { walkScenarioSteps } from './scenario-tree';

import {
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_API_KEY,
  DEFAULT_GROQ_MODEL,
} from './defaults';
import {
  createDefaultScenario,
  createVoiceAnswerScenario,
  createStep,
  DEFAULT_SCENARIO_SOUND_SETTINGS,
  DEFAULT_SCENARIO_STEP_SETTINGS,
  normalizeScenarios,
  type ScenarioSoundSettingsDefaults,
  type ScenarioStepSettingsDefaults,
} from './scenario';

export interface OverlayPosition {
  x: number;
  y: number;
  // Центр по горизонтали не зависит от ширины содержимого окна.
  centerX?: number;
}

export interface AppSettings {
  startupMode: '' | 'window' | 'hidden-taskbar' | 'tray';
  // Горячие клавиши
  hotkeyRecord: string;
  hotkeyCancel: string;
  hotkeyPause: string;
  hotkeyResume: string;
  // Провайдер распознавания
  provider: 'groq' | 'none';
  groqApiKey: string;
  groqModel: string;
  groqPrompt: string;
  groqTemperature: number;
  groqLanguage: string;
  groqResponseFormat: 'verbose_json' | 'json' | 'text';
  // Пост-процессинг текста (Описание приложения.md:87, 114-118)
  postProcessEnabled: boolean;
  postProcessProvider: 'gemini' | 'none';
  geminiApiKey: string;
  geminiModel: string;
  geminiPrompt: string;
  // Поведение оверлея
  liveTranscriptionEnabled: boolean;
  liveSilenceDurationMs: number;
  liveMaxChunkDurationSeconds: number;
  liveChunkOverlapSeconds: number;
  position: OverlayPosition | null;
  overlayFollowCursorMonitor: boolean;
  overlayMaxWidthPercent: number;
  // Звуковая индикация событий
  soundEnabled: boolean;
  soundProfile: 'default' | 'soft';
  soundStart: 'chime' | 'beep' | 'none';
  soundSuccess: 'chord' | 'click' | 'none';
  soundCancel: 'low' | 'none';
  soundError: 'buzz' | 'none';
  // Вставка
  autoCopyClipboard: boolean;
  autoPasteActiveWindow: boolean;
  // История
  historyMaxItems: number;
  // Сценарии обработки
  scenarios: import('./scenario').Scenario[];
  activeScenarioId: string;
  androidScenarioId: string;
  scenarioVersion: number;
}

export const SETTINGS_STORAGE_KEY = 'stt_app_settings';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? parseSettingsJson(raw) : defaultSettings();
  } catch (e) {
    console.error('Ошибка чтения конфигурации:', e);
  }
  return defaultSettings();
}

export function parseSettingsJson(raw: string): AppSettings {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new TypeError('Конфигурация должна быть JSON-объектом.');
  return normalizeSettings(parsed);
}

export function normalizeSettings(value: unknown): AppSettings {
  const source = isRecord(value) ? value : {};
  const defaults = defaultSettings();
  const stringValue = (key: keyof AppSettings): string =>
    typeof source[key] === 'string' ? source[key] as string : defaults[key] as string;
  const numberValue = (key: keyof AppSettings): number =>
    typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] as number : defaults[key] as number;
  const booleanValue = (key: keyof AppSettings): boolean =>
    typeof source[key] === 'boolean' ? source[key] as boolean : defaults[key] as boolean;
  const enumValue = <T extends string>(key: keyof AppSettings, values: readonly T[], fallback: T): T =>
    typeof source[key] === 'string' && values.includes(source[key] as T) ? source[key] as T : fallback;

  const oldRecordHotkey = source.hotkeyRecord === 'Space' ? 'Control+Shift+KeyD' : stringValue('hotkeyRecord');
  const oldPauseHotkey = source.hotkeyPause === 'KeyP' || source.hotkeyPause === 'F2'
    ? 'Control+Alt+KeyD' : stringValue('hotkeyPause');
  const oldResumeHotkey = source.hotkeyResume === 'KeyP' || source.hotkeyResume === 'F2'
    ? 'Control+Alt+KeyD' : stringValue('hotkeyResume');
  const rawScenarios = Array.isArray(source.scenarios) ? source.scenarios.filter(isRecord) : [];
  const requestedScenarioId = typeof source.activeScenarioId === 'string' ? source.activeScenarioId : '';
  const rawActiveScenario = rawScenarios.find(item => item.id === requestedScenarioId) ?? rawScenarios[0];
  const rawSteps = rawActiveScenario && Array.isArray(rawActiveScenario.steps)
    ? rawActiveScenario.steps.filter(isRecord)
    : [];
  const rawTrigger = rawSteps.find(step => step.type === 'startRecording');
  const oldCancelHotkey = typeof source.hotkeyCancel === 'string'
    ? source.hotkeyCancel
    : typeof rawTrigger?.hotkeyCancel === 'string' ? rawTrigger.hotkeyCancel : defaults.hotkeyCancel;
  const position = isRecord(source.position)
    && typeof source.position.x === 'number' && Number.isFinite(source.position.x)
    && typeof source.position.y === 'number' && Number.isFinite(source.position.y)
    ? {
      x: source.position.x,
      y: source.position.y,
      ...(typeof source.position.centerX === 'number' && Number.isFinite(source.position.centerX)
        ? { centerX: source.position.centerX } : {}),
    }
    : null;

  const normalized: Omit<AppSettings, 'scenarios' | 'activeScenarioId' | 'androidScenarioId' | 'scenarioVersion'> = {
    startupMode: enumValue('startupMode', ['', 'window', 'hidden-taskbar', 'tray'],
      source.hideTaskbar === true ? 'tray' : defaults.startupMode),
    hotkeyRecord: oldRecordHotkey,
    hotkeyCancel: oldCancelHotkey,
    hotkeyPause: oldPauseHotkey,
    hotkeyResume: oldResumeHotkey,
    provider: enumValue('provider', ['groq', 'none'], defaults.provider),
    groqApiKey: stringValue('groqApiKey'),
    groqModel: stringValue('groqModel'),
    groqPrompt: stringValue('groqPrompt'),
    groqTemperature: numberValue('groqTemperature'),
    groqLanguage: stringValue('groqLanguage'),
    groqResponseFormat: enumValue('groqResponseFormat', ['verbose_json', 'json', 'text'], defaults.groqResponseFormat),
    postProcessEnabled: booleanValue('postProcessEnabled'),
    postProcessProvider: enumValue('postProcessProvider', ['gemini', 'none'], defaults.postProcessProvider),
    geminiApiKey: stringValue('geminiApiKey'),
    geminiModel: stringValue('geminiModel'),
    geminiPrompt: stringValue('geminiPrompt'),
    liveTranscriptionEnabled: typeof source.liveTranscriptionEnabled === 'boolean'
      ? source.liveTranscriptionEnabled
      : typeof source.showTranscription === 'boolean' ? source.showTranscription : defaults.liveTranscriptionEnabled,
    liveSilenceDurationMs: numberValue('liveSilenceDurationMs'),
    liveMaxChunkDurationSeconds: numberValue('liveMaxChunkDurationSeconds'),
    liveChunkOverlapSeconds: numberValue('liveChunkOverlapSeconds'),
    position,
    overlayFollowCursorMonitor: booleanValue('overlayFollowCursorMonitor'),
    overlayMaxWidthPercent: numberValue('overlayMaxWidthPercent'),
    soundEnabled: booleanValue('soundEnabled'),
    soundProfile: enumValue('soundProfile', ['default', 'soft'], defaults.soundProfile),
    soundStart: enumValue('soundStart', ['chime', 'beep', 'none'], defaults.soundStart),
    soundSuccess: enumValue('soundSuccess', ['chord', 'click', 'none'], defaults.soundSuccess),
    soundCancel: enumValue('soundCancel', ['low', 'none'], defaults.soundCancel),
    soundError: enumValue('soundError', ['buzz', 'none'], defaults.soundError),
    autoCopyClipboard: booleanValue('autoCopyClipboard'),
    autoPasteActiveWindow: booleanValue('autoPasteActiveWindow'),
    historyMaxItems: numberValue('historyMaxItems'),
  };

  // Переносим прежние общие настройки звука в сценарные шаги при загрузке.
  const soundSettings: ScenarioSoundSettingsDefaults = {
    enabled: normalized.soundEnabled,
    profile: normalized.soundProfile,
    insert: normalized.soundSuccess,
  };

  const fallbackScenario = createDefaultScenario(
    false,
    normalized.autoPasteActiveWindow ? 'paste' : 'copy',
    normalized.hotkeyRecord,
    normalized.soundStart,
    settingsFromLegacy(normalized),
    soundSettings,
    normalized.hotkeyPause,
  );
  if (isAndroid) fallbackScenario.steps.find(step => step.type === 'paste')!.enabled = normalized.autoPasteActiveWindow;
  const stepSettings = settingsFromLegacy(normalized);
  const scenarios = normalizeScenarios(source.scenarios, fallbackScenario, normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings);
  const storedScenarioVersion = typeof source.scenarioVersion === 'number' && Number.isFinite(source.scenarioVersion)
    ? source.scenarioVersion
    : 0;
  if (storedScenarioVersion < 14) for (const scenario of scenarios) {
    if (scenario.id === 'default-scenario' && ['По умолчанию', 'Стандартный сценарий'].includes(scenario.name)) scenario.name = 'Голосовой ввод';
  }
  // Переносим прежнюю общую клавишу паузы в настройки шага записи.
  for (const scenario of scenarios) {
    const trigger = scenario.steps.find(step => step.type === 'startRecording');
    if (trigger && !trigger.hotkeyPause) trigger.hotkeyPause = normalized.hotkeyPause;
  }
  if (storedScenarioVersion < 3) {
    const defaultScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    if (defaultScenario && !defaultScenario.steps.some(step => step.type === 'postprocess')) {
      const deliveryIndex = defaultScenario.steps.findIndex(step => step.type === 'copy' || step.type === 'paste');
      if (deliveryIndex >= 0) defaultScenario.steps.splice(deliveryIndex, 0, createStep('postprocess', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
    }
  }
  if (storedScenarioVersion < 4) {
    const defaultScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    if (defaultScenario) {
      const copyIndex = defaultScenario.steps.findIndex(step => step.type === 'copy');
      const pasteIndex = defaultScenario.steps.findIndex(step => step.type === 'paste');
      if (copyIndex < 0 && pasteIndex >= 0) {
        defaultScenario.steps.splice(pasteIndex, 0, createStep('copy', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
      } else if (copyIndex >= 0 && pasteIndex < 0) {
        defaultScenario.steps.splice(copyIndex + 1, 0, createStep('paste', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
      }
    }
  }
  if (storedScenarioVersion < 7) {
    const defaultScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const postprocessStep = defaultScenario?.steps.find(step => step.type === 'postprocess');
    if (postprocessStep) {
      postprocessStep.enabled = false;
    }
  }
  if (storedScenarioVersion < 8) {
    const defaultScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const pasteStep = defaultScenario?.steps.find(step => step.type === 'paste');
    if (pasteStep) pasteStep.enabled = true;
  }
  if (isAndroid && storedScenarioVersion < 10) {
    const defaultScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const pasteStep = defaultScenario?.steps.find(step => step.type === 'paste');
    if (pasteStep) pasteStep.enabled = true;
  }
  if (storedScenarioVersion < 11) {
    for (const scenario of scenarios) {
      if (scenario.id !== 'default-scenario' && !scenario.name.startsWith('По умолчанию')) continue;
      const copyIndex = scenario.steps.findIndex(step => step.type === 'copy');
      const copy = scenario.steps[copyIndex];
      const paste = scenario.steps[copyIndex + 1];
      if (copy && paste?.type === 'paste' && !copy.parallelGroup && !paste.parallelGroup) {
        copy.parallelGroup = paste.parallelGroup = 'default-delivery';
      }
    }
  }
  if (storedScenarioVersion < 12 && !scenarios.some(scenario => scenario.id === 'voice-answer-scenario' || scenario.name === 'Голосовой ответ')) {
    scenarios.push(createVoiceAnswerScenario(stepSettings));
  }
  if (storedScenarioVersion < 13) {
    const trigger = scenarios.find(scenario => scenario.id === 'voice-answer-scenario')?.steps.find(step => step.type === 'startRecording');
    if (trigger && !trigger.hotkey?.trim()) trigger.hotkey = 'Control+Shift+KeyR';
  }
  if (storedScenarioVersion < 15) for (const scenario of scenarios) {
    if (scenario.id !== 'default-scenario' && scenario.id !== 'voice-answer-scenario') continue;
    const transcription = scenario.steps.find(step => step.type === 'transcribe')?.transcription;
    if (transcription && !transcription.prompt.trim()) transcription.prompt = VOICE_TRANSCRIPTION_PROMPT;
    const postprocessing = scenario.steps.find(step => step.type === 'postprocess')?.postprocessing;
    if (postprocessing && (!postprocessing.prompt.trim() || scenario.id === 'voice-answer-scenario'
      && postprocessing.prompt === 'Ответь на запрос пользователя кратко и по существу. Текст ответа будет прочитан вслух.')) {
      postprocessing.prompt = scenario.id === 'default-scenario' ? VOICE_INPUT_CLEANUP_PROMPT : VOICE_ANSWER_PROMPT;
    }
  }
  if (storedScenarioVersion < 16) for (const scenario of scenarios) {
    for (const step of walkScenarioSteps(scenario.steps)) {
      if (step.transcription?.prompt === LEGACY_VOICE_TRANSCRIPTION_PROMPT) step.transcription.prompt = VOICE_TRANSCRIPTION_PROMPT;
    }
  }
  if (storedScenarioVersion < 17) for (const scenario of scenarios) {
    for (const step of walkScenarioSteps(scenario.steps)) {
      const transcription = step.transcription;
      if (transcription && (transcription.prompt === LEGACY_VOICE_TRANSCRIPTION_PROMPT
        || transcription.prompt === LEGACY_MULTILINGUAL_TRANSCRIPTION_PROMPT)) {
        transcription.prompt = VOICE_TRANSCRIPTION_PROMPT;
      }
      const postprocessing = step.postprocessing;
      if (postprocessing?.prompt === LEGACY_VOICE_INPUT_CLEANUP_PROMPT) postprocessing.prompt = VOICE_INPUT_CLEANUP_PROMPT;
      if (postprocessing?.prompt === LEGACY_VOICE_ANSWER_PROMPT) postprocessing.prompt = VOICE_ANSWER_PROMPT;
    }
  }
  const activeScenarioId = scenarios.some(scenario => scenario.id === requestedScenarioId)
    ? requestedScenarioId
    : scenarios[0]?.id ?? '';
  const androidScenarioId = scenarios.some(scenario => scenario.id === source.androidScenarioId)
    ? source.androidScenarioId as string
    : activeScenarioId;
  // Older versions ran only the selected scenario. Preserve that behavior on migration.
  for (const scenario of scenarios) {
    const raw = rawScenarios.find(item => item.id === scenario.id);
    if (raw && typeof raw.enabled !== 'boolean') scenario.enabled = scenario.id === activeScenarioId;
  }
  refreshScenarioTriggerClaims(scenarios);
  const activeScenario = scenarios.find(scenario => scenario.id === activeScenarioId);
  const trigger = activeScenario?.steps.find(step => step.type === 'startRecording');
  const transcription = activeScenario?.steps.find(step => step.type === 'transcribe')?.transcription;
  const postprocessing = activeScenario?.steps.find(step => step.type === 'postprocess')?.postprocessing;
  return {
    ...normalized,
    hotkeyRecord: trigger?.hotkey ?? normalized.hotkeyRecord,
    hotkeyPause: trigger?.hotkeyPause ?? normalized.hotkeyPause,
    hotkeyCancel: normalized.hotkeyCancel,
    soundStart: trigger?.sound ?? normalized.soundStart,
    soundEnabled: trigger?.soundEnabled ?? normalized.soundEnabled,
    soundProfile: trigger?.soundProfile ?? normalized.soundProfile,
    soundSuccess: activeScenario?.steps.find(step => step.type === 'paste')?.soundSuccess ?? normalized.soundSuccess,
    provider: transcription?.provider ?? normalized.provider,
    groqApiKey: transcription?.apiKey ?? normalized.groqApiKey,
    groqModel: transcription?.model ?? normalized.groqModel,
    groqPrompt: transcription?.prompt ?? normalized.groqPrompt,
    groqTemperature: transcription?.temperature ?? normalized.groqTemperature,
    groqLanguage: transcription?.language ?? normalized.groqLanguage,
    groqResponseFormat: transcription?.responseFormat ?? normalized.groqResponseFormat,
    liveSilenceDurationMs: transcription?.liveSilenceDurationMs ?? normalized.liveSilenceDurationMs,
    liveMaxChunkDurationSeconds: transcription?.liveMaxChunkDurationSeconds ?? normalized.liveMaxChunkDurationSeconds,
    liveChunkOverlapSeconds: transcription?.liveChunkOverlapSeconds ?? normalized.liveChunkOverlapSeconds,
    liveTranscriptionEnabled: transcription?.liveTranscriptionEnabled ?? normalized.liveTranscriptionEnabled,
    postProcessProvider: postprocessing?.provider ?? normalized.postProcessProvider,
    geminiApiKey: postprocessing?.apiKey ?? normalized.geminiApiKey,
    geminiModel: postprocessing?.model ?? normalized.geminiModel,
    geminiPrompt: postprocessing?.prompt ?? normalized.geminiPrompt,
    postProcessEnabled: activeScenario?.steps.some(step => step.enabled && step.type === 'postprocess') ?? false,
    autoCopyClipboard: activeScenario?.steps.some(step => step.enabled && step.type === 'copy') ?? false,
    autoPasteActiveWindow: activeScenario?.steps.some(step => step.enabled && step.type === 'paste') ?? false,
    scenarios,
    activeScenarioId,
    androidScenarioId,
    scenarioVersion: 17,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultSettings(): AppSettings {
  const scenario = createDefaultScenario(false, 'paste', 'Control+Shift+KeyD', 'chime', DEFAULT_SCENARIO_STEP_SETTINGS, DEFAULT_SCENARIO_SOUND_SETTINGS, 'Control+Alt+KeyD');
  return {
    hotkeyRecord: 'Control+Shift+KeyD',
    startupMode: '',
    hotkeyCancel: 'Escape',
    hotkeyPause: 'Control+Alt+KeyD',
    hotkeyResume: 'Control+Alt+KeyD',
    provider: 'groq',
    groqApiKey: DEFAULT_GROQ_API_KEY,
    groqModel: DEFAULT_GROQ_MODEL,
    groqPrompt: '',
    groqTemperature: 0.0,
    groqLanguage: 'auto',
    groqResponseFormat: 'verbose_json',
    postProcessEnabled: false,
    postProcessProvider: 'gemini',
    geminiApiKey: DEFAULT_GEMINI_API_KEY,
    geminiModel: DEFAULT_GEMINI_MODEL,
    geminiPrompt: '',
    liveTranscriptionEnabled: true,
    liveSilenceDurationMs: 700,
    liveMaxChunkDurationSeconds: 9,
    liveChunkOverlapSeconds: 0.5,
    position: null,
    overlayFollowCursorMonitor: false,
    overlayMaxWidthPercent: 50,
    soundEnabled: DEFAULT_SCENARIO_SOUND_SETTINGS.enabled,
    soundProfile: DEFAULT_SCENARIO_SOUND_SETTINGS.profile,
    soundStart: 'chime',
    soundSuccess: 'chord',
    soundCancel: 'low',
    soundError: 'buzz',
    autoCopyClipboard: true,
    autoPasteActiveWindow: true,
    historyMaxItems: 10,
    scenarios: [scenario, createVoiceAnswerScenario()],
    activeScenarioId: scenario.id,
    androidScenarioId: scenario.id,
    scenarioVersion: 17,
  };
}

function settingsFromLegacy(settings: Omit<AppSettings, 'scenarios' | 'activeScenarioId' | 'androidScenarioId' | 'scenarioVersion'>): ScenarioStepSettingsDefaults {
  return {
    transcription: {
      provider: settings.provider,
      apiKey: settings.groqApiKey,
      model: settings.groqModel,
      prompt: settings.groqPrompt,
      temperature: settings.groqTemperature,
      language: settings.groqLanguage,
      responseFormat: settings.groqResponseFormat,
      liveTranscriptionEnabled: settings.liveTranscriptionEnabled,
      liveSilenceDurationMs: settings.liveSilenceDurationMs,
      liveMaxChunkDurationSeconds: settings.liveMaxChunkDurationSeconds,
      liveChunkOverlapSeconds: settings.liveChunkOverlapSeconds,
    },
    postprocessing: {
      provider: settings.postProcessProvider,
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      prompt: settings.geminiPrompt,
    },
  };
}

export function resetGeneralSettings(settings: AppSettings): AppSettings {
  const reset = normalizeSettings({
    ...defaultSettings(),
    scenarios: settings.scenarios,
    activeScenarioId: settings.activeScenarioId,
    androidScenarioId: settings.androidScenarioId,
    scenarioVersion: settings.scenarioVersion,
  });
  // Scenario settings also have legacy mirrors at the top level.
  return { ...reset, scenarios: settings.scenarios, activeScenarioId: settings.activeScenarioId, scenarioVersion: settings.scenarioVersion };
}

export function saveSettings(cfg: AppSettings): void {
  try {
    refreshScenarioTriggerClaims(cfg.scenarios);
    const text = JSON.stringify(cfg);
    localStorage.setItem(SETTINGS_STORAGE_KEY, text);
    if (isAndroid) void androidCall('saveBubbleConfiguration', { text }).catch(console.warn);
  } catch (e) {
    console.error('Ошибка сохранения конфигурации:', e);
  }
}

// Панель и оверлей записывают разные части общей конфигурации.
export function saveSettingsPreservingOverlayPosition(cfg: AppSettings): void {
  cfg.position = loadSettings().position;
  saveSettings(cfg);
}

export function saveOverlayPosition(position: OverlayPosition): void {
  const settings = loadSettings();
  settings.position = position;
  saveSettings(settings);
}

// Алиасы для оверлея
export type OverlayConfig = AppSettings;
export const loadConfig = loadSettings;
export const saveConfig = saveSettings;
