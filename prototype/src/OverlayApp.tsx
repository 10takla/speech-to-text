import { useEffect, useState } from 'react';
import RecordingTranscriptPreview from './RecordingTranscriptPreview';
import type { RecordingPreview } from './recording-transcript';
import './style.scss';

export function Waveform() {
  return <div className="waveform" id="waveform">
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
  </div>;
}

export default function OverlayApp({ showWaveform = true }: { showWaveform?: boolean }) {
  const [preview, setPreview] = useState<RecordingPreview>({ text: '', fragments: [] });
  useEffect(() => {
    const update = (event: Event) => setPreview((event as CustomEvent<RecordingPreview>).detail);
    window.addEventListener('overlay-transcription-preview', update);
    void import('./overlay-controller');
    return () => window.removeEventListener('overlay-transcription-preview', update);
  }, []);

  return (
    <div id="overlay-container" className="overlay-stage overlay-content-hidden">
      <div className="overlay-content">
        <div className="overlay-header" id="overlay-drag-handle">
          <div className="status-indicator">
            <span className="indicator-dot" />
            <span className="overlay-title" id="overlay-status-text">Ожидание</span>
          </div>
          {showWaveform && <Waveform />}
        </div>

        <div className="overlay-body">
          <div className="transcription-preview hidden" id="live-preview">
            <RecordingTranscriptPreview {...preview} />
          </div>
          <div className="error-banner hidden" id="error-banner" />
          <button
            id="btn-open-mic-settings"
            className="btn secondary hidden mic-settings-button"
          >
            Настройки микрофона
          </button>
        </div>
      </div>

      <div className="overlay-width-skeleton-preview hidden" id="overlay-width-skeleton-preview" aria-hidden="true" />
    </div>
  );
}
