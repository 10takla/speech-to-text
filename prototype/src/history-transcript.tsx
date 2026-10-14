import { useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { HistoryItem } from './history-db';
import { historyFragments, renderHistoryFragments, retainedHistoryText } from './history-fragments';
import { invokeCommand } from './tauri-commands';

type CopyState = 'copy' | 'success' | 'error';

function TranscriptContent({ record }: { record: HistoryItem }) {
  const content = useRef<HTMLDivElement>(null);
  const copying = useRef(false);
  const mounted = useRef(false);
  const timers = useRef(new Set<number>());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ state: CopyState; error?: string }>({ state: 'copy' });
  const hasFragments = historyFragments(record).length > 0;
  const copyText = hasFragments ? retainedHistoryText(record) : record.text || '';

  useLayoutEffect(() => {
    mounted.current = true;
    const rendered = renderHistoryFragments(record);
    if (rendered) content.current!.append(rendered.element);
    const pendingTimers = timers.current;
    return () => {
      mounted.current = false;
      rendered?.dispose();
      pendingTimers.forEach(timer => window.clearTimeout(timer));
      pendingTimers.clear();
    };
  }, [record]);

  async function copy() {
    if (!copyText || copying.current) return;
    copying.current = true;
    setBusy(true);
    let delay = 1400;
    try {
      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invokeCommand(invoke, 'write_clipboard_text', { text: copyText });
      } else {
        await navigator.clipboard.writeText(copyText);
      }
      setFeedback({ state: 'success' });
    } catch (error) {
      console.warn('Не удалось скопировать текст из истории:', error);
      setFeedback({ state: 'error', error: String(error) });
      delay = 1800;
    } finally {
      if (mounted.current) {
        const timer = window.setTimeout(() => {
          timers.current.delete(timer);
          setFeedback({ state: 'copy' });
        }, delay);
        timers.current.add(timer);
        setBusy(false);
      }
      copying.current = false;
    }
  }

  const label = feedback.state === 'success' ? 'Скопировано' : feedback.state === 'error'
    ? 'Не удалось скопировать' : 'Скопировать включённые сегменты транскрибации';
  const title = feedback.state === 'error' ? `${label}: ${feedback.error}`
    : feedback.state === 'copy' ? 'Скопировать включённые сегменты' : label;
  return (
    <div className="history-transcript-row">
      <div className="history-transcript-content" ref={content}>
        {!hasFragments && <div className="history-transcript-text">{record.text || ''}</div>}
      </div>
      <button type="button" className="history-copy-button" disabled={!copyText || busy}
        aria-label={label} title={title} data-state={feedback.state} onClick={copy}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {feedback.state === 'copy' ? <>
            <rect x="8" y="8" width="13" height="13" rx="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
          </> : <path d={feedback.state === 'success' ? 'm5 12 4 4L19 6'
            : 'M12 9v4m0 4h.01M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.4L13.7 3.9a2 2 0 0 0-3.4 0Z'} />}
        </svg>
      </button>
    </div>
  );
}

export function HistoryTranscript({ record, inStep = false }: { record: HistoryItem; inStep?: boolean }) {
  const hasTranscript = historyFragments(record).some(fragment => fragment.segments.length > 0);
  const transcriptionStatus = record.steps?.find(step => step.type === 'transcribe')?.status;
  const transcriptReady = !record.steps?.length || transcriptionStatus === 'success' || transcriptionStatus === 'error';
  if (!transcriptReady || (!hasTranscript && (record.steps?.length || !record.text))) return null;

  return <div className={`history-transcript${inStep ? ' history-step-transcript' : ''}`}>
    <TranscriptContent record={record} />
  </div>;
}
