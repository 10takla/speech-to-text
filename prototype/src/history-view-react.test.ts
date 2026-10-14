import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHistoryView } from './history-view-react';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
vi.mock('./history-transcript', () => ({ HistoryTranscript: () => null }));

let page: EventTarget & { hidden: boolean };
let audio: { paused: boolean }[];
const list = vi.fn(async () => []);
let history: ReturnType<typeof createHistoryView>;

beforeEach(() => {
  vi.useFakeTimers();
  page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval }));
  audio = [];
  list.mockClear();
  history = createHistoryView({ querySelectorAll: () => audio } as unknown as HTMLElement,
    () => 10, { list, add: vi.fn(), update: vi.fn() });
});

afterEach(() => {
  history.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('stops database polling while hidden and refreshes on return', async () => {
  expect(list).toHaveBeenCalledTimes(1);
  page.hidden = true;
  await vi.advanceTimersByTimeAsync(9000);
  expect(list).toHaveBeenCalledTimes(1);
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  expect(list).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3000);
  expect(list).toHaveBeenCalledTimes(3);
});

it('skips database reads during playback and resumes after playback stops', async () => {
  audio.push({ paused: false });
  await vi.advanceTimersByTimeAsync(6000);
  expect(list).toHaveBeenCalledTimes(1);
  audio[0]!.paused = true;
  await vi.advanceTimersByTimeAsync(3000);
  expect(list).toHaveBeenCalledTimes(2);
});

it('removes polling and visibility listeners when disposed', async () => {
  history.dispose();
  page.dispatchEvent(new Event('visibilitychange'));
  await history.refresh();
  await vi.advanceTimersByTimeAsync(6000);
  expect(list).toHaveBeenCalledTimes(1);
});
