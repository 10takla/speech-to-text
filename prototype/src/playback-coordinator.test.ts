import { afterEach, expect, it, vi } from 'vitest';
import { claimPlayback, ownsPlayback, releasePlayback, stopExclusivePlayback } from './playback-coordinator';

afterEach(stopExclusivePlayback);

it('interrupts the previous audio owner when switching playback levels', () => {
  const segment = {}, fragment = {}, playlist = {};
  const stopSegment = vi.fn(), stopFragment = vi.fn();
  claimPlayback(segment, stopSegment);
  claimPlayback(fragment, stopFragment);
  expect(stopSegment).toHaveBeenCalledOnce();
  claimPlayback(playlist, vi.fn());
  expect(stopFragment).toHaveBeenCalledOnce();
  expect(ownsPlayback(playlist)).toBe(true);
});

it('does not let a late completion of old playback release the new owner', () => {
  const first = {}, second = {};
  claimPlayback(first, vi.fn());
  claimPlayback(second, vi.fn());
  releasePlayback(first);
  expect(ownsPlayback(second)).toBe(true);
});

it('retains one owner during transitions between fragments of its playlist', () => {
  const playlist = {}, stop = vi.fn();
  claimPlayback(playlist, stop);
  claimPlayback(playlist, stop);
  expect(stop).not.toHaveBeenCalled();
  stopExclusivePlayback();
  expect(stop).toHaveBeenCalledOnce();
  expect(ownsPlayback(playlist)).toBe(false);
});
