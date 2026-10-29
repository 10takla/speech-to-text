import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import RecordingTranscriptPreview from '../RecordingTranscriptPreview';
import type { RecordingPreview } from '../recording-transcript';
import OverlaySteps, { type OverlayStepStatus } from '../OverlaySteps';

export function OverlayRuns() {
  return <div id="overlay-container" className="overlay-stage overlay-content-hidden">
    <div id="overlay-runs" />
    <div className="overlay-width-skeleton-preview hidden" id="overlay-width-skeleton-preview" aria-hidden="true" />
  </div>;
}

export function OverlayRun({ target, showWaveform = true }: { target: HTMLElement; showWaveform?: boolean }) {
  const [preview, setPreview] = useState<RecordingPreview>({ text: '', fragments: [] });
  const [steps, setSteps] = useState<readonly OverlayStepStatus[]>([]);
  useEffect(() => {
    const preview = (event: Event) => setPreview((event as CustomEvent<RecordingPreview>).detail);
    const steps = (event: Event) => setSteps((event as CustomEvent<readonly OverlayStepStatus[]>).detail);
    target.addEventListener('overlay-transcription-preview', preview);
    target.addEventListener('overlay-steps', steps);
    return () => {
      target.removeEventListener('overlay-transcription-preview', preview);
      target.removeEventListener('overlay-steps', steps);
    };
  }, [target]);
  return (<>
      <div className={`overlay-content${steps.length ? ' overlay-content--steps' : ''}${steps.some(step => step.status === 'error') ? ' overlay-content--step-errors' : ''}`}>
        <div className="overlay-header" data-role="overlay-drag-handle">
          <div className={`status-indicator${steps.length ? ' status-indicator--steps' : ''}`}>
            {showWaveform && <span className="overlay-state-icon" aria-hidden="true">
              <div className="waveform" data-role="waveform">{Array.from({length: 5}, (_, index) => <div className="bar" key={index} />)}</div>
              <span className="overlay-processing-spinner" />
              <svg className="overlay-error-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 2 15 14H1Z" strokeLinejoin="round" />
                <path d="M8 6v4m0 1.5v1" />
              </svg>
              <svg className="overlay-paused-icon" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 3h3v10H4zm5 0h3v10H9z" />
              </svg>
            </span>}
            <span className="overlay-title" data-role="overlay-status-text">Ожидание</span>
            {steps.length > 0 && <OverlaySteps steps={steps} />}
          </div>
        </div>

        <div className="overlay-body">
          <div className="transcription-preview hidden" data-role="live-preview">
            <RecordingTranscriptPreview {...preview} />
          </div>
          <div className="error-banner hidden" data-role="error-banner" />
          <button
            data-role="btn-open-mic-settings"
            className="btn secondary hidden mic-settings-button"
          >
            Настройки микрофона
          </button>
        </div>
      </div>

  </>);
}

export function createOverlayRunView(id: string, showWaveform = true) {
  const element = document.createElement('section');
  element.className = 'overlay-run overlay-content-hidden';
  element.dataset.runId = id;
  document.getElementById('overlay-runs')!.append(element);
  const root = createRoot(element);
  flushSync(() => root.render(<OverlayRun target={element} showWaveform={showWaveform} />));
  return { element, dispose: () => { root.unmount(); element.remove(); } };
}
