import { invoke, isTauri } from '@tauri-apps/api/core';
import { androidCall, isAndroid } from './android-runtime';
import { piperBaseUrl } from './speech-provider-settings';

export type PiperRoute = 'voices' | 'info' | 'all-voices' | 'download' | 'synthesize';

// Piper's own server does not send CORS headers. Native transport also works from the Android bubble.
export async function piperFetch(baseUrl: string, route: PiperRoute, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const url = piperBaseUrl(baseUrl);
  signal?.throwIfAborted();
  if (!isTauri() && !isAndroid) return fetch(`${url}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const request = { baseUrl: url, route, body: body === undefined ? '' : JSON.stringify(body) };
  const pending = isAndroid
    ? androidCall<{ status: number; data: string }>('piperHttp', request)
    : invoke<{ status: number; data: string }>('piper_http', request);
  let abort = () => {};
  try {
    const result = await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason ?? new DOMException('Отменено', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
    return new Response(Uint8Array.from(atob(result.data), char => char.charCodeAt(0)), {
      status: result.status, headers: { 'Content-Type': route === 'synthesize' ? 'audio/wav' : 'application/json' },
    });
  } finally { signal?.removeEventListener('abort', abort); }
}
