import { isTauri } from '@tauri-apps/api/core';
import { isAndroid } from '../android-runtime';
import { base64 } from '../binary-base64';
import { invokeCommand } from '../tauri-commands';

export interface DeepgramHttpResult {
  status: number;
  ok: boolean;
  body: string;
}

export async function deepgramRequest(
  path: string,
  options: {
    method: 'GET' | 'POST';
    apiKey: string;
    contentType?: string;
    body?: Uint8Array;
    signal?: AbortSignal;
  },
  fetcher?: typeof fetch,
): Promise<DeepgramHttpResult> {
  options.signal?.throwIfAborted();
  const apiKey = options.apiKey.trim();

  if (!fetcher && isTauri() && !isAndroid) {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invokeCommand(invoke, 'deepgram_http', {
      method: options.method,
      path,
      apiKey,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.body?.byteLength ? { bodyBase64: base64(options.body) } : {}),
    });
    options.signal?.throwIfAborted();
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      body: result.body,
    };
  }

  const requestBody = options.body
    ? Uint8Array.from(options.body).buffer
    : undefined;
  const response = await (fetcher ?? fetch)(`https://api.deepgram.com${path}`, {
    method: options.method,
    signal: options.signal,
    headers: {
      Authorization: `Token ${apiKey}`,
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
    },
    ...(requestBody !== undefined ? { body: requestBody } : {}),
  });
  const body = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

export function readDeepgramError(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const field of ['err_msg', 'message', 'error']) {
        if (typeof record[field] === 'string' && record[field].trim()) {
          return record[field].trim();
        }
      }
    }
  } catch {
    // Keep non-JSON text or HTTP status fallback below.
  }
  const trimmed = body.trim();
  return trimmed || `HTTP ${status}`;
}
