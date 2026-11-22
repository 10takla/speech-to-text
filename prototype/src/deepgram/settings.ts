import { DEFAULT_DEEPGRAM_API_KEY } from '../defaults';

export const DEEPGRAM_DEFAULT_MODEL = 'nova-3';

export interface DeepgramSettings {
  apiKey: string;
  model: string;
  language: string;
  smartFormat: boolean;
  interimResults: boolean;
  diarize: boolean;
  endpointingMs: number;
  keyterms: string[];
}

// Supported languages for Nova-3 / Nova-2 (https://developers.deepgram.com/docs/models-languages-overview)
export const DEEPGRAM_LANGUAGES = [
  'multi',
  'ru', 'en', 'en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl',
  'uk', 'tr', 'ja', 'ko', 'zh', 'hi', 'ar', 'sv', 'no', 'da', 'fi', 'cs',
  'sk', 'ro', 'hu', 'bg', 'el', 'id', 'vi', 'th',
] as const;

export function normalizeDeepgramSettings(value?: Partial<DeepgramSettings>): DeepgramSettings {
  const text = (v: unknown, fallback = '') => typeof v === 'string' ? v.trim() : fallback;
  const endpointingRaw = typeof value?.endpointingMs === 'number' && Number.isFinite(value.endpointingMs)
    ? Math.round(value.endpointingMs)
    : 300;
  return {
    apiKey: text(value?.apiKey, DEFAULT_DEEPGRAM_API_KEY),
    model: text(value?.model, DEEPGRAM_DEFAULT_MODEL) || DEEPGRAM_DEFAULT_MODEL,
    language: text(value?.language, 'multi') || 'multi',
    smartFormat: value?.smartFormat !== false,
    interimResults: value?.interimResults !== false,
    diarize: value?.diarize === true,
    endpointingMs: endpointingRaw,
    keyterms: Array.isArray(value?.keyterms)
      ? value.keyterms.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
      : [],
  };
}

export function deepgramConfigurationError(value?: Partial<DeepgramSettings>): string | null {
  const s = normalizeDeepgramSettings(value);
  if (!s.apiKey) return 'Deepgram: укажите API-ключ.';
  if (!s.model) return 'Deepgram: выберите модель.';
  if (!Number.isInteger(s.endpointingMs) || (s.endpointingMs !== 0 && (s.endpointingMs < 10 || s.endpointingMs > 10_000))) {
    return 'Deepgram: пауза фиксации должна быть 0 или от 10 до 10000 мс.';
  }
  return null;
}

export function deepgramListenQuery(
  settings: DeepgramSettings,
  live?: { sampleRate: number; channels: number; encoding?: 'linear16' },
): URLSearchParams {
  const s = normalizeDeepgramSettings(settings);
  const params = new URLSearchParams();
  params.set('model', s.model);
  if (s.language === 'multi') {
    if (!live && !/^nova-(?:2|3)/i.test(s.model)) params.set('detect_language', 'true');
    else params.set('language', 'multi');
  } else if (s.language) {
    params.set('language', s.language);
  }
  if (s.smartFormat) {
    params.set('smart_format', 'true');
  } else {
    params.set('smart_format', 'false');
    params.set('punctuate', 'false');
  }
  if (s.diarize) params.set('diarize', 'true');
  const termParam = /^nova-3/i.test(s.model) ? 'keyterm' : 'keywords';
  for (const term of s.keyterms) {
    params.append(termParam, term);
  }
  if (live) {
    params.set('interim_results', s.interimResults ? 'true' : 'false');
    params.set('endpointing', s.endpointingMs > 0 ? String(s.endpointingMs) : 'false');
    params.set('encoding', live.encoding ?? 'linear16');
    params.set('sample_rate', String(live.sampleRate));
    params.set('channels', String(live.channels));
  }
  return params;
}
