import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { defaultSettings, loadSettings, saveSettings, type OverlayState } from './config';
import { createOverlayWindowController } from './overlay-window';

vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: async () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1,
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } }),
  monitorFromPoint: async () => ({
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
  }),
  availableMonitors: async () => [],
}));
vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {
    x: number;
    y: number;
    constructor(x: number, y: number) { this.x = x; this.y = y; }
  },
}));

function element(initialClasses: string[] = []): HTMLElement {
  const classes = new Set(initialClasses);
  const properties = new Map<string, string>();
  return {
    classList: {
      add: (...names: string[]) => { names.forEach(name => classes.add(name)); },
      remove: (...names: string[]) => { names.forEach(name => classes.delete(name)); },
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
    style: {
      setProperty: (name: string, value: string) => { properties.set(name, value); },
      removeProperty: (name: string) => { properties.delete(name); },
      getPropertyValue: (name: string) => properties.get(name) ?? '',
    },
    getBoundingClientRect: () => ({ width: 260, height: 54 }),
    addEventListener: vi.fn(),
  } as unknown as HTMLElement;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(state: OverlayState = 'idle') {
  const container = element();
  const skeleton = element(['hidden']);
  const native = {
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 260, height: 54 }),
    onResized: vi.fn(),
    onMoved: vi.fn(),
  };
  const settings = defaultSettings();
  const controller = createOverlayWindowController({
    container,
    skeletonPreview: skeleton,
    dragHandle: element(),
    getConfig: () => settings,
    getState: () => state,
    getInvoke: () => null,
  });
  await controller.initialize(native as unknown as TauriWindow);
  return { controller, container, skeleton, native };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('window', { screen: { width: 1920 }, setTimeout, clearTimeout, setInterval: () => 1,
    clearInterval: () => {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('overlay width preview visibility', () => {
  it.each([40, 1620])('shrinks both monitor margins proportionally from x=%s without resizing the preview window', async initialX => {
    const settings = defaultSettings();
    const centerX = initialX + 130;
    settings.position = { x: initialX, y: 120, centerX };
    const geometry = { x: initialX, y: 120, width: 260, height: 54 };
    let restoreSize = false;
    const native = {
      outerPosition: async () => ({ x: geometry.x, y: geometry.y }),
      outerSize: async () => ({ width: geometry.width, height: geometry.height }),
      setPosition: vi.fn(async (position: { x: number; y: number }) => { Object.assign(geometry, position); }),
      show: vi.fn(), hide: vi.fn(), setIgnoreCursorEvents: vi.fn(),
      onResized: vi.fn(), onMoved: vi.fn(),
    };
    const container = element();
    const controller = createOverlayWindowController({
      container, dragHandle: element(), skeletonPreview: element(),
      getConfig: () => settings, getState: () => 'idle', getInvoke: () => null,
      settleResize: async () => { if (restoreSize) geometry.width = 260; },
    });
    await controller.initialize(native as unknown as TauriWindow);
    for (const percent of [50, 100, 25, 50]) {
      await controller.previewWidth(percent);
      const previewWidth = 1920 * percent / 100;
      expect(container.style.getPropertyValue('--overlay-max-width')).toBe(`${previewWidth}px`);
      const left = Number.parseFloat(container.style.getPropertyValue('--overlay-preview-left'));
      expect(left).toBeCloseTo((1920 - previewWidth) * initialX / (1920 - 260));
      if (percent < 100) {
        expect(left).toBeGreaterThan(0);
        expect(1920 - left - previewWidth).toBeGreaterThan(0);
      } else expect(left).toBe(0);
      expect(container.style.getPropertyValue('--overlay-preview-viewport-width')).toBe('1920px');
      expect(Number.parseFloat(container.style.getPropertyValue('--overlay-preview-before'))).toBeCloseTo(initialX / (1920 - 260));
      geometry.width = 1920;
      await controller.keepWithinMonitor();
      expect(geometry.x).toBe(0);
      expect(geometry.y).toBe(120);
    }
    restoreSize = true;
    await controller.previewWidth(null);
    expect(geometry.x).toBe(initialX);
    expect(settings.position).toEqual({ x: initialX, y: 120, centerX });
  });

  it('cancels a show when enter and leave happen before native work starts', async () => {
    const { controller, container, skeleton, native } = await setup();
    const entered = controller.previewWidth(50);
    const left = controller.previewWidth(null);
    await Promise.all([entered, left]);
    expect(native.show).not.toHaveBeenCalled();
    expect(native.hide).toHaveBeenCalledOnce();
    expect(skeleton.classList.contains('hidden')).toBe(true);
    expect(container.classList.contains('overlay-content-hidden')).toBe(true);
  });

  it('keeps ordinary content hidden on a quick leave while native show and hide are unfinished', async () => {
    const { controller, container, skeleton, native } = await setup();
    const showing = deferred();
    const hiding = deferred();
    native.show.mockImplementation(() => showing.promise);
    native.hide.mockImplementation(() => hiding.promise);

    await controller.previewWidth(50);
    await vi.waitFor(() => expect(native.show).toHaveBeenCalledOnce());
    const stopped = controller.previewWidth(null);

    expect(skeleton.classList.contains('hidden')).toBe(true);
    expect(container.classList.contains('overlay-width-preview')).toBe(false);
    expect(container.classList.contains('overlay-content-hidden')).toBe(true);
    showing.resolve();
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());
    expect(container.classList.contains('overlay-content-hidden')).toBe(true);
    hiding.resolve();
    await stopped;
    expect(container.classList.contains('overlay-content-hidden')).toBe(true);
  });

  it('preserves a new preview when the previous native hide completes', async () => {
    const { controller, container, skeleton, native } = await setup();
    const hiding = deferred();
    native.hide.mockImplementation(() => hiding.promise);
    await controller.previewWidth(25);
    await vi.waitFor(() => expect(native.show).toHaveBeenCalledOnce());
    const stopped = controller.previewWidth(null);
    await vi.waitFor(() => expect(native.hide).toHaveBeenCalledOnce());

    await controller.previewWidth(75);
    hiding.resolve();
    await stopped;
    await vi.waitFor(() => expect(native.show).toHaveBeenCalledTimes(2));
    expect(controller.previewActive).toBe(true);
    expect(container.classList.contains('overlay-width-preview')).toBe(true);
    expect(skeleton.classList.contains('hidden')).toBe(false);
    expect(container.style.getPropertyValue('--overlay-preview-width')).toBe('1440px');
  });

  it('restores ordinary content for an active recording', async () => {
    const { controller, container, skeleton, native } = await setup('recording');
    await controller.previewWidth(50);
    await controller.previewWidth(null);
    expect(container.classList.contains('overlay-content-hidden')).toBe(false);
    expect(skeleton.classList.contains('hidden')).toBe(true);
    expect(native.hide).not.toHaveBeenCalled();
  });
});

describe('overlay position persistence', () => {
  it('restores the browser position near the bottom after the previous content was taller', async () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    const container = element();
    const geometry = { left: 470, top: 500, width: 260, height: 300 };
    container.getBoundingClientRect = () => geometry as DOMRect;
    const settings = defaultSettings();
    settings.position = { x: 470, y: 746, centerX: 600 };
    const controller = createOverlayWindowController({
      container, dragHandle: element(), skeletonPreview: element(),
      getConfig: () => settings, getState: () => 'recording', getInvoke: () => null,
    });
    await controller.restoreSavedPosition();
    expect(container.style.top).toBe('500px');
    geometry.height = 54;
    await controller.restoreSavedPosition();
    expect(container.style.top).toBe('746px');
    expect(settings.position).toEqual({ x: 470, y: 746, centerX: 600 });
  });
  it('resets the browser overlay to the bottom center without native commands', async () => {
    Object.assign(window, { innerWidth: 1200, innerHeight: 800 });
    const container = element();
    container.style.left = '40px';
    container.style.top = '50px';
    const settings = defaultSettings();
    const controller = createOverlayWindowController({
      container, dragHandle: element(), skeletonPreview: element(),
      getConfig: () => settings, getState: () => 'idle', getInvoke: () => null,
    });
    expect(await controller.moveToCursorMonitor(true)).toBe(true);
    expect(container.style.left).toBe('470px');
    expect(container.style.top).toBe('722px');
    expect(settings.position).toBeNull();
  });

  async function geometrySetup(pinned = false) {
    const settings = defaultSettings();
    settings.position = { x: 700, y: 80, centerX: 960 };
    saveSettings(settings);
    const geometry = { x: 700, y: 80, width: 520, height: 54 };
    const native = {
      outerPosition: async () => ({ x: geometry.x, y: geometry.y }),
      outerSize: async () => ({ width: geometry.width, height: geometry.height }),
      setPosition: vi.fn(async (position: { x: number; y: number }) => {
        geometry.x = position.x; geometry.y = position.y;
      }),
      onResized: vi.fn(async (_callback: () => void) => {}),
      onMoved: vi.fn(async (_callback: (event: unknown) => void) => {}),
    };
    const dragHandle = element();
    const invoke = vi.fn(async (_command: string, _payload?: unknown): Promise<unknown> => undefined);
    const settleResize = vi.fn(async () => {});
    const controller = createOverlayWindowController({
      container: element(), dragHandle, skeletonPreview: element(),
      getConfig: () => settings, getState: () => 'recording',
      getInvoke: () => invoke as unknown as typeof import('@tauri-apps/api/core').invoke,
      settleResize,
      isPinned: () => pinned,
    });
    await controller.initialize(native as unknown as TauriWindow);
    return { settings, geometry, native, controller, dragHandle, invoke, settleResize };
  }

  it('requests an explicit reset instead of restoring the old monitor anchor', async () => {
    const { controller, invoke } = await geometrySetup();
    await controller.moveToCursorMonitor(true);
    expect(invoke).toHaveBeenCalledWith('position_overlay_on_cursor_monitor', { reset: true });
    await controller.moveToCursorMonitor();
    expect(invoke).toHaveBeenCalledWith('position_overlay_on_cursor_monitor', { reset: false });
  });

  it('does not follow the cursor to another monitor while text is being selected', async () => {
    const { controller, invoke } = await geometrySetup(true);
    invoke.mockClear();
    expect(await controller.moveToCursorMonitor()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores delayed and reordered resize/move events and restores the same center for any width', async () => {
    const { geometry, native, controller } = await geometrySetup();
    const saved = loadSettings().position;
    const moved = native.onMoved.mock.calls[0][0] as unknown as (event: unknown) => void;
    const resized = native.onResized.mock.calls[0][0] as unknown as () => void;
    for (const width of [1100, 120, 840, 260, 1101, 521]) {
      geometry.width = width;
      geometry.x = 960 - width / 2;
      // Старое событие перемещения доставлено после нового размера.
      moved({ payload: { x: 400, y: 500 } });
      resized();
      moved({ payload: { x: geometry.x, y: geometry.y } });
      expect(loadSettings().position).toEqual(saved);
      geometry.x = 30;
      await controller.restoreSavedPosition();
      expect(Math.abs(geometry.x + width / 2 - 960)).toBeLessThanOrEqual(.5);
      expect(geometry.y).toBe(80);
    }
  });

  it('saves only after the native mouse button is released and resize has settled', async () => {
    const { geometry, controller, dragHandle, invoke, settleResize } = await geometrySetup();
    const initial = loadSettings().position;
    let held = true;
    invoke.mockImplementation(async (...args: unknown[]) => args[0] === 'is_overlay_dragging' ? held : undefined);
    settleResize.mockImplementation(async () => { geometry.width = 400; geometry.x = 500; geometry.y = 200; });
    const mouseDown = vi.mocked(dragHandle.addEventListener).mock.calls[0][1] as unknown as
      (event: { button: number }) => Promise<void>;
    const dragging = mouseDown({ button: 0 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('is_overlay_dragging', undefined));
    expect(loadSettings().position).toEqual(initial);
    expect(await controller.moveToCursorMonitor()).toBe(false);
    held = false;
    await dragging;
    expect(loadSettings().position).toEqual({ x: 500, y: 200, centerX: 700 });
    expect(invoke).toHaveBeenCalledWith('remember_overlay_position', undefined);
  });
});
