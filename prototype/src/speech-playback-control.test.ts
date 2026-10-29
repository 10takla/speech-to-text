// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveSpeech, seekBy, setActiveSpeech, togglePause } from './speech-playback-control';

describe('speech playback control', () => {
  beforeEach(() => {
    clearActiveSpeech();
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
