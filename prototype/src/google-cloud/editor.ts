import { serviceAccountProject } from './auth';
import { fetchGoogleCloudCatalog, googleCloudCatalogError, googleCloudFeatures, googleCloudModelOptions, type GoogleCloudLocation } from './catalog';
import { GOOGLE_CLOUD_FEATURES, googleCloudConfigurationError, type GoogleCloudSettings } from './settings';

interface Editor { settings: GoogleCloudSettings; updateStatus(): void }
const editors = new WeakMap<HTMLElement, Editor>();

export function mountGoogleCloudEditor(root: HTMLElement, settings: GoogleCloudSettings, save: () => void,
  onStatus?: (text: string, state: 'idle' | 'ready' | 'error', details: string) => void): void {
  const previous = editors.get(root);
  if (previous?.settings === settings) { previous.updateStatus(); return; }
  root.replaceChildren();
  let locations: GoogleCloudLocation[] | undefined, checked = false, loading = false, failure = '';
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  const grid = document.createElement('div'); grid.className = 'form-grid'; root.append(grid);
  const field = <T extends HTMLInputElement | HTMLSelectElement>(title: string, control: T): T => {
    const label = document.createElement('label'); label.className = 'form-field form-field--important';
    label.append(`${title} *`, control); grid.append(label);
    control.required = true; control.setAttribute('aria-label', title); return control;
  };
  const project = document.createElement('input'); project.value = settings.projectId;
  field('ID проекта', project);
  const credentials = document.createElement('input'); credentials.type = 'password'; credentials.value = settings.credentials;
  credentials.placeholder = 'JSON сервисного аккаунта или OAuth-токен'; credentials.autocomplete = 'off';
  field('Авторизация Google Cloud', credentials);
  const location = field('Регион', document.createElement('select'));
  const model = field('Модель', document.createElement('select'));
  const language = field('Язык', document.createElement('select'));
  const features = document.createElement('div'); features.className = 'form-grid'; root.append(features);
  const test = document.createElement('button'); test.type = 'button'; test.className = 'btn secondary compact-btn'; test.textContent = 'Тест';
  test.title = 'Обновить регионы, модели и языки через Locations API без распознавания аудио. Запрос учитывается в квоте API.';
  const status = document.createElement('span'); status.className = 'status-pill status-pill--idle'; status.setAttribute('role', 'status');
  const details = document.createElement('p'); details.className = 'model-load-status'; details.setAttribute('role', 'status');
  root.append(test, status, details);
  const updateStatus = () => {
    if (editors.get(root)?.settings !== settings) return;
    const problem = googleCloudConfigurationError(settings) || (locations ? googleCloudCatalogError(settings, locations) : null);
    const message = failure || problem || (checked ? 'Регионы, модели, языки и функции получены из API.' : 'Проверка без обработки аудио.');
    const state = loading ? 'idle' : failure || problem ? 'error' : checked ? 'ready' : 'idle';
    const text = loading ? 'Проверяется' : failure || problem ? 'Не готов' : checked ? 'Готов' : 'Не проверен';
    status.textContent = text; status.className = `status-pill status-pill--${state}`; status.title = message;
    details.textContent = message;
    for (const input of [project, credentials, location, model, language]) input.closest('label')?.classList.toggle('is-invalid', !input.value.trim());
    onStatus?.(text, state, message);
  };
  const options = (control: HTMLSelectElement, entries: [string, string][], value: string) => {
    control.replaceChildren(new Option('Выберите…', ''));
    if (value && !entries.some(([id]) => id === value)) control.add(new Option(`${value} (недоступен)`, value));
    entries.forEach(([id, name]) => control.add(new Option(name, id))); control.value = value;
  };
  const renderChoices = () => {
    options(location, (locations ?? []).map(l => [l.id, l.name === l.id ? l.id : `${l.name} (${l.id})`]), settings.location);
    const selected = locations?.find(l => l.id === settings.location);
    const models = googleCloudModelOptions(selected);
    options(model, models.map(id => [id, id]), settings.model);
    const languages = Object.entries(selected?.languages ?? {}).filter(([, list]) => list.some(m => m.id === settings.model)).map(([code]) => code).sort();
    const entries: [string, string][] = languages.filter(code => code !== 'auto').map(code => [code, code]);
    // Locations API doesn't describe the special language code "auto".
    // https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
    if (settings.model === 'chirp_3') entries.unshift(['auto', 'Авто']);
    options(language, entries, settings.language);
    features.replaceChildren();
    const available = googleCloudFeatures(selected, settings.model, settings.language);
    for (const [id, , title] of GOOGLE_CLOUD_FEATURES) {
      if (!available.some(f => f.id === id) && settings.features[id] === undefined) continue;
      const label = document.createElement('label'); label.className = 'form-field';
      const input = document.createElement('select'); input.setAttribute('aria-label', title);
      input.add(new Option('По умолчанию', '')); input.add(new Option('Вкл', 'true')); input.add(new Option('Выкл', 'false'));
      input.value = settings.features[id] === undefined ? '' : String(settings.features[id]);
      label.append(title, input); features.append(label);
      input.addEventListener('change', () => {
        if (!input.value) delete settings.features[id]; else settings.features[id] = input.value === 'true';
        save(); updateStatus();
      });
    }
    const info = document.createElement('span'); info.className = 'model-load-status';
    info.textContent = available.map(f => `${f.id}${f.releaseState ? ` (${f.releaseState})` : ''}`).join(', ');
    features.append(info); updateStatus();
  };
  const load = async (refresh = false) => {
    request?.abort(); request = new AbortController(); const current = request;
    if (!settings.projectId || !settings.credentials) { updateStatus(); return; }
    const snapshot = { ...settings }; loading = true; failure = ''; checked = false; updateStatus();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; current.abort(); }, 15_000);
    try {
      const result = await fetchGoogleCloudCatalog(snapshot, current.signal, fetch, refresh);
      if (current.signal.aborted || !root.isConnected || editors.get(root)?.settings !== settings) return;
      locations = result; checked = true;
      if (!settings.location) settings.location = locations.find(l => googleCloudModelOptions(l).includes('chirp_3'))?.id ?? locations[0]?.id ?? '';
      if (!settings.model) settings.model = googleCloudModelOptions(locations.find(l => l.id === settings.location)).find(id => id === 'chirp_3')
        ?? googleCloudModelOptions(locations.find(l => l.id === settings.location))[0] ?? '';
      save(); renderChoices();
    } catch (error) {
      if (current.signal.aborted && !timedOut) return;
      failure = timedOut ? 'Google Cloud не ответил за 15 секунд.' : error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(timeout); if (request === current) { loading = false; updateStatus(); } }
  };
  const changedAuth = () => {
    request?.abort(); clearTimeout(timer); locations = undefined; checked = false; loading = false; failure = '';
    settings.projectId = project.value.trim(); settings.credentials = credentials.value.trim();
    if (!settings.projectId) { settings.projectId = serviceAccountProject(settings.credentials); project.value = settings.projectId; }
    save(); renderChoices(); timer = setTimeout(() => { void load(); }, 700);
  };
  project.addEventListener('input', changedAuth); credentials.addEventListener('input', changedAuth);
  location.addEventListener('change', () => { settings.location = location.value; save(); renderChoices(); });
  model.addEventListener('change', () => { settings.model = model.value; save(); renderChoices(); });
  language.addEventListener('change', () => { settings.language = language.value; save(); renderChoices(); });
  test.addEventListener('click', () => { clearTimeout(timer); void load(true); });
  editors.set(root, { settings, updateStatus }); renderChoices();
  if (settings.projectId && settings.credentials) void load();
}
