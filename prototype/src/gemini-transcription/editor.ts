import type { ProviderModel } from '../provider-models';
import { fetchGeminiTranscriptionCatalog } from './catalog';
import { GEMINI_TRANSCRIPTION_LANGUAGES, geminiTranscriptionConfigurationError, type GeminiTranscriptionSettings } from './settings';

type Status = (text: string, state: 'idle' | 'ready' | 'error', details: string) => void;
interface Editor { settings: GeminiTranscriptionSettings; updateStatus(): void; dispose(): void }
const editors = new WeakMap<HTMLElement, Editor>();

export function mountGeminiTranscriptionEditor(root: HTMLElement, settings: GeminiTranscriptionSettings, save: () => void, onStatus?: Status): void {
  const previous = editors.get(root);
  if (previous?.settings === settings) { previous.updateStatus(); return; }
  previous?.dispose(); root.replaceChildren();
  let models: ProviderModel[] | undefined, loading = false, failure = '';
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  const grid = document.createElement('div'); grid.className = 'form-grid'; root.append(grid);
  const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(title: string, input: T, required = false): T => {
    const label = document.createElement('label'); label.className = `form-field${required ? ' form-field--important' : ''}`;
    input.setAttribute('aria-label', title); input.required = required;
    label.append(`${title}${required ? ' *' : ''}`, input); grid.append(label); return input;
  };
  const key = field('API-ключ Google AI Studio', document.createElement('input'), true);
  key.type = 'password'; key.autocomplete = 'off'; key.value = settings.apiKey; key.placeholder = 'AIza…';
  const link = document.createElement('a'); link.href = 'https://aistudio.google.com/apikey'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Получить API-ключ'; root.append(link);
  const model = field('Модель транскрибации', document.createElement('select'), true);
  const language = field('Язык', document.createElement('select'));
  language.add(new Option('Авто', 'auto'));
  const names = new Intl.DisplayNames(['ru'], { type: 'language' });
  GEMINI_TRANSCRIPTION_LANGUAGES.forEach(code => {
    let title = code;
    try { title = `${names.of(code) ?? code} (${code})`; } catch { /* Keep the documented code. */ }
    language.add(new Option(title, code));
  });
  if (![...language.options].some(option => option.value === settings.language)) language.add(new Option(`${settings.language} (недоступен)`, settings.language));
  language.value = settings.language;
  const mode = field('Режим транскрибации', document.createElement('select'));
  mode.add(new Option('Дословно', 'verbatim')); mode.add(new Option('Умный', 'smart')); mode.value = settings.mode;
  const checkbox = (title: string, checked: boolean, change: (value: boolean) => void) => {
    const input = field(title, document.createElement('input')); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => { change(input.checked); save(); updateStatus(); });
  };
  checkbox('Таймкоды слов', settings.timestamps, value => { settings.timestamps = value; });
  checkbox('Разделять говорящих', settings.diarization, value => { settings.diarization = value; });
  const vocabulary = field('Словарь: один термин на строку', document.createElement('textarea'));
  vocabulary.value = settings.vocabulary.join('\n'); vocabulary.rows = 2;
  const test = document.createElement('button'); test.type = 'button'; test.className = 'btn secondary compact-btn'; test.textContent = 'Тест';
  test.title = 'Обновить список моделей и проверить ключ без распознавания. Запрос может учитываться в квоте API.';
  const status = document.createElement('span'); status.className = 'status-pill'; status.setAttribute('role', 'status');
  const details = document.createElement('p'); details.className = 'model-load-status'; details.setAttribute('role', 'status');
  root.append(test, status, details);
  const updateStatus = () => {
    if (editors.get(root)?.settings !== settings) return;
    const local = geminiTranscriptionConfigurationError(settings);
    const unavailable = models && !models.some(m => m.id === settings.model)
      ? models.length ? 'Выбранная модель отсутствует в списке доступных моделей.' : 'API не вернул доступных моделей Gemini Transcribe.' : '';
    const message = failure || unavailable || local || (models ? 'Ключ и модель проверены через API. Языки и параметры — по документации; распознавание не запускалось.' : 'Укажите ключ из Google AI Studio.');
    const state = loading ? 'idle' : failure || unavailable || local ? 'error' : models ? 'ready' : 'idle';
    const text = loading ? 'Проверяется' : state === 'error' ? 'Не готов' : state === 'ready' ? 'Готов' : 'Не проверен';
    status.textContent = text; status.className = `status-pill status-pill--${state}`; status.title = message;
    details.textContent = message;
    key.closest('label')?.classList.toggle('is-invalid', !settings.apiKey);
    model.closest('label')?.classList.toggle('is-invalid', !settings.model || Boolean(unavailable));
    onStatus?.(text, state, message);
  };
  const renderModels = () => {
    model.replaceChildren(new Option('Выберите…', ''));
    if (settings.model && !models?.some(m => m.id === settings.model)) model.add(new Option(`${settings.model} (недоступен)`, settings.model));
    models?.forEach(m => model.add(new Option(m.name, m.id))); model.value = settings.model; updateStatus();
  };
  const load = async (refresh = false) => {
    request?.abort(); const current = request = new AbortController();
    if (!settings.apiKey || !root.isConnected || editors.get(root)?.settings !== settings) { updateStatus(); return; }
    loading = true; failure = ''; updateStatus();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 15_000);
    try {
      const result = await fetchGeminiTranscriptionCatalog(settings.apiKey, current.signal, fetch, refresh);
      if (current.signal.aborted || !root.isConnected || editors.get(root)?.settings !== settings) return;
      models = result;
      if (!settings.model && models.length) { settings.model = models[0].id; save(); }
      renderModels();
    } catch (error) {
      if (current.signal.aborted && !timedOut) return;
      failure = timedOut ? 'Gemini API не ответил за 15 секунд.' : error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(timeout); if (request === current) { loading = false; updateStatus(); } }
  };
  key.addEventListener('input', () => {
    clearTimeout(timer); request?.abort(); settings.apiKey = key.value.trim(); models = undefined; loading = false; failure = '';
    save(); renderModels(); timer = setTimeout(() => { void load(); }, 700);
  });
  model.addEventListener('change', () => { settings.model = model.value; save(); updateStatus(); });
  language.addEventListener('change', () => { settings.language = language.value; save(); updateStatus(); });
  mode.addEventListener('change', () => { settings.mode = mode.value === 'smart' ? 'smart' : 'verbatim'; save(); updateStatus(); });
  vocabulary.addEventListener('input', () => { settings.vocabulary = vocabulary.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); save(); updateStatus(); });
  test.addEventListener('click', () => { clearTimeout(timer); void load(true); });
  editors.set(root, { settings, updateStatus, dispose: () => { clearTimeout(timer); request?.abort(); } });
  renderModels();
  if (settings.apiKey) queueMicrotask(() => { void load(); });
}
