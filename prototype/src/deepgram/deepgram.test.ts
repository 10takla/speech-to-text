import { describe, expect, it, vi } from 'vitest';
import {
  deepgramConfigurationError,
  deepgramListenQuery,
  normalizeDeepgramSettings,
} from './settings';
import {
  parseDeepgramAlternative,
  parseDeepgramRestResponse,
  parseWavPcm,
  transcribeWithDeepgram,
} from './transcribe';
import { fetchDeepgramCatalog } from './catalog';
import { createDeepgramLiveTranscriber } from './live';
import { appendRecordingFragments, type RecordingFragment } from '../recording-editor';
import { getScenarioReadinessError } from '../recording-workflow';
import { findScenarioDuplicates } from '../scenario-duplicates';
import { createDefaultScenario } from '../scenario';

function makeWavBuffer(samples: number[], sampleRate = 16_000, extraChunkBeforeData = false): ArrayBuffer {
  const extraSize = extraChunkBeforeData ? 12 : 0; // 'LIST' (4) + size (4) + 4 payload bytes
  const dataSize = samples.length * 2;
  const totalSize = 44 + extraSize + dataSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let offset = 36;
  if (extraChunkBeforeData) {
    writeTag(offset, 'LIST');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, 0x12345678, true);
    offset += 12;
  }
  writeTag(offset, 'data');
  view.setUint32(offset + 4, dataSize, true);
  offset += 8;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset + i * 2, samples[i], true);
  }
  return buffer;
}

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: Array<string | ArrayBuffer> = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    const ev = Object.assign(new Event('close'), { wasClean: true, code, reason }) as CloseEvent;
    this.onclose?.(ev);
    this.dispatchEvent(ev);
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    const ev = new Event('open');
    this.onopen?.(ev);
    this.dispatchEvent(ev);
  }

  emitMessage(payload: unknown) {
    const ev = new MessageEvent('message', { data: JSON.stringify(payload) });
    this.onmessage?.(ev);
    this.dispatchEvent(ev);
  }

  emitError() {
    const ev = new Event('error');
    this.onerror?.(ev);
    this.dispatchEvent(ev);
  }
}

describe('deepgram settings and query builder', () => {
  it('normalizes defaults and validates configuration errors', () => {
    const defaults = normalizeDeepgramSettings({ apiKey: '  dg-key  ' });
    expect(defaults).toEqual({
      apiKey: 'dg-key',
      model: 'nova-3',
      language: 'multi',
      smartFormat: true,
      punctuate: true,
      numerals: false,
      interimResults: true,
      diarize: false,
      fillerWords: false,
      profanityFilter: false,
      mipOptOut: false,
      endpointingMs: 300,
      utteranceEndMs: 0,
      redact: '',
      keyterms: [],
      replace: [],
    });
    expect(deepgramConfigurationError({ apiKey: '' })).toBe('Deepgram: укажите API-ключ.');
    expect(deepgramConfigurationError({ apiKey: 'k', endpointingMs: 5 })).toContain('пауза фиксации');
    expect(deepgramConfigurationError({ apiKey: 'k', endpointingMs: 0 })).toBeNull();
    expect(deepgramConfigurationError({ apiKey: 'k', utteranceEndMs: 500 })).toContain('конец фразы');
    expect(deepgramConfigurationError({ apiKey: 'k', utteranceEndMs: 1200, interimResults: false })).toContain('Промежуточный текст на лету');
    expect(deepgramConfigurationError({ apiKey: 'k', replace: ['invalid'] })).toContain('что:на_что');
    expect(deepgramConfigurationError({ apiKey: 'k', replace: ['дипграм:Deepgram'], utteranceEndMs: 1200 })).toBeNull();
    expect(deepgramConfigurationError(defaults)).toBeNull();
  });

  it('builds nova-3 keyterm and nova-2 keywords query parameters along with extended options', () => {
    const s3 = normalizeDeepgramSettings({
      apiKey: 'k',
      model: 'nova-3',
      language: 'multi',
      numerals: true,
      diarize: true,
      fillerWords: true,
      profanityFilter: true,
      mipOptOut: true,
      redact: 'pci',
      endpointingMs: 350,
      utteranceEndMs: 1200,
      keyterms: ['Antigravity', 'Deepgram'],
      replace: ['дипграм:Deepgram', 'нова:Nova'],
    });
    const q3 = deepgramListenQuery(s3, { sampleRate: 16_000, channels: 1 });
    expect(q3.get('model')).toBe('nova-3');
    expect(q3.get('language')).toBe('multi');
    expect(q3.get('smart_format')).toBe('true');
    expect(q3.get('numerals')).toBe('true');
    expect(q3.get('diarize')).toBe('true');
    expect(q3.get('filler_words')).toBe('true');
    expect(q3.get('profanity_filter')).toBe('true');
    expect(q3.get('mip_opt_out')).toBe('true');
    expect(q3.get('redact')).toBe('pci');
    expect(q3.getAll('keyterm')).toEqual(['Antigravity', 'Deepgram']);
    expect(q3.getAll('keywords')).toEqual([]);
    expect(q3.getAll('replace')).toEqual(['дипграм:Deepgram', 'нова:Nova']);
    expect(q3.get('interim_results')).toBe('true');
    expect(q3.get('endpointing')).toBe('350');
    expect(q3.get('utterance_end_ms')).toBe('1200');
    expect(q3.get('encoding')).toBe('linear16');
    expect(q3.get('sample_rate')).toBe('16000');

    const s2 = normalizeDeepgramSettings({
      apiKey: 'k',
      model: 'nova-2',
      language: 'ru',
      smartFormat: false,
      punctuate: true,
      keyterms: ['термин'],
    });
    const q2 = deepgramListenQuery(s2);
    expect(q2.get('model')).toBe('nova-2');
    expect(q2.get('language')).toBe('ru');
    expect(q2.get('smart_format')).toBe('false');
    expect(q2.get('punctuate')).toBe('true');
    expect(q2.getAll('keywords')).toEqual(['термин']);
    expect(q2.getAll('keyterm')).toEqual([]);
  });
});

describe('deepgram parsing and WAV helpers', () => {
  it('parses word timestamps, punctuated_word, speaker, and zero-length words', () => {
    const transcript = parseDeepgramAlternative({
      transcript: 'Привет, мир',
      words: [
        { word: 'привет', punctuated_word: 'Привет,', start: 0.1, end: 0.1, speaker: 0 },
        { word: 'мир', start: 0.25, end: 0.6, speaker: 1 },
      ],
    }, 5.0);

    expect(transcript.text).toBe('Привет, мир');
    expect(transcript.segments).toEqual([
      { start: 5.1, end: 5.101, text: 'Привет,', speaker: '0' },
      { start: 5.25, end: 5.6, text: 'мир', speaker: '1' },
    ]);

    const rest = parseDeepgramRestResponse({
      results: { channels: [{ alternatives: [{ transcript: 'Тест', words: [{ word: 'Тест', start: 0, end: 0.4 }] }] }] },
    });
    expect(rest.segments).toEqual([{ start: 0, end: 0.4, text: 'Тест' }]);
  });

  it('parses standard 44-byte WAV and WAV with extra chunk before data', () => {
    const standard = parseWavPcm(makeWavBuffer([100, 200, 300], 48_000, false));
    expect(standard).toEqual({
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: 6,
      totalFrames: 3,
    });

    const withExtra = parseWavPcm(makeWavBuffer([1, 2, 3, 4], 16_000, true));
    expect(withExtra).toEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 56,
      dataLength: 8,
      totalFrames: 4,
    });
  });
});

describe('deepgram catalog and REST transcribe', () => {
  it('rejects 401 invalid API key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ err_msg: 'Invalid credentials.' }), { status: 401 }),
    );
    await expect(fetchDeepgramCatalog('bad-key', undefined, fetcher, true)).rejects.toThrow('неверный API-ключ');
  });

  it('deduplicates streaming models with nova-3 first and supports /v1/projects fallback on 404', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/v1/auth/token')) return new Response('', { status: 404 });
      if (url.endsWith('/v1/projects')) return new Response('{"projects":[]}', { status: 200 });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          stt: [
            { name: 'Base', canonical_name: 'base-general', languages: ['en'], streaming: true },
            { name: 'BatchOnly', canonical_name: 'whisper-large', languages: ['ru'], streaming: false },
            { name: 'General', canonical_name: 'nova-2-general', languages: ['en'], streaming: true },
            { name: 'General', canonical_name: 'nova-3-general', languages: ['en'], streaming: true },
            { name: 'General', canonical_name: 'nova-3-general', languages: ['ru'], streaming: true },
          ],
        }), { status: 200 });
      }
      return new Response('', { status: 500 });
    });

    const models = await fetchDeepgramCatalog('dg-ok', undefined, fetcher, true);
    expect(models.map(m => m.id)).toEqual(['nova-3', 'nova-2', 'base']);
    expect(models[0].description).toContain('en, ru');
  });

  it('transcribes via REST fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        results: {
          channels: [{
            alternatives: [{
              transcript: 'Привет',
              words: [{ punctuated_word: 'Привет', start: 0.05, end: 0.35 }],
            }],
          }],
        },
      }), { status: 200 }),
    );
    const result = await transcribeWithDeepgram(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), {
      apiKey: 'dg-key',
    }, undefined, fetcher);
    expect(result.text).toBe('Привет');
    expect(result.segments).toEqual([{ start: 0.05, end: 0.35, text: 'Привет' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('https://api.deepgram.com/v1/listen?');
  });
});

describe('deepgram live WebSocket transcriber', () => {
  it('streams PCM chunks, tracks interim and final words, finalizes tail, and shifts pause offsets', async () => {
    const sockets: MockWebSocket[] = [];
    let state: 'recording' | 'editing' | 'transcribing' = 'recording';
    const previews: string[] = [];
    const errors: unknown[] = [];

    const frames1 = [1000, -1000, 500, -500];
    const frames2 = [200, 300, 400, 500];
    let currentFrames = frames1.slice();
    let paused = false;

    const engine = createDeepgramLiveTranscriber({
      getState: () => state,
      getDeepgramSettings: () => normalizeDeepgramSettings({ apiKey: 'dg-live-key', language: 'ru' }),
      isLiveEnabled: () => true,
      readPcm: async fromFrame => {
        const slice = currentFrames.slice(fromFrame);
        const buf = new ArrayBuffer(slice.length * 2);
        const view = new DataView(buf);
        slice.forEach((v, i) => view.setInt16(i * 2, v, true));
        return { sampleRate: 16_000, totalFrames: currentFrames.length, paused, pcm: buf };
      },
      onPreview: text => previews.push(text),
      onError: err => errors.push(err),
      createWebSocket: (url, protocols) => {
        const ws = new MockWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });

    engine.start(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].protocols).toEqual(['token', 'dg-live-key']);
    expect(sockets[0].url).toContain('wss://api.deepgram.com/v1/listen?');

    sockets[0].emitOpen();
    expect(sockets[0].sent.some(item => item instanceof ArrayBuffer && item.byteLength === frames1.length * 2)).toBe(true);

    // Interim result appears in previewSegments without committing.
    sockets[0].emitMessage({
      type: 'Results',
      is_final: false,
      start: 0,
      duration: 0.00025,
      channel: { alternatives: [{ transcript: 'при', words: [{ word: 'при', start: 0, end: 0.0002 }] }] },
    });
    expect(engine.segments).toEqual([]);
    expect(engine.previewSegments).toHaveLength(1);
    expect(previews.at(-1)).toBe('при');

    // Final result commits segments; also verify clamping against final WAV duration.
    sockets[0].emitMessage({
      type: 'Results',
      is_final: true,
      start: 0,
      duration: 0.00025,
      channel: {
        alternatives: [{
          transcript: 'Привет',
          words: [{ punctuated_word: 'Привет', start: 0.00001, end: 0.99 }],
        }],
      },
    });

    paused = true;
    state = 'editing';
    const wav1 = makeWavBuffer([...frames1, ...frames2], 16_000); // 8 frames = 0.0005s
    const finalizePromise = engine.finalize!(wav1);
    await new Promise(resolve => setTimeout(resolve, 20));

    // Tail frames + Finalize + CloseStream must be sent.
    expect(sockets[0].sent.some(item => item === JSON.stringify({ type: 'Finalize' }))).toBe(true);
    expect(sockets[0].sent.some(item => item === JSON.stringify({ type: 'CloseStream' }))).toBe(true);
    const totalPcmSent = sockets[0].sent
      .filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
      .reduce((sum, buf) => sum + buf.byteLength, 0);
    expect(totalPcmSent).toBe((frames1.length + frames2.length) * 2);

    sockets[0].close();
    await finalizePromise;

    expect(errors).toEqual([]);
    expect(engine.finalized).toBe(true);
    expect(engine.committedThroughSeconds).toBeCloseTo(8 / 16_000, 6);
    expect(engine.segments[0].end).toBeCloseTo(8 / 16_000, 6);

    // Pause -> Resume shifts streamBaseSeconds by fragmentOffset.
    const fragmentOffset = 8 / 16_000;
    engine.resumeAfterPause(fragmentOffset, 0.5);
    currentFrames = [...frames1, ...frames2, 700, 800];
    paused = false;
    state = 'recording';
    engine.start(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(2);
    sockets[1].emitOpen();
    const resumedPcmBytes = sockets[1].sent
      .filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
      .reduce((sum, buf) => sum + buf.byteLength, 0);
    expect(resumedPcmBytes).toBe(4); // only the 2 new frames after pause

    sockets[1].emitMessage({
      type: 'Results',
      is_final: true,
      start: 0,
      duration: 0.0001,
      channel: {
        alternatives: [{
          transcript: 'мир',
          words: [{ punctuated_word: 'мир', start: 0, end: 0.0001 }],
        }],
      },
    });
    expect(engine.segments).toHaveLength(2);
    expect(engine.segments[1].start).toBeCloseTo(fragmentOffset, 6);
    engine.stop();
  });

  it('cancels cleanly via AbortSignal during finalize', async () => {
    const sockets: MockWebSocket[] = [];
    const engine = createDeepgramLiveTranscriber({
      getState: () => 'recording',
      getDeepgramSettings: () => normalizeDeepgramSettings({ apiKey: 'dg-key' }),
      isLiveEnabled: () => true,
      readPcm: async () => ({ sampleRate: 16_000, totalFrames: 2, paused: false, pcm: new ArrayBuffer(4) }),
      onPreview: () => {},
      onError: () => {},
      createWebSocket: (url, protocols) => {
        const ws = new MockWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });

    engine.start(true);
    await new Promise(resolve => setTimeout(resolve, 15));
    const controller = new AbortController();
    controller.abort();
    await expect(engine.finalize!(makeWavBuffer([1, 2], 16_000), controller.signal)).rejects.toThrow();
    engine.stop();
  });
});

describe('deepgram integration with fragments, readiness, and duplicates', () => {
  it('commits cleanly finalized silent live recording without creating a pending REST tail', () => {
    const fakeBuffer = {
      duration: 2.0,
      sampleRate: 16_000,
      length: 32_000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(32_000),
    } as unknown as AudioBuffer;
    const fragments: RecordingFragment[] = [];
    const nextOffset = appendRecordingFragments(
      fakeBuffer,
      fragments,
      0,
      { segments: [], throughSeconds: 2.0, finalized: true },
      () => new Blob(),
    );
    expect(nextOffset).toBe(2.0);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].transcript).toEqual({ text: '', segments: [] });
  });

  it('validates readiness and finds duplicates for deepgram step settings', () => {
    const scenario = createDefaultScenario();
    const step = scenario.steps.find(s => s.type === 'transcribe')!;
    step.transcription!.provider = 'deepgram';
    step.transcription!.deepgram = normalizeDeepgramSettings({ apiKey: '' });

    expect(getScenarioReadinessError({
      provider: 'deepgram',
      groqApiKey: '',
      postProcessProvider: 'none',
      geminiApiKey: '',
      scenarios: [scenario],
      activeScenarioId: scenario.id,
      deepgram: step.transcription!.deepgram,
    })).toBe('Deepgram: укажите API-ключ.');

    step.transcription!.deepgram = normalizeDeepgramSettings({ apiKey: 'dg-ok' });
    expect(getScenarioReadinessError({
      provider: 'deepgram',
      groqApiKey: '',
      postProcessProvider: 'none',
      geminiApiKey: '',
      scenarios: [scenario],
      activeScenarioId: scenario.id,
      deepgram: step.transcription!.deepgram,
    })).toBeNull();

    const duplicateBranchStep = structuredClone(step);
    duplicateBranchStep.id = 'branch-transcribe';
    duplicateBranchStep.transcription!.deepgram = normalizeDeepgramSettings({ apiKey: 'different-key-same-config' });
    step.parallelBranches = [[duplicateBranchStep]];
    const duplicates = findScenarioDuplicates(scenario);
    expect(duplicates.has(step.id)).toBe(true);
    expect(duplicates.has(duplicateBranchStep.id)).toBe(true);
  });
});
