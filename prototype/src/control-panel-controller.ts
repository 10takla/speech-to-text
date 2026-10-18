import { resetGeneralSettings, loadSettings, parseSettingsJson, saveSettings as persistSettings, saveSettingsPreservingOverlayPosition as persistSettingsPreservingOverlayPosition } from './config';
import { scenarioBindings } from './scenario-triggers';
import { confirmAction } from './confirmation-dialog';
import { isTauri } from '@tauri-apps/api/core';
import { createHistoryView } from './history-view';
import { invokeCommand } from './tauri-commands';
import { errorMessage } from './error-message';
import { mountScenarioEditor } from './scenario-editor';
import { updateScenarioResetButtons } from './scenario-list';
import { isBrowserOverlayPreviewEnabled, sendOverlayWidthPreview } from './browser-overlay-preview';
import { isAndroid, androidCall } from './android-runtime';
import { fetchGeminiTextModels, fetchGroqSpeechModels, geminiModelParameters, selectAvailableGeminiModel, type ProviderModel, type GeminiGenerationSettings } from './provider-models';
import { getRecentLogs, initLoggerForwarding } from './logger';

initLoggerForwarding('control-panel');

function selectValue<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.find(candidate => candidate === value) ?? fallback;
}

// Элементы формы
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
const groqLanguage = document.getElementById('groq-language') as HTMLSelectElement;
const groqTemperature = document.getElementById('groq-temperature') as HTMLInputElement;
const groqPrompt = document.getElementById('groq-prompt') as HTMLInputElement;

// Элементы пост-процессинга текста (Описание приложения.md:87, 114-118)
const postProcessProvider = document.getElementById('post-process-provider') as HTMLSelectElement;
const geminiApiKey = document.getElementById('gemini-api-key') as HTMLInputElement;
const geminiModel = document.getElementById('gemini-model') as HTMLSelectElement;
const geminiPrompt = document.getElementById('gemini-prompt') as HTMLInputElement;

const toggleLiveTranscription = document.getElementById('toggle-live-transcription') as HTMLInputElement;
const liveTranscriptionParameters = document.getElementById('live-transcription-parameters') as HTMLElement;
const liveSilenceDuration = document.getElementById('live-silence-duration') as HTMLInputElement;
const liveMaxChunkDuration = document.getElementById('live-max-chunk-duration') as HTMLInputElement;
const liveChunkOverlap = document.getElementById('live-chunk-overlap') as HTMLInputElement;
const overlayMaxWidthPercent = document.getElementById('overlay-max-width-percent') as HTMLInputElement;
const overlayMaxWidthSlider = document.getElementById('overlay-max-width-slider') as HTMLInputElement;
const toggleOverlayMonitorMovement = document.getElementById('toggle-overlay-monitor-movement') as HTMLInputElement;
const btnResetPos = document.getElementById('btn-reset-pos') as HTMLButtonElement;

const saveStatus = document.getElementById('save-status') as HTMLElement;
const groqModelStatus = document.getElementById('groq-model-status') as HTMLElement;
const geminiModelStatus = document.getElementById('gemini-model-status') as HTMLElement;
const refreshGroqModelsButton = document.getElementById('refresh-groq-models') as HTMLButtonElement;
const refreshGeminiModelsButton = document.getElementById('refresh-gemini-models') as HTMLButtonElement;

// Загрузка сохраненных настроек
let saveStatusTimer: ReturnType<typeof setTimeout> | undefined;
const settings = loadSettings();
function saveSettings(value: typeof settings) {
  persistSettings(value);
  refreshScenarioResetState();
}
function saveSettingsPreservingOverlayPosition(value: typeof settings) {
  persistSettingsPreservingOverlayPosition(value);
  refreshScenarioResetState();
}
function refreshScenarioResetState() {
  const root = document.getElementById('scenario-editor');
  if (root) updateScenarioResetButtons(root, settings.scenarios);
}
saveSettingsPreservingOverlayPosition(settings);

const startupMode = document.getElementById('startup-mode') as HTMLSelectElement;
const startupStatus = document.getElementById('startup-status') as HTMLElement;
function renderStartupSettings() {
  startupMode.value = settings.startupMode;
}
async function syncStartupSettings() {
  if (!isTauri() || isAndroid) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invokeCommand(invoke, 'set_startup_settings', { settings: { startupMode: settings.startupMode } });
  startupStatus.textContent = settings.startupMode
    ? 'Автозапуск при входе в Windows включён.'
    : 'Автозапуск выключен.';
}
renderStartupSettings();
if (isAndroid) document.getElementById('startup-settings')!.hidden = true;
if (!isTauri()) {
  startupMode.disabled = true;
  startupStatus.textContent = 'Автозапуск доступен в приложении для Windows.';
}
startupMode.addEventListener('change', async () => {
    const previous = settings.startupMode;
    startupMode.disabled = true;
    settings.startupMode = ['', 'window', 'hidden-taskbar', 'tray'].includes(startupMode.value)
      ? startupMode.value as typeof settings.startupMode : '';
    try {
      await syncStartupSettings();
      saveSettingsPreservingOverlayPosition(settings);
    } catch (error) {
      settings.startupMode = previous;
      renderStartupSettings();
      startupStatus.textContent = errorMessage(error);
    } finally {
      startupMode.disabled = !isTauri();
    }
  });

const overlayWidthField = overlayMaxWidthPercent.closest('.overlay-width-row, .form-field') as HTMLElement | null;

async function showOverlayWidthPreview() {
  if (isAndroid) return;
  const parsed = Number(overlayMaxWidthPercent.value);
  const percent = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 50;
  if (isBrowserOverlayPreviewEnabled()) {
    sendOverlayWidthPreview(percent);
    return;
  }
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo('overlay', 'overlay-width-preview', percent);
  } catch (error) {
    console.warn('Не удалось показать превью ширины оверлея:', error);
  }
}

async function hideOverlayWidthPreview() {
  if (isAndroid) return;
  if (isBrowserOverlayPreviewEnabled()) {
    sendOverlayWidthPreview(null);
    return;
  }
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo('overlay', 'overlay-width-preview', null);
  } catch (error) {
    console.warn('Не удалось скрыть превью ширины оверлея:', error);
  }
}

overlayWidthField?.addEventListener('mouseenter', showOverlayWidthPreview);
overlayWidthField?.addEventListener('mouseleave', () => { void hideOverlayWidthPreview(); });

if (providerSelect) providerSelect.value = settings.provider;
modelSelect.value = settings.groqModel;
apiKeyInput.value = settings.groqApiKey;
if (groqLanguage) groqLanguage.value = settings.groqLanguage || 'auto';
if (groqTemperature) groqTemperature.value = String(settings.groqTemperature ?? 0.0);
if (groqPrompt) groqPrompt.value = settings.groqPrompt || '';

if (postProcessProvider) postProcessProvider.value = settings.postProcessProvider || 'gemini';
if (geminiApiKey) geminiApiKey.value = settings.geminiApiKey;
if (geminiModel) geminiModel.value = settings.geminiModel;
if (geminiPrompt) geminiPrompt.value = settings.geminiPrompt || '';

function autoFitInputWidth(input: HTMLInputElement, minChars = 1) {
  let canvas: HTMLCanvasElement | null = null;
  const update = () => {
    const text = input.value || input.placeholder || '';
    if (!canvas) canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const style = window.getComputedStyle(input);
      ctx.font = `${style.fontWeight || 'normal'} ${style.fontSize || '12px'} ${style.fontFamily || 'monospace'}`;
      const measuredText = text || 'M'.repeat(minChars);
      const textWidth = ctx.measureText(measuredText).width;
      const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
      const spacingWidth = Math.max(0, measuredText.length - 1) * letterSpacing;
      input.style.width = `${Math.max(14, Math.ceil(textWidth + spacingWidth + 4))}px`;
    } else {
      const len = text.length;
      input.style.width = `${Math.max(minChars, len)}ch`;
    }
  };
  input.addEventListener('input', update);
  input.addEventListener('change', update);
  update();
}

toggleLiveTranscription.checked = settings.liveTranscriptionEnabled;
liveTranscriptionParameters.hidden = !toggleLiveTranscription.checked;
liveSilenceDuration.value = String(settings.liveSilenceDurationMs);
liveMaxChunkDuration.value = String(settings.liveMaxChunkDurationSeconds);
liveChunkOverlap.value = String(settings.liveChunkOverlapSeconds);
overlayMaxWidthPercent.value = String(settings.overlayMaxWidthPercent ?? 50);
overlayMaxWidthSlider.value = overlayMaxWidthPercent.value;

[liveSilenceDuration, liveMaxChunkDuration, liveChunkOverlap, overlayMaxWidthPercent].forEach((el) => {
  autoFitInputWidth(el);
});
toggleOverlayMonitorMovement.checked = settings.overlayFollowCursorMonitor;

function notifySaved() {
  clearTimeout(saveStatusTimer);
  const message = '✓ Настройки сохранены';
  saveStatus.textContent = message;
  saveStatus.style.color = '#34d399';
  saveStatusTimer = setTimeout(() => {
    if (saveStatus.textContent !== message) return;
    saveStatus.textContent = 'Все настройки сохраняются автоматически';
    saveStatus.style.color = 'var(--text-muted)';
  }, 1500);
}

let groqModelsRequest = 0;
let geminiModelsRequest = 0;

type ProviderCheck = { fingerprint: string; text: string; details: string; state: 'idle' | 'ready' | 'error' };
const providerChecks = new Map<'groq' | 'gemini', ProviderCheck>();
const providerCheckTimers = new Map<'groq' | 'gemini', number>();
const scheduledProviderChecks = new Map<'groq' | 'gemini', string>();
const activeProviderChecks = new Map<'groq' | 'gemini', AbortController>();
const modelCatalogs = new Map<'groq' | 'gemini', { key: string; models: ProviderModel[]; revision: number }>();
let modelCatalogRevision = 0;
let renderedModelParameters = '';

function rememberModels(provider: 'groq' | 'gemini', key: string, models: ProviderModel[]) {
  modelCatalogs.set(provider, { key, models, revision: ++modelCatalogRevision });
}

function selectedModelMetadata(provider: 'groq' | 'gemini'): ProviderModel | undefined {
  const catalog = modelCatalogs.get(provider);
  const key = (provider === 'groq' ? apiKeyInput : geminiApiKey).value.trim();
  if (catalog?.key !== key) return undefined;
  const id = (provider === 'groq' ? modelSelect : geminiModel).value;
  return catalog.models.find(model => model.id === id);
}

function updateModelMetadata() {
  for (const provider of ['groq', 'gemini'] as const) {
    const model = selectedModelMetadata(provider);
    const info = document.getElementById(`${provider}-model-info`);
    if (info) {
      const parts = [];
      if (model?.inputTokenLimit) parts.push(`${provider === 'groq' ? 'Контекст' : 'Вход'}: ${model.inputTokenLimit.toLocaleString('ru-RU')} токенов`);
      if (model?.outputTokenLimit) parts.push(`Ответ: до ${model.outputTokenLimit.toLocaleString('ru-RU')} токенов`);
      info.textContent = parts.join(' · ');
      info.title = model?.description || '';
    }
  }
  const root = document.getElementById('gemini-model-parameters');
  if (!root) return;
  const signature = JSON.stringify([settings.activeScenarioId, postProcessProvider.value, geminiApiKey.value.trim(), geminiModel.value, modelCatalogs.get('gemini')?.revision]);
  if (signature === renderedModelParameters) return;
  renderedModelParameters = signature;
  root.replaceChildren();
  const model = selectedModelMetadata('gemini');
  if (!model || postProcessProvider.value !== 'gemini') return;
  const step = settings.scenarios.find(scenario => scenario.id === settings.activeScenarioId)?.steps.find(step => step.type === 'postprocess');
  if (!step?.postprocessing) return;
  const values = step.postprocessing.generationConfig;
  const parameters = geminiModelParameters(model);
  for (const key of ['temperature', 'topP', 'topK', 'maxOutputTokens'] as const) {
    if (values?.[key] !== undefined && !parameters.some(parameter => parameter.key === key)) {
      parameters.push({ key, label: `${key} (не поддерживается)`, min: 0, step: 'any' });
    }
  }
  for (const parameter of parameters) {
    const label = document.createElement('label');
    label.className = 'form-field';
    label.append(document.createTextNode(`${parameter.label}:`));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(parameter.min);
    if (parameter.max !== undefined) input.max = String(parameter.max);
    input.step = parameter.step;
    input.dataset.generationParameter = parameter.key;
    input.value = String(values?.[parameter.key] ?? (values === undefined && parameter.key === 'temperature' ? 0.2 : ''));
    input.placeholder = parameter.defaultValue === undefined ? 'По умолчанию' : String(parameter.defaultValue);
    input.title = 'Пустое поле — значение по умолчанию у провайдера';
    input.addEventListener('input', () => {
      const legacyDefaults = geminiModelParameters(model).some(field => field.key === 'temperature') ? { temperature: 0.2 } : {};
      const config: GeminiGenerationSettings = { ...(step.postprocessing?.generationConfig ?? legacyDefaults) };
      if (!input.value) delete config[parameter.key];
      else if (input.validity.valid) config[parameter.key] = input.valueAsNumber;
      else { updateProviderReadiness(); return; }
      step.postprocessing!.generationConfig = config;
      saveSettingsPreservingOverlayPosition(settings);
      updateProviderReadiness();
      notifySaved();
    });
    label.append(input);
    root.append(label);
  }
}

function geminiLocalSettingsError(): string | null {
  const model = selectedModelMetadata('gemini');
  if (!model) return null;
  const allowed = geminiModelParameters(model);
  for (const input of document.querySelectorAll<HTMLInputElement>('#gemini-model-parameters input')) {
    if (!input.value) continue;
    const parameter = allowed.find(field => field.key === input.dataset.generationParameter);
    if (!parameter) return `Параметр ${input.dataset.generationParameter} не поддерживается выбранной моделью. Очистите поле.`;
    if (!input.validity.valid) return `Проверьте параметр «${parameter.label}» для выбранной модели.`;
  }
  return null;
}

function scheduleProviderChecks() {
  const scenario = settings.scenarios.find(item => item.id === settings.activeScenarioId);
  for (const provider of ['groq', 'gemini'] as const) {
    const hasStep = scenario?.steps.some(step => step.type === (provider === 'groq' ? 'transcribe' : 'postprocess'));
    const fingerprint = providerFingerprint(provider);
    const signature = fingerprint;
    if (scheduledProviderChecks.get(provider) === signature) continue;
    scheduledProviderChecks.set(provider, signature);
    window.clearTimeout(providerCheckTimers.get(provider));
    activeProviderChecks.get(provider)?.abort();
    activeProviderChecks.delete(provider);
    const selected = (provider === 'groq' ? providerSelect : postProcessProvider).value;
    const key = (provider === 'groq' ? apiKeyInput : geminiApiKey).value.trim();
    const model = (provider === 'groq' ? modelSelect : geminiModel).value;
    if (!hasStep || selected === 'none' || !key || !model) continue;
    providerCheckTimers.set(provider, window.setTimeout(() => {
      providerCheckTimers.delete(provider);
      void checkProviderSettings(provider);
    }, 700));
  }
}

function providerFingerprint(provider: 'groq' | 'gemini'): string {
  const fields = provider === 'groq'
    ? [providerSelect, apiKeyInput, modelSelect]
    : [postProcessProvider, geminiApiKey, geminiModel];
  return JSON.stringify(fields.map(field => field?.value));
}

function groqLocalSettingsError(): string | null {
  const temperature = Number(groqTemperature.value);
  if (!groqTemperature.value.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    return 'Температура должна быть от 0 до 1.';
  }
  if (!['auto', 'ru', 'en'].includes(groqLanguage.value)) return 'Выберите поддерживаемый язык.';
  return null;
}

async function checkProviderSettings(provider: 'groq' | 'gemini') {
  window.clearTimeout(providerCheckTimers.get(provider));
  providerCheckTimers.delete(provider);
  activeProviderChecks.get(provider)?.abort();
  const fingerprint = providerFingerprint(provider);
  const isGroq = provider === 'groq';
  const button = document.getElementById(`check-${provider}-settings`) as HTMLButtonElement;
  const key = (isGroq ? apiKeyInput : geminiApiKey).value.trim();
  const selected = (isGroq ? providerSelect : postProcessProvider).value;
  const model = (isGroq ? modelSelect : geminiModel).value;
  const abort = new AbortController();
  activeProviderChecks.set(provider, abort);
  const timeout = window.setTimeout(() => abort.abort(), 15000);
  button.disabled = true;
  providerChecks.set(provider, { fingerprint, text: 'Проверяется', details: '', state: 'idle' });
  updateProviderReadiness();
  try {
    if (selected === 'none') throw new Error('Выберите провайдера.');
    if (!key) throw new Error('Введите API-ключ.');
    if (!model) throw new Error('Выберите модель.');
    const models = isGroq
      ? await fetchGroqSpeechModels(key, abort.signal)
      : await fetchGeminiTextModels(key, abort.signal);
    if (!models.some(item => item.id === model)) throw new Error('Выбранная модель отсутствует в списке подходящих моделей провайдера.');
    if (fingerprint !== providerFingerprint(provider) || activeProviderChecks.get(provider) !== abort) return;
    rememberModels(provider, key, models);
    providerChecks.set(provider, {
      fingerprint, text: 'Ключ и модель проверены', state: 'ready',
      details: 'API отвечает, ключ принят, модель найдена. Параметры проверены локально. Обработка не запускалась; запросы API могут учитываться в ограничениях провайдера. Права и квота на обработку проверятся при выполнении шага.',
    });
  } catch (error) {
    if (fingerprint !== providerFingerprint(provider) || activeProviderChecks.get(provider) !== abort) return;
    providerChecks.set(provider, {
      fingerprint, text: 'Ошибка проверки', state: 'error',
      details: abort.signal.aborted ? 'Провайдер не ответил за 15 секунд.' : errorMessage(error),
    });
  } finally {
    window.clearTimeout(timeout);
    if (!activeProviderChecks.has(provider) || activeProviderChecks.get(provider) === abort) {
      activeProviderChecks.delete(provider);
      button.disabled = false;
      updateProviderReadiness();
    }
  }
}

async function refreshModelList(provider: 'groq' | 'gemini') {
  const isGroq = provider === 'groq';
  const select = isGroq ? modelSelect : geminiModel;
  const apiKey = (isGroq ? apiKeyInput : geminiApiKey).value.trim();
  const status = isGroq ? groqModelStatus : geminiModelStatus;
  const button = isGroq ? refreshGroqModelsButton : refreshGeminiModelsButton;
  const requestId = isGroq ? ++groqModelsRequest : ++geminiModelsRequest;
  if (!apiKey) {
    status.textContent = 'Введите API-ключ';
    status.className = 'model-load-status model-load-status--error';
    return;
  }

  status.textContent = 'Загрузка моделей…';
  status.className = 'model-load-status model-load-status--loading';
  button.disabled = true;
  try {
    const models = isGroq
      ? await fetchGroqSpeechModels(apiKey)
      : await fetchGeminiTextModels(apiKey);
    if (requestId !== (isGroq ? groqModelsRequest : geminiModelsRequest)) return;
    if (apiKey !== (isGroq ? apiKeyInput : geminiApiKey).value.trim()) return;
    if (!models.length) {
      throw new Error(isGroq
        ? 'API не вернуло модели распознавания речи.'
        : 'API не вернуло модели генерации текста.');
    }
    rememberModels(provider, apiKey, models);
    setModelOptions(select, models, isGroq ? settings.groqModel : selectAvailableGeminiModel(models, settings.geminiModel));
    status.textContent = `Моделей: ${models.length}`;
    status.className = 'model-load-status model-load-status--success';
    updateAndSave();
    updateProviderReadiness();
  } catch (error) {
    if (requestId !== (isGroq ? groqModelsRequest : geminiModelsRequest)) return;
    status.textContent = `Не удалось загрузить: ${error instanceof Error ? error.message : String(error)}`;
    status.className = 'model-load-status model-load-status--error';
  } finally {
    if (requestId === (isGroq ? groqModelsRequest : geminiModelsRequest)) button.disabled = false;
  }
}

function setModelOptions(select: HTMLSelectElement, models: ProviderModel[], currentModel: string) {
  const uniqueModels = [...new Map(models.map(model => [model.id, model])).values()];
  const hasCurrent = uniqueModels.some(model => model.id === currentModel);
  const options = uniqueModels.map(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    return option;
  });
  select.replaceChildren(...options);
  select.value = hasCurrent ? currentModel : (uniqueModels[0]?.id ?? '');
}

let lastRegisteredRecordHotkey: string | null = null;
let lastOverlayMonitorMovementSetting: boolean | null = null;
const scenarioEditorRoot = document.getElementById('scenario-editor');
const refreshScenarioEditor = scenarioEditorRoot
  ? mountScenarioEditor(scenarioEditorRoot, settings, () => {
      const activeScenario = settings.scenarios.find(scenario => scenario.id === settings.activeScenarioId);
      settings.postProcessEnabled = activeScenario?.steps.some(step => step.enabled && step.type === 'postprocess') ?? false;
      const trigger = activeScenario?.steps.find(step => step.type === 'startRecording');
      const paste = activeScenario?.steps.find(step => step.type === 'paste');
      const transcription = activeScenario?.steps.find(step => step.type === 'transcribe')?.transcription;
      const postprocessing = activeScenario?.steps.find(step => step.type === 'postprocess')?.postprocessing;
      if (trigger?.hotkey) settings.hotkeyRecord = trigger.hotkey;
      if (trigger?.hotkeyPause) settings.hotkeyPause = trigger.hotkeyPause;
      if (trigger?.sound) settings.soundStart = trigger.sound;
      if (trigger) {
        settings.soundEnabled = trigger.soundEnabled ?? settings.soundEnabled;
        settings.soundProfile = trigger.soundProfile ?? settings.soundProfile;
      }
      if (paste?.soundSuccess) settings.soundSuccess = paste.soundSuccess;
      if (transcription) {
        settings.provider = transcription.provider;
        settings.groqApiKey = transcription.apiKey;
        settings.groqModel = transcription.model;
        settings.groqPrompt = transcription.prompt;
        settings.groqTemperature = transcription.temperature;
        settings.groqLanguage = transcription.language;
        settings.groqResponseFormat = transcription.responseFormat;
        settings.liveTranscriptionEnabled = transcription.liveTranscriptionEnabled;
        settings.liveSilenceDurationMs = transcription.liveSilenceDurationMs;
        settings.liveMaxChunkDurationSeconds = transcription.liveMaxChunkDurationSeconds;
        settings.liveChunkOverlapSeconds = transcription.liveChunkOverlapSeconds;
        providerSelect.value = settings.provider;
        apiKeyInput.value = settings.groqApiKey;
        modelSelect.value = settings.groqModel;
        if (groqPrompt) groqPrompt.value = settings.groqPrompt;
        if (groqTemperature) groqTemperature.value = String(settings.groqTemperature);
        if (groqLanguage) groqLanguage.value = settings.groqLanguage;
        toggleLiveTranscription.checked = settings.liveTranscriptionEnabled;
        liveTranscriptionParameters.hidden = !toggleLiveTranscription.checked;
        liveSilenceDuration.value = String(settings.liveSilenceDurationMs);
        liveMaxChunkDuration.value = String(settings.liveMaxChunkDurationSeconds);
        liveChunkOverlap.value = String(settings.liveChunkOverlapSeconds);
      }
      if (postprocessing) {
        settings.postProcessProvider = postprocessing.provider;
        settings.geminiApiKey = postprocessing.apiKey;
        settings.geminiModel = postprocessing.model;
        settings.geminiPrompt = postprocessing.prompt;
        postProcessProvider.value = settings.postProcessProvider;
        geminiApiKey.value = settings.geminiApiKey;
        const catalog = modelCatalogs.get('gemini');
        if (catalog?.key === settings.geminiApiKey.trim()) {
          const selected = selectAvailableGeminiModel(catalog.models, settings.geminiModel);
          setModelOptions(geminiModel, catalog.models, selected);
          postprocessing.model = settings.geminiModel = geminiModel.value;
        } else {
          geminiModel.value = settings.geminiModel;
          if (settings.postProcessProvider === 'gemini' && settings.geminiApiKey.trim()) void refreshModelList('gemini');
        }
        if (geminiPrompt) geminiPrompt.value = settings.geminiPrompt;
      }
      settings.autoCopyClipboard = activeScenario?.steps.some(step => step.enabled && step.type === 'copy') ?? false;
      settings.autoPasteActiveWindow = activeScenario?.steps.some(step => step.enabled && step.type === 'paste') ?? false;
      saveSettingsPreservingOverlayPosition(settings);
      void syncRecordHotkey();
      if (`${settings.hotkeyPause}|${settings.hotkeyCancel}` !== lastRegisteredControlHotkeys) void syncControlHotkeys();
      updateProviderBlocksVisibility();
      updateProviderReadiness();
      notifySaved();
    })
  : () => {};

async function syncOverlayMonitorMovementSetting() {
  if (isAndroid) return;
  if (lastOverlayMonitorMovementSetting === settings.overlayFollowCursorMonitor) return;
  lastOverlayMonitorMovementSetting = settings.overlayFollowCursorMonitor;
  if (isBrowserOverlayPreviewEnabled()) return;
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo('overlay', 'overlay-monitor-movement-setting', settings.overlayFollowCursorMonitor);
  } catch (error) {
    console.warn('Не удалось передать настройку перемещения оверлея:', error);
  }
}

function toGlobalShortcut(configuredKey: string): string {
  return configuredKey.split('+').map((part) => {
    if (part === 'Control') return 'Ctrl';
    if (part === 'Meta') return 'Super';
    if (part.startsWith('Key')) return part.slice(3);
    if (part.startsWith('Digit')) return part.slice(5);
    return part;
  }).join('+');
}

let registeringScenarioHotkeys = false;
async function syncRecordHotkey() {
  if (isAndroid || !isTauri() || registeringScenarioHotkeys) return;
  const bindings = scenarioBindings(settings.scenarios, settings.hotkeyCancel).map(binding => ({
    ...binding, shortcut: toGlobalShortcut(binding.shortcut),
  }));
  const signature = JSON.stringify(bindings);
  if (signature === lastRegisteredRecordHotkey) return;
  registeringScenarioHotkeys = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invokeCommand(invoke, 'set_scenario_hotkeys', { bindings });
    lastRegisteredRecordHotkey = signature;
  } catch (error) {
    console.error('Не удалось зарегистрировать триггеры сценариев:', error);
    saveStatus.textContent = `Не удалось зарегистрировать триггер: ${String(error)}`;
    saveStatus.style.color = '#f87171';
  } finally {
    registeringScenarioHotkeys = false;
    const latest = scenarioBindings(settings.scenarios, settings.hotkeyCancel).map(binding => ({
      ...binding, shortcut: toGlobalShortcut(binding.shortcut),
    }));
    if (JSON.stringify(latest) !== signature) void syncRecordHotkey();
  }
}

let lastRegisteredControlHotkeys: string | null = null;
let lastAttemptedControlHotkeys: string | null = null;
let registeringControlHotkeys = false;
async function syncControlHotkeys() {
  if (isAndroid) return;
  if (scenarioEditorRoot?.dataset.executingScenarioId) return;
  const signature = `${settings.hotkeyPause}|${settings.hotkeyCancel}`;
  if (registeringControlHotkeys || signature === lastRegisteredControlHotkeys || signature === lastAttemptedControlHotkeys) return;
  if (!isTauri()) return;
  const pauseShortcut = toGlobalShortcut(settings.hotkeyPause || 'Control+Alt+KeyD');
  const cancelShortcut = toGlobalShortcut(settings.hotkeyCancel || 'Escape');
  lastAttemptedControlHotkeys = signature;
  registeringControlHotkeys = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invokeCommand(invoke, 'set_control_hotkeys', {
      pauseShortcut,
      cancelShortcut,
    });
    lastRegisteredControlHotkeys = signature;
  } catch (error) {
    console.error('Не удалось зарегистрировать глобальные клавиши паузы и отмены:', error);
    saveStatus.textContent = `Не удалось зарегистрировать клавиши паузы/отмены: ${String(error)}`;
    saveStatus.style.color = '#f87171';
  } finally {
    registeringControlHotkeys = false;
    if (`${settings.hotkeyPause}|${settings.hotkeyCancel}` !== signature) void syncControlHotkeys();
  }
}
function updateAndSave() {
  settings.groqModel = modelSelect.value;
  settings.groqApiKey = apiKeyInput.value.trim();
  settings.liveTranscriptionEnabled = toggleLiveTranscription.checked;
  liveTranscriptionParameters.hidden = !toggleLiveTranscription.checked;
  settings.liveSilenceDurationMs = Math.max(300, Math.min(2000, Number(liveSilenceDuration.value) || 700));
  settings.liveMaxChunkDurationSeconds = Math.max(3, Math.min(20, Number(liveMaxChunkDuration.value) || 9));
  settings.liveChunkOverlapSeconds = Math.max(0, Math.min(2, Number(liveChunkOverlap.value) || 0));
  settings.overlayMaxWidthPercent = Math.max(0, Math.min(100, Number(overlayMaxWidthPercent.value) || 0));
  settings.overlayFollowCursorMonitor = toggleOverlayMonitorMovement.checked;
  if (groqLanguage) settings.groqLanguage = groqLanguage.value;
  if (groqTemperature) settings.groqTemperature = parseFloat(groqTemperature.value) || 0.0;
  if (groqPrompt) settings.groqPrompt = groqPrompt.value;

  if (providerSelect) {
    settings.provider = selectValue(providerSelect.value, ['groq', 'none'], settings.provider);
  }
  const activeScenario = settings.scenarios.find(scenario => scenario.id === settings.activeScenarioId);
  settings.postProcessEnabled = activeScenario?.steps.some(step => step.enabled && step.type === 'postprocess') ?? false;
  const trigger = activeScenario?.steps.find(step => step.type === 'startRecording');
  const paste = activeScenario?.steps.find(step => step.type === 'paste');
  if (trigger?.hotkey) settings.hotkeyRecord = trigger.hotkey;
  if (trigger) trigger.hotkeyPause = settings.hotkeyPause;
  if (trigger?.sound) settings.soundStart = trigger.sound;
  if (trigger) {
    settings.soundEnabled = trigger.soundEnabled ?? settings.soundEnabled;
    settings.soundProfile = trigger.soundProfile ?? settings.soundProfile;
  }
  if (paste?.soundSuccess) settings.soundSuccess = paste.soundSuccess;
  const transcription = activeScenario?.steps.find(step => step.type === 'transcribe');
  if (transcription) {
    transcription.transcription = {
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
    };
  }
  settings.postProcessProvider = selectValue(postProcessProvider.value, ['gemini', 'none'], settings.postProcessProvider);
  settings.geminiApiKey = geminiApiKey.value.trim();
  settings.geminiModel = geminiModel.value;
  settings.geminiPrompt = geminiPrompt.value;
  const postprocessing = activeScenario?.steps.find(step => step.type === 'postprocess');
  if (postprocessing) {
    postprocessing.postprocessing = {
      ...postprocessing.postprocessing,
      provider: settings.postProcessProvider,
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      prompt: settings.geminiPrompt,
    };
  }
  settings.autoCopyClipboard = activeScenario?.steps.some(step => step.enabled && step.type === 'copy') ?? false;
  settings.autoPasteActiveWindow = activeScenario?.steps.some(step => step.enabled && step.type === 'paste') ?? false;

  saveSettingsPreservingOverlayPosition(settings);
  void syncOverlayMonitorMovementSetting();
  void syncRecordHotkey();
  if (`${settings.hotkeyPause}|${settings.hotkeyCancel}` !== lastRegisteredControlHotkeys) void syncControlHotkeys();
  notifySaved();
}

function updateProviderReadiness() {
  updateModelMetadata();
  const sttStatus = document.getElementById('stt-provider-status');
  const postStatus = document.getElementById('postprocess-provider-status');
  const groqApiKeyField = document.getElementById('groq-api-key-field');
  const geminiApiKeyField = document.getElementById('gemini-api-key-field');

  // STT провайдер
  const sttSelected = providerSelect?.value;
  if (sttSelected === 'none') {
    if (sttStatus) {
      sttStatus.textContent = 'Не выбран';
      sttStatus.className = 'status-pill status-pill--idle';
    }
    groqApiKeyField?.classList.remove('is-invalid');
  } else if (sttSelected === 'groq') {
    const hasKey = Boolean(apiKeyInput.value.trim());
    const hasModel = Boolean(modelSelect.value);
    const isReady = hasKey && hasModel;
    if (sttStatus) {
      sttStatus.textContent = isReady ? 'Готов' : 'Нужен API ключ';
      sttStatus.className = `status-pill ${isReady ? 'status-pill--ready' : 'status-pill--error'}`;
    }
    if (groqApiKeyField) {
      groqApiKeyField.classList.toggle('is-invalid', !hasKey);
    }
  }

  // Пост-процессинг провайдер
  const activeScenario = settings.scenarios.find(scenario => scenario.id === settings.activeScenarioId);
  const postEnabled = activeScenario?.steps.some(step => step.enabled && step.type === 'postprocess') ?? false;
  const hasPrompt = Boolean(geminiPrompt.value.trim());
  const promptInvalid = postEnabled && !hasPrompt;
  geminiPrompt.required = postEnabled;
  geminiPrompt.setAttribute('aria-invalid', String(promptInvalid));
  geminiPrompt.setCustomValidity(promptInvalid ? 'Укажите промпт преобразования.' : '');
  document.getElementById('gemini-prompt-field')?.classList.toggle('is-invalid', promptInvalid);
  const promptRequired = document.getElementById('gemini-prompt-required');
  if (promptRequired) promptRequired.hidden = !postEnabled;
  const promptError = document.getElementById('gemini-prompt-error');
  if (promptError) promptError.hidden = !promptInvalid;
  const postSelected = postProcessProvider?.value;
  if (!postEnabled) {
    if (postStatus) {
      postStatus.textContent = 'Отключен';
      postStatus.className = 'status-pill status-pill--idle';
    }
    geminiApiKeyField?.classList.remove('is-invalid');
  } else if (postSelected === 'none') {
    if (postStatus) {
      postStatus.textContent = 'Не выбран';
      postStatus.className = 'status-pill status-pill--idle';
    }
    geminiApiKeyField?.classList.remove('is-invalid');
  } else if (postSelected === 'gemini') {
    const hasKey = Boolean(geminiApiKey.value.trim());
    const hasModel = Boolean(geminiModel.value);
    const isReady = hasKey && hasModel && hasPrompt;
    if (postStatus) {
      postStatus.textContent = isReady ? 'Готов' : !hasKey ? 'Нужен API ключ' : !hasModel ? 'Выберите модель' : 'Нужен промпт';
      postStatus.className = `status-pill ${isReady ? 'status-pill--ready' : 'status-pill--error'}`;
    }
    if (geminiApiKeyField) {
      geminiApiKeyField.classList.toggle('is-invalid', !hasKey);
    }
  }

  for (const provider of ['groq', 'gemini'] as const) {
    const result = document.getElementById(`${provider}-check-result`);
    const pill = provider === 'groq' ? sttStatus : postStatus;
    const check = providerChecks.get(provider);
    if (check && check.fingerprint !== providerFingerprint(provider)) providerChecks.delete(provider);
    const current = providerChecks.get(provider);
    if (pill) pill.title = current?.details || '';
    if (result) {
      result.textContent = current?.details || '';
      result.className = `model-load-status${current?.state === 'error' ? ' model-load-status--error' : ''}`;
    }
    if (pill && current && (provider === 'groq' || (postEnabled && hasPrompt))) {
      pill.textContent = current.text;
      pill.className = `status-pill status-pill--${current.state}`;
    } else if (pill?.classList.contains('status-pill--ready')) {
      pill.textContent = 'Настроен';
      pill.className = 'status-pill status-pill--idle';
    }
    const localError = provider === 'groq' && sttSelected === 'groq' ? groqLocalSettingsError()
      : provider === 'gemini' && postSelected === 'gemini' && postEnabled ? geminiLocalSettingsError() : null;
    if (localError) {
      if (pill) {
        pill.textContent = 'Ошибка настроек';
        pill.className = 'status-pill status-pill--error';
        pill.title = localError;
      }
      if (result) {
        result.textContent = localError;
        result.className = 'model-load-status model-load-status--error';
      }
    }
  }
  scheduleProviderChecks();
}

function updateProviderBlocksVisibility() {
  const groqBlock = document.getElementById('provider-specific-groq');
  const groqApiKeyField = document.getElementById('groq-api-key-field');
  const isGroq = providerSelect?.value === 'groq';
  if (groqBlock) groqBlock.style.display = isGroq ? 'block' : 'none';
  if (groqApiKeyField) groqApiKeyField.style.display = isGroq ? 'flex' : 'none';

  const geminiBlock = document.getElementById('gemini-specific-block');
  const geminiApiKeyField = document.getElementById('gemini-api-key-field');
  const isGemini = postProcessProvider?.value === 'gemini';
  if (geminiBlock) geminiBlock.style.display = isGemini ? 'block' : 'none';
  if (geminiApiKeyField) geminiApiKeyField.style.display = isGemini ? 'flex' : 'none';

  updateProviderReadiness();
}

updateProviderBlocksVisibility();

// Синхронизируем глобальные горячие клавиши при запуске и при их изменении
void syncRecordHotkey();
void syncControlHotkeys();

// Гарантируем, что оверлей скрыт до старта записи
void (async () => {
  if (isAndroid) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invokeCommand(invoke, 'hide_overlay');
  } catch (e) {}
})();

// Привязка событий изменения
[providerSelect, modelSelect, groqLanguage, groqTemperature, postProcessProvider, geminiModel, liveSilenceDuration, liveMaxChunkDuration, liveChunkOverlap, overlayMaxWidthPercent, toggleOverlayMonitorMovement].filter(Boolean).forEach((el) => {
  el.addEventListener('change', () => {
    updateProviderBlocksVisibility();
    updateAndSave();
    if (el === providerSelect && providerSelect.value === 'groq') void refreshModelList('groq');
    if (el === postProcessProvider && postProcessProvider.value === 'gemini') void refreshModelList('gemini');
  });
});

[apiKeyInput, geminiApiKey].filter(Boolean).forEach((el) => {
  el.addEventListener('input', () => {
    updateProviderReadiness();
  });
  el.addEventListener('change', () => {
    updateProviderReadiness();
    updateAndSave();
    if (el === apiKeyInput && providerSelect.value === 'groq') void refreshModelList('groq');
    if (el === geminiApiKey && postProcessProvider.value === 'gemini') void refreshModelList('gemini');
  });
});

refreshGroqModelsButton.addEventListener('click', () => { void refreshModelList('groq'); });
document.getElementById('check-groq-settings')?.addEventListener('click', () => { void checkProviderSettings('groq'); });
document.getElementById('check-gemini-settings')?.addEventListener('click', () => { void checkProviderSettings('gemini'); });
[groqTemperature, groqLanguage].filter(Boolean).forEach(field => {
  field.addEventListener('input', updateProviderReadiness);
});
refreshGeminiModelsButton.addEventListener('click', () => { void refreshModelList('gemini'); });
if (providerSelect.value === 'groq' && apiKeyInput.value.trim()) void refreshModelList('groq');
if (postProcessProvider.value === 'gemini' && geminiApiKey.value.trim()) void refreshModelList('gemini');

overlayMaxWidthSlider.addEventListener('input', () => {
  overlayMaxWidthPercent.value = overlayMaxWidthSlider.value;
  showOverlayWidthPreview();
});
overlayMaxWidthSlider.addEventListener('change', updateAndSave);
overlayMaxWidthPercent.addEventListener('input', () => {
  const parsed = Number(overlayMaxWidthPercent.value);
  if (!Number.isFinite(parsed)) return;
  const value = Math.round(Math.max(0, Math.min(100, parsed)) * 10) / 10;
  overlayMaxWidthSlider.value = String(value);
  overlayMaxWidthPercent.value = String(value);
  showOverlayWidthPreview();
});

btnResetPos?.addEventListener('click', async () => {
  settings.position = null;
  saveSettings(settings);
  notifySaved();
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invokeCommand(invoke, 'position_overlay_on_cursor_monitor', { reset: true });
  } catch (error) {
    console.error('Не удалось сбросить позицию оверлея:', error);
    saveStatus.textContent = `Не удалось сбросить позицию: ${errorMessage(error)}`;
    saveStatus.style.color = '#f87171';
  }
});

[toggleLiveTranscription].filter(Boolean).forEach((el) => {
  el.addEventListener('change', updateAndSave);
});

apiKeyInput.addEventListener('input', updateAndSave);
geminiApiKey?.addEventListener('input', updateAndSave);
groqPrompt?.addEventListener('input', updateAndSave);
geminiPrompt?.addEventListener('input', () => {
  updateAndSave();
  updateProviderReadiness();
});

// Редактор конфигурации и копирование логов
const btnSettingsJson = document.getElementById('btn-settings-json') as HTMLButtonElement;
const btnCopySettingsJson = document.getElementById('btn-copy-settings-json') as HTMLButtonElement;
const btnCopyLogs = document.getElementById('btn-copy-logs') as HTMLButtonElement;
const settingsJsonPanel = document.getElementById('settings-json-panel') as HTMLElement;
const inputSettingsJson = document.getElementById('input-settings-json') as HTMLTextAreaElement;
const btnApplySettingsJson = document.getElementById('btn-apply-settings-json') as HTMLButtonElement;
const btnCancelSettingsJson = document.getElementById('btn-cancel-settings-json') as HTMLButtonElement;
const settingsJsonStatus = document.getElementById('settings-json-status') as HTMLElement;

async function copyText(text: string) {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invokeCommand(invoke, 'write_clipboard_text', { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

btnSettingsJson?.addEventListener('click', () => {
  if (!settingsJsonPanel.hidden) {
    closeSettingsJson();
    return;
  }
  inputSettingsJson.value = JSON.stringify({ ...settings, position: loadSettings().position }, null, 2);
  settingsJsonPanel.hidden = false;
  settingsJsonStatus.textContent = '';
  inputSettingsJson.removeAttribute('aria-invalid');
  btnSettingsJson.setAttribute('aria-expanded', 'true');
  inputSettingsJson.setSelectionRange(0, 0);
  inputSettingsJson.focus();
  inputSettingsJson.scrollTop = 0;
  inputSettingsJson.scrollLeft = 0;
});

function closeSettingsJson() {
  settingsJsonPanel.hidden = true;
  inputSettingsJson.value = '';
  inputSettingsJson.removeAttribute('aria-invalid');
  settingsJsonStatus.textContent = '';
  btnSettingsJson.setAttribute('aria-expanded', 'false');
}

btnCancelSettingsJson?.addEventListener('click', () => {
  closeSettingsJson();
  btnSettingsJson.focus();
});

inputSettingsJson.addEventListener('input', () => {
  settingsJsonStatus.textContent = '';
  inputSettingsJson.removeAttribute('aria-invalid');
});

btnCopySettingsJson?.addEventListener('click', async () => {
  try {
    await copyText(inputSettingsJson.value);
    settingsJsonStatus.textContent = 'Конфигурация скопирована';
    settingsJsonStatus.style.color = '#34d399';
  } catch (error) {
    settingsJsonStatus.textContent = `Не удалось скопировать: ${errorMessage(error)}`;
    settingsJsonStatus.style.color = '#f87171';
  }
});

function applyConfiguration(next: typeof settings) {
    Object.assign(settings, next);
    renderStartupSettings();
    void syncStartupSettings().catch(error => { startupStatus.textContent = errorMessage(error); });
    renderedModelParameters = '';
    saveSettings(settings);
    lastRegisteredRecordHotkey = null;
    lastRegisteredControlHotkeys = null;
    lastAttemptedControlHotkeys = null;
    void syncRecordHotkey();
    void syncControlHotkeys();

    providerSelect.value = settings.provider;
    modelSelect.value = settings.groqModel;
    apiKeyInput.value = settings.groqApiKey;
    postProcessProvider.value = settings.postProcessProvider;
    geminiApiKey.value = settings.geminiApiKey;
    geminiModel.value = settings.geminiModel;
    geminiPrompt.value = settings.geminiPrompt;
    if (groqLanguage) groqLanguage.value = settings.groqLanguage || 'auto';
    if (groqTemperature) groqTemperature.value = String(settings.groqTemperature ?? 0.0);
    if (groqPrompt) groqPrompt.value = settings.groqPrompt || '';
    toggleLiveTranscription.checked = settings.liveTranscriptionEnabled;
    liveTranscriptionParameters.hidden = !toggleLiveTranscription.checked;
    liveSilenceDuration.value = String(settings.liveSilenceDurationMs ?? 700);
    liveMaxChunkDuration.value = String(settings.liveMaxChunkDurationSeconds ?? 9);
    liveChunkOverlap.value = String(settings.liveChunkOverlapSeconds ?? 0.5);
    overlayMaxWidthPercent.value = String(settings.overlayMaxWidthPercent ?? 50);
    overlayMaxWidthSlider.value = overlayMaxWidthPercent.value;
    toggleOverlayMonitorMovement.checked = settings.overlayFollowCursorMonitor;
    refreshScenarioEditor();
    updateProviderBlocksVisibility();
    historyMaxItemsSelect.value = String(settings.historyMaxItems || 10);
    void historyView.refresh();
    if (settings.provider === 'groq' && settings.groqApiKey.trim()) void refreshModelList('groq');
    if (settings.postProcessProvider === 'gemini' && settings.geminiApiKey.trim()) void refreshModelList('gemini');
    void syncOverlayMonitorMovementSetting();

}

document.getElementById('btn-reset-settings')!.addEventListener('click', async () => {
  if (!await confirmAction({
    title: 'Сбросить настройки?',
    message: 'Общие настройки вернутся к значениям по умолчанию. Сценарии, история записей и аудиофайлы не изменятся.',
    confirmLabel: 'Сбросить настройки',
  })) return;
  applyConfiguration(resetGeneralSettings(settings));
  closeSettingsJson();
  saveStatus.textContent = 'Настройки сброшены';
  saveStatus.style.color = '#34d399';
});

btnApplySettingsJson?.addEventListener('click', () => {
  try {
    const imported = parseSettingsJson(inputSettingsJson.value);
    applyConfiguration(imported);

    saveStatus.textContent = '✓ Конфигурация применена';
    saveStatus.style.color = '#34d399';
    closeSettingsJson();
  } catch (err) {
    settingsJsonStatus.textContent = `Ошибка конфигурации: ${errorMessage(err)}`;
    settingsJsonStatus.style.color = '#f87171';
    inputSettingsJson.setAttribute('aria-invalid', 'true');
  }
});

btnCopyLogs?.addEventListener('click', async () => {
  try {
    let logs = getRecentLogs();
    if (isAndroid) {
      const result = await androidCall<{ logs: string }>('getLogs');
      logs = result.logs;
    } else if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      logs = await invokeCommand(invoke, 'get_app_logs');
    }
    if (!logs.trim()) logs = 'Логи пока отсутствуют.';
    await copyText(logs);
    saveStatus.textContent = 'Логи скопированы';
    saveStatus.style.color = '#34d399';
  } catch (error) {
    saveStatus.textContent = `Не удалось скопировать логи: ${errorMessage(error)}`;
    saveStatus.style.color = '#f87171';
  }
});

// История записей
const historyListEl = document.getElementById('history-list') as HTMLElement;
const historyMaxItemsSelect = document.getElementById('history-max-items') as HTMLSelectElement;
const historyView = createHistoryView(historyListEl, () => settings.historyMaxItems || 10);

if (historyMaxItemsSelect) {
  historyMaxItemsSelect.value = String(settings.historyMaxItems || 10);
  historyMaxItemsSelect.addEventListener('change', () => {
    settings.historyMaxItems = parseInt(historyMaxItemsSelect.value, 10);
    saveSettingsPreservingOverlayPosition(settings);
    void historyView.refresh();
    notifySaved();
  });
}
