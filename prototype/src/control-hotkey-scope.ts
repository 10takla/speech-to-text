// Serialize native registration changes so a slow activation cannot outlive cancellation.
export function createControlHotkeyScope(apply: (active: boolean) => Promise<void>) {
  let desired: boolean | undefined;
  let pending = Promise.resolve();
  return (active: boolean): Promise<void> => {
    if (desired === active) return pending;
    desired = active;
    pending = pending.catch(() => {}).then(() => apply(active)).catch(error => {
      if (desired === active) desired = undefined;
      throw error;
    });
    return pending;
  };
}

export function needsControlHotkeys(state: string, starting: boolean, pinned: boolean) {
  return state !== 'idle' || starting || pinned;
}
