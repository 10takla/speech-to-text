import { useEffect, useState, useSyncExternalStore } from 'react';

// The speech that plays while it streams in (MP3: Edge, ElevenLabs). The overlay
// controls it locally: the service only sends audio, everything received stays
// in the element's buffer, so pause, seeking and speed need no new requests.

/** A spoken word or sentence and when it sounds, in seconds from the start of the audio. */
export interface SpeechMark { kind: 'WordBoundary' | 'SentenceBoundary'; text: string; from: number; to: number }

let active: HTMLAudioElement | undefined;
let marks: readonly SpeechMark[] = [];
// The service is still sending the audio (until the last chunk has arrived).
let streaming = false;
let activeCleanup: (() => void) | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function setActiveSpeech(audio: HTMLAudioElement | undefined, cleanup?: () => void): void {
  if (active === audio) return;
  activeCleanup?.();
  active = audio;
  activeCleanup = cleanup;
  notify();
}

export function clearActiveSpeech(audio?: HTMLAudioElement): void {
  if (!audio || active === audio) {
    activeCleanup?.();
    activeCleanup = undefined;
    active = undefined;
    // The marks stay: the finished text keeps its tracks. The next speech starts with none.
    streaming = false;
    notify();
  }
}

/** The marks arrive with the audio; a new speech starts with none. */
export function resetSpeechMarks(): void {
  if (!marks.length && !streaming) return;
  marks = [];
  streaming = true;
  notify();
}

/** The last chunk has arrived: the whole audio is loaded. */
export function finishSpeechLoading(): void {
  if (!streaming) return;
  streaming = false;
  notify();
}

export function useSpeechLoading(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => streaming);
}

export function addSpeechMark(mark: SpeechMark): void {
  marks = [...marks, mark];
  notify();
}

/** The marks of the speech being shown (or just finished). */
export const getSpeechMarks = (): readonly SpeechMark[] => marks;

export function useSpeechMarks(): readonly SpeechMark[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => marks);
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

export function useActiveSpeech(): HTMLAudioElement | undefined {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => active);
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

export function setSpeechRate(audio: HTMLAudioElement, rate: number): void {
  // The voice keeps its pitch when sped up.
  audio.preservesPitch = true;
  audio.playbackRate = rate;
}
