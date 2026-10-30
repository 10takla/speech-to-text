// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveSpeech, seekBy, setActiveSpeech, togglePause } from './speech-playback-control';

const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn(), listen: vi.fn(), action: undefined as ((action: string) => void) | undefined }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

describe('speech playback control', () => {
  beforeEach(() => {
    clearActiveSpeech();
    native.enabled = false;
  });

  it('preserves audio and allows rewinding after playback finishes', () => {
    let isEnded = true;
    const audio = {
      currentTime: 10,
      duration: 10,
      paused: true,
      get ended() { return isEnded; },
      buffered: { length: 1, end: () => 10 } as unknown as TimeRanges,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      dataset: {} as Record<string, string>,
    } as unknown as HTMLAudioElement;

    const cleanup = vi.fn();
    setActiveSpeech(audio, cleanup);

    // Rewind by 5 seconds
    seekBy(audio, -5);
    expect(audio.currentTime).toBe(5);

    // Toggle pause plays from current position
    isEnded = false;
    togglePause(audio);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();

    // Clearing active speech triggers cleanup
    clearActiveSpeech();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('restarts from beginning if user plays when audio ended at the end', () => {
    const audio = {
      currentTime: 10,
      duration: 10,
      paused: true,
      ended: true,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      dataset: {} as Record<string, string>,
    } as unknown as HTMLAudioElement;

    togglePause(audio);
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledOnce();
  });
});

describe('system media controls for retained speech', () => {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  let session: { playbackState: MediaSessionPlaybackState; setActionHandler: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clearActiveSpeech();
    handlers.clear();
    session = { playbackState: 'none', setActionHandler: vi.fn((action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    }) };
    vi.stubGlobal('navigator', { mediaSession: session });
  });
  afterEach(() => { clearActiveSpeech(); native.enabled = false; vi.unstubAllGlobals(); });

  function player() {
    const audio = document.createElement('audio');
    let paused = false, ended = false;
    Object.defineProperties(audio, {
      duration: { value: 10 },
      paused: { get: () => paused },
      ended: { get: () => ended && audio.currentTime >= 10 },
      buffered: { value: { length: 1, end: () => 10 } },
    });
    const play = vi.spyOn(audio, 'play').mockImplementation(async () => {
      paused = false; ended = false; audio.dispatchEvent(new Event('play'));
    });
    vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; audio.dispatchEvent(new Event('pause')); });
    const finish = () => { audio.currentTime = 10; paused = true; ended = true; audio.dispatchEvent(new Event('ended')); };
    return { audio, play, finish };
  }

  function action(name: MediaSessionAction) {
    const handler = handlers.get(name);
    expect(handler, `system ${name} handler`).toBeTypeOf('function');
    handler!({ action: name });
  }

  it('restarts finished audio through the system play action', () => {
    const { audio, play, finish } = player();
    setActiveSpeech(audio);
    expect(session.playbackState).toBe('playing');
    finish();
    expect(session.playbackState).toBe('paused');
    action('play');
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledOnce();
    expect(session.playbackState).toBe('playing');
  });

  it('resumes from a rewound position after the audio has finished', () => {
    const { audio, play, finish } = player();
    setActiveSpeech(audio); finish(); seekBy(audio, -5);
    action('play');
    expect(audio.currentTime).toBe(5);
    expect(play).toHaveBeenCalledOnce();
    action('play');
    expect(audio.paused).toBe(false);
    expect(audio.dataset.userPaused).toBeUndefined();
  });

  it('preserves the position and the user pause for system pause and stop', () => {
    const { audio } = player();
    setActiveSpeech(audio); audio.currentTime = 4;
    for (const name of ['pause', 'stop'] as const) {
      action(name);
      expect(audio.paused).toBe(true);
      expect(audio.dataset.userPaused).toBe('true');
      expect(session.playbackState).toBe('paused');
      action('play');
      expect(audio.currentTime).toBe(4);
      expect(audio.paused).toBe(false);
      expect(audio.dataset.userPaused).toBeUndefined();
    }
  });

  it('moves system controls to the next speech and removes them when it is cleared', () => {
    const first = player(), second = player();
    setActiveSpeech(first.audio);
    setActiveSpeech(second.audio);
    first.finish();
    expect(session.playbackState).toBe('playing');
    second.finish(); action('play');
    expect(first.play).not.toHaveBeenCalled();
    expect(second.play).toHaveBeenCalledOnce();
    clearActiveSpeech();
    expect(handlers.size).toBe(0);
    expect(session.playbackState).toBe('none');
  });

  it('retains a native Windows media session after ending and routes system signals back to the player', async () => {
    native.enabled = true;
    native.invoke.mockReset().mockResolvedValue(undefined);
    const unlisten = vi.fn();
    native.listen.mockImplementation(async (_event, handler) => {
      native.action = action => handler({ payload: action });
      return unlisten;
    });
    vi.stubGlobal('navigator', { userAgent: 'Windows', mediaSession: session });
    const { audio, play, finish } = player();
    setActiveSpeech(audio);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith('set_speech_media_state', { state: 'playing' }));
    finish();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith('set_speech_media_state', { state: 'paused' }));
    native.action!('play');
    expect(play).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(0);
    finish(); seekBy(audio, -5);
    native.action!('play');
    expect(audio.currentTime).toBe(5);
    expect(play).toHaveBeenCalledTimes(2);
    clearActiveSpeech();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith('set_speech_media_state', { state: 'none' }));
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('does not reactivate system controls when cleared before the native listener is ready', async () => {
    native.enabled = true;
    native.invoke.mockReset().mockResolvedValue(undefined);
    let ready!: (unlisten: () => void) => void;
    native.listen.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    vi.stubGlobal('navigator', { userAgent: 'Windows' });
    const { audio } = player();
    setActiveSpeech(audio);
    clearActiveSpeech();
    const unlisten = vi.fn();
    ready(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    expect(native.invoke).toHaveBeenCalledWith('set_speech_media_state', { state: 'none' });
  });
});
