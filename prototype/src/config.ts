export type OverlayState = 'idle' | 'recording' | 'transcribing' | 'editing' | 'error';
import { isAndroid, androidCall } from './android-runtime';

import {
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_API_KEY,
  DEFAULT_GROQ_MODEL,
} from './defaults';
import {
  createDefaultScenario,
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

  const oldRecordHotkey = source.hotkeyRecord === 'Space' ? 'Control+Digit1' : stringValue('hotkeyRecord');
  const oldPauseHotkey = source.hotkeyPause === 'KeyP' || source.hotkeyPause === 'F2'
    ? 'Control+Digit2' : stringValue('hotkeyPause');
  const oldResumeHotkey = source.hotkeyResume === 'KeyP' || source.hotkeyResume === 'F2'
    ? 'Control+Digit2' : stringValue('hotkeyResume');
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

  const normalized: Omit<AppSettings, 'scenarios' | 'activeScenarioId' | 'scenarioVersion'> = {
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
  // Переносим прежнюю общую клавишу паузы в настройки шага записи.
  for (const scenario of scenarios) {
    const trigger = scenario.steps.find(step => step.type === 'startRecording');
    if (trigger && !trigger.hotkeyPause) trigger.hotkeyPause = normalized.hotkeyPause;
  }
  if (storedScenarioVersion < 3) {
    const standardScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    if (standardScenario && !standardScenario.steps.some(step => step.type === 'postprocess')) {
      const deliveryIndex = standardScenario.steps.findIndex(step => step.type === 'copy' || step.type === 'paste');
      if (deliveryIndex >= 0) standardScenario.steps.splice(deliveryIndex, 0, createStep('postprocess', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
    }
  }
  if (storedScenarioVersion < 4) {
    const standardScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    if (standardScenario) {
      const copyIndex = standardScenario.steps.findIndex(step => step.type === 'copy');
      const pasteIndex = standardScenario.steps.findIndex(step => step.type === 'paste');
      if (copyIndex < 0 && pasteIndex >= 0) {
        standardScenario.steps.splice(pasteIndex, 0, createStep('copy', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
      } else if (copyIndex >= 0 && pasteIndex < 0) {
        standardScenario.steps.splice(copyIndex + 1, 0, createStep('paste', normalized.hotkeyRecord, normalized.soundStart, stepSettings, soundSettings));
      }
    }
  }
  if (storedScenarioVersion < 7) {
    const standardScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const postprocessStep = standardScenario?.steps.find(step => step.type === 'postprocess');
    if (postprocessStep) {
      postprocessStep.enabled = false;
    }
  }
  if (storedScenarioVersion < 8) {
    const standardScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const pasteStep = standardScenario?.steps.find(step => step.type === 'paste');
    if (pasteStep) pasteStep.enabled = true;
  }
  if (isAndroid && storedScenarioVersion < 10) {
    const standardScenario = scenarios.find(scenario =>
      scenario.id === 'default-scenario' || scenario.name === 'Стандартный сценарий',
    );
    const pasteStep = standardScenario?.steps.find(step => step.type === 'paste');
    if (pasteStep) pasteStep.enabled = true;
  }
  const activeScenarioId = scenarios.some(scenario => scenario.id === requestedScenarioId)
    ? requestedScenarioId
    : scenarios[0].id;
  const activeScenario = scenarios.find(scenario => scenario.id === activeScenarioId)!;
  const trigger = activeScenario.steps.find(step => step.type === 'startRecording');
  const transcription = activeScenario.steps.find(step => step.type === 'transcribe')?.transcription;
  const postprocessing = activeScenario.steps.find(step => step.type === 'postprocess')?.postprocessing;
  return {
    ...normalized,
    hotkeyRecord: trigger?.hotkey ?? normalized.hotkeyRecord,
    hotkeyPause: trigger?.hotkeyPause ?? normalized.hotkeyPause,
    hotkeyCancel: normalized.hotkeyCancel,
    soundStart: trigger?.sound ?? normalized.soundStart,
    soundEnabled: trigger?.soundEnabled ?? normalized.soundEnabled,
    soundProfile: trigger?.soundProfile ?? normalized.soundProfile,
    soundSuccess: activeScenario.steps.find(step => step.type === 'paste')?.soundSuccess ?? normalized.soundSuccess,
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
    postProcessEnabled: activeScenario.steps.some(step => step.enabled && step.type === 'postprocess'),
    autoCopyClipboard: activeScenario.steps.some(step => step.enabled && step.type === 'copy'),
    autoPasteActiveWindow: activeScenario.steps.some(step => step.enabled && step.type === 'paste'),
    scenarios,
    activeScenarioId,
    scenarioVersion: 10,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultSettings(): AppSettings {
  const scenario = createDefaultScenario(false, 'paste', 'Control+Digit1', 'chime', DEFAULT_SCENARIO_STEP_SETTINGS, DEFAULT_SCENARIO_SOUND_SETTINGS, 'Control+Digit2');
  return {
    hotkeyRecord: 'Control+Digit1',
    startupMode: '',
    hotkeyCancel: 'Escape',
    hotkeyPause: 'Control+Digit2',
    hotkeyResume: 'Control+Digit2',
    provider: 'groq',
    groqApiKey: DEFAULT_GROQ_API_KEY,
    groqModel: DEFAULT_GROQ_MODEL,
    groqPrompt: '',
    groqTemperature: 0.0,
    groqLanguage: 'ru',
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
    scenarios: [scenario],
    activeScenarioId: scenario.id,
    scenarioVersion: 10,
  };
}

function settingsFromLegacy(settings: Omit<AppSettings, 'scenarios' | 'activeScenarioId' | 'scenarioVersion'>): ScenarioStepSettingsDefaults {
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

export function saveSettings(cfg: AppSettings): void {
  try {
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
