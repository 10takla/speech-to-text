import { postProcessTextWithGemini, type GeminiPostProcessOptions } from './gemini';
import { transcribeTimedAudioWithGroq, type GroqTranscriptionOptions } from './groq';
import type { TextPostProcessor, TranscriptionProvider } from './ports';
import { fetchGeminiTextModels, selectAvailableGeminiModel, type ProviderModel } from './provider-models';

interface GeminiCatalog {
  loadedAt: number;
  models?: ProviderModel[];
  loading?: Promise<ProviderModel[]>;
  signal?: AbortSignal;
}
const geminiCatalogs = new WeakMap<typeof fetch, Map<string, GeminiCatalog>>();

async function getGeminiCatalog(key: string, signal: AbortSignal | undefined, fetcher: typeof fetch) {
  let catalogs = geminiCatalogs.get(fetcher);
  if (!catalogs) { catalogs = new Map(); geminiCatalogs.set(fetcher, catalogs); }
  const now = Date.now();
  for (const [storedKey, entry] of catalogs) {
    if (!entry.loading && now - entry.loadedAt >= 60_000) catalogs.delete(storedKey);
  }
  let catalog = catalogs.get(key);
  if (!catalog?.models && (!catalog?.loading || catalog.signal !== signal || signal?.aborted)) {
    catalog = { loadedAt: 0, signal };
    const entry = catalog;
    catalogs.set(key, entry);
    entry.loading = fetchGeminiTextModels(key, signal, fetcher).then(models => {
      entry.models = models;
      entry.loadedAt = Date.now();
      entry.loading = undefined;
      entry.signal = undefined;
      return models;
    }, error => {
      if (catalogs.get(key) === entry) catalogs.delete(key);
      throw error;
    });
  }
  const entry = catalog!;
  const models = entry.models ?? await entry.loading!;
  return { models, invalidate: () => { if (catalogs.get(key) === entry) catalogs.delete(key); } };
}

export function createGroqTranscriptionProvider(
  options: () => GroqTranscriptionOptions,
  fetcher: typeof fetch = fetch,
): TranscriptionProvider {
  return {
    transcribe: (audio, signal) => transcribeTimedAudioWithGroq(audio, options(), signal, fetcher),
  };
}

export function createGeminiTextPostProcessor(
  options: () => GeminiPostProcessOptions,
  fetcher: typeof fetch = fetch,
): TextPostProcessor {
  return {
    process: async (text, signal) => {
      if (!text.trim()) return '';
      const selected = options();
      if (!selected.instructionPrompt?.trim()) throw new Error('Для постобработки укажите промпт преобразования.');
      const key = selected.apiKey?.trim() ?? '';
      const catalog = await getGeminiCatalog(key, signal, fetcher);
      const model = selectAvailableGeminiModel(catalog.models, selected.model ?? '');
      if (!model) throw new Error('API Gemini не вернуло доступных моделей для генерации текста.');
      try {
        return await postProcessTextWithGemini(text, { ...selected, model }, fetcher, signal);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Google Gemini API (404)')) {
          catalog.invalidate();
          throw new Error(`Модель Gemini «${model}» недоступна для генерации с этим ключом. Обновите список моделей и выберите другую.`);
        }
        throw error;
      }
    },
  };
}
