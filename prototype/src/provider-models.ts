export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  thinking?: boolean;
}

interface GroqModelsResponse {
  data?: Array<{ id?: unknown; active?: unknown; context_window?: unknown }>;
  error?: { message?: unknown };
}

interface GeminiModelsResponse {
  models?: Array<{
    name?: unknown;
    baseModelId?: unknown;
    displayName?: unknown;
    supportedGenerationMethods?: unknown;
    description?: unknown;
    inputTokenLimit?: unknown;
    outputTokenLimit?: unknown;
    temperature?: unknown;
    maxTemperature?: unknown;
    topP?: unknown;
    topK?: unknown;
    thinking?: unknown;
  }>;
  nextPageToken?: unknown;
  error?: { message?: unknown };
}

export async function fetchGroqSpeechModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModel[]> {
  const response = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const body = await response.json().catch(() => ({})) as GroqModelsResponse;
  if (!response.ok) throw new Error(readApiError(body.error?.message) || `HTTP ${response.status}`);

  return (body.data ?? [])
    .flatMap(model => typeof model.id === 'string' && /whisper/i.test(model.id) && model.active !== false
      ? [{ id: model.id, name: model.id, inputTokenLimit: finiteNumber(model.context_window) }]
      : [])
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchGeminiTextModels(apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ProviderModel[]> {
  return fetchGeminiModels(apiKey, signal, fetcher, 'text');
}

export function fetchGeminiTranscriptionModels(apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ProviderModel[]> {
  return fetchGeminiModels(apiKey, signal, fetcher, 'transcribe');
}

async function fetchGeminiModels(apiKey: string, signal: AbortSignal | undefined, fetcher: typeof fetch, kind: 'text' | 'transcribe'): Promise<ProviderModel[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('API-ключ Gemini не указан.');
  const models: ProviderModel[] = [];
  let pageToken = '';
  const visited = new Set<string>();

  do {
    signal?.throwIfAborted();
    if (visited.has(pageToken)) throw new Error('Gemini API вернул повторную страницу моделей.');
    visited.add(pageToken);
    const query = new URLSearchParams();
    if (pageToken) query.set('pageToken', pageToken);
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models?${query}`, {
      signal, headers: { 'x-goog-api-key': key },
    });
    const body = await response.json().catch(() => ({})) as GeminiModelsResponse;
    if (!response.ok) throw new Error(readApiError(body.error?.message) || `HTTP ${response.status}`);

    for (const model of body.models ?? []) {
      const methods = Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods
        : [];
      if (typeof model.name !== 'string') continue;
      const id = model.name.replace(/^models\//, '');
      // Models API exposes identifiers, but no dedicated ASR capability field.
      // https://ai.google.dev/gemini-api/docs/transcribe — exclude Live models (different protocol).
      const isTranscription = /^gemini-.*-transcribe(?:-|$)/i.test(id);
      if (kind === 'transcribe' ? !isTranscription || /(?:^|-)live(?:-|$)/i.test(id)
        : !methods.includes('generateContent') || isTranscription) continue;
      models.push({
        id,
        name: typeof model.displayName === 'string' ? model.displayName : id,
        description: typeof model.description === 'string' ? model.description : undefined,
        inputTokenLimit: finiteNumber(model.inputTokenLimit),
        outputTokenLimit: finiteNumber(model.outputTokenLimit),
        temperature: finiteNumber(model.temperature),
        maxTemperature: finiteNumber(model.maxTemperature),
        topP: finiteNumber(model.topP),
        topK: finiteNumber(model.topK),
        thinking: typeof model.thinking === 'boolean' ? model.thinking : undefined,
      });
    }

    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
  } while (pageToken);

  return models.sort((left, right) => left.name.localeCompare(right.name));
}

export function selectAvailableGeminiModel(models: readonly ProviderModel[], requested: string): string {
  const saved = requested.replace(/^models\//, '');
  if (models.some(model => model.id === saved)) return saved;
  // Prefer a stable general-purpose Flash returned by this key, not a hard-coded model version.
  return models.find(model => /^gemini-[\d.]+-flash$/.test(model.id))?.id
    ?? models.find(model => /^gemini-[\d.]+-(?:flash-lite|pro)$/.test(model.id))?.id
    ?? models[0]?.id ?? '';
}

function readApiError(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface GeminiGenerationSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
}

export interface ModelParameter {
  key: keyof GeminiGenerationSettings;
  label: string;
  min: number;
  max?: number;
  step: string;
  defaultValue?: number;
}

export function geminiModelParameters(model: ProviderModel): ModelParameter[] {
  const fields: ModelParameter[] = [];
  if (model.temperature !== undefined || model.maxTemperature !== undefined) {
    fields.push({ key: 'temperature', label: 'Температура', min: 0, max: model.maxTemperature, step: 'any', defaultValue: model.temperature });
  }
  if (model.topP !== undefined) fields.push({ key: 'topP', label: 'Top P', min: 0, max: 1, step: 'any', defaultValue: model.topP });
  if (model.topK !== undefined) fields.push({ key: 'topK', label: 'Top K', min: 1, step: '1', defaultValue: model.topK });
  if (model.outputTokenLimit) fields.push({ key: 'maxOutputTokens', label: 'Макс. токенов ответа', min: 1, max: model.outputTokenLimit, step: '1' });
  return fields;
}
