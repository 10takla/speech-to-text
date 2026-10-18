import { isTauri, invoke } from '@tauri-apps/api/core';
import { isAndroid, isAndroidBubble, androidCall } from './android-runtime';
import { loadSettings, type AppSettings } from './config';
import type { HistoryItem } from './history-db';
import { transcribeTimedAudioWithGroq, type GroqTranscriptionOptions, type TimedTranscript } from './groq';
import { invokeCommand } from './tauri-commands';

export function historyRecordingAudio(record: HistoryItem): Blob | undefined {
  return record.audioBlob?.size ? record.audioBlob : record.originalAudioBlob?.size ? record.originalAudioBlob : undefined;
}

export async function copyHistoryText(text: string): Promise<void> {
  if (isAndroidBubble) await androidCall('copy', { text });
  else if (isTauri()) await invokeCommand(invoke, 'write_clipboard_text', { text });
  else await navigator.clipboard.writeText(text);
}

type TranscriptionSettings = Pick<AppSettings, 'provider' | 'groqApiKey' | 'groqModel' | 'groqPrompt' | 'groqTemperature' | 'groqLanguage'>;
interface RetranscriptionDependencies {
  settings(): TranscriptionSettings;
  transcribe(audio: Blob, options: GroqTranscriptionOptions, signal?: AbortSignal): Promise<TimedTranscript>;
  copy(text: string): Promise<void>;
}

/** Repeat recognition only; never rerun scenario actions or change its saved results. */
export async function retranscribeHistoryRecording(record: HistoryItem, signal?: AbortSignal,
  dependencies: RetranscriptionDependencies = { settings: loadSettings, transcribe: transcribeTimedAudioWithGroq, copy: copyHistoryText }): Promise<string> {
  const audio = historyRecordingAudio(record);
  if (!audio) throw new Error('Аудиозапись не сохранена.');
  const settings = dependencies.settings();
  if (settings.provider !== 'groq') throw new Error('Выберите провайдер транскрибации в настройках.');
  if (!settings.groqApiKey.trim()) throw new Error('Укажите API-ключ транскрибации в настройках.');
  signal?.throwIfAborted();
  const result = await dependencies.transcribe(audio, {
    apiKey: settings.groqApiKey.trim(), model: settings.groqModel, prompt: settings.groqPrompt,
    temperature: settings.groqTemperature, language: settings.groqLanguage,
  }, signal);
  signal?.throwIfAborted();
  const text = result.text.trim();
  if (!text) throw new Error('Речь не распознана.');
  await dependencies.copy(text);
  return text;
}

export function historyRecordingFilename(record: HistoryItem, audio: Blob, suffix = ''): string {
  const mime = audio.type.split(';')[0].toLowerCase();
  const extension = ({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/flac': 'flac' } as Record<string, string>)[mime] ?? 'bin';
  return `recording-${new Date(record.timestamp).toISOString().replace(/[:.]/g, '-')}${suffix ? `-${suffix.replace(/[^a-zA-Z0-9_-]/g, '_')}` : ''}.${extension}`;
}

export async function downloadHistoryRecording(record: HistoryItem, filenameSuffix = ''): Promise<boolean> {
  const audio = historyRecordingAudio(record);
  if (!audio) throw new Error('Аудиозапись не сохранена.');
  const filename = historyRecordingFilename(record, audio, filenameSuffix);
  if (isAndroid || isTauri()) {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    const data = btoa(binary);
    if (isAndroid) {
      const result = await androidCall<{ saved: boolean }>('saveRecording', { data, filename, mimeType: audio.type.split(';')[0] || 'application/octet-stream' });
      return result.saved;
    }
    return invokeCommand(invoke, 'save_recording_file', { data, filename });
  }
  const url = URL.createObjectURL(audio);
  try {
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Download handlers may read the URL after the click has returned.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}
