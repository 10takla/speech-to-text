interface SegmentPainter {
  setDeleted(deleted: boolean): boolean;
  refresh(): void;
}

/** Paint segment exclusions across fragment boundaries, for mouse, pen, and touch. */
export function attachSegmentPainting(panel: HTMLElement, painters: WeakMap<HTMLElement, SegmentPainter>) {
  const document = panel.ownerDocument;
  const view = document.defaultView!;
  const controller = new AbortController();
  type Session = {
    pointerId: number;
    startIndex: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    remove: boolean;
    nodes: HTMLElement[];
    indexByNode: Map<HTMLElement, number>;
    touched: Set<number>;
    active: boolean;
    holdTimer: ReturnType<typeof setTimeout>;
  };
  let session: Session | null = null;
  let suppressClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  function paint(indexes: Iterable<number>) {
    if (!session) return;
    const refresh = new Set<() => void>();
    for (const index of indexes) {
      if (session.touched.has(index)) continue;
      session.touched.add(index);
      const painter = painters.get(session.nodes[index]);
      if (painter?.setDeleted(session.remove)) refresh.add(painter.refresh);
    }
    refresh.forEach(update => update());
  }

  function activate(current: Session) {
    if (session !== current || current.active) return;
    current.active = true;
    clearTimeout(current.holdTimer);
    // Capture only after painting starts, so a short tap still clicks the original segment.
    try { panel.setPointerCapture(current.pointerId); } catch { /* Pointer may already have been cancelled. */ }
    paint([current.startIndex]);
  }

  function paintPath(current: Session, x: number, y: number) {
    const dx = x - current.lastX;
    const dy = y - current.lastY;
    const samples = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 3));
    const touched = new Set<number>();
    for (let step = 1; step <= samples; step++) {
      const hit = document.elementFromPoint(current.lastX + dx * step / samples, current.lastY + dy * step / samples)
        ?.closest('.editor-segment')?.closest<HTMLElement>('[data-segment]');
      if (!hit || !panel.contains(hit)) continue;
      const index = current.indexByNode.get(hit);
      if (index !== undefined) touched.add(index);
    }
    current.lastX = x;
    current.lastY = y;
    paint(touched);
  }

  panel.addEventListener('pointerdown', event => {
    if (event.button !== 0 || session) return;
    const target = event.target as HTMLElement;
    if (target.closest('.editor-segment-playback-bar, .transcript-row-track')) return;
    const segment = target.closest('.editor-segment')?.closest<HTMLElement>('[data-segment]');
    if (!segment || !panel.contains(segment)) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>('[data-segment]'));
    const startIndex = nodes.indexOf(segment);
    if (startIndex < 0) return;
    suppressClick = false;
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    const current: Session = {
      pointerId: event.pointerId, startIndex, startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, remove: !segment.classList.contains('deleted'),
      nodes, indexByNode: new Map(nodes.map((node, index) => [node, index])), touched: new Set(), active: false,
      holdTimer: setTimeout(() => activate(current), 220),
    };
    session = current;
  }, { signal: controller.signal });

  view.addEventListener('pointermove', event => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    activate(current);
    if (event.cancelable) event.preventDefault();
    for (const sample of event.getCoalescedEvents?.() ?? []) paintPath(current, sample.clientX, sample.clientY);
    paintPath(current, event.clientX, event.clientY);
  }, { signal: controller.signal, passive: false });

  function end(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    clearTimeout(session.holdTimer);
    if (session.active) {
      suppressClick = true;
      suppressTimer = setTimeout(() => { suppressClick = false; suppressTimer = null; }, 500);
    }
    try { if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    session = null;
  }
  view.addEventListener('pointerup', end, { signal: controller.signal });
  view.addEventListener('pointercancel', end, { signal: controller.signal });
  panel.addEventListener('contextmenu', event => event.preventDefault(), { signal: controller.signal });
  panel.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal: controller.signal });

  return () => {
    controller.abort();
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    if (!session) return;
    clearTimeout(session.holdTimer);
    try { if (panel.hasPointerCapture(session.pointerId)) panel.releasePointerCapture(session.pointerId); } catch { /* already released */ }
    session = null;
  };
}
