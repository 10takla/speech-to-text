export interface SystemSpeechSettings {
  voiceId: string;
  language: string;
  rate: number;
  pitch: number;
  volume: number;
}

// Voices/languages are discovered at runtime. Numeric controls use a conservative
// application range: WinRT SpeakingRate/AudioPitch and Android setSpeechRate/setPitch.
export function normalizeSpeechSettings(value?: Partial<SystemSpeechSettings> | null): SystemSpeechSettings {
  const bounded = (number: unknown, min: number, max: number, fallback: number) =>
    typeof number === 'number' && Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  return {
    voiceId: typeof value?.voiceId === 'string' ? value.voiceId : '',
    language: typeof value?.language === 'string' ? value.language : '',
    rate: bounded(value?.rate, 0.5, 2, 1),
    pitch: bounded(value?.pitch, 0.5, 2, 1),
    volume: bounded(value?.volume, 0, 1, 1),
  };
}

// Language setting that picks the voice by the text itself: a voice of one
// language skips letters of another (an English voice reads no Cyrillic).
export const AUTO_SPEECH_LANGUAGE = 'auto';

const SCRIPT_LANGUAGES = {
  cyrillic: ['ru', 'uk', 'be', 'bg', 'sr', 'kk', 'mk'],
  latin: ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl'],
};

// The writing system that dominates the text decides the language; among the
// installed voice languages the first matching one wins. '' — system default.
export function pickSpeechLanguage(text: string, languages: readonly string[]): string {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (!cyrillic && !latin) return '';
  for (const prefix of SCRIPT_LANGUAGES[cyrillic >= latin ? 'cyrillic' : 'latin']) {
    const match = languages.find(code => code.toLowerCase().split(/[-_]/)[0] === prefix);
    if (match) return match;
  }
  return '';
}
