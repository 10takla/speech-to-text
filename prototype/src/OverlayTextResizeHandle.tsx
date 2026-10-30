import { useLayoutEffect, useRef, useState } from 'react';

// scrollHeight also includes empty space in an already expanded viewport.
// Measure its in-flow contents so dragging can never increase its own limit.
function contentHeight(box: HTMLElement): number {
  const pixels = (style: CSSStyleDeclaration, name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const style = getComputedStyle(box);
  let height = pixels(style, 'padding-top') + pixels(style, 'padding-bottom')
    + pixels(style, 'border-top-width') + pixels(style, 'border-bottom-width');
  for (const child of box.children) {
    const childStyle = getComputedStyle(child);
    height += child.getBoundingClientRect().height + pixels(childStyle, 'margin-top') + pixels(childStyle, 'margin-bottom');
  }
  return height;
}

/** A grip inside the scrolling text block; pointer capture keeps the drag local. */
export default function OverlayTextResizeHandle() {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => { setHeight(handle.current?.parentElement?.getBoundingClientRect().height ?? 0); }, []);

  const resize = (box: HTMLElement, next: number) => {
    const em = parseFloat(getComputedStyle(box).fontSize) || 16;
    const maximum = Math.max(2.2 * em, contentHeight(box));
    const value = Math.max(2.2 * em, Math.min(maximum, next));
    box.style.maxHeight = `${maximum}px`;
    box.style.height = `${value}px`;
    box.dataset.userScrolled = 'true';
    setHeight(value);
  };
  const finish = (element: HTMLElement, pointer: number) => {
    if (drag.current?.pointer !== pointer) return;
    drag.current = null;
    if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
  };

  return <div ref={handle} className="overlay-text-resize-handle" role="separator" tabIndex={0}
    aria-label="Высота текста озвучки" aria-orientation="horizontal" aria-valuenow={Math.round(height)}
    title="Потяните, чтобы изменить высоту текста"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const box = event.currentTarget.parentElement!;
      const height = box.getBoundingClientRect().height;
      drag.current = { pointer: event.pointerId, y: event.clientY, height };
      resize(box, height);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      resize(event.currentTarget.parentElement!, start.height + event.clientY - start.y);
    }}
    onPointerUp={event => finish(event.currentTarget, event.pointerId)}
    onPointerCancel={event => finish(event.currentTarget, event.pointerId)}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); event.stopPropagation();
      const box = event.currentTarget.parentElement!;
      resize(box, box.getBoundingClientRect().height + (event.key === 'ArrowUp' ? -16 : 16));
    }} />;
}
