import { observeRecordingResource } from './parallel-runs/runtime';
import { playAudioElement } from './system-speech';
import { addSpeechMark, clearActiveSpeech, finishSpeechLoading, resetSpeechMarks, setActiveSpeech, type SpeechMark } from './speech-playback-control';

// Plays speech while it streams in: MP3 (Edge, ElevenLabs) through MediaSource,
// raw 16-bit PCM (Gemini) through Web Audio. Pauses while a recording runs.

/** Failure of streamed speech; `started` — some audio was already played. */
export class StreamingSpeechError extends Error {
  readonly started: boolean;
  constructor(message: string, started: boolean) { super(message); this.started = started; }
}

export const canStreamMp3 = () => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');

interface Player { push(chunk: Uint8Array): void; end(): Promise<void>; stop(): void }

function mp3Player(volume: number, signal?: AbortSignal): Player {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const stop = new AbortController();
  const playbackSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let playback: Promise<void> | undefined;
  let buffer: SourceBuffer | undefined;
  let pending: Uint8Array[] = [];
  let ended = false;
  // Appends queued chunks one at a time; closes the stream after the last one.
  const pump = () => {
    if (!buffer || buffer.updating || source.readyState !== 'open') return;
    if (pending.length) {
      const joined = new Uint8Array(pending.reduce((size, chunk) => size + chunk.length, 0));
      pending.reduce((offset, chunk) => { joined.set(chunk, offset); return offset + chunk.length; }, 0);
      pending = [];
      buffer.appendBuffer(joined);
    } else if (ended) source.endOfStream();
  };
  source.addEventListener('sourceopen', () => {
    buffer = source.addSourceBuffer('audio/mpeg');
    buffer.addEventListener('updateend', pump);
    pump();
  }, { once: true });
  const audio = new Audio(url);
  const cleanup = () => {
    audio.pause();
    URL.revokeObjectURL(url);
  };
  return {
    push(chunk) {
      pending.push(chunk);
      if (!playback) {
        // The overlay controls this element: pause, ±5 s, speed.
        setActiveSpeech(audio, cleanup);
        playback = playAudioElement(audio, playbackSignal, volume);
      }
      pump();
    },
    async end() {
      ended = true; pump();
      await playback;
    },
    stop() { stop.abort(); void playback?.catch(() => {}); clearActiveSpeech(audio); cleanup(); },
  };
}

function pcmPlayer(rate: number, volume: number, signal?: AbortSignal): Player {
  const context = new AudioContext({ sampleRate: rate });
  const gain = context.createGain();
  gain.gain.value = volume;
  gain.connect(context.destination);
  let next = 0, active = 0, ended = false, carry: number | undefined;
  let finish = () => {}, fail = (_error: unknown) => {};
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  void finished.catch(() => {});
  const stopObserving = observeRecordingResource(recording => { void (recording ? context.suspend() : context.resume()).catch(() => {}); });
  const close = () => { stopObserving(); signal?.removeEventListener('abort', abort); void context.close().catch(() => {}); };
  const abort = () => { close(); fail(new DOMException('Озвучка отменена', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
  const settle = () => { if (ended && !active) { close(); finish(); } };
  return {
    push(chunk) {
      let bytes = chunk;
      // A chunk may split a 16-bit sample; its odd byte opens the next chunk.
      if (carry !== undefined) { bytes = new Uint8Array(chunk.length + 1); bytes[0] = carry; bytes.set(chunk, 1); carry = undefined; }
      if (bytes.length % 2) { carry = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
      const samples = bytes.length / 2;
      if (!samples || context.state === 'closed') return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const audio = context.createBuffer(1, samples, rate), data = audio.getChannelData(0);
      for (let index = 0; index < samples; index++) data[index] = view.getInt16(index * 2, true) / 32768;
      const node = context.createBufferSource();
      node.buffer = audio; node.connect(gain);
      node.onended = () => { active--; settle(); };
      // A short lead absorbs the network jitter between chunks.
      next = Math.max(next, context.currentTime + .1);
      node.start(next);
      next += audio.duration; active++;
    },
    end() { ended = true; settle(); return finished; },
    stop() { close(); finish(); },
  };
}

export interface StreamSink { mp3(chunk: Uint8Array): void; pcm(chunk: Uint8Array, rate: number): void; mark(mark: SpeechMark): void }

/** Runs `produce`, playing each chunk it hands over; returns its whole audio once played.
 * `onAudio` gets the whole audio as soon as it is synthesized, before the playback ends. */
export async function streamAndPlay(volume: number, signal: AbortSignal | undefined,
  produce: (sink: StreamSink) => Promise<Blob>, onAudio?: (audio: Blob) => void): Promise<Blob> {
  let player: Player | undefined;
  resetSpeechMarks();
  // What has been received, kept even if the speech is cut off: the history can play that part.
  const received: Uint8Array[] = [];
  const sink: StreamSink = {
    mark: addSpeechMark,
    mp3: chunk => { received.push(chunk); (player ??= mp3Player(volume, signal)).push(chunk); },
    pcm: (chunk, rate) => { (player ??= pcmPlayer(rate, volume, signal)).push(chunk); },
  };
  try {
    const audio = await produce(sink);
    finishSpeechLoading();
    onAudio?.(audio);
    await player?.end();
    return audio;
  } catch (error) {
    player?.stop();
    if (received.length) onAudio?.(new Blob(received as BlobPart[], { type: 'audio/mpeg' }));
    resetSpeechMarks();
    finishSpeechLoading();
    if (signal?.aborted || error instanceof StreamingSpeechError) throw error;
    throw new StreamingSpeechError(error instanceof Error ? error.message : String(error), !!player);
  }
}
