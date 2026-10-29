// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observePanelColumns } from './layout';

let main: HTMLElement;
let balancedHeight: number;
let width: number;
let viewportHeight: number;
let pending: FrameRequestCallback | undefined;
let dispose: () => void;

const update = () => { const callback = pending; pending = undefined; callback?.(0); };

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  document.body.innerHTML = '<div id="control-panel-app"><main class="cp-main"></main></div>';
  document.body.style.paddingBottom = '5px';
  main = document.querySelector('main')!;
  main.style.columnWidth = '480px';
  main.style.columnGap = '12px';
  balancedHeight = 700;
  width = 1900;
  viewportHeight = 1000;
  vi.spyOn(main, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
  vi.spyOn(main, 'getBoundingClientRect').mockImplementation(() => ({
    top: 5 - window.scrollY, height: balancedHeight,
  } as DOMRect));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pending = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { pending = undefined; });
  dispose = observePanelColumns(main);
});

afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.body.className = '';
  Reflect.deleteProperty(document, 'fonts');
});

it('fills columns to the available window height when all content fits', () => {
  update();
  expect(main.style.height).toBe('990px');
  expect(main.style.columnFill).toBe('auto');
});

it('returns to natural balancing when growing content exceeds the window', () => {
  update();
  balancedHeight = 1300;
  window.dispatchEvent(new Event('resize'));
  update();
  expect(main.style.height).toBe('');
  expect(main.style.columnFill).toBe('');
  balancedHeight = 600;
  window.dispatchEvent(new Event('resize'));
  update();
  expect(main.style.height).toBe('990px');
});

it('recomputes the mode when only window height changes', () => {
  update();
  viewportHeight = 600;
  window.dispatchEvent(new Event('resize'));
  update();
  expect(main.style.height).toBe('');
});

it('does not treat the scrolled position as extra available height', () => {
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(400);
  update();
  expect(main.style.height).toBe('990px');
});

it('keeps narrow single-column windows in normal document flow', () => {
  update();
  width = 640;
  window.dispatchEvent(new Event('resize'));
  update();
  expect(main.style.height).toBe('');
});

it('does not apply desktop column heights on Android', () => {
  document.body.classList.add('android-app');
  update();
  expect(main.style.height).toBe('');
});
