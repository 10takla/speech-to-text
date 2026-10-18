import { describe, expect, it, vi } from 'vitest';
import { createControlHotkeyScope, needsControlHotkeys } from './control-hotkey-scope';

describe('control hotkey scope', () => {
  it('leaves idle Escape free but keeps cancellation during startup, execution, errors and pinning', () => {
    expect(needsControlHotkeys('idle', false, false)).toBe(false);
    expect(needsControlHotkeys('idle', true, false)).toBe(true);
    for (const state of ['recording', 'editing', 'transcribing', 'error']) {
      expect(needsControlHotkeys(state, false, false)).toBe(true);
    }
    expect(needsControlHotkeys('idle', false, true)).toBe(true);
  });

  it('releases controls after a pending activation, without reordering commands', async () => {
    let finish!: () => void;
    const apply = vi.fn((active: boolean) => active ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    const setActive = createControlHotkeyScope(apply);
    const activation = setActive(true);
    const release = setActive(false);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith(true));
    finish();
    await Promise.all([activation, release]);
    expect(apply.mock.calls).toEqual([[true], [false]]);
    await setActive(false);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed native registration', async () => {
    const apply = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    const setActive = createControlHotkeyScope(apply);
    await expect(setActive(true)).rejects.toThrow('busy');
    await setActive(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
