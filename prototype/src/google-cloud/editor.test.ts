// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountGoogleCloudEditor } from './editor';
import { normalizeGoogleCloudSettings } from './settings';

beforeEach(() => {
  vi.stubGlobal('Option', function(text = '', value = text) {
    const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
  });
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const payload = { locations: [{ locationId: 'eu', metadata: { languages: { models: {
  'ru-RU': { modelFeatures: { chirp_3: { modelFeature: [{ feature: 'automatic_punctuation', releaseState: 'GA' }] } } },
  'en-US': { modelFeatures: { chirp_3: { modelFeature: [{ feature: 'automatic_punctuation', releaseState: 'GA' }] }, latest_long: { modelFeature: [] } } },
} } } }] };
const setup = () => {
  const root = document.createElement('div'); document.body.append(root);
  const settings = normalizeGoogleCloudSettings({ credentials: 'test-token', projectId: 'test-project' });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload)); vi.stubGlobal('fetch', fetcher);
  const save = vi.fn(); const status = vi.fn();
  mountGoogleCloudEditor(root, settings, save, status);
  const select = (name: string) => root.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  return { root, settings, fetcher, save, status, select };
};

it('discovers regions/models/languages automatically and validates local selections without more API requests', async () => {
  const { root, settings, fetcher, status, select } = setup();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Готов', 'ready', expect.any(String)));
  expect(settings.location).toBe('eu'); expect(settings.model).toBe('chirp_3');
  expect([...select('Язык').options].map(o => o.value)).toEqual(['', 'auto', 'en-US', 'ru-RU']);
  const punctuation = select('Автоматическая пунктуация');
  expect(punctuation.value).toBe('');
  punctuation.value = 'true'; punctuation.dispatchEvent(new Event('change'));
  expect(settings.features).toEqual({ automatic_punctuation: true });
  select('Модель').value = 'latest_long'; select('Модель').dispatchEvent(new Event('change'));
  expect(status).toHaveBeenLastCalledWith('Не готов', 'error', expect.stringContaining('Автоопределение'));
  select('Язык').value = 'en-US'; select('Язык').dispatchEvent(new Event('change'));
  expect(status).toHaveBeenLastCalledWith('Не готов', 'error', expect.stringContaining('Функция'));
  expect(fetcher).toHaveBeenCalledOnce();
  root.querySelector<HTMLButtonElement>('button')!.click();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

it('does not overwrite a saved unavailable model and does not share UI state between scenarios', async () => {
  const { root, settings, save, status, select } = setup();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Готов', 'ready', expect.any(String)));
  const next = { ...settings, model: 'removed-model', language: 'en-US' };
  mountGoogleCloudEditor(root, next, save, status);
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Не готов', 'error', expect.stringContaining('Модель')));
  expect(select('Модель').value).toBe('removed-model');
  expect(next.model).toBe('removed-model'); expect(settings.model).toBe('chirp_3');
});
