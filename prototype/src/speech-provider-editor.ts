import type { ScenarioStep } from './scenario';
import { normalizeSpeechProviders, speechConfigurationError } from './speech-provider-settings';
import { fetchSpeechCatalog, fetchPiperDownloads, downloadPiperVoice, type SpeechCatalog, type SpeechVoice } from './speech-providers';

const catalogs = new Map<string, { promise: Promise<SpeechCatalog>; loaded: number }>();

export function mountExternalSpeechSettings(parent: HTMLElement, step: ScenarioStep, save: () => void) {
  const provider = step.speechProvider;
  if (!provider || provider === 'none' || provider === 'system') return;
  const all = step.speechProviders = normalizeSpeechProviders(step.speechProviders);
  const config = all[provider];
  const root = document.createElement('div');
  root.className = 'external-speech-settings';
  parent.append(root);
  const status = document.createElement('span');
  status.className = 'model-load-status'; status.setAttribute('role', 'status');
  let badge: HTMLSpanElement | undefined;
  let catalog: SpeechCatalog | undefined;
  let catalogError = '';
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const inputs: { control: HTMLInputElement | HTMLSelectElement; valid: () => boolean }[] = [];
  const signature = () => provider === 'piper' ? all.piper.url : all[provider].apiKey.trim();
  let loadedSignature = '';
  const setStatus = () => {
    if (!badge) {
      const summary = root.closest('details')?.querySelector(':scope > summary');
      if (summary) {
        summary.querySelector('.speech-provider-readiness')?.remove();
        badge = document.createElement('span'); badge.className = 'speech-provider-readiness status-pill';
        summary.append(badge);
      }
    }
    const problem = speechConfigurationError(provider, all);
    const selectedModel = catalog?.models.find(model => provider !== 'piper' && model.id === all[provider].model);
    const selectedVoice = catalog?.voices.find(voice => voice.id === config.voice);
    const unavailable = catalog && (!selectedVoice || (provider !== 'piper' && !selectedModel));
    const message = loading ? 'Проверка…' : catalogError || problem || (unavailable ? 'Выбранная модель или голос недоступны.' : '');
    const ready = !message && catalog && loadedSignature === signature();
    status.textContent = message || (ready ? `${provider === 'piper' ? '' : `Моделей: ${catalog!.models.length}; `}голосов: ${catalog!.voices.length}. ${catalog!.notice ?? ''}` : 'Не проверен');
    status.title = ready ? provider === 'piper' ? 'Голоса получены с локального сервера. Синтез не запускался.'
      : 'Параметры проверены без синтеза. Возможность генерации и остаток квоты проверяются при выполнении шага.' : message;
    if (badge) {
      badge.textContent = loading ? 'Проверка…' : message ? 'Не готов' : ready ? 'Параметры проверены' : 'Не проверен';
      badge.className = `speech-provider-readiness status-pill status-pill--${loading ? 'idle' : message ? 'error' : ready ? 'ready' : 'idle'}`;
      badge.title = message || status.title;
    }
    inputs.forEach(({ control, valid }) => control.setAttribute('aria-invalid', String(!valid())));
  };
  const field = (title: string, control: HTMLElement, required = false) => {
    const label = document.createElement('label');
    label.className = 'scenario-step-setting-label';
    label.append(title);
    if (required) {
      label.classList.add('form-field--important');
      const marker = document.createElement('span'); marker.className = 'req-marker'; marker.textContent = '*'; label.append(marker);
      control.setAttribute('aria-required', 'true');
    }
    control.setAttribute('aria-label', title);
    label.append(control); root.append(label);
  };
  const input = (title: string, value: string, update: (value: string) => void, type = 'text', required = false) => {
    const control = document.createElement('input'); control.type = type; control.value = value;
    control.autocomplete = 'off'; control.spellcheck = false;
    if (required) { control.required = true; inputs.push({ control, valid: () => !!control.value.trim() }); }
    control.addEventListener('input', () => { update(control.value); save(); setStatus(); });
    field(title, control, required); return control;
  };
  const number = (title: string, value: number | undefined, min: number, max: number, increment: number, update: (value?: number) => void) => {
    const control = document.createElement('input'); control.type = 'number'; control.value = value === undefined ? '' : String(value);
    field(title, control);
    control.min = String(min); control.max = String(max); control.step = String(increment); control.placeholder = 'По умолчанию';
    control.addEventListener('input', () => {
      if (control.value === '') { update(undefined); save(); }
      else if (control.checkValidity() && Number.isFinite(control.valueAsNumber)) { update(control.valueAsNumber); save(); }
    });
  };
  const picker = (title: string, value: string, update: (value: string) => void, required = false) => {
    const control = document.createElement('select');
    if (required) { control.required = true; inputs.push({ control, valid: () => !!control.value && (control === voices
      ? !!catalog?.voices.some(voice => voice.id === control.value) : !!catalog?.models.some(model => model.id === control.value)) }); }
    control.add(new Option(value || 'Выберите…', value));
    control.addEventListener('change', () => { update(control.value); save(); refreshDependent(); setStatus(); });
    field(title, control, required); return control;
  };
  const replaceOptions = (control: HTMLSelectElement, options: { id: string; name: string }[], value: string, empty = 'Выберите…') => {
    control.replaceChildren(new Option(empty, ''));
    options.forEach(option => control.add(new Option(option.name, option.id)));
    if (value && !options.some(option => option.id === value)) control.add(new Option(`${value} · недоступен`, value));
    control.value = value;
  };
  const note = document.createElement('p'); note.className = 'model-load-status';
  note.textContent = provider === 'piper' ? 'Локальный сервер Piper. Озвучка не требует облачной квоты.' : 'Бесплатно в пределах квоты провайдера.';
  root.append(note);
  const key = provider === 'piper'
    ? input('Адрес Piper', all.piper.url, value => { all.piper.url = value; }, 'url', true)
    : input('API-ключ', all[provider].apiKey, value => { all[provider].apiKey = value; }, 'password', true);
  key.addEventListener('input', () => {
    generation++; loading = false; refresh.disabled = test.disabled = false;
    catalog = undefined; catalogError = ''; loadedSignature = ''; setStatus();
    clearTimeout(timer); timer = setTimeout(() => { if (root.isConnected) void load(); }, 600);
  });
  const models = provider === 'piper' ? undefined : picker('Модель', all[provider].model, value => { all[provider].model = value; }, true);
  const voices = picker('Голос', config.voice, value => { config.voice = value; if (provider === 'piper') all.piper.speakerId = undefined; }, true);
  const dependent = document.createElement('div'); root.append(dependent);
  const refreshDependent = () => {
    dependent.replaceChildren();
    const model = catalog?.models.find(item => provider !== 'piper' && item.id === all[provider].model);
    const voice = catalog?.voices.find(item => item.id === config.voice);
    if (provider === 'piper' && (voice?.speakers?.length ?? 0) > 1) {
      const speaker = document.createElement('select'); speaker.setAttribute('aria-label', 'Говорящий');
      speaker.add(new Option('По умолчанию', ''));
      voice!.speakers!.forEach(item => speaker.add(new Option(item.name, String(item.id))));
      speaker.value = all.piper.speakerId === undefined ? '' : String(all.piper.speakerId);
      speaker.addEventListener('change', () => { all.piper.speakerId = speaker.value === '' ? undefined : +speaker.value; save(); });
      const label = document.createElement('label'); label.className = 'scenario-step-setting-label'; label.append('Говорящий', speaker); dependent.append(label);
    }
    if (provider === 'elevenlabs') {
      const language = document.createElement('select'); language.setAttribute('aria-label', 'Язык');
      replaceOptions(language, all.elevenlabs.model.includes('multilingual_v2') ? [] : model?.languages ?? [], all.elevenlabs.language, 'Авто');
      language.addEventListener('change', () => { all.elevenlabs.language = language.value; save(); });
      const label = document.createElement('label'); label.className = 'scenario-step-setting-label'; label.append('Язык', language);
      label.hidden = all.elevenlabs.model.includes('multilingual_v2') || !model?.languages?.length;
      dependent.append(label);
      styleField.hidden = !model?.style;
      boostField.hidden = !model?.speakerBoost;
      if (model && (all.elevenlabs.canUseStyle !== !!model.style || all.elevenlabs.canUseSpeakerBoost !== !!model.speakerBoost)) {
        all.elevenlabs.canUseStyle = !!model.style; all.elevenlabs.canUseSpeakerBoost = !!model.speakerBoost; save();
      }
    }
  };
  let styleField: HTMLElement, boostField: HTMLElement;
  if (provider === 'gemini') {
    const style = document.createElement('textarea'); style.value = all.gemini.style; style.rows = 2;
    style.placeholder = 'Например: спокойно, с короткими паузами';
    style.addEventListener('input', () => { all.gemini.style = style.value; save(); });
    field('Манера речи', style);
  } else if (provider === 'elevenlabs') {
    number('Стабильность', all.elevenlabs.stability, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.stability = value; });
    number('Сходство с голосом', all.elevenlabs.similarity, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.similarity = value; });
    number('Скорость', all.elevenlabs.speed, .7, 1.2, .05, value => { if (value !== undefined) all.elevenlabs.speed = value; });
    number('Выразительность', all.elevenlabs.style, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.style = value; });
    styleField = root.lastElementChild as HTMLElement;
    const boost = document.createElement('input'); boost.type = 'checkbox'; boost.checked = all.elevenlabs.speakerBoost;
    boost.addEventListener('change', () => { all.elevenlabs.speakerBoost = boost.checked; save(); });
    field('Усиление сходства', boost); boostField = root.lastElementChild as HTMLElement;
    styleField.hidden = boostField.hidden = true;
  } else {
    number('Длительность речи', all.piper.lengthScale, .1, 5, .1, value => { all.piper.lengthScale = value; });
    number('Вариативность', all.piper.noiseScale, 0, 2, .05, value => { all.piper.noiseScale = value; });
    number('Вариативность длительности', all.piper.noiseWScale, 0, 2, .05, value => { all.piper.noiseWScale = value; });
  }
  number('Громкость, %', Math.round(config.volume * 100), 0, 100, 1, value => { config.volume = (value ?? 100) / 100; });
  const buttons = document.createElement('div'); buttons.className = 'btn-group'; root.append(buttons);
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn secondary'; refresh.textContent = 'Обновить';
  const test = document.createElement('button'); test.type = 'button'; test.className = 'btn secondary'; test.textContent = 'Тест';
  refresh.title = 'Получить модели и голоса без синтеза'; test.title = 'Проверить параметры без синтеза';
  buttons.append(refresh, test); root.append(status);
  const load = async (force = false) => {
    if (!signature().trim()) { setStatus(); return; }
    const id = ++generation, requested = signature(), cacheKey = `${provider}:${requested}`;
    loading = true; catalogError = ''; refresh.disabled = test.disabled = true; setStatus();
    try {
      let cached = catalogs.get(cacheKey);
      if (force || !cached || Date.now() - cached.loaded > 60_000) {
        const promise = fetchSpeechCatalog(provider, structuredClone(all));
        cached = { promise, loaded: Date.now() }; catalogs.set(cacheKey, cached);
        void promise.catch(() => { if (catalogs.get(cacheKey)?.promise === promise) catalogs.delete(cacheKey); });
        if (catalogs.size > 50) catalogs.delete(catalogs.keys().next().value!);
      }
      const result = await cached.promise;
      if (id !== generation || requested !== signature() || !root.isConnected) return;
      catalog = result; loadedSignature = requested;
      let changed = false;
      if (provider !== 'piper' && !all[provider].model && result.models.length) { all[provider].model = result.models[0].id; changed = true; }
      if (!config.voice && result.voices.length) { config.voice = result.voices[0].id; changed = true; }
      if (models && provider !== 'piper') replaceOptions(models, result.models, all[provider].model);
      replaceOptions(voices, result.voices.map(voice => ({ ...voice, name: `${voice.name}${voice.language ? ` (${voice.language})` : ''}` })), config.voice);
      refreshDependent();
      if (changed) save();
    } catch (error) {
      if (id === generation && root.isConnected) catalogError = error instanceof Error ? error.message : String(error);
    } finally {
      if (id === generation) { loading = false; refresh.disabled = test.disabled = false; setStatus(); }
    }
  };
  refresh.addEventListener('click', () => { void load(true); });
  test.addEventListener('click', () => { void load(true); });
  if (provider === 'piper') {
    const setup = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Подключение Piper'; setup.append(summary);
    const help = document.createElement('p'); help.className = 'model-load-status';
    help.textContent = 'Запустите Piper на компьютере. На Android укажите сетевой адрес этого компьютера.';
    const commands = document.createElement('pre'); commands.textContent = 'python -m pip install "piper-tts[http]"\npython -m piper.download_voices ru_RU-irina-medium\npython -m piper.http_server -m ru_RU-irina-medium';
    setup.append(help, commands); root.append(setup);
    const download = document.createElement('details'), downloadSummary = document.createElement('summary'); downloadSummary.textContent = 'Загрузить голос'; download.append(downloadSummary);
    const list = document.createElement('select'); list.setAttribute('aria-label', 'Голос для загрузки'); list.add(new Option('Загрузите список голосов…', ''));
    const languages = document.createElement('select'); languages.setAttribute('aria-label', 'Язык загружаемого голоса'); languages.add(new Option('Все языки', ''));
    const loadVoices = document.createElement('button'); loadVoices.type = 'button'; loadVoices.className = 'btn secondary'; loadVoices.textContent = 'Список голосов';
    const downloadButton = document.createElement('button'); downloadButton.type = 'button'; downloadButton.className = 'btn secondary'; downloadButton.textContent = 'Скачать'; downloadButton.disabled = true;
    const message = document.createElement('span'); message.className = 'model-load-status'; message.setAttribute('role', 'status');
    let available: SpeechVoice[] = [];
    const filter = () => { replaceOptions(list, available.filter(voice => !languages.value || voice.language === languages.value), ''); downloadButton.disabled = true; };
    languages.addEventListener('change', filter);
    loadVoices.addEventListener('click', () => { void (async () => {
      const url = all.piper.url; loadVoices.disabled = true; message.textContent = 'Загрузка списка…';
      try {
        const result = await fetchPiperDownloads(url);
        if (!root.isConnected || url !== all.piper.url) return;
        available = result;
        languages.replaceChildren(new Option('Все языки', ''));
        [...new Set(available.map(voice => voice.language).filter((value): value is string => !!value))].sort().forEach(language => languages.add(new Option(language, language)));
        filter(); message.textContent = `Голосов: ${available.length}`;
      } catch (error) { message.textContent = (error as Error).message; }
      finally { loadVoices.disabled = false; }
    })(); });
    list.addEventListener('change', () => { downloadButton.disabled = !list.value; });
    downloadButton.addEventListener('click', () => { void (async () => {
      const voice = list.value, url = all.piper.url;
      if (!voice) return;
      downloadButton.disabled = true; message.textContent = 'Скачивание…';
      try {
        await downloadPiperVoice(url, voice);
        if (!root.isConnected || url !== all.piper.url) return;
        if (config.voice !== voice) all.piper.speakerId = undefined;
        config.voice = voice; save(); await load(true); message.textContent = 'Голос загружен.';
      } catch (error) { message.textContent = (error as Error).message; }
      finally { downloadButton.disabled = !list.value; }
    })(); });
    download.append(languages, list, loadVoices, downloadButton, message); root.append(download);
  }
  queueMicrotask(() => { setStatus(); if (root.isConnected) void load(); });
}
