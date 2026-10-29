import type { invoke as TauriInvoke } from '@tauri-apps/api/core';
import type { AudioCapturePort, TextOutputPort } from './ports';
import { invokeCommand } from './tauri-commands';
import { DEFAULT_CLIPBOARD_HISTORY_LEVEL } from './scenario';
import { isAndroid, androidCall, androidAudio } from './android-runtime';
import { normalizeAfterStopMs, waitForStopTail } from './recording-stop';

export function createTauriAudioCapture(invoke: typeof TauriInvoke): AudioCapturePort {
  if (isAndroid) return {
    start: deviceId => androidCall('start', { deviceId: deviceId || '' }),
    pause: () => androidCall('pause'), resume: () => androidCall('resume'),
    snapshot: () => androidAudio('snapshot'),
    stop: async (requestedAtMs = Date.now(), afterStopMs, signal) => {
      try { await waitForStopTail(requestedAtMs, normalizeAfterStopMs(afterStopMs), signal); }
      catch (error) {
        if (signal?.aborted) await androidCall('cancel');
        throw error;
      }
      return androidAudio('stop');
    },
    cancel: () => androidCall('cancel'), inputLevel: () => androidCall<number>('level'),
  };
  return {
    start: microphoneId => invokeCommand(invoke, 'start_audio_recording', { deviceId: microphoneId || null }),
    pause: () => invokeCommand(invoke, 'pause_audio_recording'),
    resume: () => invokeCommand(invoke, 'resume_audio_recording'),
    snapshot: () => invokeCommand(invoke, 'snapshot_audio_recording'),
    stop: (requestedAtMs = Date.now(), afterStopMs, signal) => {
      const stopping = invokeCommand(invoke, 'stop_audio_recording', {
        requestedAtMs, afterStopMs: normalizeAfterStopMs(afterStopMs),
      });
      const cancel = () => { void invokeCommand(invoke, 'cancel_audio_recording').catch(console.warn); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      return stopping.finally(() => signal?.removeEventListener('abort', cancel));
    },
    cancel: () => invokeCommand(invoke, 'cancel_audio_recording'),
    inputLevel: () => invokeCommand(invoke, 'get_audio_input_level'),
  };
}

export function createTauriTextOutput(invoke: typeof TauriInvoke, runId?: string): TextOutputPort {
  return {
    copy: (text, historyLevel = DEFAULT_CLIPBOARD_HISTORY_LEVEL) => invokeCommand(invoke, 'copy_text_to_clipboard', { text, historyLevel, ...(runId && { runId }) }),
    paste: (text, returnFocusToOriginalWindow = false) => invokeCommand(invoke, 'paste_text_into_active_window', { text, returnFocusToOriginalWindow, ...(runId && { runId }) }),
  };
}
