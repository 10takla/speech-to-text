import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { HistoryItem } from './history-db';
import { historyFragments, renderHistoryFragments, retainedHistoryText } from './history-fragments';
import { copyHistoryText, downloadHistoryRecording, historyRecordingAudio, retranscribeHistoryRecording } from './history-recording-actions';
import { errorMessage } from './error-message';
import { extractHistoryAudio, type HistoryAudioExcerpt } from './history-audio-excerpt';
import { HistoryAudioMenu, type HistoryAudioMenuState } from './history-audio-menu';

type Action = 'copy' | 'download' | 'transcribe';
type Feedback = { action: Action; state: 'success' | 'error'; error?: string };

function TranscriptContent({ record, showTranscript }: { record: HistoryItem; showTranscript: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const timers = useRef(new Set<number>());
  const [busy, setBusy] = useState<Action | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [menu, setMenu] = useState<HistoryAudioMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const hasFragments = showTranscript && historyFragments(record).length > 0;
  const copyText = !showTranscript ? '' : hasFragments ? retainedHistoryText(record) : record.text || '';
  const audio = historyRecordingAudio(record);
  const hasAudioTracks = hasFragments && historyFragments(record).some(fragment =>
    fragment.audioBlob?.size && fragment.segments.length > 0);

  useLayoutEffect(() => {
    mounted.current = true;
    const pendingTimers = timers.current;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      pendingTimers.forEach(timer => window.clearTimeout(timer));
      pendingTimers.clear();
    };
  }, []);

  useLayoutEffect(() => {
    setMenu(null);
    const rendered = showTranscript ? renderHistoryFragments(record, (event, excerpt) => {
      if (operation.current) return;
      const anchor = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const bounds = anchor?.getBoundingClientRect();
      setMenu({ excerpt, anchor, x: event.clientX || bounds?.left || 0, y: event.clientY || bounds?.bottom || 0 });
    }) : null;
    if (rendered) content.current!.append(rendered.element);
    return () => rendered?.dispose();
  }, [record, showTranscript]);

  async function run(action: Action, excerpt?: HistoryAudioExcerpt) {
    if (operation.current || (action === 'copy' ? !copyText : excerpt ? !excerpt.parts.length : !audio)) return;
    setMenu(null);
    const controller = new AbortController();
    operation.current = controller;
    timers.current.forEach(timer => window.clearTimeout(timer));
    timers.current.clear();
    setBusy(action);
    setFeedback(null);
    let succeeded = false;
    const timeout = action === 'transcribe' ? window.setTimeout(() => {
      controller.abort(new Error('Транскрибация не завершилась за 2 минуты. Повторите попытку.'));
    }, 120_000) : undefined;
    try {
      const selectedRecord = excerpt ? { ...record, audioBlob: await extractHistoryAudio(excerpt, controller.signal), originalAudioBlob: undefined } : record;
      controller.signal.throwIfAborted();
      if (action === 'copy') await copyHistoryText(copyText);
      else if (action === 'transcribe') await retranscribeHistoryRecording(selectedRecord, controller.signal);
      else if (!await downloadHistoryRecording(selectedRecord, excerpt?.filenameSuffix)) return;
      succeeded = true;
      if (mounted.current) setFeedback({ action, state: 'success' });
    } catch (error) {
      if (mounted.current) setFeedback({ action, state: 'error', error: errorMessage(controller.signal.reason ?? error) });
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      operation.current = null;
      if (mounted.current) {
        if (succeeded) {
          const timer = window.setTimeout(() => {
            timers.current.delete(timer);
            setFeedback(null);
          }, 4000);
          timers.current.add(timer);
        }
        setBusy(null);
      }
    }
  }

  const copyState = feedback?.action === 'copy' ? feedback.state : 'copy';
  const label = copyState === 'success' ? 'Скопировано' : copyState === 'error'
    ? 'Не удалось скопировать' : 'Скопировать включённые сегменты транскрибации';
  const title = copyState === 'error' ? `${label}: ${feedback?.error}`
    : copyState === 'copy' ? 'Скопировать включённые сегменты' : label;
  const message = busy === 'transcribe' ? 'Транскрибация…' : busy === 'download' ? 'Сохранение аудио…' : feedback?.state === 'error' ? feedback.error
    : feedback?.action === 'transcribe' ? 'Текст распознан и скопирован.' : feedback?.action === 'download'
      ? isTauri() ? 'Аудиозапись сохранена.' : 'Скачивание начато.' : '';
  return <>
    <div className="history-transcript-row">
      <div className="history-transcript-content" ref={content}>
        {showTranscript && !hasFragments && <div className="history-transcript-text">{copyText}</div>}
      </div>
      <div className={`history-recording-actions${!hasAudioTracks && audio ? ' history-recording-actions--menu' : ''}`} role="group" aria-label="Действия с записью">
      <button type="button" className="history-copy-button" disabled={!copyText || busy !== null}
        aria-label={label} title={title} data-state={copyState} onClick={() => void run('copy')}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {copyState === 'copy' ? <>
            <rect x="8" y="8" width="13" height="13" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </> : <path d={copyState === 'success' ? 'm5 12 4 4L19 6'
            : 'M12 9v4m0 4h.01M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.4L13.7 3.9a2 2 0 0 0-3.4 0Z'} />}
        </svg>
      </button>
      {!hasAudioTracks && audio && <button type="button" className="history-copy-button history-recording-menu-button"
        disabled={busy !== null} aria-label="Действия с аудиозаписью" aria-haspopup="menu" aria-expanded={!!menu}
        onClick={event => {
          const anchor = event.currentTarget;
          const bounds = anchor.getBoundingClientRect();
          setMenu({ anchor, x: bounds.left, y: bounds.bottom });
        }}>Действия</button>}
      </div>
    </div>
    {message && <div className={`history-action-message${feedback?.state === 'error' ? ' history-action-message--error' : ''}`} role="status">{message}</div>}
    {menu && <HistoryAudioMenu menu={menu} onClose={closeMenu} onAction={(action, excerpt) => void run(action, excerpt)} />}
  </>;
}

export function HistoryTranscript({ record, inStep = false }: { record: HistoryItem; inStep?: boolean }) {
  const hasTranscript = historyFragments(record).some(fragment => fragment.segments.length > 0);
  const transcriptionStep = record.steps?.find(step => step.type === 'transcribe');
  const transcriptReady = !transcriptionStep || transcriptionStep.status === 'success' || transcriptionStep.status === 'error';
  if (!transcriptReady || (!hasTranscript && (record.steps?.length || !record.text) && !historyRecordingAudio(record))) return null;

  return <div className={`history-transcript${inStep ? ' history-step-transcript' : ''}`}>
    <TranscriptContent record={record} showTranscript={hasTranscript || !record.steps?.length} />
  </div>;
}
