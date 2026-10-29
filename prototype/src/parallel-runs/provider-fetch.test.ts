import { afterEach, expect, it, vi } from 'vitest';
import { createProviderFetch } from './provider-fetch';

afterEach(() => vi.useRealTimers());
const request = (id: string, key = 'key', signal?: AbortSignal) => [`https://api.example.test/${id}`, { headers: { Authorization: key }, signal }] as const;

it('allows independent requests to run concurrently before a provider limit', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response('second'));
  const fetch = createProviderFetch(fetcher);
  const first = fetch(...request('first'));
  expect(await (await fetch(...request('second'))).text()).toBe('second');
  finish(new Response('first')); await first;
});

it('queues ready requests after 429, respects Retry-After, and lets other credentials proceed', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
    calls.push(String(input));
    return calls.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : new Response('ok');
  });
  const waiting = vi.fn();
  const fetch = createProviderFetch(fetcher, waiting);
  const first = fetch(...request('first'));
  await vi.advanceTimersByTimeAsync(0);
  const second = fetch(...request('second'));
  await fetch(...request('other-key', 'other'));
  expect(calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([first, second]);
  expect(calls.map(url => url.split('/').at(-1))).toEqual(['first', 'other-key', 'first', 'second']);
  expect(waiting).toHaveBeenCalledWith(true);
  expect(waiting).toHaveBeenCalledWith(false);
});

it('cancels just one waiter and reports a persistent provider error after bounded retries', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }));
  const fetch = createProviderFetch(fetcher);
  const first = fetch(...request('first'));
  await vi.advanceTimersByTimeAsync(0);
  const abort = new AbortController();
  const second = fetch(...request('cancelled', 'key', abort.signal));
  const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort(); await rejection;
  await vi.advanceTimersByTimeAsync(3000);
  expect((await first).status).toBe(429);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
