import { isAndroid } from './android-runtime';

type OverlayPreviewMessage = {
  type: 'overlay-width-preview';
  percent: number | null;
};

const browserPreviewEnabled = import.meta.env.DEV && !isAndroid && !('__TAURI_INTERNALS__' in window);
const channel = browserPreviewEnabled && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('speech-to-text-overlay-preview')
  : null;

export function isBrowserOverlayPreviewEnabled() {
  return channel !== null;
}

export function sendOverlayWidthPreview(percent: number | null) {
  channel?.postMessage({ type: 'overlay-width-preview', percent } satisfies OverlayPreviewMessage);
}

export function listenForOverlayWidthPreview(handler: (percent: number | null) => void) {
  if (!channel) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!event.data || typeof event.data !== 'object') return;
    const message = event.data as Partial<OverlayPreviewMessage>;
    if (message.type !== 'overlay-width-preview') return;
    if (message.percent !== null && (typeof message.percent !== 'number' || !Number.isFinite(message.percent))) return;
    handler(message.percent);
  };
  channel.addEventListener('message', onMessage);
  return () => channel.removeEventListener('message', onMessage);
}
