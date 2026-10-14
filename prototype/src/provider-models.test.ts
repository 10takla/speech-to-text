import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGeminiTextModels, fetchGroqSpeechModels, geminiModelParameters } from './provider-models';

afterEach(() => vi.unstubAllGlobals());

describe('provider model metadata', () => {
  it('retains Groq context sizes and excludes inactive and non-speech models', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [
      { id: 'whisper-large-v3', context_window: 448, active: true },
      { id: 'whisper-inactive', active: false },
      { id: 'llama', context_window: 8192 },
    ] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchGroqSpeechModels('test-key')).toEqual([
      { id: 'whisper-large-v3', name: 'whisper-large-v3', inputTokenLimit: 448 },
    ]);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/models');
  });

  it('loads Gemini metadata across pages and keeps version-specific model identifiers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: [
        { name: 'models/gemini-test-001', baseModelId: 'gemini-test', displayName: 'Test', supportedGenerationMethods: ['generateContent'], temperature: 1, maxTemperature: 2, topP: 0.95, inputTokenLimit: 1000, outputTokenLimit: 200 },
        { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
      ], nextPageToken: 'page2' }))
      .mockResolvedValueOnce(Response.json({ models: [
        { name: 'models/gemini-test-002', supportedGenerationMethods: ['generateContent'], topK: 40 },
      ] }));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const models = await fetchGeminiTextModels('test-key', signal);
    const first = models.find(model => model.id === 'gemini-test-001')!;
    expect(first).toMatchObject({ maxTemperature: 2, inputTokenLimit: 1000, outputTokenLimit: 200 });
    expect(geminiModelParameters(first).map(field => field.key)).toEqual(['temperature', 'topP', 'maxOutputTokens']);
    expect(geminiModelParameters(models.find(model => model.id === 'gemini-test-002')!)).toEqual([
      { key: 'topK', label: 'Top K', min: 1, step: '1', defaultValue: 40 },
    ]);
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=page2');
    expect(fetcher.mock.calls[1][1]).toEqual({ signal });
  });

  it('does not invent settings for missing or invalid API metadata', () => {
    expect(geminiModelParameters({ id: 'test', name: 'Test' })).toEqual([]);
  });

  it('reports authentication failures instead of returning an empty model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Invalid key' } }, { status: 401 })));
    await expect(fetchGroqSpeechModels('bad-key')).rejects.toThrow('Invalid key');
  });
});
