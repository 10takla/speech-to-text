export interface GoogleCloudSettings {
  projectId: string;
  credentials: string;
  location: string;
  model: string;
  language: string;
  features: Record<string, boolean>;
}

export function normalizeGoogleCloudSettings(value?: Partial<GoogleCloudSettings>): GoogleCloudSettings {
  const text = (v: unknown, fallback = '') => typeof v === 'string' ? v.trim() : fallback;
  return {
    projectId: text(value?.projectId), credentials: text(value?.credentials),
    location: text(value?.location), model: text(value?.model), language: text(value?.language, 'auto'),
    features: Object.fromEntries(Object.entries(value?.features ?? {}).filter(([, v]) => typeof v === 'boolean')),
  };
}

export function googleCloudConfigurationError(settings?: Partial<GoogleCloudSettings>): string | null {
  const s = normalizeGoogleCloudSettings(settings);
  if (!s.credentials) return 'Google Cloud: укажите JSON сервисного аккаунта или OAuth-токен.';
  if (!s.projectId) return 'Google Cloud: укажите ID проекта.';
  if (!/^[a-zA-Z0-9:.-]+$/.test(s.projectId)) return 'Google Cloud: неверный ID проекта.';
  if (!s.location || !/^[a-z0-9-]+$/.test(s.location)) return 'Google Cloud: выберите регион.';
  if (!s.model) return 'Google Cloud: выберите модель.';
  if (!s.language) return 'Google Cloud: выберите язык.';
  // https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
  if (s.language === 'auto' && s.model !== 'chirp_3') return 'Автоопределение языка доступно для Chirp 3. Выберите язык или модель chirp_3.';
  return null;
}

// API exposes feature availability; request field names come from RecognitionFeatures.
// https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers#RecognitionFeatures
export const GOOGLE_CLOUD_FEATURES = [
  ['automatic_punctuation', 'enableAutomaticPunctuation', 'Автоматическая пунктуация'],
  ['profanity_filter', 'profanityFilter', 'Фильтр ненормативной лексики'],
  ['spoken_punctuation', 'enableSpokenPunctuation', 'Произнесённая пунктуация'],
  ['spoken_emojis', 'enableSpokenEmojis', 'Произнесённые эмодзи'],
] as const;
