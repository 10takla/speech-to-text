export const DEFAULT_AFTER_STOP_MS = 150;

export function normalizeAfterStopMs(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : DEFAULT_AFTER_STOP_MS;
}

// Browser/Android capture remains active for the requested extra recording time.
// Desktop capture applies the boundary directly on the audio stream's clock.
export function waitForStopTail(requestedAtMs: number, afterStopMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + Math.max(0, requestedAtMs + normalizeAfterStopMs(afterStopMs) - Date.now());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Запись отменена', 'AbortError')); };
    const check = () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { cleanup(); resolve(); }
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}
