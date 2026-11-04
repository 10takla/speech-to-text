import type { HistoryRepository } from './ports';

/** Keep history writes ordered while steps continue with their own work. The
 * entry id may still be pending: writes queue behind the entry's creation. */
export function createWorkflowHistory(history: Pick<HistoryRepository, 'update'>, id: string | null | Promise<string | null>) {
  const entry = Promise.resolve(id);
  let pending: Promise<void> = entry.then(() => {});
  return {
    update(updates: Parameters<HistoryRepository['update']>[1]) {
      const write = pending.then(() => entry).then(value => value ? history.update(value, updates) : null);
      // A failed status write must not prevent a later result/error from being saved.
      pending = write.then(() => {}, () => {});
      return write;
    },
    flush: () => pending,
  };
}
