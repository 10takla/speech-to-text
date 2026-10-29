import { invoke, isTauri } from '@tauri-apps/api/core';
import { androidCall, isAndroid } from './android-runtime';
import { AUTO_SPEECH_LANGUAGE, normalizeSpeechSettings, pickSpeechLanguage, type SystemSpeechSettings } from './speech-settings';
import { observeRecordingResource } from './parallel-runs/runtime';
import { isUserPaused } from './speech-playback-control';

export interface SystemSpeechVoice { id: string; name: string; language: string; networkRequired?: boolean }
export interface SystemSpeechCapabilities { voices: SystemSpeechVoice[]; defaultVoiceId: string }

export async function getSystemSpeechCapabilities(): Promise<SystemSpeechCapabilities> {
  if (isAndroid) return androidCall<SystemSpeechCapabilities>('speechCapabilities');
  if (isTauri()) return invoke<SystemSpeechCapabilities>('system_speech_capabilities');
  throw new Error('Список системных голосов доступен в приложении Windows или Android.');
}

export async function synthesizeSystemSpeech(text: string, signal?: AbortSignal, options?: SystemSpeechSettings): Promise<Blob> {
  signal?.throwIfAborted();
  if (!text.trim()) throw new Error('Нет текста для озвучки.');
  let audio: Blob;
  const settings = normalizeSpeechSettings(options);
  if (settings.language === AUTO_SPEECH_LANGUAGE) {
    const { voices } = await getSystemSpeechCapabilities();
    settings.language = pickSpeechLanguage(text, voices.map(voice => voice.language));
    settings.voiceId = '';
    signal?.throwIfAborted();
  }
  if (isAndroid) {
    const requestId = crypto.randomUUID();
    const abort = () => { void androidCall('cancelSpeech', { requestId }).catch(console.warn); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await androidCall<{ data: string }>('synthesizeSpeech', { text, requestId, ...settings });
      audio = new Blob([Uint8Array.from(atob(result.data), char => char.charCodeAt(0))], { type: 'audio/wav' });
    } finally { signal?.removeEventListener('abort', abort); }
  } else if (isTauri()) {
    const bytes = await invoke<number[]>('synthesize_system_speech', { text, settings });
    audio = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
  } else throw new Error('Системная озвучка доступна в приложении Windows и Android.');
  signal?.throwIfAborted();
  return audio;
}

export async function playSpeechAudio(blob: Blob, signal?: AbortSignal, options?: SystemSpeechSettings): Promise<void> {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  try { await playAudioElement(new Audio(url), signal, normalizeSpeechSettings(options).volume); } finally { URL.revokeObjectURL(url); }
}

// Plays until the end; pauses while a recording runs. The caller owns the source.
export async function playAudioElement(audio: HTMLAudioElement, signal?: AbortSignal, volume = 1): Promise<void> {
  signal?.throwIfAborted();
  audio.volume = volume;
  let removeAbortListener = () => {};
  let stopObservingRecording = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { audio.pause(); reject(new DOMException('Озвучка отменена', 'AbortError')); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      removeAbortListener = cleanup;
      signal?.addEventListener('abort', abort, { once: true });
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error('Не удалось воспроизвести озвучку.')); };
      stopObservingRecording = observeRecordingResource(recording => {
        if (recording) audio.pause();
        else if (!signal?.aborted && !isUserPaused(audio)) void audio.play().catch(error => { cleanup(); reject(error); });
      });
    });
  } finally { stopObservingRecording(); removeAbortListener(); }
}
