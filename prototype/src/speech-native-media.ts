import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from './tauri-commands';

type Action = 'play' | 'pause' | 'stop';
type PlaybackState = 'none' | 'paused' | 'playing';
let pending = Promise.resolve();

// Serialize changes across audio replacements: clearing an old player must not
// disable the next player's system controls after its initialization completes.
function publish(state: PlaybackState) {
  pending = pending.then(() => invokeCommand(invoke, 'set_speech_media_state', { state })).catch(console.warn);
}

export function connectNativeSpeechMedia(audio: HTMLAudioElement, actions: Record<Action, () => void>): () => void {
  let disposed = false;
  let ready = false;
  let unlisten: (() => void) | undefined;
  const update = () => { if (ready && !disposed) publish(audio.paused || audio.ended ? 'paused' : 'playing'); };
  const events = ['play', 'pause', 'ended'];
  events.forEach(event => audio.addEventListener(event, update));
  void listen<Action>('speech-media-action', event => {
    if (!disposed) actions[event.payload]?.();
  }).then(stop => {
    if (disposed) { stop(); return; }
    unlisten = stop;
    ready = true;
    update();
  }).catch(console.warn);
  return () => {
    disposed = true;
    events.forEach(event => audio.removeEventListener(event, update));
    unlisten?.();
    publish('none');
  };
}
