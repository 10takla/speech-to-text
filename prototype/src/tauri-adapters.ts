import type { invoke as TauriInvoke } from '@tauri-apps/api/core';
import type { AudioCapturePort, TextOutputPort } from './ports';
import { invokeCommand } from './tauri-commands';
import { DEFAULT_CLIPBOARD_HISTORY_LEVEL } from './scenario';
import { isAndroid, androidCall, androidAudio } from './android-runtime';

export function createTauriAudioCapture(invoke: typeof TauriInvoke): AudioCapturePort {
  if (isAndroid) return {
    start: deviceId => androidCall('start', { deviceId: deviceId || '' }),
    pause: () => androidCall('pause'), resume: () => androidCall('resume'),
    snapshot: () => androidAudio('snapshot'), stop: () => androidAudio('stop'),
    cancel: () => androidCall('cancel'), inputLevel: () => androidCall<number>('level'),
  };
  return {
    start: microphoneId => invokeCommand(invoke, 'start_audio_recording', { deviceId: microphoneId || null }),
    pause: () => invokeCommand(invoke, 'pause_audio_recording'),
    resume: () => invokeCommand(invoke, 'resume_audio_recording'),
    snapshot: () => invokeCommand(invoke, 'snapshot_audio_recording'),
    stop: () => invokeCommand(invoke, 'stop_audio_recording'),
    cancel: () => invokeCommand(invoke, 'cancel_audio_recording'),
    inputLevel: () => invokeCommand(invoke, 'get_audio_input_level'),
  };
}

export function createTauriTextOutput(invoke: typeof TauriInvoke): TextOutputPort {
  return {
    copy: (text, historyLevel = DEFAULT_CLIPBOARD_HISTORY_LEVEL) => invokeCommand(invoke, 'copy_text_to_clipboard', { text, historyLevel }),
    paste: text => invokeCommand(invoke, 'paste_text_into_active_window', { text }),
  };
}
