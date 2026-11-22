import type { OverlayState } from '../config';
import type { TranscriptSegment } from '../groq';
import type { LiveTranscriber } from '../live-transcription';
import type { AudioCapturePort } from '../ports';
import { deepgramConfigurationError, deepgramListenQuery, type DeepgramSettings } from './settings';
import { parseDeepgramAlternative, parseWavPcm } from './transcribe';

const MAX_WS_CHUNK_BYTES = 32 * 1024;
const KEEP_ALIVE_MS = 4000;
const FINALIZE_TIMEOUT_MS = 4000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

interface DeepgramLiveDependencies {
  getState(): OverlayState;
  getDeepgramSettings(): DeepgramSettings;
  isLiveEnabled(): boolean;
  readPcm?: AudioCapturePort['readPcm'];
  snapshotAudio?: () => Promise<ArrayBuffer>;
  onPreview(text: string): void;
  onError(error: unknown): void;
  onProcessing?(status: 'running' | 'success' | 'error' | 'idle'): void;
  createWebSocket?(url: string, protocols: string[]): WebSocket;
}

function formatSegmentsText(segments: readonly TranscriptSegment[]): string {
  return segments.map(segment => segment.text).join(' ').replace(/\s+([,.;:!?…])/g, '$1').trim();
}

export function createDeepgramLiveTranscriber(dependencies: DeepgramLiveDependencies): LiveTranscriber {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  let polling = false;
  let finalizing = false;
  let ws: WebSocket | null = null;
  let wsHadError = false;
  let pendingChunks: ArrayBuffer[] = [];

  let committedSegments: TranscriptSegment[] = [];
  let interimSegments: TranscriptSegment[] = [];
  let committedThroughSeconds = 0;
  let finalizedCleanly = false;
  let streamBaseSeconds = 0;
  let sentFrames = 0;
  let lastFinalizedTotalFrames = 0;
  let sampleRate = 0;
  let lastAudioSentAt = 0;
  let processingStatus: 'running' | 'success' | 'error' | 'idle' = 'idle';

  function emitProcessing(status: 'running' | 'success' | 'error' | 'idle') {
    if (processingStatus === status) return;
    processingStatus = status;
    dependencies.onProcessing?.(status);
  }

  function fullPreviewText(): string {
    return formatSegmentsText([...committedSegments, ...interimSegments]);
  }

  function clearTimers() {
    if (pollTimer !== null) {
      globalThis.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (keepAliveTimer !== null) {
      globalThis.clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function closeSocketImmediate() {
    const socket = ws;
    ws = null;
    pendingChunks = [];
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
        socket.close();
      }
    } catch {
      // Ignore already-closed WebSocket errors.
    }
  }

  function sendBytesChunked(socket: WebSocket, bytes: ArrayBuffer) {
    if (socket.readyState !== WS_OPEN || !bytes.byteLength) return;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_WS_CHUNK_BYTES) {
      const slice = bytes.slice(offset, offset + MAX_WS_CHUNK_BYTES);
      socket.send(slice);
    }
    lastAudioSentAt = performance.now();
  }

  function enqueuePcmBytes(bytes: ArrayBuffer) {
    if (!bytes.byteLength) return;
    if (!ws) return;
    if (ws.readyState === WS_OPEN) {
      sendBytesChunked(ws, bytes);
    } else if (ws.readyState === WS_CONNECTING) {
      pendingChunks.push(bytes);
    }
  }

  function appendCommittedSegments(incoming: readonly TranscriptSegment[]) {
    if (!incoming.length) return;
    for (const seg of incoming) {
      const duplicate = committedSegments.some(existing =>
        Math.abs(existing.start - seg.start) < 0.002
        && Math.abs(existing.end - seg.end) < 0.002
        && existing.text === seg.text,
      );
      if (!duplicate) committedSegments.push({ ...seg });
    }
    committedSegments.sort((a, b) => a.start - b.start);
  }

  function handleMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const msg = payload as Record<string, unknown>;
    if (msg.type === 'Error') {
      wsHadError = true;
      const errText = typeof msg.description === 'string' && msg.description.trim()
        ? msg.description.trim()
        : typeof msg.message === 'string' && msg.message.trim()
          ? msg.message.trim()
          : 'Ошибка потока Deepgram.';
      emitProcessing('error');
      dependencies.onError(new Error(errText));
      return;
    }
    if (msg.type !== 'Results') return;

    const channel = msg.channel && typeof msg.channel === 'object' && !Array.isArray(msg.channel)
      ? msg.channel as Record<string, unknown>
      : undefined;
    const alternatives = channel && Array.isArray(channel.alternatives) ? channel.alternatives : [];
    const start = typeof msg.start === 'number' && Number.isFinite(msg.start) ? msg.start : 0;
    const duration = typeof msg.duration === 'number' && Number.isFinite(msg.duration) ? msg.duration : 0;
    const parsed = parseDeepgramAlternative(alternatives[0], streamBaseSeconds, start, duration);
    const isFinal = msg.is_final === true;

    if (isFinal) {
      interimSegments = [];
      appendCommittedSegments(parsed.segments);
      if (duration > 0) {
        committedThroughSeconds = Math.max(committedThroughSeconds, streamBaseSeconds + start + duration);
      }
      emitProcessing('success');
      dependencies.onPreview(fullPreviewText());
    } else {
      interimSegments = parsed.text ? parsed.segments : [];
      emitProcessing(interimSegments.length ? 'running' : 'idle');
      dependencies.onPreview(fullPreviewText());
    }
  }

  function openSocket(rate: number, activeGeneration: number): WebSocket | null {
    const settings = dependencies.getDeepgramSettings();
    const error = deepgramConfigurationError(settings);
    if (error) {
      wsHadError = true;
      dependencies.onError(new Error(error));
      return null;
    }
    const query = deepgramListenQuery(settings, { sampleRate: rate, channels: 1, encoding: 'linear16' });
    const url = `wss://api.deepgram.com/v1/listen?${query}`;
    const socket = dependencies.createWebSocket
      ? dependencies.createWebSocket(url, ['token', settings.apiKey.trim()])
      : new WebSocket(url, ['token', settings.apiKey.trim()]);
    socket.binaryType = 'arraybuffer';
    wsHadError = false;

    socket.onopen = () => {
      if (activeGeneration !== generation || ws !== socket) {
        try { socket.close(); } catch {}
        return;
      }
      lastAudioSentAt = performance.now();
      const queued = pendingChunks;
      pendingChunks = [];
      for (const chunk of queued) {
        sendBytesChunked(socket, chunk);
      }
    };
    socket.onmessage = event => {
      if (activeGeneration !== generation || ws !== socket) return;
      handleMessage(event.data);
    };
    socket.onerror = () => {
      if (activeGeneration !== generation || ws !== socket) return;
      wsHadError = true;
      emitProcessing('error');
      dependencies.onError(new Error('Не удалось подключиться к WebSocket Deepgram.'));
    };
    socket.onclose = event => {
      if (activeGeneration !== generation || ws !== socket) return;
      if (!finalizing && !event.wasClean && event.code !== 1000 && event.code !== 1005) {
        wsHadError = true;
      }
    };
    return socket;
  }

  async function pollOnce(activeGeneration: number) {
    if (polling || finalizing || activeGeneration !== generation || dependencies.getState() !== 'recording') return;
    polling = true;
    try {
      let rate = 0;
      let totalFrames = 0;
      let paused = false;
      let pcm = new ArrayBuffer(0);

      if (dependencies.readPcm) {
        const chunk = await dependencies.readPcm(sentFrames);
        if (finalizing || activeGeneration !== generation || dependencies.getState() !== 'recording') return;
        rate = chunk.sampleRate;
        totalFrames = chunk.totalFrames;
        paused = chunk.paused;
        pcm = chunk.pcm;
      } else if (dependencies.snapshotAudio) {
        const wavBytes = await dependencies.snapshotAudio();
        if (finalizing || activeGeneration !== generation || dependencies.getState() !== 'recording') return;
        const wav = parseWavPcm(wavBytes);
        if (!wav) return;
        rate = wav.sampleRate;
        totalFrames = wav.totalFrames;
        const startFrame = Math.min(sentFrames, totalFrames);
        if (totalFrames > startFrame) {
          pcm = wavBytes.slice(wav.dataOffset + startFrame * 2, wav.dataOffset + totalFrames * 2);
        }
      } else {
        return;
      }

      if (paused || rate <= 0) return;
      if (!sampleRate) sampleRate = rate;
      if (!ws && !wsHadError) {
        ws = openSocket(sampleRate, activeGeneration);
      }
      if (totalFrames > sentFrames && pcm.byteLength > 0 && ws && !wsHadError) {
        enqueuePcmBytes(pcm);
        sentFrames = totalFrames;
      }
    } catch (error) {
      if (activeGeneration === generation && !finalizing) {
        dependencies.onError(error);
      }
    } finally {
      polling = false;
    }
  }

  function stop() {
    clearTimers();
    generation++;
    finalizing = false;
    polling = false;
    interimSegments = [];
    closeSocketImmediate();
    emitProcessing('idle');
  }

  function suspend() {
    clearTimers();
  }

  function start(reset = false) {
    if (reset) {
      stop();
      committedSegments = [];
      interimSegments = [];
      committedThroughSeconds = 0;
      finalizedCleanly = false;
      streamBaseSeconds = 0;
      sentFrames = 0;
      lastFinalizedTotalFrames = 0;
      sampleRate = 0;
      wsHadError = false;
    }
    if (!dependencies.isLiveEnabled() || dependencies.getState() !== 'recording' || pollTimer !== null) return;
    const error = deepgramConfigurationError(dependencies.getDeepgramSettings());
    if (error) {
      wsHadError = true;
      dependencies.onError(new Error(error));
      return;
    }

    const activeGeneration = generation;
    const intervalMs = dependencies.readPcm ? 60 : 150;
    pollTimer = globalThis.setInterval(() => {
      void pollOnce(activeGeneration);
    }, intervalMs);
    keepAliveTimer = globalThis.setInterval(() => {
      if (finalizing || activeGeneration !== generation || !ws || ws.readyState !== WS_OPEN) return;
      if (performance.now() - lastAudioSentAt >= KEEP_ALIVE_MS) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
        lastAudioSentAt = performance.now();
      }
    }, 2000);
    void pollOnce(activeGeneration);
  }

  async function finalize(finalAudio?: ArrayBuffer | Blob, signal?: AbortSignal): Promise<void> {
    const activeGeneration = generation;
    finalizing = true;
    clearTimers();

    try {
      signal?.throwIfAborted();
      let finalBytes: ArrayBuffer | undefined;
      if (finalAudio instanceof ArrayBuffer) finalBytes = finalAudio;
      else if (finalAudio) finalBytes = await finalAudio.arrayBuffer();
      signal?.throwIfAborted();
      if (activeGeneration !== generation) return;

      const wav = finalBytes ? parseWavPcm(finalBytes) : null;
      if (wav) {
        lastFinalizedTotalFrames = wav.totalFrames;
        if (!sampleRate) sampleRate = wav.sampleRate;
      }

      if (!ws && wav && dependencies.isLiveEnabled() && !wsHadError && wav.totalFrames > sentFrames) {
        ws = openSocket(wav.sampleRate, activeGeneration);
      }

      const socket = ws;
      if (socket && socket.readyState === WS_CONNECTING) {
        await new Promise<void>(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', finish);
            socket.removeEventListener('close', finish);
            resolve();
          };
          const onOpen = () => {
            if (activeGeneration === generation && ws === socket) {
              lastAudioSentAt = performance.now();
              const queued = pendingChunks;
              pendingChunks = [];
              for (const chunk of queued) sendBytesChunked(socket, chunk);
            }
            finish();
          };
          const onAbort = () => finish();
          const timer = globalThis.setTimeout(finish, 3000);
          socket.addEventListener('open', onOpen, { once: true });
          socket.addEventListener('error', finish, { once: true });
          socket.addEventListener('close', finish, { once: true });
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }

      signal?.throwIfAborted();
      if (activeGeneration !== generation) return;

      if (socket && socket.readyState === WS_OPEN) {
        if (wav && wav.totalFrames > sentFrames) {
          const tailBytes = finalBytes!.slice(
            wav.dataOffset + sentFrames * 2,
            wav.dataOffset + wav.totalFrames * 2,
          );
          sendBytesChunked(socket, tailBytes);
          sentFrames = wav.totalFrames;
        }
        socket.send(JSON.stringify({ type: 'Finalize' }));
        socket.send(JSON.stringify({ type: 'CloseStream' }));

        await new Promise<void>(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.removeEventListener('close', finish);
            socket.removeEventListener('error', finish);
            resolve();
          };
          const onAbort = () => finish();
          const timer = globalThis.setTimeout(finish, FINALIZE_TIMEOUT_MS);
          socket.addEventListener('close', finish, { once: true });
          socket.addEventListener('error', finish, { once: true });
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }

      if (activeGeneration !== generation) return;
      signal?.throwIfAborted();

      if (!wsHadError && wav && dependencies.isLiveEnabled()) {
        const targetDuration = wav.totalFrames / wav.sampleRate;
        committedSegments = committedSegments
          .map(seg => {
            const start = Math.min(seg.start, Math.max(0, targetDuration - 0.001));
            const end = Math.min(seg.end, targetDuration);
            return { ...seg, start, end };
          })
          .filter(seg => seg.end > seg.start);
        committedThroughSeconds = targetDuration;
        finalizedCleanly = true;
      }
    } finally {
      interimSegments = [];
      if (activeGeneration === generation) {
        finalizing = false;
        closeSocketImmediate();
        emitProcessing('idle');
        dependencies.onPreview(fullPreviewText());
      }
    }
  }

  return {
    get streaming() { return true; },
    get finalized() { return finalizedCleanly; },
    get text() { return fullPreviewText(); },
    get segments() { return committedSegments; },
    get previewSegments() { return [...committedSegments, ...interimSegments]; },
    get committedThroughSeconds() { return committedThroughSeconds; },
    get elapsedSeconds() {
      return sampleRate > 0 ? sentFrames / sampleRate : committedThroughSeconds;
    },
    start,
    stop,
    suspend,
    finalize,
    observeSpeechLevel() {
      // Deepgram detects endpointing server-side over the raw audio stream.
    },
    replaceFinalizedTranscript(segments) {
      stop();
      committedSegments = segments.map(segment => ({ ...segment }));
      interimSegments = [];
      dependencies.onPreview(fullPreviewText());
    },
    resumeAfterPause(fragmentOffset) {
      streamBaseSeconds = fragmentOffset;
      committedThroughSeconds = Math.max(committedThroughSeconds, fragmentOffset);
      finalizedCleanly = false;
      wsHadError = false;
      sentFrames = lastFinalizedTotalFrames || (sampleRate > 0 ? Math.round(fragmentOffset * sampleRate) : sentFrames);
    },
  };
}
