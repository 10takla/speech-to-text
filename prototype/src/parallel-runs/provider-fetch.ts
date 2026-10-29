type Waiting = (waiting: boolean) => void;
type Job = { execute(): Promise<void>; cancel(): void };
type Limit = { until: number; jobs: Job[]; busy: boolean; timer?: ReturnType<typeof setTimeout> };
const transports = new WeakMap<typeof fetch, Map<string, Limit>>();

function drain(limit: Limit) {
  if (limit.busy || !limit.jobs.length || limit.timer) return;
  const delay = limit.until - Date.now();
  if (delay > 0) { limit.timer = setTimeout(() => { limit.timer = undefined; drain(limit); }, Math.min(delay, 2_147_483_647)); return; }
  const job = limit.jobs.shift()!;
  limit.busy = true;
  void job.execute().finally(() => { limit.busy = false; drain(limit); });
}

function retryDelay(response: Response, attempt: number) {
  const value = response.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }
  return 1000 * 2 ** attempt;
}

/** Requests run concurrently until the provider reports a limit for these credentials. */
export function createProviderFetch(fetcher: typeof fetch = fetch, onWaiting?: Waiting): typeof fetch {
  let limits = transports.get(fetcher);
  if (!limits) { limits = new Map(); transports.set(fetcher, limits); }
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const headers = new Headers(init?.headers ?? request?.headers);
    const credentials = headers.get('authorization') ?? headers.get('x-goog-api-key') ?? headers.get('xi-api-key') ?? url.searchParams.get('key') ?? '';
    const key = `${url.origin}\n${credentials}`;
    let limit = limits!.get(key);
    if (!limit) { limit = { until: 0, jobs: [], busy: false }; limits!.set(key, limit); }
    const signal = init?.signal ?? request?.signal;
    const send = async (attempt: number): Promise<Response> => {
      signal?.throwIfAborted();
      const response = await fetcher(request ? request.clone() : input, init);
      if (response.status !== 429 || attempt >= 3) return response;
      limit!.until = Math.max(limit!.until, Date.now() + retryDelay(response, attempt));
      await response.body?.cancel().catch(() => {});
      return enqueue(attempt + 1);
    };
    const enqueue = (attempt: number): Promise<Response> => {
      signal?.throwIfAborted();
      onWaiting?.(true);
      return new Promise<Response>((resolve, reject) => {
        let running = false;
        const cleanup = () => { signal?.removeEventListener('abort', abort); onWaiting?.(false); };
        const abort = () => {
          if (running) return;
          const index = limit!.jobs.indexOf(job);
          if (index >= 0) limit!.jobs.splice(index, 1);
          cleanup(); reject(signal?.reason ?? new DOMException('Отменено', 'AbortError'));
          drain(limit!);
        };
        const job: Job = {
          cancel: abort,
          execute: async () => {
            running = true;
            cleanup();
            try {
              signal?.throwIfAborted();
              // Release the dispatcher before re-enqueuing a rate-limited retry.
              const response = await fetcher(request ? request.clone() : input, init);
              if (response.status === 429 && attempt < 3) {
                limit!.until = Math.max(limit!.until, Date.now() + retryDelay(response, attempt));
                await response.body?.cancel().catch(() => {});
                void enqueue(attempt + 1).then(resolve, reject);
              } else resolve(response);
            } catch (error) { reject(error); }
          },
        };
        limit!.jobs.push(job);
        signal?.addEventListener('abort', abort, { once: true });
        drain(limit!);
      });
    };
    return limit.until > Date.now() || limit.busy || limit.jobs.length ? enqueue(0) : send(0);
  };
}
