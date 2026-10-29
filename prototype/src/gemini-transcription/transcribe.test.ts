import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGeminiTranscriptionModels, fetchGeminiTextModels } from '../provider-models';
import { fetchGeminiTranscriptionCatalog } from './catalog';
import { geminiTranscriptionConfigurationError, geminiTranscriptionConfig, normalizeGeminiTranscriptionSettings } from './settings';
import { parseGeminiTranscript } from './transcribe';
import { createTranscriptionProvider } from '../provider-adapters';
import { decodeAudio } from '../audio-decoding';
import { defaultSettings, parseSettingsJson } from '../config';
import { getScenarioReadinessError } from '../recording-workflow';
import { retranscribeHistoryRecording } from '../history-recording-actions';
import { createStep } from '../scenario';

vi.mock('../audio-decoding', () => ({ decodeAudio: vi.fn() }));
const settings = () => normalizeGeminiTranscriptionSettings({ apiKey: 'test-key', model: 'gemini-3.5-transcribe' });
const models = { models: [{ name: 'models/gemini-3.5-transcribe', displayName: 'Gemini Transcribe', supportedGenerationMethods: ['generateContent'] }] };
const result = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Привет, мир!', annotations: [
  { type: 'word_info', text: 'Привет,', start_offset: '0.1s', end_offset: '0.4s', speaker: 'spk_1' },
  { type: 'word_info', text: 'мир!', start_offset: '0.5s', end_offset: '1s', speaker: 'spk_2' },
] }] }] };
const selected = () => ({ provider: 'gemini' as const, geminiTranscription: settings(), apiKey: '', model: '', prompt: '', temperature: 0, language: 'auto' });

beforeEach(() => {
  const buffer = { numberOfChannels: 1, length: 16000, sampleRate: 16000, duration: 1, getChannelData: () => new Float32Array(16000) } as unknown as AudioBuffer;
  vi.mocked(decodeAudio).mockResolvedValue(buffer);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Gemini Transcribe catalog', () => {
  it('loads paginated ASR models, keeps returned versions, and excludes Live/text/TTS models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ models: [
      ...models.models,
      { name: 'models/gemini-3.5-transcribe-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-tts', supportedGenerationMethods: ['generateContent'] },
    ], nextPageToken: 'page2' })).mockResolvedValueOnce(Response.json({ models: [
      { name: 'models/gemini-3.5-transcribe-preview', displayName: 'Preview', inputTokenLimit: 1000 },
    ] }));
    const catalog = await fetchGeminiTranscriptionModels(' test-key ', undefined, fetcher);
    expect(catalog.map(m => m.id)).toEqual(['gemini-3.5-transcribe', 'gemini-3.5-transcribe-preview']);
    expect(catalog[1].inputTokenLimit).toBe(1000);
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=page2');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ 'x-goog-api-key': 'test-key' });
    const textFetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [
      ...models.models, { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    ] }));
    expect((await fetchGeminiTextModels('test-key', undefined, textFetcher)).map(m => m.id)).toEqual(['gemini-3.5-flash']);
  });

  it('caches per key and refreshes on Test without processing any audio', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(models));
    await fetchGeminiTranscriptionCatalog('first', undefined, fetcher);
    await fetchGeminiTranscriptionCatalog('first', undefined, fetcher);
    await fetchGeminiTranscriptionCatalog('second', undefined, fetcher);
    await fetchGeminiTranscriptionCatalog('first', undefined, fetcher, true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('interactions'))).toBe(true);
  });
});

describe('Gemini Transcribe configuration', () => {
  it('validates documented compatibility without silently rewriting user settings', () => {
    expect(geminiTranscriptionConfigurationError(settings())).toBeNull();
    expect(geminiTranscriptionConfigurationError({ ...settings(), mode: 'smart' })).toContain('несовместим');
    expect(geminiTranscriptionConfigurationError({ ...settings(), vocabulary: ['term'] })).toContain('Словарь');
    expect(geminiTranscriptionConfigurationError({ ...settings(), vocabulary: Array(1001).fill('word'), timestamps: false })).toContain('1000');
    expect(geminiTranscriptionConfigurationError({ ...settings(), language: 'unknown' })).toContain('язык');
    expect(geminiTranscriptionConfigurationError({ ...settings(), model: 'gemini-3.5-transcribe-live' })).toContain('файлового');
    expect(geminiTranscriptionConfig({ ...settings(), mode: 'smart', timestamps: false, language: 'ru-RU', vocabulary: ['Слово'] }))
      .toEqual({ mode: 'smart', language_codes: ['ru-RU'], custom_vocabulary: ['Слово'] });
    expect(geminiTranscriptionConfig(settings())).toEqual({ mode: { type: 'verbatim', timestamp_granularities: ['word'] } });
  });

  it('preserves independent transcription settings through JSON import and handles readiness in branches', () => {
    const config = defaultSettings();
    const step = config.scenarios[0].steps.find(s => s.type === 'transcribe')!;
    step.transcription = { ...step.transcription!, provider: 'gemini', apiKey: '', geminiTranscription: settings() };
    const restored = parseSettingsJson(JSON.stringify(config));
    expect(restored.provider).toBe('gemini'); expect(restored.geminiTranscription).toEqual(settings());
    expect(getScenarioReadinessError(restored)).toBeNull();
    const branch = createStep('transcribe'); branch.transcription!.provider = 'gemini';
    branch.transcription!.geminiTranscription = { ...settings(), apiKey: '' };
    restored.scenarios[0].steps[1].parallelBranches = [[branch]];
    expect(getScenarioReadinessError(restored)).toContain('API-ключ');
  });
});

describe('Gemini Transcribe requests and results', () => {
  it('sends inline audio to Interactions with API-key auth, timestamps and no implicit fixed language', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).includes('interactions') ? result : models));
    const signal = new AbortController().signal;
    const provider = createTranscriptionProvider(selected, fetcher);
    const transcript = await provider.transcribe(new Blob(['audio']), signal);
    expect(transcript.text).toBe('Привет, мир!');
    expect(transcript.segments).toEqual([
      { start: 0.1, end: 0.4, text: 'Привет,', speaker: 'spk_1' }, { start: 0.5, end: 1, text: 'мир!', speaker: 'spk_2' },
    ]);
    const [, init] = fetcher.mock.calls[1];
    expect(init?.signal).toBe(signal);
    expect(init?.headers).toEqual({ 'x-goog-api-key': 'test-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('gemini-3.5-transcribe'); expect(body.store).toBe(false);
    expect(body.generation_config.transcription_config).toEqual({ mode: { type: 'verbatim', timestamp_granularities: ['word'] } });
    expect(body.input[0].mime_type).toBe('audio/wav'); expect(atob(body.input[0].data).slice(0, 4)).toBe('RIFF');
  });

  it('splits long audio and offsets timestamps, while passing explicit languages and diarization', async () => {
    vi.mocked(decodeAudio).mockResolvedValue({ numberOfChannels: 1, length: 250 * 16000, sampleRate: 16000, duration: 250,
      getChannelData: () => new Float32Array(250 * 16000),
    } as unknown as AudioBuffer);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).includes('interactions') ? result : models));
    const options = { ...selected(), geminiTranscription: { ...settings(), language: 'ru-RU', diarization: true } };
    const transcript = await createTranscriptionProvider(() => options, fetcher).transcribe(new Blob(['audio']));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(transcript.segments[2].start).toBe(240.1);
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).generation_config.transcription_config).toEqual({ language_codes: ['ru-RU'],
      mode: { type: 'verbatim', timestamp_granularities: ['word'], diarization_mode: 'speaker' },
    });
  });

  it('rejects unavailable models and API errors, and stops after cancellation', async () => {
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [] }));
    await expect(createTranscriptionProvider(selected, unavailable).transcribe(new Blob(['audio']))).rejects.toThrow('недоступна');
    expect(unavailable).toHaveBeenCalledOnce();
    const denied = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(models))
      .mockImplementation(async () => Response.json({ error: { message: 'Quota exceeded' } }, { status: 429, headers: { 'Retry-After': '0' } }));
    await expect(createTranscriptionProvider(selected, denied).transcribe(new Blob(['audio']))).rejects.toThrow('429');
    const abort = new AbortController();
    const cancelled = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (!String(url).includes('interactions')) return Response.json(models);
      abort.abort(); return Response.json(result);
    });
    await expect(createTranscriptionProvider(selected, cancelled).transcribe(new Blob(['audio']), abort.signal)).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('handles smart text output, silence, invalid annotations, failed and malformed responses', () => {
    expect(parseGeminiTranscript({ output_text: ' Текст ' })).toEqual({ text: 'Текст', segments: [] });
    expect(parseGeminiTranscript({ status: 'completed', steps: [] })).toEqual({ text: '', segments: [] });
    expect(() => parseGeminiTranscript({ status: 'incomplete', steps: [] })).toThrow('не завершено');
    expect(() => parseGeminiTranscript({})).toThrow('не вернул');
    expect(() => parseGeminiTranscript(null)).toThrow('некорректный');
    expect(parseGeminiTranscript({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Text', annotations: [
      { type: 'word_info', text: 'Text', start_offset: 'bad', end_offset: '1s' },
    ] }] }] }).segments).toEqual([]);
  });

  it('retranscribes history with the Gemini key and leaves other providers unused', async () => {
    const transcribeGemini = vi.fn(async () => ({ text: ' Новый текст ', segments: [] })), transcribe = vi.fn(), copy = vi.fn(async () => {});
    const audio = new Blob(['audio']); const signal = new AbortController().signal;
    expect(await retranscribeHistoryRecording({ id: 'saved', timestamp: 1, text: 'Old', audioBlob: audio }, signal, {
      settings: () => ({ provider: 'gemini', geminiTranscription: settings(), groqApiKey: '', groqModel: '', groqPrompt: '', groqTemperature: 0, groqLanguage: '' }),
      transcribe, transcribeGemini, copy,
    })).toBe('Новый текст');
    expect(transcribeGemini).toHaveBeenCalledWith(audio, settings(), signal); expect(transcribe).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('Новый текст');
  });
});
