import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGoogleCloudCatalog, googleCloudCatalogError, googleCloudFeatures } from './catalog';
import { googleCloudToken } from './auth';
import { googleCloudConfigurationError, normalizeGoogleCloudSettings } from './settings';
import { parseGoogleCloudTranscript, transcribeWithGoogleCloud } from './transcribe';
import { defaultSettings, parseSettingsJson } from '../config';
import { createTranscriptionProvider } from '../provider-adapters';
import { getScenarioReadinessError } from '../recording-workflow';
import { retranscribeHistoryRecording } from '../history-recording-actions';

const settings = () => normalizeGoogleCloudSettings({ credentials: 'oauth-token', projectId: 'test-project', location: 'eu', model: 'chirp_3', language: 'auto' });
const location = (id = 'eu') => ({ locationId: id, displayName: id, metadata: { languages: { models: {
  'ru-RU': { modelFeatures: { chirp_3: { modelFeature: [{ feature: 'automatic_punctuation', releaseState: 'GA' }] },
    chirp: { modelFeature: [] } } },
  'en-US': { modelFeatures: { chirp_3: { modelFeature: [{ feature: 'automatic_punctuation', releaseState: 'GA' }, { feature: 'profanity_filter', releaseState: 'GA' }] } } },
  'fr-FR': { modelFeatures: { latest_long: { modelFeature: [] } } },
} } } });
const recognition = { results: [{ alternatives: [{ transcript: 'Привет, мир!', words: [
  { word: 'Привет,', startOffset: '0s', endOffset: '0.25s' }, { word: 'мир!', startOffset: '0.25s', endOffset: '1s' },
] }] }] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Google Cloud discovery', () => {
  it('loads all locations pages, parses language/model/features hierarchy, and caches metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ locations: [location()], nextPageToken: 'second' }))
      .mockResolvedValueOnce(Response.json({ locations: [location('us')] }));
    const catalog = await fetchGoogleCloudCatalog(settings(), undefined, fetcher);
    expect(catalog.map(l => l.id)).toEqual(['eu', 'us']);
    expect(catalog[0].languages['ru-RU'][0]).toEqual({ id: 'chirp_3', features: [{ id: 'automatic_punctuation', releaseState: 'GA' }] });
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=second');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer oauth-token' });
    expect(await fetchGoogleCloudCatalog(settings(), undefined, fetcher)).toBe(catalog);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(googleCloudFeatures(catalog[0], 'chirp_3', 'auto')).toEqual([{ id: 'automatic_punctuation', releaseState: 'GA' }]);
    expect(googleCloudFeatures(catalog[0], 'chirp_3', 'en-US')).toHaveLength(2);
    expect(googleCloudCatalogError({ ...settings(), language: 'fr-FR' }, catalog)).toContain('Язык');
    expect(googleCloudCatalogError({ ...settings(), features: { profanity_filter: true } }, catalog)).toContain('недоступна');
  });

  it('reports API errors and supports cancellation without making recognition requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'Speech API disabled' } }, { status: 403 }));
    await expect(fetchGoogleCloudCatalog(settings(), undefined, fetcher)).rejects.toThrow('Speech API disabled');
    const controller = new AbortController(); controller.abort();
    await expect(fetchGoogleCloudCatalog(settings(), controller.signal, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).not.toContain(':recognize');
  });

  it('keeps catalogs separate for projects and credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ locations: [location()] }));
    await fetchGoogleCloudCatalog(settings(), undefined, fetcher);
    await fetchGoogleCloudCatalog({ ...settings(), projectId: 'second-project' }, undefined, fetcher);
    await fetchGoogleCloudCatalog({ ...settings(), credentials: 'second-token' }, undefined, fetcher);
    await fetchGoogleCloudCatalog(settings(), undefined, fetcher, true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('Google Cloud credentials and configuration', () => {
  it('signs service account assertions, exchanges them for tokens and refreshes expired tokens', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const private_key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
    const credentials = JSON.stringify({ private_key, client_email: 'test@example.test', project_id: 'test-project' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ access_token: 'fresh-token', expires_in: 3600 }));
    let now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(await googleCloudToken(credentials, undefined, fetcher)).toBe('fresh-token');
    const assertion = (fetcher.mock.calls[0][1]?.body as URLSearchParams).get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    const decode = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toMatchObject({ iss: 'test@example.test', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform' });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, decode(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
    await googleCloudToken(credentials, undefined, fetcher); expect(fetcher).toHaveBeenCalledOnce();
    now += 3_600_000;
    await googleCloudToken(credentials, undefined, fetcher); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves Google settings through JSON import and validates readiness independently of Groq', () => {
    const config = defaultSettings();
    const step = config.scenarios[0].steps.find(s => s.type === 'transcribe')!;
    step.transcription = { ...step.transcription!, provider: 'google-cloud', apiKey: '', googleCloud: settings() };
    const restored = parseSettingsJson(JSON.stringify(config));
    expect(restored.provider).toBe('google-cloud'); expect(restored.googleCloud).toEqual(settings());
    expect(getScenarioReadinessError(restored)).toBeNull();
    restored.googleCloud!.credentials = '';
    expect(getScenarioReadinessError(restored)).toContain('Google Cloud');
    expect(googleCloudConfigurationError({ ...settings(), model: 'latest_long' })).toContain('Автоопределение');
    expect(googleCloudConfigurationError({ ...settings(), model: 'latest_long', language: 'en-US' })).toBeNull();
  });
});

describe('Google Cloud transcription', () => {
  const stubAudio = () => {
    class Buffer {
      numberOfChannels: number; length: number; sampleRate: number; channels: Float32Array[];
      constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
        Object.assign(this, options); this.numberOfChannels = options.numberOfChannels; this.length = options.length; this.sampleRate = options.sampleRate;
        this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
      }
      get duration() { return this.length / this.sampleRate; }
      getChannelData(channel: number) { return this.channels[channel]; }
    }
    vi.stubGlobal('AudioBuffer', Buffer);
    return Buffer;
  };

  it('sends regional V2 requests, splits long audio and shifts word timestamps', async () => {
    const Buffer = stubAudio();
    const { cutAudio } = await import('../recording-editor');
    const audio = cutAudio(new Buffer({ numberOfChannels: 1, length: 112 * 8000, sampleRate: 8000 }) as unknown as AudioBuffer, [{ start: 0, end: 112 }]);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).includes(':recognize') ? recognition : { locations: [location()] }));
    const options = { ...settings(), features: { automatic_punctuation: true } };
    const provider = createTranscriptionProvider(() => ({ provider: 'google-cloud', googleCloud: options, apiKey: '', model: '', prompt: '', temperature: 0, language: 'auto' }), fetcher);
    const result = await provider.transcribe(audio);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const calls = fetcher.mock.calls.filter(([url]) => String(url).includes(':recognize'));
    expect(calls[0][0]).toBe('https://eu-speech.googleapis.com/v2/projects/test-project/locations/eu/recognizers/_:recognize');
    const body = JSON.parse(calls[0][1]?.body as string);
    expect(body.config).toEqual({ autoDecodingConfig: {}, model: 'chirp_3', languageCodes: ['auto'], features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true } });
    expect(atob(body.content).slice(0, 4)).toBe('RIFF');
    expect(result.text).toBe('Привет, мир! Привет, мир! Привет, мир!');
    expect(result.segments[2]).toEqual({ start: 55, end: 55.25, text: 'Привет,' });
    expect(result.segments[4].start).toBe(110);
  });

  it('rejects incompatible languages before uploading audio, and preserves explicit languages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ locations: [location()] }));
    await expect(transcribeWithGoogleCloud(new Blob(['unused']), { ...settings(), language: 'de-DE' }, undefined, fetcher)).rejects.toThrow('Язык');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(parseGoogleCloudTranscript({ results: [{ alternatives: [{ transcript: 'Text', words: [
      { word: 'Text', endOffset: '1s' }, { word: 'invalid', startOffset: 'bad', endOffset: '2s' },
    ] }] }] }, 5).segments).toEqual([{ start: 5, end: 6, text: 'Text' }]);
  });

  it('uses Google Cloud for retranscription of saved audio without requiring a Groq key', async () => {
    const cloud = vi.fn(async () => ({ text: ' Новый текст ', segments: [] }));
    const groq = vi.fn(); const copy = vi.fn(async () => {});
    const audio = new Blob(['saved']);
    expect(await retranscribeHistoryRecording({ id: 'saved', timestamp: 1, text: 'Old', audioBlob: audio }, undefined, {
      settings: () => ({ provider: 'google-cloud', googleCloud: settings(), groqApiKey: '', groqModel: '', groqPrompt: '', groqTemperature: 0, groqLanguage: '' }),
      transcribe: groq, transcribeGoogleCloud: cloud, copy,
    })).toBe('Новый текст');
    expect(cloud).toHaveBeenCalledWith(audio, settings(), undefined); expect(groq).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('Новый текст');
  });
});
