import { afterEach, expect, it, vi } from 'vitest';
import { normalizeAfterStopMs, waitForStopTail } from './recording-stop';

afterEach(() => vi.useRealTimers());

it('defaults to 150 ms while preserving zero and accepting only nonnegative integers', () => {
  expect([undefined, -1, 0.5, NaN, Infinity].map(normalizeAfterStopMs)).toEqual([150, 150, 150, 150, 150]);
  expect(normalizeAfterStopMs(0)).toBe(0);
});

it('records only the remaining tail when handling stop late', async () => {
  vi.useFakeTimers();
  const clicked = Date.now();
  await vi.advanceTimersByTimeAsync(100);
  const finished = vi.fn();
  const stopping = waitForStopTail(clicked, 150).then(finished);
  await vi.advanceTimersByTimeAsync(49);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  expect(finished).toHaveBeenCalledOnce();
});

it('cancels the extra recording time immediately', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const stopping = waitForStopTail(Date.now(), 150, controller.signal);
  const rejected = expect(stopping).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
