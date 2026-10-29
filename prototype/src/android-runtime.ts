import { invoke, isTauri } from '@tauri-apps/api/core';

interface BubbleBridge {
  request(id: string, action: string, payload: string): void;
  configuration(): string;
  maxHeight(): number;
}

declare global {
  interface Window {
    AndroidBubble?: BubbleBridge;
    bubbleReply?: (id: string, value: unknown, error: string | null) => void;
  }
}

export const isAndroidBubble = typeof window !== 'undefined' && Boolean(window.AndroidBubble);
export const isAndroid = isAndroidBubble || (typeof window !== 'undefined' && isTauri() && /Android/i.test(navigator.userAgent));

let nextRequest = 0;
const requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
if (isAndroidBubble) {
  window.bubbleReply = (id, value, error) => {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve(value);
  };
}

export function androidCall<T = void>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (isAndroidBubble) return new Promise<T>((resolve, reject) => {
    const id = String(++nextRequest);
    requests.set(id, { resolve: value => resolve(value as T), reject });
    try { window.AndroidBubble!.request(id, action, JSON.stringify(payload)); }
    catch (error) { requests.delete(id); reject(error); }
  });
  return invoke<T>('android_runtime_call', { action, payload });
}

/** Supplies the existing overlay's native output port from the Bubble WebView. */
export const bubbleInvoke: typeof invoke = async <T>(command: string, args?: Parameters<typeof invoke>[1]): Promise<T> => {
  const payload = args as Record<string, unknown> | undefined;
  if (command === 'copy_text_to_clipboard' || command === 'write_clipboard_text') {
    return androidCall<T>('copy', payload);
  }
  if (command === 'paste_text_into_active_window') return androidCall<T>('paste', payload);
  throw new Error(`Команда недоступна в оверлее: ${command}`);
};

export async function androidAudio(action: 'snapshot' | 'stop'): Promise<ArrayBuffer> {
  const result = await androidCall<{ data: string }>(action);
  if (isAndroidBubble) return Uint8Array.from(atob(result.data), char => char.charCodeAt(0)).buffer;
  const bytes = await invoke<ArrayBuffer | number[]>('decode_android_audio', { data: result.data });
  return Array.isArray(bytes) ? Uint8Array.from(bytes).buffer : bytes;
}
