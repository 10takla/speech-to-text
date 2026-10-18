import { afterEach, describe, expect, it, vi } from 'vitest';

function createDatabase() {
  return {
    close: vi.fn(),
    onversionchange: null as (() => void) | null,
    onclose: null as (() => void) | null,
    transaction: vi.fn(() => ({
      objectStore: () => ({
        getAll: () => {
          const request = { result: [], onsuccess: null as (() => void) | null };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
      }),
    })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('history database connection', () => {
  it('shares a connection for concurrent and subsequent reads, reopening after version changes or closure', async () => {
    vi.resetModules();
    const connections: ReturnType<typeof createDatabase>[] = [];
    const open = vi.fn(() => {
      const db = createDatabase();
      connections.push(db);
      const request = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    vi.stubGlobal('indexedDB', { open });
    const { getHistoryRecords } = await import('./history-db');
    expect(await Promise.all([getHistoryRecords(), getHistoryRecords()])).toEqual([[], []]);
    await getHistoryRecords();
    expect(open).toHaveBeenCalledTimes(1);
    expect(connections[0].transaction).toHaveBeenCalledTimes(3);
    connections[0].onversionchange?.();
    expect(connections[0].close).toHaveBeenCalledOnce();
    await getHistoryRecords();
    expect(open).toHaveBeenCalledTimes(2);
    connections[0].onclose?.();
    await getHistoryRecords();
    expect(open).toHaveBeenCalledTimes(2);
    connections[1].onclose?.();
    await getHistoryRecords();
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('retries opening after an error instead of caching the rejected connection', async () => {
    vi.resetModules();
    const open = vi.fn(() => {
      const request = {
        result: createDatabase(), error: new Error('Database unavailable'),
        onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
      };
      const first = open.mock.calls.length === 1;
      queueMicrotask(() => first ? request.onerror?.() : request.onsuccess?.());
      return request;
    });
    vi.stubGlobal('indexedDB', { open });
    const { getHistoryRecords } = await import('./history-db');
    await expect(getHistoryRecords()).rejects.toThrow('Database unavailable');
    expect(await getHistoryRecords()).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
