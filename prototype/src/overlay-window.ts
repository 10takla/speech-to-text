import type { OverlayConfig, OverlayState } from './config';
import { saveOverlayPosition } from './config';
import { invokeCommand } from './tauri-commands';
import type { Window as TauriWindow } from '@tauri-apps/api/window';

type Invoke = typeof import('@tauri-apps/api/core').invoke;

interface OverlayWindowDependencies {
  container: HTMLElement;
  dragHandle: HTMLElement;
  skeletonPreview: HTMLElement;
  getConfig(): OverlayConfig;
  getState(): OverlayState;
  getInvoke(): Invoke | null;
  settleResize?(): Promise<void>;
  isPinned?(): boolean;
}

export interface OverlayWindowController {
  readonly window: TauriWindow | null;
  readonly previewActive: boolean;
  readonly preserveCenterOnResize: boolean;
  initialize(window: TauriWindow): Promise<void>;
  restoreSavedPosition(): Promise<void>;
  initializeBrowser(): void;
  previewWidth(percent: number | null): Promise<void>;
  syncMonitorTracking(): void;
  finishPreviewResize(): void;
  updateMaxWidth(): Promise<void>;
  scheduleMaxWidthUpdate(): void;
  moveToCursorMonitor(reset?: boolean): Promise<boolean>;
  keepWithinMonitor(): Promise<void>;
}

export function createOverlayWindowController(dependencies: OverlayWindowDependencies): OverlayWindowController {
  const { container, dragHandle, skeletonPreview } = dependencies;
  let nativeWindow: TauriWindow | null = null;
  let maxWidthFrame: number | null = null;
  let maxWidthUpdateGeneration = 0;
  let monitorTrackingTimer: number | null = null;
  let widthPreviewActive = false;
  let widthPreviewFinishing = false;
  let previewGeneration = 0;
  let cachedMonitorWidth = 0;
  let cachedMonitorWorkArea: { left: number; width: number; scale: number } | undefined;
  let previewPercent = 50;
  let monitorMoveInProgress = false;
  let browserCenterX: number | null = null;
  let browserPreviewOriginalLeft: string | undefined;
  let previewHorizontalFraction = 0.5;
  let nativePreviewAnchor: { centerX: number; y: number } | undefined;
  let windowVisibilityQueue: Promise<void> = Promise.resolve();
  let nativeDragInProgress = false;

  function config() {
    return dependencies.getConfig();
  }

  function syncMonitorTracking() {
    const shouldTrack = !!nativeWindow
      && !widthPreviewActive
      && !dependencies.isPinned?.()
      && config().overlayFollowCursorMonitor
      && (dependencies.getState() !== 'idle' || widthPreviewActive);
    if (shouldTrack && monitorTrackingTimer === null) {
      monitorTrackingTimer = window.setInterval(() => { void moveToCursorMonitor(); }, 200);
    } else if (!shouldTrack && monitorTrackingTimer !== null) {
      window.clearInterval(monitorTrackingTimer);
      monitorTrackingTimer = null;
    }
  }

  function setPreviewWindowVisibility(visible: boolean): Promise<void> {
    if (!nativeWindow) return Promise.resolve();
    const targetWindow = nativeWindow;
    const operation = windowVisibilityQueue.then(async () => {
      if (widthPreviewActive !== visible) return;
      try {
        if (visible) await targetWindow.show();
        else await targetWindow.hide();
      } catch (error) {
        console.warn(`Не удалось ${visible ? 'показать' : 'скрыть'} окно предпросмотра оверлея:`, error);
      }
    });
    windowVisibilityQueue = operation.catch(() => {});
    return operation;
  }

  function setPreviewCursorEventsIgnored(ignored: boolean): Promise<void> {
    if (!nativeWindow) return Promise.resolve();
    const targetWindow = nativeWindow;
    const operation = windowVisibilityQueue.then(async () => {
      if (widthPreviewActive !== ignored) return;
      try {
        await targetWindow.setIgnoreCursorEvents(ignored);
      } catch (error) {
        console.warn('Не удалось переключить прозрачность курсора предпросмотра:', error);
      }
    });
    windowVisibilityQueue = operation.catch(() => {});
    return operation;
  }

  function scheduleMaxWidthUpdate() {
    if (maxWidthFrame !== null) window.cancelAnimationFrame(maxWidthFrame);
    maxWidthFrame = window.requestAnimationFrame(() => {
      maxWidthFrame = null;
      void updateMaxWidth();
    });
  }

  async function updateMaxWidth() {
    const generation = ++maxWidthUpdateGeneration;
    const configuredPercent = Number(config().overlayMaxWidthPercent);
    const percent = Number.isFinite(configuredPercent)
      ? Math.max(0, Math.min(100, configuredPercent))
      : 50;
    let monitorWidth = nativeWindow ? window.screen.width : window.innerWidth;
    let monitorHeight = nativeWindow ? window.screen.availHeight : window.innerHeight;
    let availableWidth = monitorWidth;
    if (nativeWindow) {
      try {
        const { currentMonitor } = await import('@tauri-apps/api/window');
        const monitor = await currentMonitor();
        if (monitor && monitor.scaleFactor > 0) {
          monitorWidth = monitor.size.width / monitor.scaleFactor;
          const area = monitor.workArea;
          monitorHeight = area.size.height / monitor.scaleFactor;
          availableWidth = area.size.width / monitor.scaleFactor;
          cachedMonitorWidth = monitorWidth;
          cachedMonitorWorkArea = { left: area.position.x, width: area.size.width, scale: monitor.scaleFactor };
        }
      } catch (error) {
        console.warn('Не удалось определить монитор оверлея:', error);
      }
    }
    if (generation !== maxWidthUpdateGeneration) return;
    const maxWidth = percent === 0 ? availableWidth : Math.min(availableWidth, monitorWidth * percent / 100);
    container.style.setProperty('--overlay-max-width', `${maxWidth}px`);
    container.style.setProperty('--overlay-max-height', `${monitorHeight}px`);
    if (widthPreviewActive) applyPreviewGeometry(monitorWidth);
  }

  function applyPreviewGeometry(monitorWidth: number) {
    const area = cachedMonitorWorkArea;
    const viewportWidth = nativeWindow && area ? area.width / area.scale : monitorWidth;
    const previewWidth = Math.min(viewportWidth, monitorWidth * previewPercent / 100);
    container.style.setProperty('--overlay-max-width', `${previewPercent === 0 ? viewportWidth : previewWidth}px`);
    container.style.setProperty('--overlay-preview-width', `${previewWidth}px`);
    container.style.setProperty('--overlay-preview-viewport-width', `${viewportWidth}px`);
    container.style.setProperty('--overlay-preview-left', `${Math.max(0, viewportWidth - previewWidth) * previewHorizontalFraction}px`);
    container.style.setProperty('--overlay-preview-before', `${previewHorizontalFraction}fr`);
    container.style.setProperty('--overlay-preview-after', `${1 - previewHorizontalFraction}fr`);
    if (!nativeWindow) container.style.left = '0px';
  }

  async function previewWidth(percent: number | null) {
    const generation = ++previewGeneration;
    if (percent === null) {
      if (!widthPreviewActive && !widthPreviewFinishing && !nativeWindow) return;
      widthPreviewActive = false;
      syncMonitorTracking();
      widthPreviewFinishing = true;
      const idle = dependencies.getState() === 'idle';
      // Содержимое скрывается независимо от завершения нативного hide().
      // Снятие класса превью не должно возвращать обычный оверлей в кадр.
      container.classList.toggle('overlay-content-hidden', !!nativeWindow && idle);
      container.classList.remove('overlay-width-preview');
      if (!nativeWindow && browserPreviewOriginalLeft !== undefined) {
        container.style.left = browserPreviewOriginalLeft;
        browserPreviewOriginalLeft = undefined;
      }
      container.style.removeProperty('--overlay-preview-width');
      container.style.removeProperty('--overlay-preview-viewport-width');
      container.style.removeProperty('--overlay-preview-left');
      container.style.removeProperty('--overlay-preview-before');
      container.style.removeProperty('--overlay-preview-after');
      skeletonPreview.classList.add('hidden');
      if (nativeWindow && idle) await setPreviewWindowVisibility(false);
      await setPreviewCursorEventsIgnored(false);
      if (generation !== previewGeneration || widthPreviewActive) return;
      await updateMaxWidth();
      await dependencies.settleResize?.();
      if (generation !== previewGeneration || widthPreviewActive) return;
      await keepWithinMonitor();
      if (generation === previewGeneration && !widthPreviewActive) nativePreviewAnchor = undefined;
      return;
    }

    const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 50;
    const shouldShowWindow = !widthPreviewActive;
    previewPercent = safePercent;
    if (!widthPreviewActive) {
      if (nativeWindow) {
        const [position, size] = await Promise.all([nativeWindow.outerPosition(), nativeWindow.outerSize()]);
        if (generation !== previewGeneration) return;
        nativePreviewAnchor = { centerX: position.x + size.width / 2, y: position.y };
        const area = cachedMonitorWorkArea;
        const freeWidth = (area?.width ?? window.screen.width) - size.width;
        previewHorizontalFraction = freeWidth > 0
          ? Math.max(0, Math.min(1, (position.x - (area?.left ?? 0)) / freeWidth)) : 0.5;
      }
      const rect = container.getBoundingClientRect();
      if (!nativeWindow) {
        browserPreviewOriginalLeft = container.style.left;
        const freeWidth = window.innerWidth - rect.width;
        previewHorizontalFraction = freeWidth > 0
          ? Math.max(0, Math.min(1, rect.left / freeWidth)) : 0.5;
      }
    }
    widthPreviewFinishing = false;
    widthPreviewActive = true;
    syncMonitorTracking();
    container.classList.add('overlay-width-preview');
    skeletonPreview.classList.remove('hidden');

    const applyPreviewWidth = (monitorWidth: number) => {
      if (generation !== previewGeneration || !widthPreviewActive) return;
      applyPreviewGeometry(monitorWidth);
    };

    applyPreviewWidth(nativeWindow ? cachedMonitorWidth || window.screen.width : window.innerWidth);
    if (nativeWindow && shouldShowWindow) {
      void setPreviewCursorEventsIgnored(true);
      await dependencies.settleResize?.();
      if (generation !== previewGeneration || !widthPreviewActive) return;
      await keepWithinMonitor();
      if (generation !== previewGeneration || !widthPreviewActive) return;
      void setPreviewWindowVisibility(true);
    }
    if (nativeWindow && !cachedMonitorWidth) {
      try {
        const { currentMonitor } = await import('@tauri-apps/api/window');
        const monitor = await currentMonitor();
        if (monitor && monitor.scaleFactor > 0) {
          cachedMonitorWidth = monitor.size.width / monitor.scaleFactor;
          cachedMonitorWorkArea = { left: monitor.workArea.position.x, width: monitor.workArea.size.width, scale: monitor.scaleFactor };
          applyPreviewWidth(cachedMonitorWidth);
        }
      } catch (error) {
        console.warn('Не удалось определить монитор для превью оверлея:', error);
      }
    }
  }

  function initializeBrowser() {
    const position = config().position;
    container.style.position = 'fixed';
    if (position) {
      container.style.left = `${position.x}px`;
      container.style.top = `${position.y}px`;
    } else {
      container.style.left = `${Math.max(10, (window.innerWidth - 360) / 2)}px`;
      container.style.top = `${Math.max(10, window.innerHeight - 280)}px`;
    }
    const initialRect = container.getBoundingClientRect();
    browserCenterX = position?.centerX ?? initialRect.left + initialRect.width / 2;
    container.style.left = `${browserCenterX - initialRect.width / 2}px`;
    void updateMaxWidth();

    const keepContainerInViewport = () => {
      const rect = container.getBoundingClientRect();
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const centerX = browserCenterX ?? rect.left + rect.width / 2;
      container.style.left = `${Math.min(Math.max(0, centerX - rect.width / 2), Math.max(0, window.innerWidth - rect.width))}px`;
      container.style.top = `${Math.min(Math.max(0, rect.top), maxTop)}px`;
    };
    new ResizeObserver(keepContainerInViewport).observe(container);
    window.addEventListener('resize', () => {
      scheduleMaxWidthUpdate();
      keepContainerInViewport();
    });
  }

  async function moveToCursorMonitor(reset = false) {
    if (dependencies.isPinned?.()) return false;
    const invoke = dependencies.getInvoke();
    if (!invoke) {
      if (!reset) return false;
      const rect = container.getBoundingClientRect();
      browserCenterX = window.innerWidth / 2;
      container.style.left = `${Math.max(0, browserCenterX - rect.width / 2)}px`;
      container.style.top = `${Math.max(0, window.innerHeight - rect.height - 24)}px`;
      if (widthPreviewActive) browserPreviewOriginalLeft = container.style.left;
      await updateMaxWidth();
      return true;
    }
    if (monitorMoveInProgress || nativeDragInProgress) return false;
    monitorMoveInProgress = true;
    try {
      const moved = await invokeCommand(invoke, 'position_overlay_on_cursor_monitor', { reset });
      if (moved) {
        await updateMaxWidth();
        if (widthPreviewActive) {
          applyPreviewGeometry(cachedMonitorWidth);
        }
      }
      return moved;
    } catch (error) {
      console.warn('Ошибка вызова position_overlay_on_cursor_monitor:', error);
      return false;
    } finally {
      monitorMoveInProgress = false;
    }
  }

  async function keepWithinMonitor() {
    if (!nativeWindow) return;
    try {
      const [{ PhysicalPosition }, { availableMonitors, monitorFromPoint }] = await Promise.all([
        import('@tauri-apps/api/dpi'),
        import('@tauri-apps/api/window'),
      ]);
      const [position, size] = await Promise.all([nativeWindow.outerPosition(), nativeWindow.outerSize()]);
      const centerX = position.x + size.width / 2;
      const centerY = position.y + size.height / 2;
      let monitor = await monitorFromPoint(centerX, centerY);
      if (!monitor) {
        const monitors = await availableMonitors();
        const closest = monitors.reduce<{ monitor: (typeof monitors)[number]; distance: number } | null>((nearest, candidate) => {
          const area = candidate.workArea;
          const right = area.position.x + area.size.width;
          const bottom = area.position.y + area.size.height;
          const dx = Math.max(area.position.x - centerX, 0, centerX - right);
          const dy = Math.max(area.position.y - centerY, 0, centerY - bottom);
          const distance = dx * dx + dy * dy;
          return !nearest || distance < nearest.distance ? { monitor: candidate, distance } : nearest;
        }, null);
        monitor = closest?.monitor ?? null;
      }
      if (!monitor) return;

      const area = monitor.workArea;
      const minX = area.position.x;
      const minY = area.position.y;
      const maxX = Math.max(minX, minX + area.size.width - size.width);
      const maxY = Math.max(minY, minY + area.size.height - size.height);
      const targetX = nativePreviewAnchor ? nativePreviewAnchor.centerX - size.width / 2 : position.x;
      const targetY = nativePreviewAnchor?.y ?? position.y;
      const x = Math.min(Math.max(Math.round(targetX), minX), maxX);
      const y = Math.min(Math.max(targetY, minY), maxY);
      if (x !== position.x || y !== position.y) await nativeWindow.setPosition(new PhysicalPosition(x, y));
    } catch (error) {
      console.warn('Не удалось удержать оверлей в пределах монитора:', error);
    }
  }

  async function initialize(native: TauriWindow) {
    nativeWindow = native;
    await dependencies.settleResize?.();
    const settings = config();
    if (settings.position) {
      try {
        await restoreSavedPosition();
      } catch (error) {
        console.warn('Не удалось восстановить сохраненную позицию:', error);
        await moveToCursorMonitor();
      }
    } else {
      await moveToCursorMonitor();
    }

    await keepWithinMonitor();
    // Старые координаты левого края переводим в центр один раз после начального resize.
    if (settings.position?.centerX === undefined) {
      await persistNativePosition();
    }
    const invoke = dependencies.getInvoke();
    if (invoke) {
      try {
        await invokeCommand(invoke, 'remember_overlay_position');
      } catch (error) {
        console.warn('Не удалось сохранить исходную относительную позицию оверлея:', error);
      }
    }
    await updateMaxWidth();
    await nativeWindow.onResized(() => { void keepWithinMonitor(); });
    try {
      await nativeWindow.onMoved(() => {
        // Событие также приходит после resize, восстановления и смены монитора.
        // Сохраняем координаты только по окончании явного перетаскивания.
        scheduleMaxWidthUpdate();
      });
    } catch (error) {
      console.warn('Ошибка подписки onMoved:', error);
    }
  }

  async function restoreSavedPosition() {
    const position = config().position;
    if (!position) return;
    if (!nativeWindow) {
      const rect = container.getBoundingClientRect();
      browserCenterX = position.centerX ?? position.x + rect.width / 2;
      const x = browserCenterX - rect.width / 2;
      container.style.left = `${Math.min(Math.max(0, x), Math.max(0, window.innerWidth - rect.width))}px`;
      container.style.top = `${Math.min(Math.max(0, position.y), Math.max(0, window.innerHeight - rect.height))}px`;
      await updateMaxWidth();
      return;
    }
    try {
      const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
      const size = await nativeWindow.outerSize();
      const x = position.centerX === undefined ? position.x : Math.round(position.centerX - size.width / 2);
      await nativeWindow.setPosition(new PhysicalPosition(x, position.y));
      await keepWithinMonitor();
      await updateMaxWidth();
    } catch (error) {
      console.warn('Не удалось восстановить сохранённую позицию оверлея:', error);
    }
  }

  dragHandle.addEventListener('mousedown', async event => {
    if (event.button !== 0 || nativeDragInProgress) return;
    if (event.target && event.target instanceof Element && !event.target.closest('.overlay-header')) return;
    // Text remains selectable; dragging is reserved for the icon and empty header space.
    if (event.target && event.target instanceof Element && event.target.closest('.overlay-title, .overlay-step-title, .overlay-step-body, .overlay-step-error, .overlay-step-controls, button, input, select, textarea')) return;
    const invoke = dependencies.getInvoke();
    if (nativeWindow && invoke) {
      nativeDragInProgress = true;
      try {
        await invokeCommand(invoke, 'start_overlay_dragging');
        // Нативное перетаскивание может не доставить mouseup в WebView.
        while (await invokeCommand(invoke, 'is_overlay_dragging')) {
          await new Promise<void>(resolve => window.setTimeout(resolve, 50));
        }
        await updateMaxWidth();
        await dependencies.settleResize?.();
        await keepWithinMonitor();
        await invokeCommand(invoke, 'remember_overlay_position');
        await persistNativePosition();
      } catch (error) {
        console.warn('Не удалось переместить окно overlay:', error);
      } finally {
        nativeDragInProgress = false;
      }
      return;
    }
    startBrowserDrag(event);
  });

  async function persistNativePosition() {
    if (!nativeWindow) return;
    const [position, size] = await Promise.all([nativeWindow.outerPosition(), nativeWindow.outerSize()]);
    const saved = { x: position.x, y: position.y, centerX: position.x + size.width / 2 };
    config().position = saved;
    saveOverlayPosition(saved);
  }

  function startBrowserDrag(event: MouseEvent) {
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = container.getBoundingClientRect();
    const initLeft = rect.left;
    const initTop = rect.top;
    container.style.position = 'fixed';
    container.style.left = `${initLeft}px`;
    container.style.top = `${initTop}px`;
    container.style.margin = '0';

    function onMouseMove(moveEvent: MouseEvent) {
      container.style.left = `${Math.max(0, initLeft + moveEvent.clientX - startX)}px`;
      container.style.top = `${Math.max(0, initTop + moveEvent.clientY - startY)}px`;
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const updatedRect = container.getBoundingClientRect();
      browserCenterX = updatedRect.left + updatedRect.width / 2;
      const saved = { x: updatedRect.left, y: updatedRect.top, centerX: browserCenterX };
      config().position = saved;
      saveOverlayPosition(saved);
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  return {
    get window() { return nativeWindow; },
    get previewActive() { return widthPreviewActive; },
    get preserveCenterOnResize() { return true; },
    initialize,
    restoreSavedPosition,
    initializeBrowser,
    previewWidth,
    syncMonitorTracking,
    finishPreviewResize() {
      if (!widthPreviewActive) widthPreviewFinishing = false;
    },
    updateMaxWidth,
    scheduleMaxWidthUpdate,
    moveToCursorMonitor,
    keepWithinMonitor,
  };
}
