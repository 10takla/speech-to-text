import type { ScenarioStep } from './scenario';
import { normalizeSpeechProviders, speechConfigurationError, type ElevenSpeechSettings, type GeminiSpeechSettings, type SpeechProviderSettings } from './speech-provider-settings';
import { synthesizeSystemSpeech, playSpeechAudio } from './system-speech';
import { piperFetch } from './piper-http';
import { createProviderFetch } from './parallel-runs/provider-fetch';
import { speakEdgeSpeech, synthesizeEdgeSpeech } from './edge-speech';
import { canStreamMp3, streamAndPlay } from './streaming-playback';


export interface SpeechVoice { id: string; name: string; language?: string; speakers?: { id: number; name: string }[]; defaults?: Record<string, number> }
export interface SpeechModel { id: string; name: string; languages?: { id: string; name: string }[]; style?: boolean; speakerBoost?: boolean }
export interface SpeechCatalog { models: SpeechModel[]; voices: SpeechVoice[]; notice?: string }
type Json = Record<string, any>;
const object = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {};
const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const geminiBase = 'https://generativelanguage.googleapis.com/v1beta';
const elevenBase = 'https://api.elevenlabs.io';
export type PiperTransport = typeof piperFetch;

async function checked(response: Response, provider: string, secret = ''): Promise<Response> {
  if (response.ok) return response;
  const body = object(await response.json().catch(() => ({})));
  let message = body.error?.message ?? body.detail?.message ?? body.error ?? body.detail;
  if (typeof message !== 'string') message = `HTTP ${response.status}`;
  if (secret) message = message.split(secret).join('[ключ скрыт]');
  throw new Error(`${provider} (${response.status}): ${message}`);
}

async function json(fetcher: typeof fetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const response = await fetcher(url, { headers, signal });
  await checked(response, url.includes('elevenlabs') ? 'ElevenLabs' : 'Gemini TTS', Object.values(headers)[0]);
  return response.json();
}

export async function fetchSpeechCatalog(provider: 'gemini' | 'elevenlabs' | 'piper', settings: SpeechProviderSettings,
  signal?: AbortSignal, fetcher: typeof fetch = fetch, piper: PiperTransport = piperFetch): Promise<SpeechCatalog> {
  signal = requestSignal(signal, 20_000);
  if (provider === 'piper') {
    const response = await piper(settings.piper.url, 'voices', undefined, signal);
    await checked(response, 'Piper');
    return { models: [], voices: parsePiperVoices(await response.json()) };
  }
  const key = settings[provider].apiKey.trim();
  if (!key) throw new Error('Укажите API-ключ.');
  if (provider === 'elevenlabs') {
    const headers = { 'xi-api-key': key };
    const modelsBody = await json(fetcher, `${elevenBase}/v1/models`, headers, signal);
    const voices: SpeechVoice[] = [];
    let next = '';
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (next) query.set('next_page_token', next);
      const body = object(await json(fetcher, `${elevenBase}/v2/voices?${query}`, headers, signal));
      for (const voice of array(body.voices)) if (typeof voice.voice_id === 'string') {
        voices.push({ id: voice.voice_id, name: voice.name || voice.voice_id, language: voice.labels?.language });
      }
      next = typeof body.next_page_token === 'string' ? body.next_page_token : '';
      if (next && seen.has(next)) throw new Error('ElevenLabs вернул повторную страницу голосов.');
      seen.add(next);
    } while (next);
    return { voices, models: array(modelsBody).filter(model => model.can_do_text_to_speech === true && typeof model.model_id === 'string')
      .map(model => ({ id: model.model_id, name: model.name || model.model_id,
        style: model.can_use_style === true, speakerBoost: model.can_use_speaker_boost === true,
        languages: array(model.languages).map(language => ({ id: language.language_id, name: language.name })) })) };
  }
  const headers = { 'x-goog-api-key': key };
  const models: SpeechModel[] = [];
  let next = '';
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams();
    if (next) query.set('pageToken', next);
    const body = object(await json(fetcher, `${geminiBase}/models?${query}`, headers, signal));
    for (const model of array(body.models)) {
      // Flash TTS has a free tier; Pro TTS is paid and is not offered here.
      if (typeof model.name !== 'string' || !/tts/i.test(model.name) || !/flash/i.test(model.name)) continue;
      if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes('generateContent')) continue;
      models.push({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name });
    }
    next = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (next && seen.has(next)) throw new Error('Gemini вернул повторную страницу моделей.');
    seen.add(next);
  } while (next);
  const voices: SpeechVoice[] = [];
  next = '';
  seen.clear();
  do {
    const query = new URLSearchParams({ page_size: '100', type: 'prebuilt' });
    if (next) query.set('page_token', next);
    const response = await fetcher(`${geminiBase}/voices?${query}`, { headers, signal });
    // Older Gemini deployments have no voice discovery endpoint; these built-in voices are documented.
    if (response.status === 404 || response.status === 501) {
      return { models, voices: ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'].map(id => ({ id, name: id })),
        notice: 'API не сообщает голоса: использован список встроенных голосов из документации.' };
    }
    await checked(response, 'Gemini TTS', key);
    const body = object(await response.json());
    for (const voice of array(body.voices)) if (typeof voice.id === 'string') {
      voices.push({ id: voice.id, name: voice.display_name || voice.displayName || voice.id, language: voice.language_code });
    }
    next = typeof body.next_page_token === 'string' ? body.next_page_token : '';
    if (next && seen.has(next)) throw new Error('Gemini вернул повторную страницу голосов.');
    seen.add(next);
  } while (next);
  return { models, voices };
}

export function parsePiperVoices(body: unknown): SpeechVoice[] {
  return Object.entries(object(body)).map(([id, entry]) => {
    const config = object(entry);
    const count = Number.isInteger(config.num_speakers) && config.num_speakers > 0 ? Math.min(config.num_speakers, 10000) : 1;
    const speakerNames = new Map(Object.entries(object(config.speaker_id_map)).map(([name, value]) => [value, name]));
    return { id, name: id, language: config.language?.code || config.espeak?.voice,
      speakers: Array.from({ length: count }, (_, index) => ({ id: index, name: speakerNames.get(index) ?? `Голос ${index + 1}` })),
      defaults: object(config.inference) as Record<string, number> };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export async function fetchPiperDownloads(url: string, signal?: AbortSignal): Promise<SpeechVoice[]> {
  const response = await piperFetch(url, 'all-voices', undefined, requestSignal(signal, 30_000));
  await checked(response, 'Piper');
  return parsePiperVoices(await response.json());
}

export async function downloadPiperVoice(url: string, voice: string, signal?: AbortSignal): Promise<void> {
  const response = await piperFetch(url, 'download', { voice }, requestSignal(signal, 180_000));
  await checked(response, 'Piper');
}

function requestSignal(signal: AbortSignal | undefined, timeout: number) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

const pcmRate = (mime: string) => Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
const base64Bytes = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));

export function audioFromBase64(data: string, mime: string): Blob {
  const bytes = base64Bytes(data);
  return /audio\/(?:l16|pcm)/i.test(mime) ? pcmToWav(bytes, pcmRate(mime)) : new Blob([bytes], { type: mime || 'audio/wav' });
}

// 16-bit mono PCM in a WAV container.
function pcmToWav(bytes: Uint8Array, rate: number): Blob {
  {
    const buffer = new ArrayBuffer(44 + bytes.length), view = new DataView(buffer);
    const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + bytes.length, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, bytes.length, true); new Uint8Array(buffer, 44).set(bytes);
    return new Blob([buffer], { type: 'audio/wav' });
  }
}

const geminiVersion = (model: string) => {
  const match = /^gemini-(\d+)\.(\d+)/.exec(model);
  return match ? [+match[1], +match[2]] as const : undefined;
};
// Gemini 3.8+ speaks only through the Interactions API.
const geminiInteractions = (model: string) => {
  const version = geminiVersion(model);
  return !!version && (version[0] > 3 || (version[0] === 3 && version[1] >= 8));
};
// Measured: 3.1 Flash TTS (streamGenerateContent) and 3.8 Flash TTS (Interactions API,
// step.delta events) stream PCM; 2.5 Flash TTS sends the whole audio in one chunk at the end.
const geminiStreams = (model: string) => (geminiVersion(model)?.[0] ?? 0) >= 3;

/** Whether the step's speech plays while it is synthesized. */
export function speechStreams(step: Pick<ScenarioStep, 'speechProvider' | 'speechProviders'>): boolean {
  const provider = step.speechProvider ?? 'system';
  if (provider === 'edge' || provider === 'elevenlabs') return canStreamMp3();
  return provider === 'gemini' && geminiStreams(normalizeSpeechProviders(step.speechProviders).gemini.model);
}

function elevenRequest(config: ElevenSpeechSettings, text: string, signal: AbortSignal): RequestInit {
  return {
    method: 'POST', signal, headers: { 'xi-api-key': config.apiKey.trim(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: config.model, ...(config.language && !config.model.includes('multilingual_v2') ? { language_code: config.language } : {}),
      voice_settings: { stability: config.stability, similarity_boost: config.similarity,
        ...(config.canUseStyle ? { style: config.style } : {}), speed: config.speed,
        ...(config.canUseSpeakerBoost ? { use_speaker_boost: config.speakerBoost } : {}) } }),
  };
}

function geminiInteraction(config: GeminiSpeechSettings, text: string) {
  return {
    model: config.model, input: [{ type: 'user_input', content: [{ type: 'text', text,
      ...(config.style ? { annotations: [{ type: 'speech_metadata', style: config.style }] } : {}) }] }],
    response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: config.voice }] },
  };
}

function geminiContent(config: GeminiSpeechSettings, text: string) {
  return {
    contents: [{ parts: [{ text: config.style ? `${config.style}\n\nПроизнеси только следующий текст:\n${text}` : text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } },
  };
}

// Reads a response body chunk by chunk.
async function readBody(response: Response, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) { onChunk(new Uint8Array(await response.arrayBuffer())); return; }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value?.length) onChunk(value);
  }
}

export async function streamElevenSpeech(config: ElevenSpeechSettings, text: string, signal: AbortSignal | undefined,
  fetcher: typeof fetch, onChunk: (chunk: Uint8Array) => void): Promise<Blob> {
  const response = await fetcher(`${elevenBase}/v1/text-to-speech/${encodeURIComponent(config.voice)}/stream?output_format=mp3_44100_128`,
    elevenRequest(config, text, requestSignal(signal, 120_000)));
  await checked(response, 'ElevenLabs', config.apiKey.trim());
  const chunks: Uint8Array[] = [];
  await readBody(response, chunk => { chunks.push(chunk); onChunk(chunk); });
  if (!chunks.length) throw new Error('ElevenLabs вернул пустое аудио.');
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

// Server-sent events of streamGenerateContent: each carries a piece of 16-bit PCM.
export async function streamGeminiSpeech(config: GeminiSpeechSettings, text: string, signal: AbortSignal | undefined,
  fetcher: typeof fetch, onPcm: (chunk: Uint8Array, rate: number) => void): Promise<Blob> {
  const interactions = geminiInteractions(config.model);
  const response = await fetcher(interactions ? `${geminiBase}/interactions?alt=sse`
    : `${geminiBase}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal: requestSignal(signal, 120_000),
    headers: { 'x-goog-api-key': config.apiKey.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify(interactions ? { ...geminiInteraction(config, text), stream: true } : geminiContent(config, text)),
  });
  await checked(response, 'Gemini TTS', config.apiKey.trim());
  const decoder = new TextDecoder();
  const pieces: Uint8Array[] = [];
  let pending = '', rate = 24000;
  const handle = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('');
    // The Interactions API closes its stream with "[DONE]".
    if (!data.trim() || data.trim() === '[DONE]') return;
    const body = object(JSON.parse(data));
    if (body.error) throw new Error(`Gemini TTS: ${object(body.error).message ?? 'ошибка потока'}`);
    const add = (data: unknown, sampleRate: number) => {
      if (typeof data !== 'string' || !data) return;
      rate = sampleRate;
      const bytes = base64Bytes(data);
      pieces.push(bytes); onPcm(bytes, rate);
    };
    // Interactions API: audio arrives in step.delta events.
    const delta = object(body.delta);
    if (body.event_type === 'step.delta' && delta.type === 'audio') add(delta.data, Number(delta.sample_rate) || pcmRate(String(delta.mime_type ?? '')));
    for (const part of array(body.candidates).slice(0, 1).flatMap(item => array(item.content?.parts))) {
      const inline = object(part.inlineData ?? part.inline_data);
      add(inline.data, pcmRate(String(inline.mimeType ?? inline.mime_type ?? '')));
    }
  };
  await readBody(response, chunk => {
    pending += decoder.decode(chunk, { stream: true });
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? '';
    events.forEach(handle);
  });
  handle(pending + decoder.decode());
  if (!pieces.length) throw new Error('Gemini TTS не вернул аудио. Обновите модели и проверьте квоту.');
  const joined = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  pieces.reduce((offset, piece) => { joined.set(piece, offset); return offset + piece.length; }, 0);
  return pcmToWav(joined, rate);
}

export async function synthesizeProviderSpeech(step: ScenarioStep, text: string, signal?: AbortSignal,
  fetcher: typeof fetch = fetch, piper: PiperTransport = piperFetch): Promise<Blob> {
  signal?.throwIfAborted();
  if (!text.trim()) throw new Error('Нет текста для озвучки.');
  const provider = step.speechProvider ?? 'system';
  const problem = speechConfigurationError(provider, step.speechProviders);
  if (problem) throw new Error(problem);
  if (provider === 'system') return synthesizeSystemSpeech(text, signal, step.speechSettings);
  const settings = normalizeSpeechProviders(step.speechProviders);
  if (provider === 'edge') return synthesizeEdgeSpeech(text, settings.edge, signal);
  const timeoutSignal = requestSignal(signal, 120_000);
  let response: Response;
  if (provider === 'piper') {
    const config = settings.piper;
    // The server falls back to its default voice if a requested model was removed.
    // Check installed voices first so the scenario cannot silently speak with another voice.
    const catalog = await piper(config.url, 'voices', undefined, timeoutSignal);
    await checked(catalog, 'Piper');
    const voice = parsePiperVoices(await catalog.json()).find(voice => voice.id === config.voice);
    if (!voice) throw new Error('Выбранный голос Piper не загружен. Загрузите голос в настройках шага.');
    if (config.speakerId !== undefined && !voice.speakers?.some(speaker => speaker.id === config.speakerId)) {
      throw new Error('Говорящий недоступен для выбранного голоса Piper.');
    }
    response = await piper(config.url, 'synthesize', { text, voice: config.voice, speaker_id: config.speakerId,
      length_scale: config.lengthScale, noise_scale: config.noiseScale, noise_w_scale: config.noiseWScale }, timeoutSignal);
    await checked(response, 'Piper');
    const blob = await response.blob();
    if (!blob.size) throw new Error('Piper вернул пустое аудио.');
    return new Blob([blob], { type: 'audio/wav' });
  }
  if (provider === 'elevenlabs') {
    const config = settings.elevenlabs;
    response = await fetcher(`${elevenBase}/v1/text-to-speech/${encodeURIComponent(config.voice)}?output_format=mp3_44100_128`,
      elevenRequest(config, text, timeoutSignal));
    await checked(response, 'ElevenLabs', config.apiKey.trim());
    const blob = await response.blob();
    if (!blob.size) throw new Error('ElevenLabs вернул пустое аудио.');
    return new Blob([blob], { type: 'audio/mpeg' });
  }
  const config = settings.gemini;
  const interactions = geminiInteractions(config.model);
  response = await fetcher(interactions ? `${geminiBase}/interactions` : `${geminiBase}/models/${encodeURIComponent(config.model)}:generateContent`, {
    method: 'POST', signal: timeoutSignal, headers: { 'x-goog-api-key': config.apiKey.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify(interactions ? geminiInteraction(config, text) : geminiContent(config, text)),
  });
  await checked(response, 'Gemini TTS', config.apiKey.trim());
  const body = object(await response.json());
  const parts = interactions
    ? array(body.steps).filter(item => item.type === 'model_output').flatMap(item => array(item.content)).filter(item => item.type === 'audio')
    : array(body.candidates).slice(0, 1).flatMap(item => array(item.content?.parts)).map(item => object(item.inlineData ?? item.inline_data));
  const audio = parts.filter(item => typeof item.data === 'string' && item.data).map(item => audioFromBase64(item.data, item.mimeType ?? item.mime_type ?? 'audio/wav'));
  if (!audio.length) throw new Error('Gemini TTS не вернул аудио. Обновите модели и проверьте квоту.');
  if (audio.length > 1) throw new Error('Gemini TTS вернул несколько аудиофайлов. Сократите текст шага.');
  signal?.throwIfAborted();
  return audio[0];
}

export function createSpeechProvider(step: ScenarioStep, onWaiting?: (waiting: boolean) => void) {
  const snapshot = structuredClone(step);
  const limitedFetch = createProviderFetch(fetch, onWaiting);
  const edge = normalizeSpeechProviders(snapshot.speechProviders).edge;
  return {
    synthesize: (text: string, signal?: AbortSignal) => synthesizeProviderSpeech(snapshot, text, signal, limitedFetch),
    // Streaming configurations play while the audio arrives.
    speak: !speechStreams(snapshot) ? undefined : async (text: string, signal?: AbortSignal, onAudio?: (audio: Blob) => void) => {
      signal?.throwIfAborted();
      if (!text.trim()) throw new Error('Нет текста для озвучки.');
      const problem = speechConfigurationError(snapshot.speechProvider, snapshot.speechProviders);
      if (problem) throw new Error(problem);
      const settings = normalizeSpeechProviders(snapshot.speechProviders);
      if (snapshot.speechProvider === 'gemini') return streamAndPlay(settings.gemini.volume, signal,
        sink => streamGeminiSpeech(settings.gemini, text, signal, limitedFetch, sink.pcm), onAudio);
      if (snapshot.speechProvider === 'elevenlabs') return streamAndPlay(settings.elevenlabs.volume, signal,
        sink => streamElevenSpeech(settings.elevenlabs, text, signal, limitedFetch, sink.mp3), onAudio);
      // Only the chosen provider speaks: a failure is the step's error, no other voice replaces it.
      return speakEdgeSpeech(text, edge, signal, onAudio);
    },
    play: (audio: Blob, signal?: AbortSignal) => {
      const provider = snapshot.speechProvider ?? 'system';
      const volume = provider === 'system' || provider === 'none' ? undefined : normalizeSpeechProviders(snapshot.speechProviders)[provider].volume;
      return playSpeechAudio(audio, signal, volume === undefined ? snapshot.speechSettings : { voiceId: '', language: '', rate: 1, pitch: 1, volume });
    },
  };
}
