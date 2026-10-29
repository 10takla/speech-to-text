import type { ScenarioStep } from './scenario';
import { AUTO_SPEECH_LANGUAGE, normalizeSpeechSettings, type SystemSpeechSettings } from './speech-settings';
import { getSystemSpeechCapabilities, type SystemSpeechVoice } from './system-speech';
import { mountExternalSpeechSettings } from './speech-provider-editor';
import { normalizeSpeechProvider, normalizeSpeechProviders } from './speech-provider-settings';
import { getEdgeVoices } from './edge-speech';
import { canStreamMp3 } from './streaming-playback';
import { fieldNote, formField, formGrid, modelPicker, playbackMode, refreshButton, setPanelStatus, type SpeechPanel } from './speech-panel';

// Where a voice form takes its voices and keeps its settings.
interface VoiceSource {
  load(force: boolean): Promise<SystemSpeechVoice[]>;
  read(): SystemSpeechSettings;
  write(settings: SystemSpeechSettings): void;
  defaultLabel?: string;
  emptyMessage: string;
  readyMessage: string;
  streaming: boolean;
  // Provider fields after the common ones.
  mountExtra?(grid: HTMLElement, save: () => void): void;
}

const systemVoices = (step: ScenarioStep): VoiceSource => ({
  load: async () => (await getSystemSpeechCapabilities()).voices,
  read: () => normalizeSpeechSettings(step.speechSettings),
  write: settings => { step.speechSettings = settings; },
  defaultLabel: 'Системный', emptyMessage: 'Системные голоса не найдены.',
  readyMessage: 'Голоса установлены в системе. Синтез не запускался.', streaming: false,
});

const edgeVoices = (step: ScenarioStep): VoiceSource => ({
  load: force => getEdgeVoices(force),
  read: () => normalizeSpeechProviders(step.speechProviders).edge,
  write: settings => { step.speechProviders = { ...normalizeSpeechProviders(step.speechProviders), edge: settings }; },
  emptyMessage: 'Голоса Edge не получены.',
  readyMessage: 'Нейроголоса Microsoft Edge получены: без ключа и лимитов, нужен интернет. Синтез не запускался.', streaming: canStreamMp3(),
  mountExtra: (grid, save) => {
    const preconnect = document.createElement('input');
    preconnect.type = 'checkbox';
    preconnect.checked = normalizeSpeechProviders(step.speechProviders).edgePreconnect;
    preconnect.title = 'Соединение с Microsoft открывается при запуске сценария: звук начинается примерно на секунду раньше.';
    preconnect.addEventListener('change', () => {
      step.speechProviders = { ...normalizeSpeechProviders(step.speechProviders), edgePreconnect: preconnect.checked };
      save();
    });
    formField(grid, 'Подключаться заранее', preconnect).title = preconnect.title;
  },
});

export function mountSpeechProvider(parent: HTMLElement, step: ScenarioStep, save: () => void, saveInline = save) {
  const root = document.createElement('section');
  root.className = 'scenario-provider-settings speech-provider-settings';
  const header = document.createElement('div'); header.className = 'card-header-row';
  const title = document.createElement('h2'); title.textContent = 'Озвучка текста';
  const actions = document.createElement('div'); actions.className = 'btn-group';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  const test = document.createElement('button'); test.type = 'button'; test.className = 'btn secondary compact-btn'; test.textContent = 'Тест';
  actions.append(status, test); header.append(title, actions);
  const details = document.createElement('p'); details.className = 'model-load-status'; details.setAttribute('role', 'status'); details.setAttribute('aria-live', 'polite');
  const grid = formGrid(root);
  root.prepend(header, details);
  const select = document.createElement('select');
  select.add(new Option('Не выбран', 'none'));
  select.add(new Option('Системный движок', 'system'));
  select.add(new Option('Microsoft Edge · нейроголоса', 'edge'));
  select.add(new Option('Piper · локально', 'piper'));
  select.add(new Option('Google Gemini TTS', 'gemini'));
  select.add(new Option('ElevenLabs', 'elevenlabs'));
  select.value = step.speechProvider ?? 'system';
  const providerField = formField(grid, 'Провайдер озвучки', select, true);
  const body = document.createElement('div'); root.append(body);
  const panel: SpeechPanel = { status, test, details, grid, body };
  const renderSettings = () => {
    parent.closest('details')?.querySelector(':scope > summary .speech-provider-readiness')?.remove();
    // The provider list stays; the key field and the provider fields are rebuilt.
    grid.replaceChildren(providerField);
    body.replaceChildren();
    test.hidden = false; test.disabled = false; test.onclick = null;
    if (select.value === 'system') mountSpeechSettings(panel, step, saveInline);
    else if (select.value === 'edge') mountSpeechSettings(panel, step, saveInline, edgeVoices(step));
    else if (select.value === 'none') { test.hidden = true; setPanelStatus(panel, 'idle', 'Не выбран', 'Выберите провайдер озвучки.'); }
    else mountExternalSpeechSettings(panel, step, saveInline);
  };
  select.addEventListener('change', () => {
    step.speechProvider = normalizeSpeechProvider(select.value);
    renderSettings();
    save();
  });
  // Same flag as the clipboard and paste steps.
  const overlay = document.createElement('label');
  overlay.className = 'checkbox-label';
  const showText = document.createElement('input');
  showText.type = 'checkbox';
  showText.dataset.showTextInOverlay = '';
  showText.checked = step.showTextInOverlay === true;
  showText.addEventListener('change', () => { step.showTextInOverlay = showText.checked; save(); });
  overlay.append(showText, 'Показывать текст в оверлее');
  root.append(overlay);
  parent.append(root);
  renderSettings();
}

export function mountSpeechSettings(panel: SpeechPanel, step: ScenarioStep, save: () => void, source = systemVoices(step)) {
  const root = panel.body;
  const settings = source.read();
  const persist = () => { source.write({ ...settings }); save(); };
  const grid = formGrid(root);
  const language = document.createElement('select');
  const voice = document.createElement('select');
  formField(grid, 'Язык', language);
  const refresh = refreshButton('Обновить список голосов', () => { void load(true); });
  const voiceField = formField(grid, 'Голос', modelPicker(voice, refresh));
  const voiceNote = fieldNote(voiceField);
  playbackMode(voiceField, source.streaming);
  let voices: SystemSpeechVoice[] = [];
  const refreshOptions = () => {
    const auto = settings.language === AUTO_SPEECH_LANGUAGE;
    language.replaceChildren(new Option('Авто по тексту', AUTO_SPEECH_LANGUAGE));
    if (source.defaultLabel) language.add(new Option(source.defaultLabel, ''));
    const languages = [...new Set(voices.map(item => item.language))].sort();
    if (settings.language && !auto && !languages.includes(settings.language)) languages.push(settings.language);
    const names = new Intl.DisplayNames(['ru'], { type: 'language' });
    languages.forEach(code => {
      let name = code;
      try { name = names.of(code) || code; } catch { /* Preserve unfamiliar engine locale tags. */ }
      language.add(new Option(name, code));
    });
    language.value = settings.language;
    // In auto mode the voice follows the language of each text.
    voice.replaceChildren(new Option(auto ? 'По языку текста' : source.defaultLabel ?? 'Первый голос языка', ''));
    voice.disabled = auto;
    if (!auto) voices.filter(item => !settings.language || item.language === settings.language).forEach(item => {
      voice.add(new Option(`${item.name} (${item.language})${item.networkRequired ? ' · онлайн' : ''}`, item.id));
    });
    if (settings.voiceId && !voices.some(item => item.id === settings.voiceId)) voice.add(new Option('Сохранённый голос недоступен', settings.voiceId));
    voice.value = settings.voiceId;
  };
  language.addEventListener('change', () => {
    settings.language = language.value;
    if (voices.find(item => item.id === settings.voiceId)?.language !== settings.language) settings.voiceId = '';
    persist(); refreshOptions();
  });
  voice.addEventListener('change', () => {
    settings.voiceId = voice.value;
    const selected = voices.find(item => item.id === voice.value);
    if (selected) settings.language = selected.language;
    persist(); refreshOptions();
  });
  for (const [key, title, min, max, increment] of [
    ['rate', 'Скорость', 0.5, 2, 0.1], ['pitch', 'Высота голоса', 0.5, 2, 0.1], ['volume', 'Громкость, %', 0, 100, 1],
  ] as const) {
    const input = document.createElement('input');
    input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(increment);
    if (key !== 'volume') input.title = 'Диапазон приложения: 0,5–2; 1 — обычное значение.';
    input.value = String(key === 'volume' ? Math.round(settings.volume * 100) : settings[key]);
    const applyValue = () => {
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < min || value > max) return false;
      const next = key === 'volume' ? value / 100 : value;
      if (settings[key] !== next) { settings[key] = next; persist(); }
      return true;
    };
    input.addEventListener('input', applyValue);
    input.addEventListener('change', () => {
      if (!applyValue()) input.value = String(key === 'volume' ? Math.round(settings.volume * 100) : settings[key]);
    });
    formField(grid, title, input);
  }
  source.mountExtra?.(grid, save);
  let generation = 0;
  const load = async (force = false) => {
    const current = ++generation;
    refresh.disabled = panel.test.disabled = true;
    voiceNote.textContent = 'Загрузка голосов…';
    setPanelStatus(panel, 'idle', 'Проверка…', 'Загрузка голосов…');
    try {
      const result = await source.load(force);
      if (current !== generation || !root.isConnected) return;
      voices = result; refreshOptions();
      voiceNote.textContent = voices.length ? `Голосов: ${voices.length}` : '';
      if (voices.length) setPanelStatus(panel, 'ready', 'Голоса получены', source.readyMessage);
      else setPanelStatus(panel, 'error', 'Ошибка', source.emptyMessage);
    } catch (error) {
      if (current !== generation || !root.isConnected) return;
      voiceNote.textContent = '';
      setPanelStatus(panel, 'error', 'Ошибка', error instanceof Error ? error.message : String(error));
    } finally { if (current === generation) refresh.disabled = panel.test.disabled = false; }
  };
  panel.test.title = 'Обновить список голосов без синтеза.';
  panel.test.onclick = () => { void load(true); };
  refreshOptions();
  void load();
}
