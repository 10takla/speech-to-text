import { googleCloudToken } from './auth';
import type { GoogleCloudSettings } from './settings';

export interface GoogleCloudModel { id: string; features: { id: string; releaseState: string }[] }
export interface GoogleCloudLocation { id: string; name: string; languages: Record<string, GoogleCloudModel[]> }
interface LocationPayload {
  locationId?: string; displayName?: string;
  metadata?: { languages?: { models?: Record<string, { modelFeatures?: Record<string, { modelFeature?: { feature?: string; releaseState?: string }[] }> }> } };
}
const catalogs = new WeakMap<typeof fetch, Map<string, { expires: number; locations: GoogleCloudLocation[] }>>();

/** https://docs.cloud.google.com/speech-to-text/docs/locations */
export async function fetchGoogleCloudCatalog(settings: Pick<GoogleCloudSettings, 'credentials' | 'projectId'>,
  signal?: AbortSignal, fetcher: typeof fetch = fetch, refresh = false): Promise<GoogleCloudLocation[]> {
  if (!/^[a-zA-Z0-9:.-]+$/.test(settings.projectId)) throw new Error('Укажите ID проекта Google Cloud.');
  let cache = catalogs.get(fetcher);
  if (!cache) { cache = new Map(); catalogs.set(fetcher, cache); }
  for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
  const key = JSON.stringify([settings.projectId, settings.credentials]);
  const known = cache.get(key);
  if (!refresh && known) { signal?.throwIfAborted(); return known.locations; }
  const token = await googleCloudToken(settings.credentials, signal, fetcher);
  const locations: GoogleCloudLocation[] = [];
  const visited = new Set<string>();
  let page = '';
  do {
    if (visited.has(page)) throw new Error('Google Cloud вернул повторную страницу регионов.');
    visited.add(page);
    const query = new URLSearchParams({ pageSize: '100' });
    if (page) query.set('pageToken', page);
    const response = await fetcher(`https://speech.googleapis.com/v2/projects/${encodeURIComponent(settings.projectId)}/locations?${query}`,
      { signal, headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(`Google Cloud (${response.status}): ${body.error?.message || 'Не удалось получить возможности.'}`);
    for (const location of (body.locations ?? []) as LocationPayload[]) {
      if (!location.locationId) continue;
      const languages: GoogleCloudLocation['languages'] = {};
      for (const [language, value] of Object.entries(location.metadata?.languages?.models ?? {})) {
        languages[language] = Object.entries(value.modelFeatures ?? {}).map(([id, features]) => ({ id,
          features: (features.modelFeature ?? []).flatMap(f => f.feature ? [{ id: f.feature, releaseState: f.releaseState ?? '' }] : []),
        }));
      }
      locations.push({ id: location.locationId, name: location.displayName || location.locationId, languages });
    }
    page = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
  } while (page);
  locations.sort((a, b) => a.id.localeCompare(b.id));
  cache.set(key, { expires: Date.now() + 600_000, locations });
  return locations;
}

export function googleCloudModelOptions(location?: GoogleCloudLocation): string[] {
  return [...new Set(Object.values(location?.languages ?? {}).flatMap(models => models.map(m => m.id)))].sort();
}

export function googleCloudFeatures(location: GoogleCloudLocation | undefined, model: string, language: string): GoogleCloudModel['features'] {
  const entries = Object.entries(location?.languages ?? {}).filter(([code]) => language === 'auto' || code === language)
    .filter(([, models]) => models.some(m => m.id === model))
    .map(([, models]) => models.find(m => m.id === model)?.features ?? []);
  if (!entries.length) return [];
  return entries[0].filter(feature => entries.every(list => list.some(item => item.id === feature.id)));
}

export function googleCloudCatalogError(settings: GoogleCloudSettings, locations: GoogleCloudLocation[]): string | null {
  const location = locations.find(item => item.id === settings.location);
  if (!location) return 'Выбранный регион Google Cloud недоступен.';
  const languages = Object.entries(location.languages).filter(([, models]) => models.some(m => m.id === settings.model));
  if (!languages.length) return 'Модель недоступна в выбранном регионе.';
  if (settings.language !== 'auto' && !languages.some(([code]) => code === settings.language)) return 'Язык недоступен для выбранной модели и региона.';
  const features = googleCloudFeatures(location, settings.model, settings.language);
  // Preserve explicit selections; never silently drop unsupported settings.
  for (const [id, enabled] of Object.entries(settings.features)) {
    if (enabled && !features.some(f => f.id === id)) return `Функция ${id} недоступна для выбранных модели и языка.`;
  }
  return null;
}
