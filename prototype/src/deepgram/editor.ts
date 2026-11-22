import type { ProviderModel } from '../provider-models';
import { fetchDeepgramCatalog } from './catalog';
import {
  DEEPGRAM_LANGUAGES,
  DEEPGRAM_REDACT_OPTIONS,
  deepgramConfigurationError,
  type DeepgramRedact,
  type DeepgramSettings,
} from './settings';

type Status = (text: string, state: 'idle' | 'ready' | 'error', details: string) => void;
export interface DeepgramEditorHostControls {
  testButton?: HTMLButtonElement;
  checkResult?: HTMLElement;
}
interface Editor { settings: DeepgramSettings; updateStatus(): void; dispose(): void }
const editors = new WeakMap<HTMLElement, Editor>();

export function disposeDeepgramEditor(root: HTMLElement): void {
  const existing = editors.get(root);
  if (!existing) return;
  editors.delete(root);
  existing.dispose();
}

export function mountDeepgramEditor(
  root: HTMLElement,
  settings: DeepgramSettings,
  save: () => void,
  onStatus?: Status,
  hostControls?: DeepgramEditorHostControls,
): void {
  const previous = editors.get(root);
  if (previous?.settings === settings) { previous.updateStatus(); return; }
  previous?.dispose();
  root.replaceChildren();

  let models: ProviderModel[] | undefined;
  let loading = false;
  let failure = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  const makeField = (
    container: HTMLElement,
    title: string,
    required = false,
    extraClass = '',
  ) => {
    const field = document.createElement('div');
    field.className = `form-field${required ? ' form-field--important' : ''}${extraClass ? ` ${extraClass}` : ''}`;
    const label = document.createElement('label');
    label.append(document.createTextNode(`${title}:`));
    if (required) {
      label.append(document.createTextNode(' '));
      const marker = document.createElement('span');
      marker.className = 'req-marker';
      marker.title = 'Обязательная настройка';
      marker.textContent = '*';
      label.append(marker);
    }
    field.append(label);
    container.append(field);
    return { field, label };
  };

  // Row 1: API key
  const keyGrid = document.createElement('div');
  keyGrid.className = 'form-grid';
  root.append(keyGrid);
  const keyField = makeField(keyGrid, 'API ключ', true);
  const key = document.createElement('input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.value = settings.apiKey;
  key.placeholder = 'dg_...';
  key.required = true;
  key.setAttribute('aria-label', 'API ключ Deepgram');
  keyField.field.append(key);

  // Row 2: Model (+ refresh button + model count/info), Language, Redact
  const mainGrid = document.createElement('div');
  mainGrid.className = 'form-grid form-grid--spaced';
  root.append(mainGrid);

  const modelField = makeField(mainGrid, 'Модель', true);
  const modelPicker = document.createElement('div');
  modelPicker.className = 'model-picker';
  const model = document.createElement('select');
  model.required = true;
  model.setAttribute('aria-label', 'Модель Deepgram');
  const refreshModelsBtn = document.createElement('button');
  refreshModelsBtn.type = 'button';
  refreshModelsBtn.className = 'btn secondary model-refresh-btn';
  refreshModelsBtn.title = 'Обновить список моделей Deepgram';
  refreshModelsBtn.setAttribute('aria-label', 'Обновить список моделей Deepgram');
  refreshModelsBtn.textContent = '↻';
  modelPicker.append(model, refreshModelsBtn);

  const modelLoadStatus = document.createElement('span');
  modelLoadStatus.className = 'model-load-status';
  modelLoadStatus.setAttribute('role', 'status');
  modelLoadStatus.setAttribute('aria-live', 'polite');

  const modelInfo = document.createElement('span');
  modelInfo.className = 'model-load-status';
  modelField.field.append(modelPicker, modelLoadStatus, modelInfo);

  const languageField = makeField(mainGrid, 'Язык');
  const language = document.createElement('select');
  language.setAttribute('aria-label', 'Язык Deepgram');
  const names = new Intl.DisplayNames(['ru'], { type: 'language' });
  DEEPGRAM_LANGUAGES.forEach(code => {
    let title: string = code;
    if (code === 'multi') {
      title = 'Авто (multi)';
    } else {
      try { title = `${names.of(code) ?? code} (${code})`; } catch { /* Keep documented code. */ }
    }
    language.add(new Option(title, code));
  });
  if (![...language.options].some(option => option.value === settings.language)) {
    language.add(new Option(settings.language, settings.language));
  }
  language.value = settings.language;
  languageField.field.append(language);

  const redactField = makeField(mainGrid, 'Скрытие данных');
  const redact = document.createElement('select');
  redact.setAttribute('aria-label', 'Скрытие чувствительных данных (redact)');
  DEEPGRAM_REDACT_OPTIONS.forEach(([id, title]) => redact.add(new Option(title, id)));
  redact.value = settings.redact;
  redactField.field.append(redact);

  // Row 3: Timing settings (Endpointing + Utterance end)
  const timingGrid = document.createElement('div');
  timingGrid.className = 'form-grid form-grid--spaced';
  root.append(timingGrid);

  const endpointingField = makeField(timingGrid, 'Пауза фиксации', false, 'compact-input-row');
  const endpointing = document.createElement('input');
  endpointing.type = 'number';
  endpointing.min = '0';
  endpointing.max = '10000';
  endpointing.step = '50';
  endpointing.value = String(settings.endpointingMs);
  endpointing.setAttribute('aria-label', 'Пауза фиксации, мс');
  const endpointingUnit = document.createElement('span');
  endpointingUnit.className = 'unit-label';
  endpointingUnit.textContent = 'мс';
  endpointingField.field.append(endpointing, endpointingUnit);

  const utteranceEndField = makeField(timingGrid, 'Конец фразы', false, 'compact-input-row');
  const utteranceEnd = document.createElement('input');
  utteranceEnd.type = 'number';
  utteranceEnd.min = '0';
  utteranceEnd.max = '5000';
  utteranceEnd.step = '100';
  utteranceEnd.value = String(settings.utteranceEndMs);
  utteranceEnd.title = '0 — выкл.; 1000–5000 мс, работает при включённом промежуточном тексте';
  utteranceEnd.setAttribute('aria-label', 'Конец фразы (utterance_end_ms), мс');
  const utteranceEndUnit = document.createElement('span');
  utteranceEndUnit.className = 'unit-label';
  utteranceEndUnit.textContent = 'мс';
  utteranceEndField.field.append(utteranceEnd, utteranceEndUnit);

  // Row 4: Compact checkboxes
  const checkboxRow = document.createElement('div');
  checkboxRow.className = 'checkbox-row checkbox-row--wrap form-grid--spaced';
  root.append(checkboxRow);
  const addCheckbox = (title: string, checked: boolean, change: (value: boolean) => void) => {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => { change(input.checked); save(); updateStatus(); });
    label.append(input, ` ${title}`);
    checkboxRow.append(label);
    return input;
  };
  addCheckbox('Умное форматирование', settings.smartFormat, value => { settings.smartFormat = value; });
  const punctuateCheckbox = addCheckbox('Пунктуация', settings.punctuate, value => { settings.punctuate = value; });
  punctuateCheckbox.disabled = settings.smartFormat;
  addCheckbox('Числа цифрами', settings.numerals, value => { settings.numerals = value; });
  addCheckbox('Промежуточный текст на лету', settings.interimResults, value => { settings.interimResults = value; });
  addCheckbox('Разделять говорящих', settings.diarize, value => { settings.diarize = value; });
  addCheckbox('Слова-паразиты', settings.fillerWords, value => { settings.fillerWords = value; });
  addCheckbox('Фильтр мата', settings.profanityFilter, value => { settings.profanityFilter = value; });
  addCheckbox('Не обучать модели (MIP opt-out)', settings.mipOptOut, value => { settings.mipOptOut = value; });

  // Row 5: Keyterms and Replace textareas
  const textareasGrid = document.createElement('div');
  textareasGrid.className = 'form-grid form-grid--spaced';
  root.append(textareasGrid);

  const keytermsField = makeField(textareasGrid, 'Ключевые термины');
  const keyterms = document.createElement('textarea');
  keyterms.className = 'prompt-input';
  keyterms.rows = 2;
  keyterms.placeholder = 'Термины, имена, словарь — по одному на строку...';
  keyterms.value = settings.keyterms.join('\n');
  keyterms.setAttribute('aria-label', 'Ключевые термины');
  keytermsField.field.append(keyterms);

  const replaceField = makeField(textareasGrid, 'Замены слов');
  const replace = document.createElement('textarea');
  replace.className = 'prompt-input';
  replace.rows = 2;
  replace.placeholder = 'что:на_что — по одной на строку...';
  replace.value = settings.replace.join('\n');
  replace.setAttribute('aria-label', 'Замены слов');
  replaceField.field.append(replace);

  // Fallback footer controls for branch step settings (when host header controls are not passed)
  let localTest: HTMLButtonElement | undefined;
  let localStatus: HTMLSpanElement | undefined;
  let localDetails: HTMLParagraphElement | undefined;
  if (!hostControls) {
    localTest = document.createElement('button');
    localTest.type = 'button';
    localTest.className = 'btn secondary compact-btn';
    localTest.textContent = 'Тест';
    localTest.title = 'Проверить ключ и модель без распознавания аудио.';
    localStatus = document.createElement('span');
    localStatus.className = 'status-pill';
    localStatus.setAttribute('role', 'status');
    localDetails = document.createElement('p');
    localDetails.className = 'model-load-status';
    localDetails.setAttribute('role', 'status');
    root.append(localTest, localStatus, localDetails);
  }

  const updateModelInfo = () => {
    const selected = models?.find(m => m.id === settings.model);
    modelInfo.textContent = selected?.description || '';
    modelInfo.title = selected?.description || '';
  };

  const updateStatus = () => {
    if (editors.get(root)?.settings !== settings) return;
    punctuateCheckbox.disabled = settings.smartFormat;
    const local = deepgramConfigurationError(settings);
    const unavailable = models && !models.some(m => m.id === settings.model)
      ? models.length ? 'Выбранная модель отсутствует в списке моделей Deepgram.' : 'API не вернул доступных моделей Deepgram.'
      : '';
    const message = failure || unavailable || local || (models
      ? 'API отвечает, ключ принят, модель найдена. Параметры проверены локально. Распознавание не запускалось.'
      : 'Укажите API ключ Deepgram.');
    const state = loading ? 'idle' : failure || unavailable || local ? 'error' : models ? 'ready' : 'idle';
    const text = loading ? 'Проверяется' : state === 'error' ? (local && !failure ? 'Ошибка настроек' : 'Не готов')
      : state === 'ready' ? 'Ключ и модель проверены' : 'Не проверен';

    if (hostControls?.testButton) hostControls.testButton.disabled = loading;
    refreshModelsBtn.disabled = loading;
    if (hostControls?.checkResult) {
      hostControls.checkResult.textContent = message;
      hostControls.checkResult.className = `model-load-status${state === 'error' ? ' model-load-status--error' : ''}`;
    }
    if (localTest) localTest.disabled = loading;
    if (localStatus) {
      localStatus.textContent = text;
      localStatus.className = `status-pill status-pill--${state}`;
      localStatus.title = message;
    }
    if (localDetails) {
      localDetails.textContent = message;
      localDetails.className = `model-load-status${state === 'error' ? ' model-load-status--error' : ''}`;
    }

    keyField.field.classList.toggle('is-invalid', !settings.apiKey);
    modelField.field.classList.toggle('is-invalid', !settings.model || Boolean(unavailable));
    replaceField.field.classList.toggle('is-invalid', settings.replace.some(rule => rule.indexOf(':') <= 0));
    updateModelInfo();
    onStatus?.(text, state, message);
  };

  const renderModels = () => {
    model.replaceChildren();
    const list = models ?? [
      { id: 'nova-3', name: 'nova-3' },
      { id: 'nova-2', name: 'nova-2' },
    ];
    if (settings.model && !list.some(m => m.id === settings.model)) {
      model.add(new Option(models ? `${settings.model} (недоступна)` : settings.model, settings.model));
    }
    list.forEach(m => model.add(new Option(m.name, m.id)));
    model.value = settings.model;
    updateStatus();
  };

  const load = async (refresh = false) => {
    request?.abort();
    const current = request = new AbortController();
    if (!settings.apiKey || !root.isConnected || editors.get(root)?.settings !== settings) {
      if (!settings.apiKey) {
        modelLoadStatus.textContent = 'Введите API-ключ';
        modelLoadStatus.className = 'model-load-status model-load-status--error';
      }
      updateStatus();
      return;
    }
    loading = true;
    failure = '';
    modelLoadStatus.textContent = 'Загрузка моделей…';
    modelLoadStatus.className = 'model-load-status model-load-status--loading';
    updateStatus();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 15_000);
    try {
      const result = await fetchDeepgramCatalog(settings.apiKey, current.signal, undefined, refresh);
      if (current.signal.aborted || !root.isConnected || editors.get(root)?.settings !== settings) return;
      models = result;
      if (!settings.model && models.length) {
        settings.model = models[0].id;
        save();
      }
      modelLoadStatus.textContent = `Моделей: ${models.length}`;
      modelLoadStatus.className = 'model-load-status model-load-status--success';
      renderModels();
    } catch (error) {
      if (current.signal.aborted && !timedOut) return;
      failure = timedOut ? 'Deepgram API не ответил за 15 секунд.' : error instanceof Error ? error.message : String(error);
      modelLoadStatus.textContent = `Не удалось загрузить: ${failure}`;
      modelLoadStatus.className = 'model-load-status model-load-status--error';
    } finally {
      clearTimeout(timeout);
      if (request === current) {
        loading = false;
        updateStatus();
      }
    }
  };

  key.addEventListener('input', () => {
    clearTimeout(timer);
    request?.abort();
    settings.apiKey = key.value.trim();
    models = undefined;
    loading = false;
    failure = '';
    modelLoadStatus.textContent = '';
    modelLoadStatus.className = 'model-load-status';
    save();
    renderModels();
    timer = setTimeout(() => { void load(); }, 700);
  });
  model.addEventListener('change', () => { settings.model = model.value; save(); updateStatus(); });
  language.addEventListener('change', () => { settings.language = language.value; save(); updateStatus(); });
  redact.addEventListener('change', () => { settings.redact = redact.value as DeepgramRedact; save(); updateStatus(); });
  endpointing.addEventListener('input', () => {
    const parsed = Number(endpointing.value);
    settings.endpointingMs = endpointing.value.trim() && Number.isFinite(parsed) ? Math.round(parsed) : -1;
    save();
    updateStatus();
  });
  utteranceEnd.addEventListener('input', () => {
    const parsed = Number(utteranceEnd.value);
    settings.utteranceEndMs = utteranceEnd.value.trim() && Number.isFinite(parsed) ? Math.round(parsed) : -1;
    save();
    updateStatus();
  });
  keyterms.addEventListener('input', () => {
    settings.keyterms = keyterms.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    save();
    updateStatus();
  });
  replace.addEventListener('input', () => {
    settings.replace = replace.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    save();
    updateStatus();
  });

  const onTestClick = () => {
    if (!root.isConnected || root.hidden || editors.get(root)?.settings !== settings) return;
    clearTimeout(timer);
    void load(true);
  };
  refreshModelsBtn.addEventListener('click', onTestClick);
  localTest?.addEventListener('click', onTestClick);
  hostControls?.testButton?.addEventListener('click', onTestClick);

  editors.set(root, {
    settings,
    updateStatus,
    dispose: () => {
      clearTimeout(timer);
      request?.abort();
      hostControls?.testButton?.removeEventListener('click', onTestClick);
      if (hostControls?.testButton) hostControls.testButton.disabled = false;
    },
  });
  renderModels();
  if (settings.apiKey) queueMicrotask(() => { void load(); });
}
