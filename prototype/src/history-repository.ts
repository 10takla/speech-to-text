import { addHistoryRecord, getHistoryRecords, updateHistoryRecord } from './history-db';
import type { HistoryRepository } from './ports';

export const indexedDbHistoryRepository: HistoryRepository = {
  add: (data, maxItems) => addHistoryRecord(data, maxItems),
  update: (id, updates) => updateHistoryRecord(id, updates),
  list: limit => getHistoryRecords(limit),
};
