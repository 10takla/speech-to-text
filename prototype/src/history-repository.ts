import { addHistoryRecord, getHistoryRecords, updateHistoryRecord, releaseRunningHistoryRecords } from './history-db';
import type { HistoryRepository } from './ports';

export const indexedDbHistoryRepository: HistoryRepository = {
  add: (data, maxItems) => addHistoryRecord(data, maxItems),
  update: (id, updates) => updateHistoryRecord(id, updates),
  list: limit => getHistoryRecords(limit),
};

export function createRunHistoryRepository(maxItems: number) {
  const ids: string[] = [];
  return {
    repository: {
      ...indexedDbHistoryRepository,
      add: async (data, limit) => {
        const item = await addHistoryRecord(data, limit, true);
        ids.push(item.id);
        return item;
      },
    } satisfies HistoryRepository,
    release: () => releaseRunningHistoryRecords(ids, maxItems),
  };
}
