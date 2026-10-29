import { describe, expect, it, vi } from 'vitest';
import { createGeminiTextPostProcessor, createGroqTranscriptionProvider } from './provider-adapters';

describe('provider adapters', () => {
  it('requires an explicit Gemini key without using an embedded fallback', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const processor = createGeminiTextPostProcessor(() => ({ instructionPrompt: 'Ответь' }), fetcher);
    await expect(processor.process('Вопрос')).rejects.toThrow('API-ключ Gemini не указан.');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('replaces a retired saved model only with a model returned by the API', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes(':generateContent')
      ? Response.json({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] })
      : Response.json({ models: [
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-9.0-flash', supportedGenerationMethods: ['generateContent'] },
      ] }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'key', model: 'gemini-1.5-flash', instructionPrompt: 'Ответь' }), fetcher);
    expect(await processor.process('Вопрос')).toBe('Ответ');
    expect(fetcher.mock.calls[1][0]).toContain('/gemini-9.0-flash:generateContent');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/gemini-1.5-flash:'))).toBe(false);
    await processor.process('Ещё вопрос');
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(1);
  });

  it('does not generate when the API returned no suitable models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [] }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'key', model: 'old', instructionPrompt: 'Ответь' }), fetcher);
    await expect(processor.process('Вопрос')).rejects.toThrow('не вернуло доступных моделей');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes the catalog after an API key change and invalidates it on generation 404', async () => {
    let key = 'first';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes(':generateContent')
      ? new Response('not found', { status: 404 })
      : Response.json({ models: [{ name: 'models/available', supportedGenerationMethods: ['generateContent'] }] }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: key, model: 'available', instructionPrompt: 'Ответь' }), fetcher);
    await expect(processor.process('Вопрос')).rejects.toThrow('недоступна для генерации с этим ключом');
    key = 'second';
    await expect(processor.process('Вопрос')).rejects.toThrow('Обновите список');
    expect(fetcher.mock.calls[2][0]).not.toContain('key=');
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({ 'x-goog-api-key': 'second' });
  });
  it('sends the transcription request through an injected fetcher', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      text: 'Привет',
      words: [{ start: 0, end: 0.7, word: 'Привет' }, { start: -1, end: 0, word: 'bad' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = createGroqTranscriptionProvider(() => ({ apiKey: 'test-key' }), fetcher);

    await expect(provider.transcribe(new Blob(['audio'], { type: 'audio/wav' }))).resolves.toEqual({
      text: 'Привет',
      segments: [{ start: 0, end: 0.7, text: 'Привет' }],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('uses an injected fetcher for post-processing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ models: [
      { name: 'models/test-model', supportedGenerationMethods: ['generateContent'] },
    ] })).mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Исправленный текст' }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', model: 'test-model', instructionPrompt: 'Исправь текст' }), fetcher);

    await expect(processor.process('исходный текст')).resolves.toBe('Исправленный текст');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain('/test-model:generateContent');
  });

  it('sends configured Gemini parameters, preserving zero temperature and provider defaults', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes(':generateContent')
      ? Response.json({ candidates: [{ content: { parts: [{ text: 'Текст' }] } }] })
      : Response.json({ models: [{ name: 'models/test-model', supportedGenerationMethods: ['generateContent'] }] }));
    const generationConfig = { temperature: 0, topP: 0.8, topK: 20, maxOutputTokens: 100 };
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', instructionPrompt: 'Исправь', generationConfig }), fetcher);
    await processor.process('текст');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).generationConfig).toEqual(generationConfig);
    const defaults = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', instructionPrompt: 'Исправь', generationConfig: {} }), fetcher);
    await defaults.process('текст');
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).generationConfig).toEqual({});
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(1);
  });

  it('shares model discovery across parallel steps and new processor instances without sharing generated answers', async () => {
    let release!: () => void;
    const discovery = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] });
      await discovery;
      return Response.json({ models: [{ name: 'models/available', supportedGenerationMethods: ['generateContent'] }] });
    });
    const options = () => ({ apiKey: 'key', instructionPrompt: 'Ответь' });
    const signal = new AbortController().signal;
    const first = createGeminiTextPostProcessor(options, fetcher).process('Первый', signal);
    const second = createGeminiTextPostProcessor(options, fetcher).process('Второй', signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([first, second])).toEqual(['Ответ', 'Ответ']);
    expect(await createGeminiTextPostProcessor(options, fetcher).process('Третий')).toBe('Ответ');
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes(':generateContent'))).toHaveLength(3);
  });

  it('refreshes an expired shared model list', async () => {
    const clock = vi.spyOn(Date, 'now');
    let now = 100_000;
    clock.mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes(':generateContent')
      ? Response.json({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] })
      : Response.json({ models: [{ name: 'models/available', supportedGenerationMethods: ['generateContent'] }] }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'key', instructionPrompt: 'Ответь' }), fetcher);
    try {
      await processor.process('Первый');
      now += 59_999;
      await processor.process('Второй');
      expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(1);
      now += 1;
      await processor.process('Третий');
      expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  it('does not couple cancellation of independent scenario runs', async () => {
    const firstRun = new AbortController();
    const secondRun = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] });
      if (init?.signal === firstRun.signal) {
        return new Promise((_resolve, reject) => firstRun.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      }
      return Response.json({ models: [{ name: 'models/available', supportedGenerationMethods: ['generateContent'] }] });
    });
    const options = () => ({ apiKey: 'key', instructionPrompt: 'Ответь' });
    const first = createGeminiTextPostProcessor(options, fetcher).process('Первый', firstRun.signal);
    const second = createGeminiTextPostProcessor(options, fetcher).process('Второй', secondRun.signal);
    const rejection = expect(first).rejects.toThrow('Aborted');
    firstRun.abort();
    await rejection;
    expect(await second).toBe('Ответ');
    expect(await createGeminiTextPostProcessor(options, fetcher).process('Третий')).toBe('Ответ');
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes(':generateContent'))).toHaveLength(2);
  });
});
