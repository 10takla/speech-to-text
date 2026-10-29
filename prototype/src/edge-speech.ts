import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { isAndroid } from './android-runtime';
import { AUTO_SPEECH_LANGUAGE, normalizeSpeechSettings, pickSpeechLanguage, type SystemSpeechSettings } from './speech-settings';
import { playSpeechAudio, type SystemSpeechVoice } from './system-speech';
import { canStreamMp3, streamAndPlay } from './streaming-playback';
import type { ScenarioStep } from './scenario';
import type { SpeechMark } from './speech-playback-control';
import { walkScenarioSteps } from './scenario-tree';
import { normalizeSpeechProviders } from './speech-provider-settings';

// Microsoft Edge neural voices, streamed by the Rust side (commands/edge_speech.rs).

// Auto mode takes these for a language; other languages take their first voice.
const PREFERRED_VOICES: Record<string, string> = { 'ru-RU': 'ru-RU-SvetlanaNeural', 'en-US': 'en-US-AvaNeural' };
let voices: Promise<SystemSpeechVoice[]> | undefined;

export function getEdgeVoices(force = false): Promise<SystemSpeechVoice[]> {
  if (!isTauri() || isAndroid) return Promise.reject(new Error('Голоса Microsoft Edge доступны в приложении Windows.'));
  if (force || !voices) {
    const request = invoke<SystemSpeechVoice[]>('edge_speech_voices');
    voices = request;
    request.catch(() => { if (voices === request) voices = undefined; });
  }
  return voices;
}

/** Opens the Edge connection ahead when the scenario speaks with Edge (the setting is on by default). */
export function prepareEdgeSpeech(steps: readonly ScenarioStep[]): void {
  if (!isTauri() || isAndroid) return;
  const speaks = [...walkScenarioSteps(steps)].some(step => step.enabled && step.type === 'speak'
    && step.speechProvider === 'edge' && normalizeSpeechProviders(step.speechProviders).edgePreconnect);
  if (speaks) void invoke('edge_speech_prepare').catch(error => console.warn('Edge TTS: заранее подключиться не удалось:', error));
}

export async function resolveEdgeVoice(text: string, settings: SystemSpeechSettings): Promise<string> {
  const auto = !settings.language || settings.language === AUTO_SPEECH_LANGUAGE;
  if (settings.voiceId && !auto) return settings.voiceId;
  const list = await getEdgeVoices();
  const language = auto ? pickSpeechLanguage(text, [...new Set(['ru-RU', 'en-US', ...list.map(voice => voice.language)])]) || 'ru-RU' : settings.language;
  const preferred = PREFERRED_VOICES[language];
  const voice = list.find(item => item.id === preferred) ?? list.find(item => item.language === language);
  if (!voice) throw new Error(`Нет голоса Edge для языка ${language}.`);
  return voice.id;
}

/** Synthesizes `text`, handing each MP3 chunk to `onChunk` as it arrives. */
async function streamEdgeSpeech(text: string, settings: SystemSpeechSettings, signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => void, onMark?: (mark: SpeechMark) => void): Promise<Blob> {
  signal?.throwIfAborted();
  if (!text.trim()) throw new Error('Нет текста для озвучки.');
  const voice = await resolveEdgeVoice(text, settings);
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const chunks: Uint8Array[] = [];
  let finish = () => {};
  const finished = new Promise<void>(resolve => { finish = resolve; });
  // Audio comes as bytes, the time marks of words and sentences as objects.
  const channel = new Channel<ArrayBuffer | SpeechMark>();
  channel.onmessage = data => {
    if (!(data instanceof ArrayBuffer)) { onMark?.(data); return; }
    const chunk = new Uint8Array(data);
    if (!chunk.length) { finish(); return; }
    chunks.push(chunk);
    onChunk(chunk);
  };
  const abort = () => { void invoke('cancel_edge_speech', { requestId }).catch(console.warn); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await invoke('edge_speech_stream', { requestId, text, voice, rate: settings.rate, pitch: settings.pitch, onAudio: channel });
    await finished;
  } finally { signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

export function synthesizeEdgeSpeech(text: string, options?: SystemSpeechSettings, signal?: AbortSignal): Promise<Blob> {
  return streamEdgeSpeech(text, normalizeSpeechSettings(options), signal, () => {});
}

/** Plays the speech while it streams in; returns the whole audio. */
export async function speakEdgeSpeech(text: string, options?: SystemSpeechSettings, signal?: AbortSignal,
  onAudio?: (audio: Blob) => void): Promise<Blob> {
  const settings = normalizeSpeechSettings(options);
  if (!canStreamMp3()) {
    const audio = await synthesizeEdgeSpeech(text, settings, signal);
    onAudio?.(audio);
    await playSpeechAudio(audio, signal, settings);
    return audio;
  }
  return streamAndPlay(settings.volume, signal, sink => streamEdgeSpeech(text, settings, signal, sink.mp3, sink.mark), onAudio);
}
