import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryAudioExcerpt } from './history-audio-excerpt';

export interface HistoryAudioMenuState {
  x: number;
  y: number;
  excerpt?: HistoryAudioExcerpt;
  anchor: HTMLElement | null;
}

export function HistoryAudioMenu({ menu, onClose, onAction }: {
  menu: HistoryAudioMenuState;
  onClose(): void;
  onAction(action: 'download' | 'transcribe', excerpt?: HistoryAudioExcerpt): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current!;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (event.target instanceof Node && !element.contains(event.target)) onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); onClose();
      menu.anchor?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);

  return createPortal(<div ref={root} className="history-audio-context-menu" role="menu"
    aria-label={menu.excerpt?.label ?? 'Запись'} style={{ left: menu.x, top: menu.y }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.current!.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    <span className="history-audio-context-label">{menu.excerpt?.label ?? 'Запись'}</span>
    <button type="button" role="menuitem" onClick={() => onAction('download', menu.excerpt)}>Скачать</button>
    <button type="button" role="menuitem" onClick={() => onAction('transcribe', menu.excerpt)}>Транскрибировать и скопировать</button>
  </div>, document.body);
}
