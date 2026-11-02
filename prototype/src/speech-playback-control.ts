import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { connectNativeSpeechMedia } from './speech-native-media';

// The speech that plays while it streams in (MP3: Edge, ElevenLabs). The overlay
// controls it locally: the service only sends audio, everything received stays
// in the element's buffer, so pause, seeking and speed need no new requests.

/** A spoken word or sentence and when it sounds, in seconds from the start of the audio. */
export interface SpeechMark { kind: 'WordBoundary' | 'SentenceBoundary'; text: string; from: number; to: number }

// Each run has its own speech (its scope): several speeches can wait on screen at the same
// time, and the user chooses which one plays. Without a scope they share one.
export type SpeechScope = object;
const SHARED_SCOPE: SpeechScope = {};
/** The scope the speech controls and text below read from. */
export const SpeechScopeContext = createContext<SpeechScope>(SHARED_SCOPE);

interface SpeechState {
  active?: HTMLAudioElement;
  marks: readonly SpeechMark[];
  // The service is still sending the audio (until the last chunk has arrived).
  streaming: boolean;
  detach?: () => void;
  cleanup?: () => void;
  listeners: Set<() => void>;
}
const states = new Map<SpeechScope, SpeechState>();
function stateOf(scope: SpeechScope = SHARED_SCOPE): SpeechState {
  let state = states.get(scope);
  if (!state) { state = { marks: [], streaming: false, listeners: new Set() }; states.set(scope, state); }
  return state;
}
const notify = (state: SpeechState) => state.listeners.forEach(listener => listener());
const subscribe = (state: SpeechState) => (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; };

// The system media controls follow one speech: the one that plays, else any.
let mediaOwner: { audio: HTMLAudioElement; cleanup?: () => void } | undefined;
function syncMedia(): void {
  const audios = [...states.values()].flatMap(state => state.active ? [state.active] : []);
  const audio = audios.find(item => !item.paused) ?? audios[0];
  if (mediaOwner?.audio === audio) return;
  mediaOwner?.cleanup?.();
  mediaOwner = audio ? { audio, cleanup: connectMediaControls(audio) } : undefined;
}

/** Another speech is playing: a new one waits paused until the user starts it. */
export function isOtherSpeechPlaying(scope?: SpeechScope): boolean {
  const own = stateOf(scope);
  return [...states.values()].some(state => state !== own && !!state.active && !state.active.paused && !state.active.ended);
}

export function setActiveSpeech(audio: HTMLAudioElement | undefined, cleanup?: () => void, scope?: SpeechScope): void {
  const state = stateOf(scope);
  if (state.active === audio) return;
  state.detach?.();
  state.cleanup?.();
  state.active = audio;
  state.cleanup = cleanup;
  state.detach = undefined;
  if (audio) {
    // The user starts this speech: the others pause, so the user chooses what to hear.
    const onPlay = () => {
      for (const other of states.values()) {
        if (other.active && other.active !== audio && !other.active.paused) {
          if (other.active.dataset) other.active.dataset.userPaused = 'true';
          other.active.pause();
        }
      }
      syncMedia();
    };
    audio.addEventListener?.('play', onPlay);
    state.detach = () => audio.removeEventListener?.('play', onPlay);
  }
  syncMedia();
  notify(state);
}

function clearState(state: SpeechState, audio?: HTMLAudioElement): void {
  if (audio && state.active !== audio) return;
  state.detach?.();
  state.detach = undefined;
  state.cleanup?.();
  state.cleanup = undefined;
  state.active = undefined;
  // The marks stay: the finished text keeps its tracks. The next speech starts with none.
  state.streaming = false;
  syncMedia();
  notify(state);
}

/** Without a scope and without audio: all speeches. */
export function clearActiveSpeech(audio?: HTMLAudioElement, scope?: SpeechScope): void {
  if (scope || audio) { clearState(stateOf(scope), audio); return; }
  for (const state of states.values()) clearState(state);
}

/** The run is gone: its speech and marks go with it. */
export function disposeSpeechScope(scope: SpeechScope): void {
  const state = states.get(scope);
  if (!state) return;
  clearState(state);
  states.delete(scope);
}

function connectMediaControls(audio: HTMLAudioElement): (() => void) | undefined {
  const play = () => { if (audio.paused || audio.ended) togglePause(audio); };
  const pause = () => { audio.dataset.userPaused = 'true'; audio.pause(); };
  // WebView2 withdraws its automatic Windows session once the audio has ended.
  // Own the native session until this retained speech is explicitly cleared.
  if (isTauri() && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)) {
    return connectNativeSpeechMedia(audio, { play, pause, stop: pause });
  }
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  const session = navigator.mediaSession;
  const update = () => { session.playbackState = audio.paused || audio.ended ? 'paused' : 'playing'; };
  const installed: MediaSessionAction[] = [];
  for (const [action, handler] of [['play', play], ['pause', pause], ['stop', pause]] as const) {
    try { session.setActionHandler(action, handler); installed.push(action); }
    catch { /* Some platforms do not support every media action. */ }
  }
  const events = ['play', 'pause', 'ended'];
  events.forEach(event => audio.addEventListener(event, update));
  update();
  return () => {
    events.forEach(event => audio.removeEventListener(event, update));
    installed.forEach(action => session.setActionHandler(action, null));
    session.playbackState = 'none';
  };
}

/** The marks arrive with the audio; a new speech starts with none. */
export function resetSpeechMarks(scope?: SpeechScope): void {
  const state = stateOf(scope);
  if (!state.marks.length && !state.streaming) return;
  state.marks = [];
  state.streaming = true;
  notify(state);
}

/** The last chunk has arrived: the whole audio is loaded. */
export function finishSpeechLoading(scope?: SpeechScope): void {
  const state = stateOf(scope);
  if (!state.streaming) return;
  state.streaming = false;
  notify(state);
}

export function useSpeechLoading(): boolean {
  const state = stateOf(useContext(SpeechScopeContext));
  return useSyncExternalStore(subscribe(state), () => state.streaming);
}

export function addSpeechMark(mark: SpeechMark, scope?: SpeechScope): void {
  const state = stateOf(scope);
  state.marks = [...state.marks, mark];
  notify(state);
}

/** The marks of the speech being shown (or just finished). */
export const getSpeechMarks = (scope?: SpeechScope): readonly SpeechMark[] => stateOf(scope).marks;

export function useSpeechMarks(): readonly SpeechMark[] {
  const state = stateOf(useContext(SpeechScopeContext));
  return useSyncExternalStore(subscribe(state), () => state.marks);
}

export function useActiveSpeech(): HTMLAudioElement | undefined {
  const state = stateOf(useContext(SpeechScopeContext));
  return useSyncExternalStore(subscribe(state), () => state.active);
}

/** The audio's position while it plays, smoothly (about every frame). */
export function useSpeechTime(audio: HTMLAudioElement | undefined): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!audio) return;
    let frame = 0;
    const tick = () => { setTime(audio.currentTime); frame = audio.paused ? 0 : requestAnimationFrame(tick); };
    const wake = () => { cancelAnimationFrame(frame); tick(); };
    const events = ['play', 'playing', 'pause', 'seeked', 'timeupdate'];
    events.forEach(event => audio.addEventListener(event, wake));
    wake();
    return () => { cancelAnimationFrame(frame); events.forEach(event => audio.removeEventListener(event, wake)); };
  }, [audio]);
  return time;
}

/** Moves the playback to `seconds`, within what has been received. */
export function seekTo(audio: HTMLAudioElement, seconds: number): void {
  const maxEnd = Math.max(receivedEnd(audio), Number.isFinite(audio.duration) ? audio.duration : 0);
  audio.currentTime = Math.max(0, Math.min(maxEnd - .05, seconds));
}

/** A pause by the user survives the end of a recording, which otherwise resumes the speech. */
export const isUserPaused = (audio: HTMLAudioElement) => audio.dataset?.userPaused === 'true';

export function togglePause(audio: HTMLAudioElement): void {
  if (audio.ended || audio.currentTime >= audio.duration) audio.currentTime = 0;
  if (audio.paused) {
    if (audio.dataset) delete audio.dataset.userPaused;
    void audio.play().catch(() => {});
  } else {
    if (!audio.dataset) (audio as any).dataset = {};
    audio.dataset.userPaused = 'true';
    audio.pause();
  }
}

/** End of the received audio: seeking forward stops there. */
export function receivedEnd(audio: HTMLAudioElement): number {
  const ranges = audio.buffered;
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

export function seekBy(audio: HTMLAudioElement, seconds: number): void {
  const maxEnd = Math.max(receivedEnd(audio), audio.duration || 0);
  audio.currentTime = Math.max(0, Math.min(maxEnd - .05, audio.currentTime + seconds));
}

export const SPEECH_RATES = [.75, 1, 1.25, 1.5, 1.75, 2] as const;

const RATE_KEY = 'speech-playback-rate';

/** The speed the user chose last: new speeches start with it. */
export function savedSpeechRate(): number {
  try {
    const rate = Number(localStorage.getItem(RATE_KEY));
    return (SPEECH_RATES as readonly number[]).includes(rate) ? rate : 1;
  } catch { return 1; }
}

/** Remembers the speed for the speeches that start next. */
export function saveSpeechRate(rate: number): void {
  try { localStorage.setItem(RATE_KEY, String(rate)); } catch { /* The speed is just not remembered. */ }
}

export function setSpeechRate(audio: HTMLAudioElement, rate: number): void {
  // The voice keeps its pitch when sped up.
  audio.preservesPitch = true;
  audio.playbackRate = rate;
  saveSpeechRate(rate);
}

/** A new speech starts at the remembered speed; speeches already playing keep theirs. */
export function applySavedSpeechRate(audio: HTMLAudioElement): void {
  const rate = savedSpeechRate();
  if (rate !== 1) { audio.preservesPitch = true; audio.playbackRate = rate; }
}
