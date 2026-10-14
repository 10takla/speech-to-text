import { describe, expect, it, vi } from 'vitest';
import { createGeminiTextPostProcessor, createGroqTranscriptionProvider } from './provider-adapters';

describe('provider adapters', () => {
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Исправленный текст' }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', model: 'test-model' }), fetcher);

    await expect(processor.process('исходный текст')).resolves.toBe('Исправленный текст');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('sends configured Gemini parameters, preserving zero temperature and provider defaults', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ candidates: [{ content: { parts: [{ text: 'Текст' }] } }] }));
    const generationConfig = { temperature: 0, topP: 0.8, topK: 20, maxOutputTokens: 100 };
    const processor = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', generationConfig }), fetcher);
    await processor.process('текст');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).generationConfig).toEqual(generationConfig);
    const defaults = createGeminiTextPostProcessor(() => ({ apiKey: 'test-key', generationConfig: {} }), fetcher);
    await defaults.process('текст');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).generationConfig).toEqual({});
  });
});
