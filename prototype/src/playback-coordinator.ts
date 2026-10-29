let active: { owner: object; stop: () => void } | null = null;

/** Segment, fragment, playlist and history playback share a single audio owner. */
export function claimPlayback(owner: object, stop: () => void): void {
  if (active?.owner === owner) return;
  const previous = active;
  active = null;
  previous?.stop();
  active = { owner, stop };
}

export function ownsPlayback(owner: object): boolean { return active?.owner === owner; }

export function releasePlayback(owner: object): void {
  if (active?.owner === owner) active = null;
}

export function stopExclusivePlayback(): void {
  const previous = active;
  active = null;
  previous?.stop();
}
