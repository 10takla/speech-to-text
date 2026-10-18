import { createRoot } from 'react-dom/client';
import { indexedDbHistoryRepository } from './history-repository';
import type { HistoryRepository } from './ports';
import { HistoryTranscript } from './history-transcript';
import { HistorySpeech } from './history-speech';
import type { HistoryItem } from './history-db';

export interface HistoryView {
  refresh(): Promise<void>;
  dispose(): void;
}

export function createHistoryView(
  container: HTMLElement,
  getLimit: () => number,
  repository: HistoryRepository = indexedDbHistoryRepository,
): HistoryView {
  const root = createRoot(container);
  let lastRenderedSignature = '';
  let renderGeneration = 0;
  let disposed = false;

  async function refresh() {
    if (disposed || document.hidden || Array.from(container.querySelectorAll('audio')).some(audio => !audio.paused)) return;
    const generation = ++renderGeneration;
    try {
      const records = await repository.list(getLimit());
      if (disposed || generation !== renderGeneration) return;
      if (Array.from(container.querySelectorAll('audio')).some(audio => !audio.paused)) return;
      const signature = records.length ? JSON.stringify(records.map(record => [
        record.id, record.updatedAt, record.status, record.text, record.scenarioName, record.steps, record.fragments?.length,
      ])) : 'empty';
      if (lastRenderedSignature === signature) return;
      lastRenderedSignature = signature;
      root.render(<HistoryList records={records} />);
    } catch (error) {
      console.warn('Ошибка загрузки истории из IndexedDB:', error);
    }
  }

  const onHistoryUpdated = () => {
    lastRenderedSignature = '';
    void refresh();
  };
  window.addEventListener('stt-history-updated', onHistoryUpdated);
  const onVisibilityChanged = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', onVisibilityChanged);
  const timer = window.setInterval(() => void refresh(), 3000);
  window.addEventListener('beforeunload', dispose);
  void refresh();

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timer);
    window.removeEventListener('stt-history-updated', onHistoryUpdated);
    document.removeEventListener('visibilitychange', onVisibilityChanged);
    window.removeEventListener('beforeunload', dispose);
    root.unmount();
  }

  return { refresh, dispose };
}

function formatDateHeading(date: Date): string {
  const today = new Date();
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((dayStart - dateStart) / 86_400_000);
  if (dayDifference === 0) return 'Сегодня';
  if (dayDifference === 1) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function HistoryList({ records }: { records: HistoryItem[] }) {
  if (!records.length) return <div className="empty-history">История пуста</div>;
  const groups: { key: string; date: Date; records: HistoryItem[] }[] = [];
  records.forEach(record => {
    const date = new Date(record.timestamp);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let group = groups.at(-1);
    if (group?.key !== key) {
      group = { key, date, records: [] };
      groups.push(group);
    }
    group.records.push(record);
  });
  return <>{groups.map((group, index) => (
    <section className="history-date-group" key={`${group.key}-${index}`}>
      <h3 className="history-date-heading">{formatDateHeading(group.date)}</h3>
      {group.records.map(record => <HistoryRecord key={record.id} record={record} />)}
    </section>
  ))}</>;
}

const statusLabels = {
  pending: 'Не выполнен', running: 'Выполняется', success: 'Выполнен', error: 'Ошибка', skipped: 'Отключён',
};

export function HistoryRecord({ record }: { record: HistoryItem }) {
  const transcriptStep = record.steps?.findIndex(step => step.type === 'transcribe') ?? -1;
  const lastTextStep = record.steps?.findLastIndex(step =>
    (step.type === 'postprocess' || step.type === 'transcribe') && step.status === 'success') ?? -1;
  const legacyError = !record.steps?.length && record.errorMessage ? (
    <div className="history-step history-step--error">
      <span className="history-step-title">{record.errorStep || 'Ошибка сценария'}</span>
      <span className="history-step-status">Ошибка</span>
      <div className="history-step-error">{record.errorMessage}</div>
    </div>
  ) : null;
  const isTranscriptionError = Boolean(record.errorStep?.toLocaleLowerCase('ru').includes('транскриб'));
  return (
    <div className="history-item">
      <div className="history-item-top">
        <div className="history-scenario-name">{record.scenarioName || 'Сценарий не сохранён'}</div>
        <span className="history-time">
          {new Date(record.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {!!record.steps?.length && <div className="history-steps">
        {record.steps.map((step, index) => (
          <div className={`history-step history-step--${step.status}`} key={step.id}>
            <span className="history-step-title">{step.title}</span>
            <span className="history-step-status">{statusLabels[step.status]}</span>
            {step.errorMessage && <div className="history-step-error">{step.errorMessage}</div>}
            {step.type === 'speak' && !!step.audioBlob?.size &&
              <HistorySpeech audio={step.audioBlob} />}
            {index === transcriptStep && <HistoryTranscript record={record} inStep />}
            {(step.type === 'postprocess' || step.type === 'transcribe' && index !== transcriptStep) && step.status === 'success' &&
              <div className="history-transcript history-step-transcript">
                <div className="history-transcript-text">{step.text ?? (index === lastTextStep ? record.text : '')}</div>
              </div>}
          </div>
        ))}
      </div>}
      {isTranscriptionError && legacyError}
      {transcriptStep < 0 && <HistoryTranscript record={record} />}
      {!isTranscriptionError && legacyError}
    </div>
  );
}
