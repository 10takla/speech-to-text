// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountGeminiTranscriptionEditor } from './editor';
import { normalizeGeminiTranscriptionSettings } from './settings';

beforeEach(() => {
  vi.stubGlobal('Option', function(text = '', value = text) {
    const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
  });
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const setup = () => {
  const root = document.createElement('div'); document.body.append(root);
  const settings = normalizeGeminiTranscriptionSettings({ apiKey: 'test-key' });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [
    { name: 'models/gemini-3.5-transcribe', displayName: 'Transcribe' },
    { name: 'models/gemini-3.5-transcribe-live' },
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
  ] })); vi.stubGlobal('fetch', fetcher);
  const save = vi.fn(), status = vi.fn();
  mountGeminiTranscriptionEditor(root, settings, save, status);
  return { root, settings, fetcher, save, status };
};

it('loads the model on initialization and validates local parameters without extra requests', async () => {
  const { root, settings, fetcher, status } = setup();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Готов', 'ready', expect.any(String)));
  expect(settings.model).toBe('gemini-3.5-transcribe');
  const model = root.querySelector<HTMLSelectElement>('[aria-label="Модель транскрибации"]')!;
  expect([...model.options].map(o => o.value)).toEqual(['', 'gemini-3.5-transcribe']);
  const language = root.querySelector<HTMLSelectElement>('[aria-label="Язык"]')!;
  expect([...language.options].some(o => o.value === 'ru-RU')).toBe(true);
  language.value = 'ru-RU'; language.dispatchEvent(new Event('change'));
  expect(settings.language).toBe('ru-RU');
  const mode = root.querySelector<HTMLSelectElement>('[aria-label="Режим транскрибации"]')!;
  mode.value = 'smart'; mode.dispatchEvent(new Event('change'));
  expect(status).toHaveBeenLastCalledWith('Не готов', 'error', expect.stringContaining('несовместим'));
  const timestamps = root.querySelector<HTMLInputElement>('[aria-label="Таймкоды слов"]')!;
  timestamps.checked = false; timestamps.dispatchEvent(new Event('change'));
  expect(status).toHaveBeenLastCalledWith('Готов', 'ready', expect.any(String));
  expect(fetcher).toHaveBeenCalledOnce();
  root.querySelector('button')!.click();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

it('keeps an unavailable saved model and has a direct link to obtain an AI Studio key', async () => {
  const { root, settings, save, status } = setup();
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Готов', 'ready', expect.any(String)));
  const next = { ...settings, model: 'gemini-old-transcribe' };
  mountGeminiTranscriptionEditor(root, next, save, status);
  await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith('Не готов', 'error', expect.stringContaining('отсутствует')));
  expect(next.model).toBe('gemini-old-transcribe');
  expect(root.querySelector('a')?.href).toBe('https://aistudio.google.com/apikey');
});
