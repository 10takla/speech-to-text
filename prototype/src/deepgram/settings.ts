import { DEFAULT_DEEPGRAM_API_KEY } from '../defaults';

export const DEEPGRAM_DEFAULT_MODEL = 'nova-3';

export type DeepgramRedact = '' | 'true' | 'pci' | 'numbers' | 'ssn' | 'pii';

export const DEEPGRAM_REDACT_OPTIONS: readonly [DeepgramRedact, string][] = [
  ['', 'Выкл.'],
  ['pci', 'Карты (PCI)'],
  ['numbers', 'Числа'],
  ['ssn', 'SSN'],
  ['pii', 'Персональные данные (PII)'],
  ['true', 'Всё'],
];

export interface DeepgramSettings {
  apiKey: string;
  model: string;
  language: string;
  smartFormat: boolean;
  punctuate: boolean;
  numerals: boolean;
  interimResults: boolean;
  diarize: boolean;
  fillerWords: boolean;
  profanityFilter: boolean;
  mipOptOut: boolean;
  endpointingMs: number;
  utteranceEndMs: number;
  redact: DeepgramRedact;
  keyterms: string[];
  replace: string[];
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
  const utteranceEndRaw = typeof value?.utteranceEndMs === 'number' && Number.isFinite(value.utteranceEndMs)
    ? Math.round(value.utteranceEndMs)
    : 0;
  const list = (items: unknown) => Array.isArray(items)
    ? items.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean)
    : [];
  const redact = DEEPGRAM_REDACT_OPTIONS.some(([id]) => id === value?.redact)
    ? value!.redact as DeepgramRedact
    : '';
  return {
    apiKey: text(value?.apiKey, DEFAULT_DEEPGRAM_API_KEY),
    model: text(value?.model, DEEPGRAM_DEFAULT_MODEL) || DEEPGRAM_DEFAULT_MODEL,
    language: text(value?.language, 'multi') || 'multi',
    smartFormat: value?.smartFormat !== false,
    punctuate: value?.punctuate !== false,
    numerals: value?.numerals === true,
    interimResults: value?.interimResults !== false,
    diarize: value?.diarize === true,
    fillerWords: value?.fillerWords === true,
    profanityFilter: value?.profanityFilter === true,
    mipOptOut: value?.mipOptOut === true,
    endpointingMs: endpointingRaw,
    utteranceEndMs: utteranceEndRaw,
    redact,
    keyterms: list(value?.keyterms),
    replace: list(value?.replace),
  };
}

export function deepgramConfigurationError(value?: Partial<DeepgramSettings>): string | null {
  const s = normalizeDeepgramSettings(value);
  if (!s.apiKey) return 'Deepgram: укажите API-ключ.';
  if (!s.model) return 'Deepgram: выберите модель.';
  if (!Number.isInteger(s.endpointingMs) || (s.endpointingMs !== 0 && (s.endpointingMs < 10 || s.endpointingMs > 10_000))) {
    return 'Deepgram: пауза фиксации должна быть 0 или от 10 до 10000 мс.';
  }
  if (!Number.isInteger(s.utteranceEndMs) || (s.utteranceEndMs !== 0 && (s.utteranceEndMs < 1000 || s.utteranceEndMs > 5000))) {
    return 'Deepgram: конец фразы должен быть 0 или от 1000 до 5000 мс.';
  }
  if (s.utteranceEndMs > 0 && !s.interimResults) {
    return 'Deepgram: «Конец фразы» требует включённого «Промежуточный текст на лету».';
  }
  if (s.replace.some(rule => rule.indexOf(':') <= 0)) {
    return 'Deepgram: замены задаются в формате «что:на_что».';
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
    params.set('punctuate', s.punctuate ? 'true' : 'false');
  }
  if (s.numerals) params.set('numerals', 'true');
  if (s.diarize) params.set('diarize', 'true');
  if (s.fillerWords) params.set('filler_words', 'true');
  if (s.profanityFilter) params.set('profanity_filter', 'true');
  if (s.mipOptOut) params.set('mip_opt_out', 'true');
  if (s.redact) params.set('redact', s.redact);
  const termParam = /^nova-3/i.test(s.model) ? 'keyterm' : 'keywords';
  for (const term of s.keyterms) {
    params.append(termParam, term);
  }
  for (const rule of s.replace) {
    params.append('replace', rule);
  }
  if (live) {
    params.set('interim_results', s.interimResults ? 'true' : 'false');
    params.set('endpointing', s.endpointingMs > 0 ? String(s.endpointingMs) : 'false');
    if (s.utteranceEndMs > 0) params.set('utterance_end_ms', String(s.utteranceEndMs));
    params.set('encoding', live.encoding ?? 'linear16');
    params.set('sample_rate', String(live.sampleRate));
    params.set('channels', String(live.channels));
  }
  return params;
}
