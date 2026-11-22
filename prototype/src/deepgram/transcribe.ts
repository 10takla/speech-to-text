import type { TimedTranscript, TranscriptSegment } from '../groq';
import { deepgramRequest, readDeepgramError } from './http';
import { deepgramConfigurationError, deepgramListenQuery, normalizeDeepgramSettings, type DeepgramSettings } from './settings';

export interface WavPcmInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  totalFrames: number;
}

export function parseWavPcm(buffer: ArrayBuffer): WavPcmInfo | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  const tag = (offset: number) => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === 'fmt ' && bodyStart + 16 <= buffer.byteLength) {
      audioFormat = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
    } else if (id === 'data') {
      dataOffset = bodyStart;
      dataLength = Math.min(size, Math.max(0, buffer.byteLength - bodyStart));
      break;
    }
    const paddedSize = size + (size % 2);
    const next = bodyStart + paddedSize;
    if (next <= offset) break;
    offset = next;
  }

  if (audioFormat !== 1 || !sampleRate || !channels || bitsPerSample !== 16 || !dataOffset) {
    return null;
  }
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const totalFrames = bytesPerFrame > 0 ? Math.floor(dataLength / bytesPerFrame) : 0;
  return { sampleRate, channels, bitsPerSample, dataOffset, dataLength, totalFrames };
}

export function parseDeepgramAlternative(
  alt: unknown,
  offsetSeconds = 0,
  fallbackStart = 0,
  fallbackDuration = 0,
): TimedTranscript {
  if (!isRecord(alt)) return { text: '', segments: [] };
  const text = typeof alt.transcript === 'string' ? alt.transcript.trim() : '';
  const rawWords = Array.isArray(alt.words) ? alt.words : [];
  const segments: TranscriptSegment[] = [];

  for (const item of rawWords) {
    if (!isRecord(item)) continue;
    const wordText = String(item.punctuated_word ?? item.word ?? '').trim();
    const rawStart = Number(item.start);
    const rawEnd = Number(item.end);
    if (!wordText || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < 0 || rawEnd < rawStart) {
      continue;
    }
    const start = offsetSeconds + rawStart;
    const end = offsetSeconds + Math.max(rawEnd, rawStart + 0.001);
    const speaker = typeof item.speaker === 'number' || typeof item.speaker === 'string'
      ? String(item.speaker)
      : undefined;
    segments.push({ start, end, text: wordText, ...(speaker !== undefined ? { speaker } : {}) });
  }

  segments.sort((a, b) => a.start - b.start);
  if (!segments.length && text && fallbackDuration > 0) {
    segments.push({
      start: offsetSeconds + Math.max(0, fallbackStart),
      end: offsetSeconds + Math.max(0, fallbackStart) + fallbackDuration,
      text,
    });
  }
  return { text, segments };
}

export function parseDeepgramRestResponse(body: unknown, offsetSeconds = 0): TimedTranscript {
  if (!isRecord(body)) throw new Error('Deepgram вернул ответ неверного формата.');
  const results = isRecord(body.results) ? body.results : undefined;
  const channels = results && Array.isArray(results.channels) ? results.channels : [];
  const firstChannel = isRecord(channels[0]) ? channels[0] : undefined;
  const alternatives = firstChannel && Array.isArray(firstChannel.alternatives) ? firstChannel.alternatives : [];
  return parseDeepgramAlternative(alternatives[0], offsetSeconds);
}

export async function transcribeWithDeepgram(
  audio: Blob,
  options?: Partial<DeepgramSettings>,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
): Promise<TimedTranscript> {
  signal?.throwIfAborted();
  const settings = normalizeDeepgramSettings(options);
  const error = deepgramConfigurationError(settings);
  if (error) throw new Error(error);

  const bytes = new Uint8Array(await audio.arrayBuffer());
  signal?.throwIfAborted();
  const query = deepgramListenQuery(settings);
  const response = await deepgramRequest(
    `/v1/listen?${query}`,
    {
      method: 'POST',
      apiKey: settings.apiKey,
      contentType: audio.type || 'audio/wav',
      body: bytes,
      signal,
    },
    fetcher,
  );
  if (!response.ok) {
    throw new Error(`Deepgram API (${response.status}): ${readDeepgramError(response.body, response.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error('Deepgram вернул ответ неверного формата.');
  }
  return parseDeepgramRestResponse(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
