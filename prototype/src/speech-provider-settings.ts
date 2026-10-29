import { AUTO_SPEECH_LANGUAGE, normalizeSpeechSettings, type SystemSpeechSettings } from './speech-settings';

export type SpeechProvider = 'none' | 'system' | 'edge' | 'piper' | 'gemini' | 'elevenlabs';
export interface GeminiSpeechSettings {
  apiKey: string; model: string; voice: string; style: string; volume: number;
}
export interface ElevenSpeechSettings {
  apiKey: string; model: string; voice: string; language: string; volume: number;
  stability: number; similarity: number; style: number; speed: number; speakerBoost: boolean;
  canUseStyle: boolean; canUseSpeakerBoost: boolean;
}
export interface PiperSpeechSettings {
  url: string; voice: string; speakerId?: number; lengthScale?: number;
  noiseScale?: number; noiseWScale?: number; volume: number;
}
export interface SpeechProviderSettings {
  // Microsoft Edge neural voices: same shape as the system engine settings.
  edge: SystemSpeechSettings;
  // Open the Edge connection at the scenario start, about a second before the speech.
  edgePreconnect: boolean;
  gemini: GeminiSpeechSettings; elevenlabs: ElevenSpeechSettings; piper: PiperSpeechSettings;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const number = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const optional = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined;

export function normalizeSpeechProviders(value?: unknown): SpeechProviderSettings {
  const root = record(value), edge = record(root.edge), gemini = record(root.gemini), eleven = record(root.elevenlabs), piper = record(root.piper);
  return {
    edge: { ...normalizeSpeechSettings(edge), language: string(edge.language, AUTO_SPEECH_LANGUAGE) },
    edgePreconnect: root.edgePreconnect !== false,
    gemini: { apiKey: string(gemini.apiKey), model: string(gemini.model), voice: string(gemini.voice),
      style: string(gemini.style), volume: number(gemini.volume, 0, 1, 1) },
    elevenlabs: { apiKey: string(eleven.apiKey), model: string(eleven.model), voice: string(eleven.voice),
      language: string(eleven.language), volume: number(eleven.volume, 0, 1, 1),
      stability: number(eleven.stability, 0, 1, .5), similarity: number(eleven.similarity, 0, 1, .75),
      style: number(eleven.style, 0, 1, 0), speed: number(eleven.speed, .7, 1.2, 1), speakerBoost: eleven.speakerBoost !== false,
      canUseStyle: eleven.canUseStyle === true, canUseSpeakerBoost: eleven.canUseSpeakerBoost === true },
    piper: { url: string(piper.url, 'http://127.0.0.1:5000'), voice: string(piper.voice),
      speakerId: piper.speakerId === undefined ? undefined : Math.floor(number(piper.speakerId, 0, 10000, 0)),
      lengthScale: optional(piper.lengthScale, .1, 5), noiseScale: optional(piper.noiseScale, 0, 2),
      noiseWScale: optional(piper.noiseWScale, 0, 2), volume: number(piper.volume, 0, 1, 1) },
  };
}

export function normalizeSpeechProvider(value: unknown): SpeechProvider {
  return value === 'none' || value === 'edge' || value === 'piper' || value === 'gemini' || value === 'elevenlabs' ? value : 'system';
}

export function piperBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Укажите адрес сервера Piper.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Адрес Piper должен быть HTTP(S), без пароля и параметров.');
  }
  return url.href.replace(/\/+$/, '');
}

export function speechConfigurationError(provider: SpeechProvider = 'system', value?: SpeechProviderSettings): string | null {
  if (provider === 'none') return 'Провайдер озвучки не выбран.';
  if (provider === 'system' || provider === 'edge') return null;
  const settings = normalizeSpeechProviders(value);
  if (provider === 'piper') {
    try { piperBaseUrl(settings.piper.url); } catch (error) { return (error as Error).message; }
  } else if (!settings[provider].apiKey.trim()) return `Укажите API-ключ ${provider === 'gemini' ? 'Gemini TTS' : 'ElevenLabs'}.`;
  if (provider !== 'piper' && !settings[provider].model) return 'Выберите модель озвучки из API.';
  if (!settings[provider].voice) return 'Выберите голос озвучки.';
  return null;
}
