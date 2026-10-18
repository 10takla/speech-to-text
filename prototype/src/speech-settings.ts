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
