import type { OverlayState } from './config';

const allowedTransitions: Record<OverlayState, readonly OverlayState[]> = {
  idle: ['idle', 'recording', 'error'],
  recording: ['recording', 'editing', 'transcribing', 'idle', 'error'],
  transcribing: ['idle', 'error'],
  editing: ['recording', 'transcribing', 'idle', 'error'],
  error: ['idle', 'recording', 'error'],
};

export function canTransitionOverlayState(from: OverlayState, to: OverlayState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionOverlayState(from: OverlayState, to: OverlayState): OverlayState {
  if (!canTransitionOverlayState(from, to)) {
    throw new Error(`Недопустимый переход состояния оверлея: ${from} → ${to}`);
  }
  return to;
}
