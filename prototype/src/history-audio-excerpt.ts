import { decodeAudio } from './audio-decoding';
import { cutAudio } from './recording-editor';

export interface HistoryAudioExcerpt {
  label: string;
  filenameSuffix: string;
  parts: { audio: Blob; start: number; end: number }[];
}

/** Decode only on demand, once per source, and export just the selected retained audio. */
export async function extractHistoryAudio(excerpt: HistoryAudioExcerpt, signal?: AbortSignal,
  decode: (blob: Blob) => Promise<AudioBuffer> = async blob => decodeAudio(await blob.arrayBuffer())): Promise<Blob> {
  signal?.throwIfAborted();
  const sources = new Map<Blob, AudioBuffer>();
  for (const part of excerpt.parts) {
    if (!sources.has(part.audio)) sources.set(part.audio, await decode(part.audio));
    signal?.throwIfAborted();
  }
  const sampleRate = sources.values().next().value?.sampleRate;
  if (!sampleRate) throw new Error('Аудио выбранного отрывка недоступно.');
  const parts = excerpt.parts.flatMap(part => {
    const buffer = sources.get(part.audio)!;
    if (!Number.isFinite(part.start) || !Number.isFinite(part.end)) return [];
    const start = Math.max(0, Math.min(buffer.length, Math.round(part.start * buffer.sampleRate)));
    const end = Math.max(start, Math.min(buffer.length, Math.round(part.end * buffer.sampleRate)));
    const length = Math.round((end - start) * sampleRate / buffer.sampleRate);
    return length ? [{ buffer, start, end, length }] : [];
  });
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (!length) throw new Error('В выбранном отрывке нет аудио.');
  const samples = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    signal?.throwIfAborted();
    const channels = Array.from({ length: part.buffer.numberOfChannels }, (_, index) => part.buffer.getChannelData(index));
    const ratio = part.buffer.sampleRate / sampleRate;
    for (let index = 0; index < part.length; index++) {
      const position = part.start + index * ratio;
      const left = Math.min(part.end - 1, Math.floor(position));
      const right = Math.min(part.end - 1, left + 1);
      const fraction = position - Math.floor(position);
      let sample = 0;
      for (const channel of channels) sample += channel[left] + (channel[right] - channel[left]) * fraction;
      samples[offset++] = sample / channels.length;
    }
  }
  return cutAudio({ sampleRate, length, numberOfChannels: 1, duration: length / sampleRate,
    getChannelData: () => samples } as unknown as AudioBuffer, [{ start: 0, end: length / sampleRate }]);
}
