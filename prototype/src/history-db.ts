export interface HistoryFragment {
  start: number;
  end: number;
  text: string;
  audioBlob?: Blob;
  segments: { start: number; end: number; text: string }[];
  removedRanges: { start: number; end: number }[];
}

export type HistoryStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface HistoryStep {
  id: string;
  type: string;
  title: string;
  status: HistoryStepStatus;
  errorMessage?: string;
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  updatedAt?: number;
  scenarioName?: string;
  steps?: HistoryStep[];
  fragments?: HistoryFragment[];
  text?: string;
  audioBlob?: Blob;
  originalAudioBlob?: Blob;
  segments?: { start: number; end: number; text: string }[];
  removedRanges?: { start: number; end: number }[];
  status?: 'recorded' | 'transcribed' | 'post-processed' | 'success' | 'error';
  errorStep?: string;
  errorMessage?: string;
}

const DB_NAME = 'SpeechToTextDB';
const DB_VERSION = 1;
const STORE_NAME = 'history';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function addHistoryRecord(
  initialData: {
    audioBlob?: Blob;
    text?: string;
    status?: HistoryItem['status'];
    errorStep?: string;
    errorMessage?: string;
    scenarioName?: string;
    steps?: HistoryStep[];
  },
  maxItems = 10
): Promise<HistoryItem> {
  const db = await openDB();
  const item: HistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    updatedAt: Date.now(),
    text: initialData.text || '',
    audioBlob: initialData.audioBlob,
    scenarioName: initialData.scenarioName,
    steps: initialData.steps,
    status: initialData.status || (initialData.errorMessage ? 'error' : initialData.text ? 'success' : 'recorded'),
    errorStep: initialData.errorStep,
    errorMessage: initialData.errorMessage,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add(item);

    tx.oncomplete = async () => {
      await trimHistoryRecords(maxItems);
      window.dispatchEvent(new CustomEvent('stt-history-updated'));
      resolve(item);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateHistoryRecord(
  id: string,
  updates: Partial<Omit<HistoryItem, 'id' | 'timestamp'>>
): Promise<HistoryItem | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const existing = getReq.result as HistoryItem | undefined;
      if (!existing) {
        resolve(null);
        return;
      }
      const updatedItem = { ...existing, ...updates, updatedAt: Math.max(Date.now(), (existing.updatedAt || existing.timestamp) + 1) };
      store.put(updatedItem);
    };

    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('stt-history-updated'));
      resolve(null);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHistoryRecords(limit = 10): Promise<HistoryItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const list = (request.result as HistoryItem[]) || [];
      // Сортируем от новых к старым
      list.sort((a, b) => b.timestamp - a.timestamp);
      resolve(list.slice(0, limit));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function trimHistoryRecords(maxItems: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();

  request.onsuccess = () => {
    const list = (request.result as HistoryItem[]) || [];
    if (list.length > maxItems) {
      list.sort((a, b) => a.timestamp - b.timestamp); // от старых к новым
      const toDeleteCount = list.length - maxItems;
      for (let i = 0; i < toDeleteCount; i++) {
        store.delete(list[i].id);
      }
    }
  };
}
