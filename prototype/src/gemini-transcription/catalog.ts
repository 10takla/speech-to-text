import { fetchGeminiTranscriptionModels, type ProviderModel } from '../provider-models';

const catalogs = new WeakMap<typeof fetch, Map<string, { expires: number; models: ProviderModel[] }>>();

export async function fetchGeminiTranscriptionCatalog(apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, refresh = false): Promise<ProviderModel[]> {
  signal?.throwIfAborted();
  let cache = catalogs.get(fetcher);
  if (!cache) { cache = new Map(); catalogs.set(fetcher, cache); }
  for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
  const key = apiKey.trim();
  const known = cache.get(key);
  if (known && !refresh) return known.models;
  const models = await fetchGeminiTranscriptionModels(key, signal, fetcher);
  signal?.throwIfAborted();
  cache.set(key, { models, expires: Date.now() + 60_000 });
  return models;
}
