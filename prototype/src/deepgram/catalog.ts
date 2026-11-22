import type { ProviderModel } from '../provider-models';
import { deepgramRequest, readDeepgramError } from './http';

interface DeepgramModelsPayload {
  stt?: Array<{
    name?: unknown;
    canonical_name?: unknown;
    architecture?: unknown;
    languages?: unknown;
    streaming?: unknown;
  }>;
}

const DEFAULT_KEY = '__default__';
const catalogs = new WeakMap<object, Map<string, { expires: number; models: ProviderModel[] }>>();
const defaultCacheKey = {};

const FALLBACK_MODELS: ProviderModel[] = [
  { id: 'nova-3', name: 'Nova-3' },
  { id: 'nova-2', name: 'Nova-2' },
];

function cacheFor(fetcher?: typeof fetch) {
  const token = (fetcher as object | undefined) ?? defaultCacheKey;
  let cache = catalogs.get(token);
  if (!cache) {
    cache = new Map();
    catalogs.set(token, cache);
  }
  return cache;
}

function modelRank(id: string): number {
  if (id === 'nova-3') return 0;
  if (id.startsWith('nova-3')) return 1;
  if (id === 'nova-2') return 2;
  if (id.startsWith('nova-2')) return 3;
  if (id.startsWith('nova-')) return 4;
  return 5;
}

export async function fetchDeepgramCatalog(
  apiKey: string,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
  refresh = false,
): Promise<ProviderModel[]> {
  signal?.throwIfAborted();
  const key = apiKey.trim();
  if (!key) throw new Error('Deepgram: укажите API-ключ.');

  const cache = cacheFor(fetcher);
  for (const [storedKey, entry] of cache) {
    if (entry.expires <= Date.now()) cache.delete(storedKey);
  }
  const known = cache.get(key);
  if (known && !refresh) return known.models;

  // Step A: Verify the API key without consuming speech-to-text quota.
  let auth = await deepgramRequest('/v1/auth/token', { method: 'GET', apiKey: key, signal }, fetcher);
  if (auth.status === 404) {
    auth = await deepgramRequest('/v1/projects', { method: 'GET', apiKey: key, signal }, fetcher);
  }
  if (auth.status === 401 || auth.status === 403) {
    throw new Error('Deepgram: неверный API-ключ.');
  }
  if (!auth.ok) {
    throw new Error(`Deepgram (${auth.status}): ${readDeepgramError(auth.body, auth.status)}`);
  }

  // Step B: Load available STT models.
  const modelsRes = await deepgramRequest('/v1/models', { method: 'GET', apiKey: key, signal }, fetcher);
  if (modelsRes.status === 401 || modelsRes.status === 403) {
    throw new Error('Deepgram: неверный API-ключ.');
  }
  if (!modelsRes.ok) {
    throw new Error(`Deepgram (${modelsRes.status}): ${readDeepgramError(modelsRes.body, modelsRes.status)}`);
  }

  let parsed: DeepgramModelsPayload = {};
  try {
    parsed = JSON.parse(modelsRes.body) as DeepgramModelsPayload;
  } catch {
    throw new Error('Deepgram вернул некорректный список моделей.');
  }

  const dedup = new Map<string, { id: string; name: string; languages: Set<string> }>();
  for (const entry of Array.isArray(parsed.stt) ? parsed.stt : []) {
    if (entry.streaming === false) continue;
    if (typeof entry.canonical_name !== 'string' || !entry.canonical_name.trim()) continue;
    const id = entry.canonical_name.trim().replace(/-general$/, '');
    if (!id) continue;
    const label = typeof entry.name === 'string' && entry.name.trim() && entry.name.trim().toLowerCase() !== 'general'
      ? `${id} (${entry.name.trim()})`
      : id;
    const existing = dedup.get(id);
    if (existing) {
      if (Array.isArray(entry.languages)) {
        entry.languages.forEach(lang => { if (typeof lang === 'string') existing.languages.add(lang); });
      }
      continue;
    }
    const languages = new Set<string>();
    if (Array.isArray(entry.languages)) {
      entry.languages.forEach(lang => { if (typeof lang === 'string') languages.add(lang); });
    }
    dedup.set(id, { id, name: label, languages });
  }

  const models: ProviderModel[] = [...dedup.values()]
    .map(item => ({
      id: item.id,
      name: item.name,
      ...(item.languages.size ? { description: `Языки: ${[...item.languages].slice(0, 12).join(', ')}${item.languages.size > 12 ? '…' : ''}` } : {}),
    }))
    .sort((left, right) => {
      const rankDiff = modelRank(left.id) - modelRank(right.id);
      return rankDiff !== 0 ? rankDiff : left.id.localeCompare(right.id);
    });

  const resolved = models.length ? models : FALLBACK_MODELS;
  cache.set(key || DEFAULT_KEY, { models: resolved, expires: Date.now() + 60_000 });
  return resolved;
}
