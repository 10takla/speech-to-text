import SpeechControls from './SpeechControls';
import SpeechText from './SpeechText';

export interface OverlayStepStatus {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
  body?: string;
  waiting?: string;
  // A speech step: its player controls go above its text.
  speech?: boolean;
}

/** Applies the steps' current «Показывать текст в оверлее» flags, so a change shows at once,
 * even during a run: the text goes away. A speech step stays while it speaks (its controls are not text),
 * and is not listed before and after that. */
export function applyOverlayTextFlags(steps: readonly OverlayStepStatus[],
  scenarioSteps: Iterable<{ id: string; type: string; showTextInOverlay?: boolean }>): OverlayStepStatus[] {
  const flags = new Map<string, { type: string; show?: boolean }>();
  for (const step of scenarioSteps) flags.set(step.id, { type: step.type, show: step.showTextInOverlay });
  return steps.flatMap(step => {
    const flag = flags.get(step.id);
    const marked = flag?.type === 'speak' ? { ...step, speech: true } : step;
    if (flag?.show !== false) return [marked];
    if (flag.type === 'speak' && step.status !== 'error' && step.status !== 'running' && !step.waiting) return [];
    return [{ ...marked, body: undefined }];
  });
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
        {step.waiting && <span className="overlay-step-waiting">{step.waiting}</span>}
        <span className="sr-only"> — {step.status === 'running' ? 'Выполняется' : step.status === 'success' ? 'Выполнено' : step.status === 'pending' ? 'Ожидает' : 'Ошибка'}</span>
      </span>
      </header>
      {step.speech && (step.status === 'running' || step.status === 'success') && <div className="overlay-step-controls"><SpeechControls /></div>}
      {(step.body?.trim() || (step.status === 'error' && step.error)) && <div className="overlay-step-body" onMouseDown={event => event.stopPropagation()}
        // The text follows the voice until the user scrolls it by hand: then it stays where they put it.
        onWheel={event => { event.currentTarget.dataset.userScrolled = 'true'; }}
        onPointerDown={event => {
          const box = event.currentTarget;
          // The scrollbar or the corner of the block: the user scrolls it or stretches its height.
          if (event.target !== box) return;
          box.dataset.userScrolled = 'true';
          // The height is fixed at its current value and the default limit is lifted at once, so it
          // can then be made both smaller and larger in one drag. The limit is in em, not vh: the overlay window
          // is as tall as its content, so a share of its height would shrink the block at the first touch.
          if (!box.style.height) box.style.height = `${box.getBoundingClientRect().height}px`;
          box.style.maxHeight = '60em';
        }}
        // The width is never changed by the user: whatever the browser has set is dropped.
        onPointerUp={event => { event.currentTarget.style.width = ''; }}>
        {step.body?.trim() && <div className={`overlay-step-text${step.speech ? ' overlay-step-text--speech' : ''}`}>{step.speech && (step.status === 'running' || step.status === 'success') ? <SpeechText body={step.body} /> : step.body}</div>}
        {step.status === 'error' && step.error && <div className="overlay-step-error">{step.error}</div>}
      </div>}
    </section>)}
  </div>;
}
