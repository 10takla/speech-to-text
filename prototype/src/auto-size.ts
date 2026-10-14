// Подстраиваем нативное окно под фактический размер содержимого.
import { invokeCommand } from './tauri-commands';
import { isAndroid } from './android-runtime';

export interface WindowAutoSizer {
  resizeNow(): Promise<void>;
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
  let running = false, pending = false;
  const settleWaiters: Array<() => void> = [];

  async function waitForSettled() {
    if (!running && !pending) return;
    await new Promise<void>(resolve => settleWaiters.push(resolve));
  }

  async function adjust() {
    if (running) {
      pending = true;
      await waitForSettled();
      return;
    }
    running = true;
    try {
      const rect = target!.getBoundingClientRect();
      const width = Math.ceil(rect.width + (options.extraWidth || 0));
      const height = Math.ceil(rect.height + (options.extraHeight || 0));
      if (!width || !height || (Math.abs(width - lastW) < 2 && Math.abs(height - lastH) < 2)) return;
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
    } catch (error) {
      if ('__TAURI_INTERNALS__' in window) console.warn('Не удалось подстроить размер окна:', error);
    } finally {
      running = false;
      if (pending) { pending = false; schedule(); }
      else {
        options.onResizeSettled?.();
        settleWaiters.splice(0).forEach(resolve => resolve());
      }
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void adjust(); }, options.resizeDelayMs ?? 30);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(target);
  window.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  schedule();

  return {
    async resizeNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await adjust();
    },
  };
}
