// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import OverlaySteps from './OverlaySteps';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function mount(speech = true, contentHeight = 300) {
  act(() => root.render(<OverlaySteps steps={[{ id: 'speech', title: 'Озвучка', status: 'success', body: 'Текст озвучки', speech }]} />));
  const body = host.querySelector<HTMLElement>('.overlay-step-body')!;
  body.style.fontSize = '16px';
  body.style.paddingTop = '3px';
  body.style.paddingBottom = '3px';
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 140));
  vi.spyOn(body.querySelector<HTMLElement>('.overlay-step-text')!, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 500, contentHeight - 13));
  const handle = body.querySelector<HTMLElement>('[role="separator"]');
  if (handle) {
    handle.style.marginBottom = '-3px';
    vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 10));
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
  }
  return { body, handle };
}
function pointer(handle: HTMLElement, type: string, y: number, pointerId = 1) {
  act(() => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientY: y, pointerId, button: 0 })));
}

it('resizes only the speech text with an internal drag handle, then stops on release', () => {
  const { body, handle } = mount();
  expect(handle).not.toBeNull();
  pointer(handle!, 'pointerdown', 100);
  expect(body.style.height).toBe('140px');
  pointer(handle!, 'pointermove', 160);
  expect(body.style.height).toBe('200px');
  expect(body.dataset.userScrolled).toBe('true');
  expect(host.style.height).toBe('');
  expect(body.parentElement!.style.height).toBe('');
  pointer(handle!, 'pointerup', 160);
  pointer(handle!, 'pointermove', 210);
  expect(body.style.height).toBe('200px');
});

it('bounds the height and ignores other pointers and cancelled drags', () => {
  const { body, handle } = mount();
  expect(handle).not.toBeNull();
  pointer(handle!, 'pointerdown', 100);
  pointer(handle!, 'pointermove', 200, 2);
  expect(body.style.height).toBe('140px');
  pointer(handle!, 'pointermove', -1000);
  expect(parseFloat(body.style.height)).toBeCloseTo(35.2);
  pointer(handle!, 'pointermove', 2000);
  expect(body.style.height).toBe('300px');
  pointer(handle!, 'pointercancel', 2000);
  pointer(handle!, 'pointermove', 120);
  expect(body.style.height).toBe('300px');
});

it('does not grow when all text is visible, even across repeated drags', () => {
  const { body, handle } = mount(true, 140);
  for (let attempt = 0; attempt < 3; attempt++) {
    pointer(handle!, 'pointerdown', 100);
    pointer(handle!, 'pointermove', 1000);
    pointer(handle!, 'pointerup', 1000);
    expect(body.style.height).toBe('140px');
  }
});

it('limits a previously oversized block to the natural text height', () => {
  const { body, handle } = mount(true, 80);
  pointer(handle!, 'pointerdown', 100);
  pointer(handle!, 'pointermove', 1000);
  expect(body.style.height).toBe('80px');
});

it('offers keyboard height adjustment without changing other text steps', () => {
  const { body, handle } = mount();
  expect(handle).not.toBeNull();
  act(() => handle!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })));
  expect(body.style.height).toBe('156px');
  mount(false);
  expect(host.querySelector('[role="separator"]')).toBeNull();
});
