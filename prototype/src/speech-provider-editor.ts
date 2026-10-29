import type { ScenarioStep } from './scenario';
import { normalizeSpeechProviders, speechConfigurationError } from './speech-provider-settings';
import { fetchSpeechCatalog, fetchPiperDownloads, downloadPiperVoice, speechStreams, type SpeechCatalog, type SpeechVoice } from './speech-providers';
import { fieldNote, formField, formGrid, modelPicker, playbackMode, refreshButton, setPanelStatus, setPlaybackMode, showField, type SpeechPanel } from './speech-panel';

const catalogs = new Map<string, { promise: Promise<SpeechCatalog>; loaded: number }>();

export function mountExternalSpeechSettings(panel: SpeechPanel, step: ScenarioStep, save: () => void) {
  const provider = step.speechProvider;
  if (!provider || provider === 'none' || provider === 'system' || provider === 'edge') return;
  const all = step.speechProviders = normalizeSpeechProviders(step.speechProviders);
  const config = all[provider];
  const root = panel.body;
  const test = panel.test;
  let badge: HTMLSpanElement | undefined;
  let catalog: SpeechCatalog | undefined;
  let catalogError = '';
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const refreshButtons: HTMLButtonElement[] = [];
  const setBusy = (busy: boolean) => { refreshButtons.forEach(button => { button.disabled = busy; }); test.disabled = busy; };
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
    const readyDetails = provider === 'piper' ? 'Голоса получены с локального сервера Piper. Озвучка не требует облачной квоты; синтез не запускался.'
      : 'Ключ принят, модели и голоса получены. Синтез не запускался; бесплатно в пределах квоты провайдера, остаток квоты проверится при выполнении шага.';
    const state = loading ? 'idle' : message ? 'error' : ready ? 'ready' : 'idle';
    setPanelStatus(panel, state, loading ? 'Проверка…' : message ? 'Ошибка' : ready ? (provider === 'piper' ? 'Голоса получены' : 'Ключ и модель проверены') : 'Не проверен',
      message || (ready ? `${readyDetails} ${catalog!.notice ?? ''}`.trim() : 'Не проверен.'));
    if (modelNote) modelNote.textContent = catalog && loadedSignature === signature() && provider !== 'piper' ? `Моделей: ${catalog.models.length}` : '';
    voiceNote.textContent = catalog && loadedSignature === signature() ? `Голосов: ${catalog.voices.length}` : '';
    if (badge) {
      badge.textContent = loading ? 'Проверка…' : message ? 'Не готов' : ready ? 'Параметры проверены' : 'Не проверен';
      badge.className = `speech-provider-readiness status-pill status-pill--${state}`;
      badge.title = panel.details.textContent ?? '';
    }
    inputs.forEach(({ control, valid }) => control.setAttribute('aria-invalid', String(!valid())));
    setPlaybackMode(mode, speechStreams(step));
    markEmpty();
  };
  const input = (grid: HTMLElement, title: string, value: string, update: (value: string) => void, type = 'text', required = false) => {
    const control = document.createElement('input'); control.type = type; control.value = value;
    control.autocomplete = 'off'; control.spellcheck = false;
    if (required) { control.required = true; inputs.push({ control, valid: () => !!control.value.trim() }); }
    control.addEventListener('input', () => { update(control.value); save(); setStatus(); });
    formField(grid, title, control, required); return control;
  };
  const number = (grid: HTMLElement, title: string, value: number | undefined, min: number, max: number, increment: number, update: (value?: number) => void) => {
    const control = document.createElement('input'); control.type = 'number'; control.value = value === undefined ? '' : String(value);
    control.min = String(min); control.max = String(max); control.step = String(increment); control.placeholder = 'По умолчанию';
    control.addEventListener('input', () => {
      if (control.value === '') { update(undefined); save(); }
      else if (control.checkValidity() && Number.isFinite(control.valueAsNumber)) { update(control.valueAsNumber); save(); }
    });
    return formField(grid, title, control);
  };
  const picker = (grid: HTMLElement, title: string, value: string, update: (value: string) => void) => {
    const control = document.createElement('select');
    control.required = true;
    inputs.push({ control, valid: () => !!control.value && (control === voices
      ? !!catalog?.voices.some(voice => voice.id === control.value) : !!catalog?.models.some(model => model.id === control.value)) });
    control.add(new Option(value || 'Выберите…', value));
    control.addEventListener('change', () => { update(control.value); save(); refreshDependent(); setStatus(); });
    // The lists come from the API, so each one can be reloaded in place.
    const reload = refreshButton(`Обновить: ${title.toLowerCase()}`, () => { void load(true); });
    refreshButtons.push(reload);
    return { control, field: formField(grid, title, modelPicker(control, reload), true) };
  };
  // An empty list says why it is empty, so a failed load is visible at the list itself.
  const emptyLabel = () => loading ? 'Загрузка…' : catalogError ? 'Не загружено' : 'Выберите…';
  const markEmpty = () => [models, voices].forEach(control => {
    const first = control?.options[0];
    if (control && first && !first.value && control.options.length === 1) first.text = emptyLabel();
  });
  const replaceOptions = (control: HTMLSelectElement, options: { id: string; name: string }[], value: string, empty = 'Выберите…') => {
    control.replaceChildren(new Option(empty, ''));
    options.forEach(option => control.add(new Option(option.name, option.id)));
    if (value && !options.some(option => option.id === value)) control.add(new Option(`${value} · недоступен`, value));
    control.value = value;
  };
  // The key sits next to the provider, as in the transcription card.
  const key = provider === 'piper'
    ? input(panel.grid, 'Адрес Piper', all.piper.url, value => { all.piper.url = value; }, 'url', true)
    : input(panel.grid, 'API-ключ', all[provider].apiKey, value => { all[provider].apiKey = value; }, 'password', true);
  key.addEventListener('input', () => {
    generation++; loading = false; setBusy(false);
    catalog = undefined; catalogError = ''; loadedSignature = ''; setStatus();
    clearTimeout(timer); timer = setTimeout(() => { if (root.isConnected) void load(); }, 600);
  });
  const grid = formGrid(root);
  const model = provider === 'piper' ? undefined : picker(grid, 'Модель', all[provider].model, value => { all[provider].model = value; });
  const models = model?.control;
  const modelNote = model && fieldNote(model.field);
  const voice = picker(grid, 'Голос', config.voice, value => { config.voice = value; if (provider === 'piper') all.piper.speakerId = undefined; });
  const voices = voice.control;
  const voiceNote = fieldNote(voice.field);
  // Playback mode depends on the configuration (Gemini: on the model), so it sits next to the model.
  const mode = playbackMode(model?.field ?? voice.field, speechStreams(step));
  const dependent = document.createElement('div'); dependent.style.display = 'contents'; grid.append(dependent);
  const refreshDependent = () => {
    dependent.replaceChildren();
    const selectedModel = catalog?.models.find(item => provider !== 'piper' && item.id === all[provider].model);
    const selectedVoice = catalog?.voices.find(item => item.id === config.voice);
    if (provider === 'piper' && (selectedVoice?.speakers?.length ?? 0) > 1) {
      const speaker = document.createElement('select');
      speaker.add(new Option('По умолчанию', ''));
      selectedVoice!.speakers!.forEach(item => speaker.add(new Option(item.name, String(item.id))));
      speaker.value = all.piper.speakerId === undefined ? '' : String(all.piper.speakerId);
      speaker.addEventListener('change', () => { all.piper.speakerId = speaker.value === '' ? undefined : +speaker.value; save(); });
      formField(dependent, 'Говорящий', speaker);
    }
    if (provider === 'elevenlabs') {
      const language = document.createElement('select');
      replaceOptions(language, all.elevenlabs.model.includes('multilingual_v2') ? [] : selectedModel?.languages ?? [], all.elevenlabs.language, 'Авто');
      language.addEventListener('change', () => { all.elevenlabs.language = language.value; save(); });
      showField(formField(dependent, 'Язык', language), !all.elevenlabs.model.includes('multilingual_v2') && !!selectedModel?.languages?.length);
      showField(styleField, !!selectedModel?.style);
      showField(boostField, !!selectedModel?.speakerBoost);
      if (selectedModel && (all.elevenlabs.canUseStyle !== !!selectedModel.style || all.elevenlabs.canUseSpeakerBoost !== !!selectedModel.speakerBoost)) {
        all.elevenlabs.canUseStyle = !!selectedModel.style; all.elevenlabs.canUseSpeakerBoost = !!selectedModel.speakerBoost; save();
      }
    }
  };
  let styleField: HTMLElement, boostField: HTMLElement;
  if (provider === 'gemini') {
    // Same prompt field as in transcription: label above, grows with the text, resizable.
    const style = document.createElement('textarea'); style.className = 'prompt-input'; style.value = all.gemini.style; style.rows = 3;
    style.placeholder = 'Например: спокойно, с короткими паузами';
    style.addEventListener('input', () => { all.gemini.style = style.value; save(); });
    const styleGrid = formGrid(root); styleGrid.classList.add('form-grid--spaced');
    formField(styleGrid, 'Манера речи', style);
  } else if (provider === 'elevenlabs') {
    number(grid, 'Стабильность', all.elevenlabs.stability, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.stability = value; });
    number(grid, 'Сходство с голосом', all.elevenlabs.similarity, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.similarity = value; });
    number(grid, 'Скорость', all.elevenlabs.speed, .7, 1.2, .05, value => { if (value !== undefined) all.elevenlabs.speed = value; });
    styleField = number(grid, 'Выразительность', all.elevenlabs.style, 0, 1, .05, value => { if (value !== undefined) all.elevenlabs.style = value; });
    const boost = document.createElement('input'); boost.type = 'checkbox'; boost.checked = all.elevenlabs.speakerBoost;
    boost.addEventListener('change', () => { all.elevenlabs.speakerBoost = boost.checked; save(); });
    boostField = formField(grid, 'Усиление сходства', boost);
    showField(styleField, false); showField(boostField, false);
  } else {
    number(grid, 'Длительность речи', all.piper.lengthScale, .1, 5, .1, value => { all.piper.lengthScale = value; });
    number(grid, 'Вариативность', all.piper.noiseScale, 0, 2, .05, value => { all.piper.noiseScale = value; });
    number(grid, 'Вариативность длительности', all.piper.noiseWScale, 0, 2, .05, value => { all.piper.noiseWScale = value; });
  }
  number(grid, 'Громкость, %', Math.round(config.volume * 100), 0, 100, 1, value => { config.volume = (value ?? 100) / 100; });
  const load = async (force = false) => {
    if (!signature().trim()) { setStatus(); return; }
    const id = ++generation, requested = signature(), cacheKey = `${provider}:${requested}`;
    loading = true; catalogError = ''; setBusy(true); setStatus();
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
      if (id === generation) { loading = false; setBusy(false); setStatus(); }
    }
  };
  test.title = 'Обновить модели и голоса и проверить ключ без синтеза. Запрос может учитываться в квоте API.';
  test.onclick = () => { void load(true); };
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
