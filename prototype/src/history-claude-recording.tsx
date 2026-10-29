import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { HistoryItem } from './history-db';
import { downloadHistoryRecording } from './history-recording-actions';
import { HistorySpeech } from './history-speech';
import { errorMessage } from './error-message';

// The parallel recording of a Claude Code run: a plain player with a download
// button. No re-recognition: Claude already supplied the text.
export function HistoryClaudeRecording({ record, audio }: { record: HistoryItem; audio: Blob }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function download() {
    if (busy) return;
    setBusy(true);
    setMessage({ text: 'Сохранение аудио…', error: false });
    try {
      const saved = await downloadHistoryRecording(record);
      if (mounted.current) setMessage(saved ? { text: isTauri() ? 'Аудиозапись сохранена.' : 'Скачивание начато.', error: false } : null);
    } catch (error) {
      if (mounted.current) setMessage({ text: errorMessage(error), error: true });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="history-claude-recording">
    <div className="history-transcript-row">
      <HistorySpeech audio={audio} kind="recording" />
      <div className="history-recording-actions" role="group" aria-label="Действия с записью">
        <button type="button" className="history-copy-button" disabled={busy}
          aria-label="Скачать запись" title="Скачать запись" onClick={() => void download()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
          </svg>
        </button>
      </div>
    </div>
    {message && <div className={`history-action-message${message.error ? ' history-action-message--error' : ''}`} role="status">{message.text}</div>}
  </div>;
}
