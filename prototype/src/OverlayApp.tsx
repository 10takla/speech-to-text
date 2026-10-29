import { useEffect, useState } from 'react';
import RecordingTranscriptPreview from './RecordingTranscriptPreview';
import type { RecordingPreview } from './recording-transcript';
import './style.scss';
import OverlaySteps, { type OverlayStepStatus } from './OverlaySteps';
import { publishScenarioProgress } from './scenario-progress';
import { loadConfig } from './config';
import { overlayRetention } from './overlay-retention';
import { isAndroid } from './android-runtime';
import { OverlayRuns } from './parallel-runs/OverlayRun';

export function Waveform() {
  return <div className="waveform" id="waveform">
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
    <div className="bar" />
  </div>;
}

export default function OverlayApp({ showWaveform = true, visualPreview = false }: { showWaveform?: boolean; visualPreview?: boolean }) {
  const [preview, setPreview] = useState<RecordingPreview>({ text: '', fragments: [] });
  const [steps, setSteps] = useState<readonly OverlayStepStatus[]>([]);
  useEffect(() => {
    if (isAndroid) return;
    const updatePinned = (pinned: boolean) => document.getElementById('overlay-container')?.classList.toggle('overlay-pinned', pinned);
    updatePinned(overlayRetention.pinned);
    const unsubscribe = overlayRetention.subscribe(updatePinned);
    const mouseDown = (event: MouseEvent) => {
      const container = document.getElementById('overlay-container');
      if (!container || container.classList.contains('overlay-content-hidden')) return;
      overlayRetention.setPinned(event.target instanceof Node && container.contains(event.target));
    };
    document.addEventListener('mousedown', mouseDown, true);
    return () => { unsubscribe(); document.removeEventListener('mousedown', mouseDown, true); };
  }, []);
  useEffect(() => {
    const update = (event: Event) => setPreview((event as CustomEvent<RecordingPreview>).detail);
    const updateSteps = (event: Event) => setSteps((event as CustomEvent<readonly OverlayStepStatus[]>).detail);
    window.addEventListener('overlay-transcription-preview', update);
    window.addEventListener('overlay-steps', updateSteps);
    if (!visualPreview) void import('./overlay-controller');
    return () => {
      window.removeEventListener('overlay-transcription-preview', update);
      window.removeEventListener('overlay-steps', updateSteps);
    };
  }, [visualPreview]);

  useEffect(() => {
    if (!visualPreview) return;
    const frames: readonly OverlayStepStatus[][] = [
      [{ id: 'transcribe', title: 'Транскрибация', status: 'running' }],
      [{ id: 'copy', title: 'В буфер обмена', status: 'running', body: 'Распознанный текст записи.' }, { id: 'paste', title: 'Вставить в поле', status: 'running', body: 'Распознанный текст записи.' }],
      [{ id: 'copy', title: 'В буфер обмена', status: 'success', body: 'Распознанный текст записи.' }, { id: 'paste', title: 'Вставить в поле', status: 'running', body: 'Распознанный текст записи.' }],
      [{ id: 'copy', title: 'В буфер обмена', status: 'success', body: 'Распознанный текст записи.' }, { id: 'paste', title: 'Вставить в поле', status: 'success', body: 'Распознанный текст записи.' }],
    ];
    const config = loadConfig();
    const scenario = config.scenarios.find(item => item.id === config.activeScenarioId);
    const display = (frame: readonly OverlayStepStatus[]) => {
      setSteps(frame.map(item => ({ ...item,
        body: scenario?.steps.find(step => step.type === item.id)?.showTextInOverlay === true ? item.body : undefined,
      })));
      publishScenarioProgress({ scenarioId: config.activeScenarioId, active: true,
        steps: frame.flatMap(item => {
          const actual = scenario?.steps.find(step => step.type === item.id);
          return actual && item.status !== 'pending' ? [{ id: actual.id, type: actual.type, status: item.status }] : [];
        }) });
    };
    display(frames[0]);
    const timers = frames.slice(1).map((frame, index) => window.setTimeout(() => display(frame), (index + 1) * 2000));
    const clear = () => publishScenarioProgress({ scenarioId: config.activeScenarioId, active: false, steps: [] });
    timers.push(window.setTimeout(clear, frames.length * 2000));
    return () => { timers.forEach(timer => window.clearTimeout(timer)); clear(); };
  }, [visualPreview]);

  if (!visualPreview) return <OverlayRuns />;

  return (
    <div id="overlay-container" className={`overlay-stage${visualPreview ? '' : ' overlay-content-hidden'}`}>
      <div className={`overlay-content${steps.length ? ' overlay-content--steps' : ''}${steps.some(step => step.status === 'error') ? ' overlay-content--step-errors' : ''}`}>
        <div className="overlay-header" id="overlay-drag-handle">
          <div className={`status-indicator${steps.length ? ' status-indicator--steps' : ''}`}>
            {showWaveform && <span className="overlay-state-icon" aria-hidden="true">
              <Waveform />
              <span className="overlay-processing-spinner" />
              <svg className="overlay-error-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 2 15 14H1Z" strokeLinejoin="round" />
                <path d="M8 6v4m0 1.5v1" />
              </svg>
              <svg className="overlay-paused-icon" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 3h3v10H4zm5 0h3v10H9z" />
              </svg>
            </span>}
            <span className="overlay-title" id="overlay-status-text">Ожидание</span>
            {steps.length > 0 && <OverlaySteps steps={steps} />}
          </div>
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
