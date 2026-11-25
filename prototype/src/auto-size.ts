// Подстраиваем нативное окно под фактический размер содержимого.
import { invokeCommand } from './tauri-commands';
import { isAndroid } from './android-runtime';

export interface WindowAutoSizer {
  resizeNow(force?: boolean): Promise<void>;
}

export function enableWindowAutoSizing(
  targetElementId: string,
  options: {
    extraHeight?: number;
    extraWidth?: number;
    nativeResizeCommand?: 'resize_overlay_to_content' | 'resize_control_panel_to_content';
    resizeDelayMs?: number;
    keepCenterOnResize?: () => boolean;
    onResizeSettled?: () => void;
  } = {},
): WindowAutoSizer | null {
  if (isAndroid) return null;
  const target = document.getElementById(targetElementId);
  if (!target) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastW = 0, lastH = 0;
  let running = false, pending = false, forceNext = false;
  let viewportSyncPending = false;
  const settleWaiters: Array<() => void> = [];

  async function waitForSettled() {
    if (!running && !pending) return;
    await new Promise<void>(resolve => settleWaiters.push(resolve));
  }

  function measure() {
    const rect = target!.getBoundingClientRect();
    return {
      width: Math.ceil(rect.width + (options.extraWidth || 0)),
      height: Math.ceil(rect.height + (options.extraHeight || 0)),
    };
  }

  async function adjust() {
    if (running) {
      pending = true;
      await waitForSettled();
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        const forced = forceNext;
        forceNext = false;
        try {
          const { width, height } = measure();
          if (!width || !height || (!forced && Math.abs(width - lastW) < 2 && Math.abs(height - lastH) < 2)) continue;
          if (options.nativeResizeCommand) {
            const { invoke } = await import('@tauri-apps/api/core');
            await invokeCommand(invoke, options.nativeResizeCommand, {
              width,
              height,
              keepCenter: options.keepCenterOnResize?.() ?? false,
            });
          } else {
            const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
              import('@tauri-apps/api/window'), import('@tauri-apps/api/dpi'),
            ]);
            await getCurrentWindow().setSize(new LogicalSize(width, height));
          }
          // Запоминаем размер только после успешного изменения нативного окна.
          lastW = width; lastH = height;
          viewportSyncPending = true;
        } catch (error) {
          if ('__TAURI_INTERNALS__' in window) console.warn('Не удалось подстроить размер окна:', error);
        }
        // A slow native call must catch up directly to the newest size, without
        // another delay or a queue of obsolete intermediate sizes.
      } while (pending);
    } finally {
      running = false;
      options.onResizeSettled?.();
      settleWaiters.splice(0).forEach(resolve => resolve());
    }
  }
  function schedule() {
    if (running) { pending = true; return; }
    // Throttle instead of debounce: continuous movement must not postpone resize.
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void adjust(); }, options.resizeDelayMs ?? 30);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(target);
  window.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  // If the native viewport finishes resizing smaller than the measured content
  // (e.g. a stale SetWindowPos landed or a resize while hidden did not stick),
  // schedule one forced re-sync as long as the content fits on screen.
  window.addEventListener('resize', () => {
    if (!viewportSyncPending) return;
    viewportSyncPending = false;
    const { width, height } = measure();
    if (!width || !height) return;
    const availW = window.screen?.availWidth || Infinity;
    const availH = window.screen?.availHeight || Infinity;
    const clippedW = window.innerWidth > 0 && window.innerWidth < Math.min(width, availW) - 1;
    const clippedH = window.innerHeight > 0 && window.innerHeight < Math.min(height, availH) - 1;
    if (clippedW || clippedH) {
      forceNext = true;
      schedule();
    }
  });
  schedule();

  return {
    async resizeNow(force = false) {
      if (force) forceNext = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await adjust();
    },
  };
}
