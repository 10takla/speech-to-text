import { describe, expect, it, vi } from 'vitest';
import { createStep } from './scenario';
import { normalizeSpeechProviders } from './speech-provider-settings';
import { audioFromBase64, fetchSpeechCatalog, parsePiperVoices, synthesizeProviderSpeech } from './speech-providers';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const options = () => {
  const value = normalizeSpeechProviders();
  value.gemini = { apiKey: 'test-google', model: 'gemini-3.8-flash-tts', voice: 'Kore', style: 'спокойно', volume: .4 };
  value.elevenlabs = { ...value.elevenlabs, apiKey: 'test-eleven', model: 'eleven_multilingual_v2', voice: 'voice-1' };
  value.piper = { ...value.piper, voice: 'ru_RU-test-medium', speakerId: 2, lengthScale: 1.2, noiseScale: 0, noiseWScale: .8 };
  return value;
};

describe('speech provider discovery', () => {
  it('loads Gemini TTS models and voices with pagination, without generating audio or exposing the key in URLs', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'models-2' }))
      .mockResolvedValueOnce(response({ models: [
        { name: 'models/gemini-3.8-flash-tts', displayName: 'Flash TTS', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-pro-tts', supportedGenerationMethods: ['generateContent'] },
      ] }))
      .mockResolvedValueOnce(response({ voices: [{ id: 'Kore', display_name: 'Кора', language_code: 'ru' }], next_page_token: 'voices-2' }))
      .mockResolvedValueOnce(response({ voices: [{ id: 'Puck' }] }));
    const catalog = await fetchSpeechCatalog('gemini', options(), undefined, fetcher);
    expect(catalog.models).toEqual([{ id: 'gemini-3.8-flash-tts', name: 'Flash TTS' }]);
    expect(catalog.voices.map(voice => voice.id)).toEqual(['Kore', 'Puck']);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain('test-google');
      expect(init?.headers).toEqual({ 'x-goog-api-key': 'test-google' });
      expect(init?.method).toBeUndefined();
    }
    expect(String(fetcher.mock.calls[1][0])).toContain('pageToken=models-2');
    expect(String(fetcher.mock.calls[3][0])).toContain('page_token=voices-2');
  });

  it('uses documented Gemini voices only when discovery is unsupported, not on authentication failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ models: [] })).mockResolvedValueOnce(response({}, 404));
    expect((await fetchSpeechCatalog('gemini', options(), undefined, fetcher)).voices.some(voice => voice.id === 'Kore')).toBe(true);
    fetcher.mockResolvedValueOnce(response({ models: [] })).mockResolvedValueOnce(response({ error: { message: 'Denied' } }, 403));
    await expect(fetchSpeechCatalog('gemini', options(), undefined, fetcher)).rejects.toThrow('403');
  });

  it('discovers ElevenLabs TTS capabilities, languages and all voice pages using read-only calls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response([
      { model_id: 'tts', name: 'TTS', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: false, languages: [{ language_id: 'ru', name: 'Русский' }] },
      { model_id: 'stt', can_do_text_to_speech: false },
    ])).mockResolvedValueOnce(response({ voices: [{ voice_id: 'first', name: 'First' }], next_page_token: 'next' }))
      .mockResolvedValueOnce(response({ voices: [{ voice_id: 'second' }] }));
    const catalog = await fetchSpeechCatalog('elevenlabs', options(), undefined, fetcher);
    expect(catalog.models).toEqual([{ id: 'tts', name: 'TTS', style: true, speakerBoost: false, languages: [{ id: 'ru', name: 'Русский' }] }]);
    expect(catalog.voices.map(voice => voice.id)).toEqual(['first', 'second']);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method && !init?.body)).toBe(true);
  });

  it('discovers installed Piper voices and speakers without synthesis or downloads', async () => {
    const piper = vi.fn().mockResolvedValue(response({ ru_RU_test: { num_speakers: 3, speaker_id_map: { Ирина: 2 }, language: { code: 'ru_RU' }, inference: { length_scale: 1 } } }));
    const catalog = await fetchSpeechCatalog('piper', options(), undefined, fetch, piper);
    expect(piper).toHaveBeenCalledWith('http://127.0.0.1:5000', 'voices', undefined, expect.any(AbortSignal));
    expect(catalog.voices[0].speakers?.[2]).toEqual({ id: 2, name: 'Ирина' });
    expect(parsePiperVoices(null)).toEqual([]);
  });
});

describe('speech synthesis', () => {
  it('sends Gemini 3.8 the exact transcript, separate style metadata, and decodes WAV', async () => {
    const step = { ...createStep('speak'), speechProvider: 'gemini' as const, speechProviders: options() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: btoa('RIFFtest') }] }] }));
    const blob = await synthesizeProviderSpeech(step, 'Ответ: 4.', undefined, fetcher);
    expect(await blob.text()).toBe('RIFFtest');
    expect(fetcher.mock.calls[0][0]).toMatch(/\/interactions$/);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).input[0].content[0]).toEqual({ type: 'text', text: 'Ответ: 4.', annotations: [{ type: 'speech_metadata', style: 'спокойно' }] });
  });

  it('wraps legacy Gemini PCM in a playable WAV header at the supplied sample rate', async () => {
    const step = { ...createStep('speak'), speechProvider: 'gemini' as const, speechProviders: options() };
    step.speechProviders.gemini.model = 'gemini-2.5-flash-preview-tts';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ candidates: [{ content: { parts: [{ inlineData: { data: btoa('\x00\x01\x02\x03'), mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }] }));
    const blob = await synthesizeProviderSpeech(step, 'Текст', undefined, fetcher);
    const bytes = await blob.arrayBuffer(), view = new DataView(bytes);
    expect(blob.type).toBe('audio/wav'); expect(blob.size).toBe(48);
    expect(view.getUint32(24, true)).toBe(24000); expect(view.getUint32(40, true)).toBe(4);
    expect(fetcher.mock.calls[0][0]).toMatch(/:generateContent$/);
    expect(audioFromBase64(btoa('RIFF'), 'audio/wav').size).toBe(4);
  });

  it('uses ElevenLabs MP3 available on the free tier and excludes unsupported voice controls', async () => {
    const step = { ...createStep('speak'), speechProvider: 'elevenlabs' as const, speechProviders: options() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('MP3'));
    expect((await synthesizeProviderSpeech(step, 'Текст', undefined, fetcher)).type).toBe('audio/mpeg');
    expect(fetcher.mock.calls[0][0]).toContain('/voice-1?output_format=mp3_44100_128');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.voice_settings).not.toHaveProperty('style');
    expect(body.voice_settings).not.toHaveProperty('use_speaker_boost');
  });

  it('sends Piper its selected voice, speaker, and synthesis settings without cloud calls', async () => {
    const step = { ...createStep('speak'), speechProvider: 'piper' as const, speechProviders: options() };
    const fetcher = vi.fn<typeof fetch>();
    const piper = vi.fn().mockResolvedValueOnce(response({ 'ru_RU-test-medium': { num_speakers: 3 } })).mockResolvedValueOnce(new Response('WAV'));
    expect(await (await synthesizeProviderSpeech(step, 'Ответ', undefined, fetcher, piper)).text()).toBe('WAV');
    expect(fetcher).not.toHaveBeenCalled();
    expect(piper).toHaveBeenCalledWith('http://127.0.0.1:5000', 'synthesize', {
      text: 'Ответ', voice: 'ru_RU-test-medium', speaker_id: 2, length_scale: 1.2, noise_scale: 0, noise_w_scale: .8,
    }, expect.any(AbortSignal));
  });

  it('does not let Piper silently replace a removed voice with the server default', async () => {
    const step = { ...createStep('speak'), speechProvider: 'piper' as const, speechProviders: options() };
    const piper = vi.fn().mockResolvedValue(response({}));
    await expect(synthesizeProviderSpeech(step, 'Текст', undefined, fetch, piper)).rejects.toThrow('не загружен');
    expect(piper).toHaveBeenCalledTimes(1);
  });

  it('stops before any request if cancelled or missing required settings', async () => {
    const step = { ...createStep('speak'), speechProvider: 'gemini' as const, speechProviders: options() };
    const fetcher = vi.fn<typeof fetch>();
    await expect(synthesizeProviderSpeech(step, 'Текст', AbortSignal.abort(), fetcher)).rejects.toThrow();
    step.speechProviders.gemini.apiKey = '';
    await expect(synthesizeProviderSpeech(step, 'Текст', undefined, fetcher)).rejects.toThrow('API-ключ');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports quota errors without retrying synthesis or exposing the key', async () => {
    const step = { ...createStep('speak'), speechProvider: 'gemini' as const, speechProviders: options() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { message: 'Quota test-google exhausted' } }, 429));
    await expect(synthesizeProviderSpeech(step, 'Текст', undefined, fetcher)).rejects.toThrow('Quota [ключ скрыт] exhausted');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
