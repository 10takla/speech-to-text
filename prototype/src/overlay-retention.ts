export function createOverlayRetention() {
  let pinned = false;
  let completed = false;
  const listeners = new Set<(pinned: boolean) => void>();
  const releaseListeners = new Set<() => void>();
  const setPinned = (value: boolean) => {
    if (pinned === value) return;
    pinned = value;
    listeners.forEach(listener => listener(pinned));
    if (!pinned && completed) releaseListeners.forEach(listener => listener());
  };
  return {
    get pinned() { return pinned; },
    setPinned,
    complete() { completed = true; return !pinned; },
    start() { completed = false; },
    cancel() { completed = false; setPinned(false); },
    subscribe(listener: (pinned: boolean) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onRelease(listener: () => void) {
      releaseListeners.add(listener);
      return () => { releaseListeners.delete(listener); };
    },
  };
}

export const overlayRetention = createOverlayRetention();
