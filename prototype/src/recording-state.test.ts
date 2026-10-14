import { describe, expect, it } from 'vitest';
import { canTransitionOverlayState, transitionOverlayState } from './recording-state';

describe('overlay recording state', () => {
  it('allows the recording, pause/edit, resume, and completion flow', () => {
    expect(transitionOverlayState('idle', 'recording')).toBe('recording');
    expect(transitionOverlayState('recording', 'editing')).toBe('editing');
    expect(transitionOverlayState('editing', 'recording')).toBe('recording');
    expect(transitionOverlayState('recording', 'transcribing')).toBe('transcribing');
    expect(transitionOverlayState('transcribing', 'idle')).toBe('idle');
  });

  it('allows a failure to return to idle or start a retry', () => {
    expect(transitionOverlayState('recording', 'error')).toBe('error');
    expect(transitionOverlayState('error', 'idle')).toBe('idle');
    expect(transitionOverlayState('error', 'recording')).toBe('recording');
  });

  it('rejects transitions that skip the recording flow', () => {
    expect(canTransitionOverlayState('idle', 'editing')).toBe(false);
    expect(() => transitionOverlayState('transcribing', 'recording')).toThrow('Недопустимый переход');
  });
});
