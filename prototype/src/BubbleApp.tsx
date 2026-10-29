import { useEffect, useState } from 'react';
import OverlayApp, { Waveform } from './OverlayApp';
import { androidCall } from './android-runtime';
import type { OverlayState } from './config';
import './bubble.scss';

const send = (action: string) => window.dispatchEvent(new CustomEvent('android-runtime-event', { detail: { action, text: '' } }));

export default function BubbleApp() {
  const [state, setState] = useState<OverlayState>('idle');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const updateState = (event: Event) => setState((event as CustomEvent<OverlayState>).detail);
    const initialized = () => setReady(true);
    window.addEventListener('android-ui-state', updateState);
    window.addEventListener('android-bubble-ready', initialized);
    const content = document.querySelector('.bubble-root')!;
    let lastHeight = 0;
    const resize = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height === lastHeight || !height) return;
      lastHeight = height;
      void androidCall('resizeBubble', { height }).catch(console.warn);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    resize();

    return () => {
      observer.disconnect();
      window.removeEventListener('android-ui-state', updateState);
      window.removeEventListener('android-bubble-ready', initialized);
    };
  }, []);
  const busy = state === 'transcribing';
  const active = state === 'recording' || state === 'editing';
  return <div className="bubble-root" data-state={state}>
    <OverlayApp showWaveform={false} />
    <div className="bubble-controls" role="toolbar" aria-label="Голосовой ввод">
      <div hidden={state !== 'recording' && !busy}><Waveform /></div>
      {active ? <>
        <button className="bubble-action" disabled={!ready} title="Отмена" aria-label="Отмена" onClick={() => send('cancel-hotkey')}><svg viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6" fill="none" stroke="currentColor" strokeWidth="2" /></svg></button>
        <button className="bubble-action" disabled={!ready} title={state === 'editing' ? 'Продолжить запись' : 'Пауза'} aria-label={state === 'editing' ? 'Продолжить запись' : 'Пауза'} onClick={() => send('pause-hotkey')}>
        {state === 'editing' ? <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg> : <svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>}
        </button>
        <button className="bubble-action" disabled={!ready || busy} title="Остановить запись" aria-label="Остановить запись" onClick={() => send('record-hotkey')}>
          <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
      </> : <button className="bubble-action" disabled={!ready} title="Запись" aria-label="Запись" onClick={() => send('record-hotkey')}>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /></svg>
      </button>}
    </div>
  </div>;
}
