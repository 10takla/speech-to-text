import { DEFAULT_GEMINI_API_KEY } from '../defaults';

export interface GeminiTranscriptionSettings {
  apiKey: string;
  model: string;
  language: string;
  mode: 'verbatim' | 'smart';
  timestamps: boolean;
  diarization: boolean;
  vocabulary: string[];
}

// Models API doesn't expose these parameters or language availability.
// https://ai.google.dev/gemini-api/docs/transcribe#supported-languages (2026-10-19)
export const GEMINI_TRANSCRIPTION_LANGUAGES = [...new Set(`af-ZA am-ET ar-EG hy-AM as-IN az-AZ be-BY bn-BD bn-IN bs-BA bg-BG rup-BG my-MM
  yue-Hant-HK ca-ES cmn-Hans-CN ceb km-KH hr-HR cs-CZ da-DK nl-NL en-GB en-IN en-US et-EE fa-IR fil-PH fi-FI fr-FR gl-ES ka-GE de-DE el-GR
  gu-IN ha-NG he-IL hi-IN hu-HU is-IS id-ID it-IT ja-JP jv-ID kea-CV kn-IN kk-KZ ko-KR ky-KG lv-LV ln-CD lt-LT mk-MK ms-MY ml-IN mt-MT
  mr-IN mn-MN ne-NP nb-NO or-IN pl-PL pt-BR pt-PT pa-IN pa-Guru-IN ro-RO ru-RU sr-RS sd-Arab-IN sk-SK sl-SI es-419 es-US sw-KE sv-SE tg-TJ
  te-IN th-TH tr-TR uk-UA uz-UZ vi-VN`.split(/\s+/))].sort();

export function normalizeGeminiTranscriptionSettings(value?: Partial<GeminiTranscriptionSettings>): GeminiTranscriptionSettings {
  const text = (v: unknown, fallback = '') => typeof v === 'string' ? v.trim() : fallback;
  return {
    apiKey: text(value?.apiKey, DEFAULT_GEMINI_API_KEY), model: text(value?.model).replace(/^models\//, ''), language: text(value?.language, 'auto'),
    mode: value?.mode === 'smart' ? 'smart' : 'verbatim', timestamps: value?.timestamps !== false,
    diarization: value?.diarization === true,
    vocabulary: Array.isArray(value?.vocabulary) ? value.vocabulary.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean) : [],
  };
}

export function geminiTranscriptionConfigurationError(value?: Partial<GeminiTranscriptionSettings>): string | null {
  const s = normalizeGeminiTranscriptionSettings(value);
  if (!s.apiKey) return 'Google Gemini: укажите API-ключ из AI Studio.';
  if (!s.model) return 'Google Gemini: выберите модель транскрибации.';
  if (!/^gemini-.*-transcribe(?:-|$)/i.test(s.model) || /(?:^|-)live(?:-|$)/i.test(s.model)) return 'Выберите модель Gemini Transcribe для файлового распознавания.';
  if (s.language !== 'auto' && !GEMINI_TRANSCRIPTION_LANGUAGES.includes(s.language)) return 'Выберите поддерживаемый язык Gemini Transcribe.';
  if (s.mode === 'smart' && (s.timestamps || s.diarization)) return 'Умный режим несовместим с таймкодами и разделением говорящих.';
  if (s.vocabulary.length > 1000) return 'Словарь Gemini Transcribe: не более 1000 терминов.';
  if (s.vocabulary.length && (s.timestamps || s.diarization)) return 'Словарь несовместим с таймкодами и разделением говорящих.';
  return null;
}

export function geminiTranscriptionConfig(s: GeminiTranscriptionSettings): Record<string, unknown> {
  return {
    ...(s.language !== 'auto' ? { language_codes: [s.language] } : {}),
    ...(s.vocabulary.length ? { custom_vocabulary: s.vocabulary } : {}),
    mode: s.mode === 'smart' ? 'smart' : { type: 'verbatim',
      ...(s.timestamps ? { timestamp_granularities: ['word'] } : {}),
      ...(s.diarization ? { diarization_mode: 'speaker' } : {}),
    },
  };
}
