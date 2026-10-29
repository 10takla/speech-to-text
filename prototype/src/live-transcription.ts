import type { AppSettings, OverlayState } from './config';
import type { TranscriptionProvider } from './ports';
import type { TimeRange } from './recording-editor';
import { decodeAudio } from './audio-decoding';
import { fitTranscriptToAudio } from './transcript-timing';
import type { TranscriptSegment } from './groq';

const MIN_CHUNK_SECONDS = 1.2;
const SPEECH_RMS_THRESHOLD = 0.008;

type LiveSettings = Pick<AppSettings,
  'liveTranscriptionEnabled' | 'liveSilenceDurationMs' | 'liveMaxChunkDurationSeconds' | 'liveChunkOverlapSeconds'>;

interface LiveTranscriptionDependencies {
  getState(): OverlayState;
  getSettings(): LiveSettings;
  snapshotAudio(): Promise<ArrayBuffer>;
  provider: TranscriptionProvider;
  cutAudio(buffer: AudioBuffer, ranges: TimeRange[]): Blob;
  onPreview(text: string): void;
  onError(error: unknown): void;
  onProcessing?(status: 'running' | 'success' | 'error' | 'idle'): void;
}

export interface LiveTranscriber {
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
  readonly committedThroughSeconds: number;
  readonly elapsedSeconds: number;
  start(reset?: boolean): void;
  stop(): void;
  suspend(): void;
  observeSpeechLevel(rms: number): void;
  replaceFinalizedTranscript(segments: TranscriptSegment[]): void;
  resumeAfterPause(fragmentOffset: number, overlapSeconds: number): void;
}

export function createLiveTranscriber(dependencies: LiveTranscriptionDependencies): LiveTranscriber {
  let timer: number | null = null;
  let generation = 0;
  let requestPending = false;
  let abortController: AbortController | null = null;
  let elapsedSeconds = 0;
  let lastTickAt = 0;
  let chunkStartSeconds = 0;
  let chunkStartElapsed = 0;
  let committedThroughSeconds = 0;
  let lastSpeechAt = 0;
  let lastSpeechElapsed = 0;
  let lastQuietElapsed: number | null = null;
  let hasSpeech = false;
  let transcriptText = '';
  let transcriptSegments: TranscriptSegment[] = [];
  let retryAfter = 0;
  let processing = false;

  function settings() {
    const current = dependencies.getSettings();
    return {
      silenceMs: Math.max(300, Math.min(2000, Number(current.liveSilenceDurationMs) || 700)),
      maxSeconds: Math.max(3, Math.min(20, Number(current.liveMaxChunkDurationSeconds) || 9)),
      overlapSeconds: Math.max(0, Math.min(2, Number(current.liveChunkOverlapSeconds) || 0)),
    };
  }

  function appendText(base: string, addition: string): string {
    const next = addition.trim();
    if (!next) return base;
    if (!base.trim()) return next;
    const normalized = next.replace(/^\s+/, '');
    return `${base.trim()}${/^[,.;:!?…]/.test(normalized) ? '' : ' '}${normalized}`
      .replace(/\s+([,.;:!?…])/g, '$1');
  }

  function removeOverlap(previous: string, current: string): string {
    const oldWords = previous.trim().split(/\s+/).filter(Boolean);
    const newWords = current.trim().split(/\s+/).filter(Boolean);
    const normalize = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    for (let count = Math.min(10, oldWords.length, newWords.length); count > 0; count--) {
      const oldTail = oldWords.slice(-count).map(normalize);
      const newHead = newWords.slice(0, count).map(normalize);
      if (oldTail.every((word, index) => word && word === newHead[index])) {
        return newWords.slice(count).join(' ');
      }
    }
    return current;
  }

  function stop() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    generation++;
    if (processing) dependencies.onProcessing?.('idle');
    processing = false;
    abortController?.abort();
    abortController = null;
    requestPending = false;
  }

  function suspend() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  async function transcribeChunk(activeGeneration: number, endedBySilence: boolean) {
    if (requestPending || dependencies.getState() !== 'recording') return;
    requestPending = true;
    const controller = new AbortController();
    abortController = controller;
    const sessionElapsedAtRequest = elapsedSeconds;
    const quietAge = lastQuietElapsed === null ? Infinity : sessionElapsedAtRequest - lastQuietElapsed;

    try {
      const bytes = await dependencies.snapshotAudio();
      if (activeGeneration !== generation || dependencies.getState() !== 'recording') return;
      const buffer = await decodeAudio(bytes.slice(0));

      const proposedEnd = !endedBySilence && quietAge <= 1.5
        ? buffer.duration - quietAge
        : buffer.duration;
      const chunkEndSeconds = Math.min(buffer.duration, Math.max(chunkStartSeconds, proposedEnd));
      if (chunkEndSeconds - chunkStartSeconds < MIN_CHUNK_SECONDS) return;
      const audioBlob = dependencies.cutAudio(buffer, [{ start: chunkStartSeconds, end: chunkEndSeconds }]);
      const overlapSeconds = settings().overlapSeconds;
      const overlap = Math.max(0, chunkStartSeconds ? overlapSeconds : 0);
      processing = true;
      dependencies.onProcessing?.('running');
      const result = fitTranscriptToAudio(await dependencies.provider.transcribe(audioBlob, controller.signal), chunkEndSeconds - chunkStartSeconds);
      if (activeGeneration !== generation || dependencies.getState() !== 'recording') return;

      const freshSegments = result.segments.filter(segment =>
        segment.start + chunkStartSeconds >= committedThroughSeconds)
        .map(segment => ({ ...segment, start: segment.start + chunkStartSeconds, end: segment.end + chunkStartSeconds }));
      const addition = result.segments.length ? freshSegments.map(segment => segment.text).join(' ')
        : overlap > 0 ? removeOverlap(transcriptText, result.text) : result.text;
      transcriptSegments.push(...freshSegments);
      if (!result.segments.length && addition.trim()) transcriptSegments.push({
        start: Math.max(chunkStartSeconds, committedThroughSeconds), end: chunkEndSeconds, text: addition.trim(),
      });
      transcriptText = appendText(transcriptText, addition);
      if (transcriptText) dependencies.onPreview(transcriptText);

      chunkStartSeconds = Math.max(0, chunkEndSeconds - overlapSeconds);
      chunkStartElapsed = Math.max(0, sessionElapsedAtRequest - Math.max(0, buffer.duration - chunkEndSeconds) - overlapSeconds);
      committedThroughSeconds = Math.max(committedThroughSeconds, chunkEndSeconds);
      hasSpeech = lastSpeechElapsed > sessionElapsedAtRequest - Math.max(0, buffer.duration - chunkEndSeconds);
      retryAfter = 0;
      processing = false;
      dependencies.onProcessing?.('success');
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (activeGeneration === generation && !isAbort) {
        processing = false;
        dependencies.onProcessing?.('error');
        dependencies.onError(error);
        retryAfter = performance.now() + 3000;
      }
    } finally {
      if (activeGeneration === generation) {
        if (processing) dependencies.onProcessing?.('idle');
        processing = false;
        requestPending = false;
        if (abortController === controller) abortController = null;
      }
    }
  }

  function start(reset = false) {
    if (reset) {
      stop();
      elapsedSeconds = 0;
      chunkStartSeconds = 0;
      chunkStartElapsed = 0;
      committedThroughSeconds = 0;
      lastSpeechAt = performance.now();
      lastSpeechElapsed = 0;
      lastQuietElapsed = null;
      hasSpeech = false;
      transcriptText = '';
      transcriptSegments = [];
      retryAfter = 0;
    }
    if (!dependencies.getSettings().liveTranscriptionEnabled || dependencies.getState() !== 'recording' || timer !== null) return;
    const activeGeneration = generation;
    lastTickAt = performance.now();
    lastSpeechAt = lastTickAt;
    timer = window.setInterval(() => {
      if (dependencies.getState() !== 'recording') {
        suspend();
        return;
      }
      const now = performance.now();
      elapsedSeconds += Math.max(0, now - lastTickAt) / 1000;
      lastTickAt = now;
      if (requestPending || !hasSpeech || now < retryAfter) return;

      const chunkAge = elapsedSeconds - chunkStartElapsed;
      const { silenceMs, maxSeconds } = settings();
      const endedBySilence = chunkAge >= MIN_CHUNK_SECONDS && now - lastSpeechAt >= silenceMs;
      if (endedBySilence || chunkAge >= maxSeconds) void transcribeChunk(activeGeneration, endedBySilence);
    }, 250);
  }

  return {
    get text() { return transcriptText; },
    get segments() { return transcriptSegments; },
    get committedThroughSeconds() { return committedThroughSeconds; },
    get elapsedSeconds() { return elapsedSeconds; },
    start,
    stop,
    suspend,
    observeSpeechLevel(rms) {
      if (dependencies.getState() !== 'recording' || timer === null) return;
      if (rms >= SPEECH_RMS_THRESHOLD) {
        hasSpeech = true;
        lastSpeechAt = performance.now();
        lastSpeechElapsed = elapsedSeconds;
      } else {
        lastQuietElapsed = elapsedSeconds;
      }
    },
    replaceFinalizedTranscript(segments) {
      // Discard in-flight recognition from before editing; it must not overwrite the edited baseline.
      stop();
      transcriptSegments = segments.map(segment => ({ ...segment }));
      transcriptText = segments.reduce((text, segment) => appendText(text, segment.text), '');
      dependencies.onPreview(transcriptText);
    },
    resumeAfterPause(fragmentOffset, overlapSeconds) {
      const normalizedOverlap = Math.max(0, Math.min(2, Number(overlapSeconds) || 0));
      chunkStartSeconds = Math.max(0, fragmentOffset - normalizedOverlap);
      chunkStartElapsed = Math.max(0, elapsedSeconds - normalizedOverlap);
      committedThroughSeconds = Math.max(committedThroughSeconds, fragmentOffset);
      hasSpeech = false;
    },
  };
}
