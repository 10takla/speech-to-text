import type { ScenarioStep } from './scenario';
import { normalizeSpeechSettings } from './speech-settings';
import { getSystemSpeechCapabilities, type SystemSpeechVoice } from './system-speech';
import { mountExternalSpeechSettings } from './speech-provider-editor';
import { normalizeSpeechProvider } from './speech-provider-settings';

export function mountSpeechProvider(parent: HTMLElement, step: ScenarioStep, save: () => void, saveInline = save) {
  const label = document.createElement('label');
  label.className = 'scenario-step-setting-label';
  label.textContent = 'Провайдер';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Провайдер озвучки');
  select.add(new Option('Не выбран', 'none'));
  select.add(new Option('Системный движок', 'system'));
  select.add(new Option('Piper · локально', 'piper'));
  select.add(new Option('Google Gemini TTS', 'gemini'));
  select.add(new Option('ElevenLabs', 'elevenlabs'));
  select.value = step.speechProvider ?? 'system';
  label.append(select);
  const settings = document.createElement('div');
  const renderSettings = () => {
    parent.closest('details')?.querySelector(':scope > summary .speech-provider-readiness')?.remove();
    settings.replaceChildren();
    if (select.value === 'system') mountSpeechSettings(settings, step, saveInline);
    else mountExternalSpeechSettings(settings, step, saveInline);
  };
  select.addEventListener('change', () => {
    step.speechProvider = normalizeSpeechProvider(select.value);
    renderSettings();
    save();
  });
  parent.append(label, settings);
  renderSettings();
}

export function mountSpeechSettings(parent: HTMLElement, step: ScenarioStep, save: () => void) {
  parent.querySelector('.system-speech-settings')?.remove();
  const root = document.createElement('div');
  root.className = 'system-speech-settings';
  const settings = normalizeSpeechSettings(step.speechSettings);
  const persist = () => { step.speechSettings = { ...settings }; save(); };
  const field = (title: string, control: HTMLElement) => {
    const label = document.createElement('label');
    label.className = 'scenario-step-setting-label';
    label.append(title, control);
    root.append(label);
  };
  const language = document.createElement('select');
  language.setAttribute('aria-label', 'Язык озвучки');
  const voice = document.createElement('select');
  voice.setAttribute('aria-label', 'Голос озвучки');
  field('Язык', language);
  field('Голос', voice);
  let voices: SystemSpeechVoice[] = [];
  const refreshOptions = () => {
    language.replaceChildren(new Option('Системный', ''));
    const languages = [...new Set(voices.map(item => item.language))].sort();
    if (settings.language && !languages.includes(settings.language)) languages.push(settings.language);
    const names = new Intl.DisplayNames(['ru'], { type: 'language' });
    languages.forEach(code => {
      let name = code;
      try { name = names.of(code) || code; } catch { /* Preserve unfamiliar engine locale tags. */ }
      language.add(new Option(name, code));
    });
    language.value = settings.language;
    voice.replaceChildren(new Option('Системный', ''));
    voices.filter(item => !settings.language || item.language === settings.language).forEach(item => {
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
    input.setAttribute('aria-label', title);
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
    field(title, input);
  }
  const status = document.createElement('span');
  status.className = 'model-load-status';
  status.setAttribute('role', 'status');
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'btn secondary'; refresh.textContent = 'Обновить голоса';
  let generation = 0;
  const load = async () => {
    const current = ++generation;
    refresh.disabled = true; status.textContent = 'Загрузка голосов…';
    try {
      const result = await getSystemSpeechCapabilities();
      if (current !== generation || !root.isConnected) return;
      voices = result.voices; refreshOptions();
      status.textContent = voices.length ? '' : 'Системные голоса не найдены.';
    } catch (error) {
      if (current === generation && root.isConnected) status.textContent = error instanceof Error ? error.message : String(error);
    } finally { if (current === generation) refresh.disabled = false; }
  };
  refresh.addEventListener('click', () => { void load(); });
  root.append(refresh, status);
  parent.append(root);
  refreshOptions();
  void load();
}
