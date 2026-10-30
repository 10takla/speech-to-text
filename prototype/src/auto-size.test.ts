// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableWindowAutoSizing } from './auto-size';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('./android-runtime', () => ({ isAndroid: false }));
let resized: ResizeObserverCallback;
let height = 100;

beforeEach(() => {
  vi.useFakeTimers();
  native.invoke.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {} disconnect() {}
  });
  document.body.innerHTML = '<div id="sized"></div>';
  height = 100;
  vi.spyOn(document.getElementById('sized')!, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, 0, 400, height));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function change(next: number) {
  height = next;
  resized([], {} as ResizeObserver);
}
function setup() {
  return enableWindowAutoSizing('sized', { nativeResizeCommand: 'resize_overlay_to_content', resizeDelayMs: 16 })!;
}

it('updates the native window during continuous dragging without waiting for a pause', async () => {
  const sizer = setup(); await sizer.resizeNow(); native.invoke.mockClear();
  for (let i = 0; i < 20; i++) {
    change(110 + i * 5);
    await vi.advanceTimersByTimeAsync(8);
  }
  expect(native.invoke.mock.calls.length).toBeGreaterThanOrEqual(8);
  expect(native.invoke.mock.lastCall?.[1]?.height).toBeGreaterThanOrEqual(195);
});

it('immediately catches up to the latest size after a slow native resize', async () => {
  const sizer = setup(); await sizer.resizeNow(); native.invoke.mockClear();
  let release!: () => void;
  native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  change(120); await vi.advanceTimersByTimeAsync(16);
  change(140); change(180); change(220);
  await vi.advanceTimersByTimeAsync(16);
  expect(native.invoke).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(native.invoke).toHaveBeenCalledTimes(2);
  expect(native.invoke.mock.lastCall?.[1]?.height).toBe(220);
});

it('resizeNow waits for the newest size and skips unchanged dimensions', async () => {
  const sizer = setup(); await sizer.resizeNow(); native.invoke.mockClear();
  let release!: () => void;
  native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  height = 120; const first = sizer.resizeNow();
  await vi.advanceTimersByTimeAsync(0);
  height = 200; const latest = sizer.resizeNow();
  let settled = false; void latest.then(() => { settled = true; });
  expect(settled).toBe(false);
  release(); await Promise.all([first, latest]);
  expect(native.invoke.mock.lastCall?.[1]?.height).toBe(200);
  expect(settled).toBe(true);
  await sizer.resizeNow();
  expect(native.invoke).toHaveBeenCalledTimes(2);
});
