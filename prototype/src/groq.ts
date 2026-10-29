import { DEFAULT_GROQ_API_KEY, DEFAULT_GROQ_MODEL } from './defaults';

// Модуль транскрибации аудио через Groq Whisper API (v1/audio/transcriptions)
// Документация API: принимает file, model, prompt, response_format, temperature, language

export { DEFAULT_GROQ_API_KEY } from './defaults';

export interface GroqTranscriptionOptions {
  apiKey?: string;
  model?: string;
  prompt?: string;
  temperature?: number;
  language?: string;
  responseFormat?: 'verbose_json' | 'json' | 'text';
}

export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string }
export interface TimedTranscript { text: string; segments: TranscriptSegment[]; fallbackSegments?: TranscriptSegment[] }

interface GroqSegmentPayload {
  start?: unknown;
  end?: unknown;
  word?: unknown;
  text?: unknown;
}

interface GroqResponsePayload {
  text?: unknown;
  words?: unknown;
  segments?: unknown;
}

let requestSequence = 0;

export async function transcribeAudioWithGroq(
  audioBlob: Blob,
  options: GroqTranscriptionOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return (await requestTranscription(audioBlob, options, undefined, false, fetcher)).text;
}

export async function transcribeTimedAudioWithGroq(
  audioBlob: Blob,
  options: GroqTranscriptionOptions = {},
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TimedTranscript> {
  return requestTranscription(audioBlob, { ...options, responseFormat: 'verbose_json' }, signal, true, fetcher);
}

async function requestTranscription(
  audioBlob: Blob,
  options: GroqTranscriptionOptions = {},
  signal?: AbortSignal,
  timed = false,
  fetcher: typeof fetch = fetch,
): Promise<TimedTranscript> {
  const requestId = ++requestSequence;
  const startedAt = performance.now();
  let headersAt: number | undefined;
  let bodyAt: number | undefined;
  let status: number | undefined;
  let outcome = 'error';
  let lastTick = startedAt;
  let maxEventLoopDelayMs = 0;
  const eventLoopProbe = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - lastTick - 100);
    lastTick = now;
  }, 100);
  try {
    const apiKey = (options.apiKey || DEFAULT_GROQ_API_KEY).trim();
    const model = options.model || DEFAULT_GROQ_MODEL;
    const language = options.language || 'auto';
    const responseFormat = options.responseFormat || 'verbose_json';
    const temperature = options.temperature ?? 0.0;
    const prompt = options.prompt || '';

    const formData = new FormData();
    const isWav = audioBlob.type.includes('wav');
    const extension = isWav ? 'wav' : 'webm';
    const file = new File([audioBlob], `audio.${extension}`, {
      type: audioBlob.type || (isWav ? 'audio/wav' : 'audio/webm'),
    });

    formData.append('file', file);
    formData.append('model', model);
    formData.append('response_format', responseFormat);
    if (timed) {
      formData.append('timestamp_granularities[]', 'word');
      formData.append('timestamp_granularities[]', 'segment');
    }
    if (language && language !== 'auto') {
      formData.append('language', language);
    }
    if (prompt.trim()) {
      formData.append('prompt', prompt.trim());
    }
    if (temperature > 0) {
      formData.append('temperature', temperature.toString());
    }

    console.info('[groq-timing] start', { requestId, bytes: audioBlob.size, model, language, timed });
    const response = await fetcher('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });
    headersAt = performance.now();
    status = response.status;
    console.info('[groq-timing] headers', { requestId, status, elapsedMs: Math.round(headersAt - startedAt) });

    if (!response.ok) {
      const errText = await response.text();
      bodyAt = performance.now();
      throw new Error(`Groq API (${response.status}): ${errText}`);
    }

    if (responseFormat === 'text') {
      const rawText = await response.text();
      bodyAt = performance.now();
      outcome = 'success';
      return { text: rawText.trim(), segments: [] };
    }

    const payload: unknown = await response.json();
    bodyAt = performance.now();
    if (!isRecord(payload)) throw new Error('Groq вернул ответ неверного формата.');
    const result = payload as GroqResponsePayload;
    const words = Array.isArray(result.words) ? result.words : [];
    const timedSegments = Array.isArray(result.segments) ? result.segments : [];
    const parseSegments = (source: unknown[]): TranscriptSegment[] => source.flatMap((value): TranscriptSegment[] => {
      if (!isGroqSegment(value)) return [];
      const start = Number(value.start);
      const end = Number(value.end);
      const text = String(value.word ?? value.text ?? '').trim();
      return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && text
        ? [{ start, end, text }]
        : [];
    });
    const wordSegments = parseSegments(words);
    const phraseSegments = parseSegments(timedSegments);
    const segments = wordSegments.length ? wordSegments : phraseSegments;
    segments.sort((a, b) => a.start - b.start);
    outcome = 'success';
    return { text: typeof result.text === 'string' ? result.text.trim() : '', segments,
      ...(wordSegments.length && phraseSegments.length ? { fallbackSegments: phraseSegments } : {}),
    };
  } finally {
    clearInterval(eventLoopProbe);
    const finishedAt = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, finishedAt - lastTick - 100);
    // Cross-origin network phases are available only if the server permits
    // Resource Timing. Missing phases must not be interpreted as zero latency.
    const resource = performance.getEntriesByName?.('https://api.groq.com/openai/v1/audio/transcriptions')
      .findLast(entry => entry.entryType === 'resource' && entry.startTime >= startedAt) as PerformanceResourceTiming | undefined;
    console.info('[groq-timing] complete', {
      requestId, outcome: signal?.aborted ? 'aborted' : outcome, status,
      headersMs: headersAt === undefined ? undefined : Math.round(headersAt - startedAt),
      bodyMs: headersAt === undefined || bodyAt === undefined ? undefined : Math.round(bodyAt - headersAt),
      parseMs: bodyAt === undefined ? undefined : Math.round(finishedAt - bodyAt),
      totalMs: Math.round(finishedAt - startedAt), maxEventLoopDelayMs: Math.round(Math.max(0, maxEventLoopDelayMs)),
      network: resource?.requestStart ? {
        dnsMs: Math.round(resource.domainLookupEnd - resource.domainLookupStart),
        connectionMs: Math.round(resource.connectEnd - resource.connectStart),
        tlsMs: resource.secureConnectionStart > 0 ? Math.round(resource.connectEnd - resource.secureConnectionStart) : undefined,
        requestToFirstByteMs: Math.round(resource.responseStart - resource.requestStart),
        downloadMs: Math.round(resource.responseEnd - resource.responseStart),
      } : 'unavailable',
    });
  }
}

function isGroqSegment(value: unknown): value is GroqSegmentPayload {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
