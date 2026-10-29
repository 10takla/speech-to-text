import { decodeAudio } from '../audio-decoding';
import { cutAudio } from '../recording-editor';
import type { TimedTranscript, TranscriptSegment } from '../groq';
import { googleCloudToken } from './auth';
import { base64 } from '../binary-base64';
import { fetchGoogleCloudCatalog, googleCloudCatalogError } from './catalog';
import { GOOGLE_CLOUD_FEATURES, googleCloudConfigurationError, normalizeGoogleCloudSettings, type GoogleCloudSettings } from './settings';

export async function transcribeWithGoogleCloud(audio: Blob, options?: Partial<GoogleCloudSettings>, signal?: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<TimedTranscript> {
  const settings = normalizeGoogleCloudSettings(options);
  const error = googleCloudConfigurationError(settings);
  if (error) throw new Error(error);
  const catalog = await fetchGoogleCloudCatalog(settings, signal, fetcher);
  const incompatible = googleCloudCatalogError(settings, catalog);
  if (incompatible) throw new Error(incompatible);
  const buffer = await decodeAudio(await audio.arrayBuffer());
  signal?.throwIfAborted();
  const host = settings.location === 'global' ? 'speech.googleapis.com' : `${settings.location}-speech.googleapis.com`;
  const url = `https://${host}/v2/projects/${encodeURIComponent(settings.projectId)}/locations/${settings.location}/recognizers/_:recognize`;
  // Recognize: <=60 s and <=10 MB. Mono PCM16 keeps each 55 s chunk below 10 MB.
  // https://docs.cloud.google.com/speech-to-text/docs/quotas
  const chunkSeconds = Math.min(55, Math.floor(9_000_000 / (buffer.sampleRate * 2)));
  if (chunkSeconds < 1) throw new Error('Неподдерживаемая частота аудио Google Cloud.');
  const texts: string[] = [], segments: TranscriptSegment[] = [];
  // Original Chirp has no word timestamps; Chirp 2/3 and conventional models do.
  // https://docs.cloud.google.com/speech-to-text/docs/models/chirp
  const features: Record<string, boolean> = settings.model === 'chirp' ? {} : { enableWordTimeOffsets: true };
  for (const [id, field] of GOOGLE_CLOUD_FEATURES) if (settings.features[id] !== undefined) features[field] = settings.features[id];
  for (let start = 0; start < buffer.duration; start += chunkSeconds) {
    signal?.throwIfAborted();
    const end = Math.min(buffer.duration, start + chunkSeconds);
    const chunk = cutAudio(buffer, [{ start, end }]);
    const token = await googleCloudToken(settings.credentials, signal, fetcher);
    const response = await fetcher(url, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { autoDecodingConfig: {}, model: settings.model, languageCodes: [settings.language], features },
        content: base64(new Uint8Array(await chunk.arrayBuffer())) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Google Cloud Speech-to-Text (${response.status}): ${body.error?.message || 'Ошибка распознавания.'}`);
    const parsed = parseGoogleCloudTranscript(body, start);
    texts.push(parsed.text); segments.push(...parsed.segments);
  }
  return { text: texts.filter(Boolean).join(' '), segments };
}

interface RecognitionPayload { results?: { alternatives?: { transcript?: string; words?: { word?: string; startOffset?: string; endOffset?: string }[] }[] }[] }
export function parseGoogleCloudTranscript(body: RecognitionPayload, offset = 0): TimedTranscript {
  const texts: string[] = [], segments: TranscriptSegment[] = [];
  const seconds = (value = '0s') => /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : NaN;
  for (const result of body.results ?? []) {
    const best = result.alternatives?.[0];
    if (best?.transcript?.trim()) texts.push(best.transcript.trim());
    for (const word of best?.words ?? []) {
      const start = seconds(word.startOffset), end = seconds(word.endOffset), text = word.word?.trim();
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) segments.push({ start: offset + start, end: offset + end, text });
    }
  }
  return { text: texts.join(' '), segments: segments.sort((a, b) => a.start - b.start) };
}
