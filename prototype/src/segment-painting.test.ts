import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachSegmentPainting } from './segment-painting';

let cleanup: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); });

function harness() {
  const view = new EventTarget();
  const words = Array.from({ length: 4 }, () => ({
    deleted: false,
    classList: { contains: (_name: string): boolean => false },
    closest: (selector: string): unknown => selector === '[data-segment]' ? undefined : null,
  }));
  words.forEach(word => {
    word.classList.contains = name => name === 'deleted' && word.deleted;
    word.closest = selector => selector === '[data-segment]' ? word : null;
  });
  const capture = new Set<number>();
  const panel = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: view, elementFromPoint: (x: number, y: number) => words[(y >= 20 ? 2 : 0) + Math.floor(x / 20)] },
    querySelectorAll: () => words,
    contains: (node: unknown) => words.includes(node as typeof words[number]),
    setPointerCapture: vi.fn((id: number) => capture.add(id)),
    hasPointerCapture: (id: number) => capture.has(id),
    releasePointerCapture: (id: number) => capture.delete(id),
  });
  const changes = vi.fn();
  const painters = new WeakMap<HTMLElement, { setDeleted(value: boolean): boolean; refresh(): void }>();
  words.forEach(word => painters.set(word as unknown as HTMLElement, {
    setDeleted(value) {
      changes(words.indexOf(word), value);
      const changed = word.deleted !== value;
      word.deleted = value;
      return changed;
    }, refresh: vi.fn(),
  }));
  cleanup = attachSegmentPainting(panel as unknown as HTMLElement, painters);
  function pointer(target: EventTarget, type: string, x: number, y = 5, word?: unknown, pointerId = 1) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      button: { value: 0 }, pointerType: { value: 'touch' }, pointerId: { value: pointerId },
      clientX: { value: x }, clientY: { value: y }, ...(word ? { target: { value: word } } : {}),
    });
    target.dispatchEvent(event);
    return event;
  }
  return { panel, view, words, changes, pointer };
}

it('keeps a short touch tap available to the segment click handler', () => {
  const h = harness();
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  vi.advanceTimersByTime(100);
  h.pointer(h.view, 'pointerup', 5);
  expect(h.panel.setPointerCapture).not.toHaveBeenCalled();
  expect(h.changes).not.toHaveBeenCalled();
  expect(h.pointer(h.panel, 'click', 5, 5, h.words[0]).defaultPrevented).toBe(false);
});

it('captures a held touch and paints across words and rows without toggling twice on release', () => {
  const h = harness();
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  vi.advanceTimersByTime(220);
  expect(h.panel.setPointerCapture).toHaveBeenCalledWith(1);
  expect(h.pointer(h.view, 'pointermove', 25).defaultPrevented).toBe(true);
  h.pointer(h.view, 'pointermove', 25, 25);
  expect(h.words.map(word => word.deleted)).toEqual([true, true, false, true]);
  h.pointer(h.view, 'pointerup', 25, 25);
  expect(h.panel.hasPointerCapture(1)).toBe(false);
  expect(h.pointer(h.panel, 'click', 25, 25, h.words[3]).defaultPrevented).toBe(true);
});

it('starts painting on a drag without waiting for the hold timer and paints the starting word', () => {
  const h = harness();
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  h.pointer(h.view, 'pointermove', 35);
  expect(h.words.map(word => word.deleted)).toEqual([true, true, false, false]);
  expect(h.panel.setPointerCapture).toHaveBeenCalledWith(1);
});

it('restores excluded words when the gesture starts on an excluded segment', () => {
  const h = harness();
  h.words[0].deleted = h.words[1].deleted = true;
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  vi.advanceTimersByTime(220);
  h.pointer(h.view, 'pointermove', 35);
  h.pointer(h.view, 'pointermove', 5);
  expect(h.words.every(word => !word.deleted)).toBe(true);
  expect(h.changes).toHaveBeenCalledTimes(2);
});

it('cancels pending holds and prevents the native long-press context menu', () => {
  const h = harness();
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  h.pointer(h.view, 'pointercancel', 5);
  vi.advanceTimersByTime(500);
  expect(h.changes).not.toHaveBeenCalled();
  expect(h.pointer(h.panel, 'contextmenu', 5).defaultPrevented).toBe(true);
});

it('ignores a second touch and releases timers and capture when the editor is disposed', () => {
  const h = harness();
  h.pointer(h.panel, 'pointerdown', 5, 5, h.words[0]);
  h.pointer(h.view, 'pointermove', 35, 5, undefined, 2);
  expect(h.changes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(220);
  cleanup!();
  expect(h.panel.hasPointerCapture(1)).toBe(false);
  h.pointer(h.view, 'pointermove', 25, 25);
  expect(h.words.map(word => word.deleted)).toEqual([true, false, false, false]);
});
