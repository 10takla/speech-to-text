import type { HistoryRepository } from './ports';

/** Keep history writes ordered while steps continue with their own work. */
export function createWorkflowHistory(history: Pick<HistoryRepository, 'update'>, id: string | null) {
  let pending = Promise.resolve();
  return {
    update(updates: Parameters<HistoryRepository['update']>[1]) {
      if (!id) return Promise.resolve(null);
      const write = pending.then(() => history.update(id, updates));
      // A failed status write must not prevent a later result/error from being saved.
      pending = write.then(() => {}, () => {});
      return write;
    },
    flush: () => pending,
  };
}
