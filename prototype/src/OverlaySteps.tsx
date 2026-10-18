export interface OverlayStepStatus {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
  body?: string;
}

export function showOverlaySteps(steps: readonly OverlayStepStatus[]) {
  window.dispatchEvent(new CustomEvent('overlay-steps', { detail: steps }));
}

export default function OverlaySteps({ steps }: { steps: readonly OverlayStepStatus[] }) {
  return <div className="overlay-steps" role="status" aria-live="polite" aria-atomic="true">
    {steps.map(step => <section key={step.id} className={`overlay-step overlay-step--${step.status}`} aria-label={step.title}>
      <header className="overlay-step-header">
      <span className="overlay-step-icon" aria-hidden="true">
        {step.status === 'running' ? <span className="overlay-processing-spinner" /> : step.status === 'success' ? '✓' : step.status === 'pending' ? '·' : '!'}
      </span>
      <span className="overlay-step-content">
        <span className="overlay-step-title">{step.title}</span>
        <span className="sr-only"> — {step.status === 'running' ? 'Выполняется' : step.status === 'success' ? 'Выполнено' : step.status === 'pending' ? 'Ожидает' : 'Ошибка'}</span>
      </span>
      </header>
      {(step.body?.trim() || (step.status === 'error' && step.error)) && <div className="overlay-step-body" onMouseDown={event => event.stopPropagation()}>
        {step.body?.trim() && <div className="overlay-step-text">{step.body}</div>}
        {step.status === 'error' && step.error && <div className="overlay-step-error">{step.error}</div>}
      </div>}
    </section>)}
  </div>;
}
