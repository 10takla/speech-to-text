import { fetchGeminiTextModels, fetchGroqSpeechModels, type ProviderModel } from './provider-models';
import { mountSpeechProvider } from './speech-settings-editor';
import { normalizeClipboardHistoryLevel, type ScenarioStep } from './scenario';
import { isAndroid } from './android-runtime';
import { mountGoogleCloudEditor } from './google-cloud/editor';
import { normalizeGoogleCloudSettings } from './google-cloud/settings';
import { mountGeminiTranscriptionEditor } from './gemini-transcription/editor';
import { normalizeGeminiTranscriptionSettings } from './gemini-transcription/settings';

const catalogs = new Map<string, ProviderModel[]>();

export function mountFinalTranscriptionSetting(root: HTMLElement, step: ScenarioStep, save: () => void) {
  if (!step.transcription) return;
  const label = document.createElement('label'); label.className = 'checkbox-label';
  const control = document.createElement('input'); control.type = 'checkbox';
  control.checked = step.transcription.retranscribeFullRecording === true;
  control.setAttribute('aria-label', 'Повторно распознавать всю запись после стопа');
  control.addEventListener('change', () => { step.transcription!.retranscribeFullRecording = control.checked; save(); });
  label.append(control, 'Повторно распознавать всю запись после стопа');
  root.append(label);
}

export function mountBranchStepSettings(root: HTMLElement, step: ScenarioStep, save: () => void, saveInline = save) {
  const field = (title: string, control: HTMLElement) => {
    const label = document.createElement('label');
    label.className = 'scenario-step-setting-label'; label.append(title, control); root.append(label);
    return control;
  };
  const input = (title: string, value: string | number, update: (value: string) => void, type = 'text') => {
    const control = document.createElement('input'); control.type = type; control.value = String(value);
    control.addEventListener('input', () => {
      if (!control.checkValidity()) return;
      update(control.value); saveInline();
    });
    field(title, control); return control;
  };
  const select = (title: string, value: string, options: [string, string][], update: (value: string) => void) => {
    const control = document.createElement('select');
    options.forEach(([id, name]) => control.add(new Option(name, id)));
    control.value = value;
    control.addEventListener('change', () => { update(control.value); save(); });
    field(title, control); return control;
  };
  const checkbox = (title: string, checked: boolean, update: (value: boolean) => void) => {
    const control = document.createElement('input'); control.type = 'checkbox'; control.checked = checked;
    control.addEventListener('change', () => { update(control.checked); save(); });
    field(title, control);
  };
  const models = (getKey: () => string, current: string, load: (key: string) => Promise<ProviderModel[]>, update: (model: string) => void) => {
    const catalogKey = () => `${step.type}:${getKey().trim()}`;
    const known = catalogs.get(catalogKey()) ?? [];
    const options: [string, string][] = known.map(model => [model.id, model.name]);
    if (!options.some(([id]) => id === current)) options.unshift([current, current || 'Выберите модель…']);
    const control = select('Модель', current, options, update);
    const refresh = document.createElement('button'); refresh.type = 'button';
    refresh.className = 'btn secondary'; refresh.textContent = 'Обновить модели';
    const status = document.createElement('span'); status.className = 'model-load-status';
    refresh.addEventListener('click', () => {
      void (async () => {
        const key = getKey().trim();
        if (!key) { status.textContent = 'Укажите API-ключ.'; return; }
        refresh.disabled = true; status.textContent = 'Загрузка…';
        try {
          const list = await load(key);
          if (key !== getKey().trim() || !root.isConnected) return;
          catalogs.set(catalogKey(), list);
          const selected = control.value;
          control.replaceChildren(new Option('Выберите модель…', ''));
          list.forEach(model => control.add(new Option(model.name, model.id)));
          control.value = list.some(model => model.id === selected) ? selected : '';
          status.textContent = `Моделей: ${list.length}`;
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        finally { refresh.disabled = false; }
      })();
    });
    root.append(refresh, status);
  };

  if (step.type === 'speak') { mountSpeechProvider(root, step, save, saveInline); return; }
  if (step.type === 'transcribe' && step.transcription) {
    const settings = step.transcription;
    mountFinalTranscriptionSetting(root, step, save);
    select('Провайдер речи', settings.provider, [['none', 'Не выбран'], ['groq', 'Groq'], ['google-cloud', 'Google Cloud'], ['gemini', 'Google Gemini (AI Studio)']], value => { settings.provider = value as typeof settings.provider; });
    if (settings.provider === 'none') return;
    if (settings.provider === 'google-cloud' || settings.provider === 'gemini') {
      const editor = document.createElement('div'); root.append(editor);
      const onStatus = (text: string, state: 'idle' | 'ready' | 'error', details: string) => {
        queueMicrotask(() => {
          const summary = editor.closest('.scenario-step-details')?.querySelector(':scope > summary');
          if (!summary) return;
          const pill = summary.querySelector<HTMLElement>('.scenario-step-readiness') ?? document.createElement('span');
          if (!pill.isConnected) summary.append(pill);
          pill.textContent = text; pill.className = `scenario-step-readiness status-pill status-pill--${state}`; pill.title = details;
        });
      };
      if (settings.provider === 'google-cloud') mountGoogleCloudEditor(editor, settings.googleCloud ??= normalizeGoogleCloudSettings(), saveInline, onStatus);
      else mountGeminiTranscriptionEditor(editor, settings.geminiTranscription ??= normalizeGeminiTranscriptionSettings(), saveInline, onStatus);
    } else {
      input('API-ключ', settings.apiKey, value => { settings.apiKey = value.trim(); }, 'password');
      models(() => settings.apiKey, settings.model, fetchGroqSpeechModels, value => { settings.model = value; });
      input('Язык', settings.language, value => { settings.language = value; }).setAttribute('aria-label', 'Язык');
      const context = document.createElement('textarea');
      context.className = 'prompt-input'; context.rows = 3; context.value = settings.prompt;
      context.addEventListener('input', () => { settings.prompt = context.value; saveInline(); });
      field('Контекст', context);
      const temperature = input('Температура', settings.temperature, value => { settings.temperature = Number(value); }, 'number');
      temperature.min = '0'; temperature.max = '1'; temperature.step = '0.1';
    }
    checkbox('Распознавать во время записи', settings.liveTranscriptionEnabled, value => { settings.liveTranscriptionEnabled = value; });
    if (settings.liveTranscriptionEnabled) {
      const silence = input('Пауза для отправки, мс', settings.liveSilenceDurationMs, value => {
        settings.liveSilenceDurationMs = Math.max(300, Math.min(2000, Number(value) || 700));
      }, 'number');
      silence.min = '300'; silence.max = '2000';
      const duration = input('Максимум фрагмента, сек', settings.liveMaxChunkDurationSeconds, value => {
        settings.liveMaxChunkDurationSeconds = Math.max(3, Math.min(20, Number(value) || 9));
      }, 'number');
      duration.min = '3'; duration.max = '20';
      const overlap = input('Перекрытие фрагментов, сек', settings.liveChunkOverlapSeconds, value => {
        settings.liveChunkOverlapSeconds = Math.max(0, Math.min(2, Number(value) || 0));
      }, 'number');
      overlap.min = '0'; overlap.max = '2'; overlap.step = '0.1';
    }
    return;
  }
  if (step.type === 'postprocess' && step.postprocessing) {
    const settings = step.postprocessing;
    select('Провайдер текста', settings.provider, [['none', 'Не выбран'], ['gemini', 'Google Gemini']], value => { settings.provider = value as typeof settings.provider; });
    if (settings.provider === 'none') return;
    input('API-ключ', settings.apiKey, value => { settings.apiKey = value.trim(); }, 'password');
    models(() => settings.apiKey, settings.model, fetchGeminiTextModels, value => { settings.model = value; });
    const prompt = document.createElement('textarea'); prompt.value = settings.prompt;
    prompt.className = 'prompt-input'; prompt.rows = 3;
    prompt.addEventListener('input', () => { settings.prompt = prompt.value; saveInline(); });
    field('Промпт преобразования', prompt);
    for (const [key, title] of [['temperature', 'Температура'], ['topP', 'Top P'], ['topK', 'Top K'], ['maxOutputTokens', 'Максимум токенов']] as const) {
      const control = input(title, settings.generationConfig?.[key] ?? '', value => {
        const config = settings.generationConfig ??= {};
        if (!value.trim()) delete config[key]; else config[key] = Number(value);
      }, 'number');
      control.min = key === 'topK' || key === 'maxOutputTokens' ? '1' : '0';
      control.step = key === 'topK' || key === 'maxOutputTokens' ? '1' : '0.1';
    }
    return;
  }
  if (step.type === 'copy' && !isAndroid) {
    const level = input('Уровень в истории', step.clipboardHistoryLevel ?? -1, value => {
      step.clipboardHistoryLevel = normalizeClipboardHistoryLevel(Number(value));
    }, 'number');
    level.max = '0'; level.step = '1';
  }
  if (step.type === 'paste') {
    if (!isAndroid) checkbox('Возвращать фокус перед вставкой', step.returnFocusToOriginalWindow === true,
      value => { step.returnFocusToOriginalWindow = value; });
    select('Звук вставки', step.soundSuccess ?? 'chord', [['chord', 'Аккорд'], ['click', 'Клик'], ['none', 'Нет']], value => {
      step.soundSuccess = value as typeof step.soundSuccess;
    });
  }
  if (step.type === 'copy' || step.type === 'paste') checkbox('Показывать текст в оверлее', step.showTextInOverlay === true,
    value => { step.showTextInOverlay = value; });
}
