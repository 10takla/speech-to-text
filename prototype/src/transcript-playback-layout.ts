import './transcript-playback-layout.scss';

export interface SegmentBox {
  fragment: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}
export interface PlaybackRow {
  top: number;
  bottom: number;
  left: number;
  right: number;
  fragments: { fragment: number; left: number; right: number }[];
}

/** Use rendered word positions, rather than the width/bottom of their fragment container. */
export function playbackRows(boxes: SegmentBox[]): PlaybackRow[] {
  const rows: PlaybackRow[] = [];
  let fragments = new Map<number, PlaybackRow['fragments'][number]>();
  for (const box of [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)) {
    let row = rows.at(-1);
    // Sorted tops only need to be compared with the most recent row.
    if (!row || box.top - row.top >= 1.5) {
      row = { top: box.top, bottom: box.bottom, left: box.left, right: box.right, fragments: [] };
      rows.push(row);
      fragments = new Map();
    }
    row.bottom = Math.max(row.bottom, box.bottom);
    row.left = Math.min(row.left, box.left);
    row.right = Math.max(row.right, box.right);
    const fragment = fragments.get(box.fragment);
    if (fragment) {
      fragment.left = Math.min(fragment.left, box.left);
      fragment.right = Math.max(fragment.right, box.right);
    } else {
      const fragment = { fragment: box.fragment, left: box.left, right: box.right };
      fragments.set(box.fragment, fragment);
      row.fragments.push(fragment);
    }
  }
  return rows;
}

interface PlaybackSource {
  element: HTMLElement;
  bar: HTMLElement;
  playing?(): boolean;
}

export function segmentAtPosition<T extends { left: number; right: number }>(segments: T[], x: number): T | undefined {
  return segments.reduce<T | undefined>((nearest, segment) => {
    const distance = (item: T) => Math.max(item.left - x, 0, x - item.right);
    return !nearest || distance(segment) < distance(nearest) ? segment : nearest;
  }, undefined);
}

/** Playback state only changes colours and availability in the shared editor styles. */
export function playbackClassChangesLayout(previous: string, current: string): boolean {
  const geometryClasses = (value: string) => value.split(/\s+/).filter(name => name
    && !['playing', 'fragment-segment-playing', 'disabled', 'all-segments-deleted'].includes(name)).sort().join(' ');
  return geometryClasses(previous) !== geometryClasses(current);
}

export function segmentTrackIsPlaying(source: HTMLElement): boolean {
  return source.classList.contains('playing') || !!source.closest('.fragment-segment-playing');
}

/** Add fragment/all playback tracks below every visual line, keeping their audio actions intact. */
export function attachTranscriptPlaybackLayout(
  flow: HTMLElement,
  sources: PlaybackSource[],
  allBar: HTMLElement,
  activateSource?: (source: HTMLElement, segment?: HTMLElement) => void,
  contextSource?: (source: HTMLElement, event: MouseEvent) => void,
) {
  flow.classList.add('transcript-line-layout');
  sources.forEach(source => {
    source.element.classList.add('transcript-fragment');
    source.bar.classList.add('transcript-playback-source');
  });
  allBar.classList.add('transcript-playback-source');
  const layer = document.createElement('div');
  layer.className = 'transcript-row-tracks';
  flow.append(layer);
  let frame: number | null = null;
  let disposed = false;
  let layoutDirty = true;
  let layoutKey = '';
  let syncTracks: (() => void)[] = [];
  const sourceIds = new WeakMap<HTMLElement, number>();
  let nextSourceId = 0;
  function sourceId(source: HTMLElement) {
    if (!sourceIds.has(source)) sourceIds.set(source, ++nextSourceId);
    return sourceIds.get(source)!;
  }
  // Temporary history playback diagnostics; remove after investigating clicks.
  const debugHistory = import.meta.env.DEV && flow.classList.contains('history-fragments');
  const debugBubble = import.meta.env.DEV && document.body.classList.contains('bubble-window');
  if (debugBubble) console.info('[bubble-layout-debug] editor attached', JSON.stringify({
    origin: location.origin, fragments: sources.length,
  }));
  let pointerHeld = false;
  const debugInput = (event: MouseEvent) => {
    const bounds = flow.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside && !pointerHeld) return;
    const target = event.target instanceof Element ? event.target : null;
    const expected = Array.from(layer.querySelectorAll<HTMLButtonElement>('.transcript-row-track')).find(button => {
      const rect = button.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    console.info('[history-playback-debug] input', JSON.stringify({
      event: event.type, x: event.clientX, y: event.clientY,
      target: target?.outerHTML.slice(0, 500),
      expectedTrack: expected?.className, disabled: expected?.disabled,
      hasHandler: !!expected?.onclick,
      hits: document.elementsFromPoint(event.clientX, event.clientY).slice(0, 5)
        .map(element => `${element.tagName}.${element.className}`),
    }));
    if (event.type === 'pointerdown') pointerHeld = true;
    if (event.type === 'pointerup') pointerHeld = false;
  };
  if (debugHistory) {
    console.info('[history-playback-debug] mounted');
    document.addEventListener('pointerdown', debugInput, true);
    document.addEventListener('pointerup', debugInput, true);
    document.addEventListener('click', debugInput, true);
  }

  function update() {
    frame = null;
    if (disposed || !flow.isConnected) return;
    if (!layoutDirty) {
      syncTracks.forEach(sync => sync());
      return;
    }
    layoutDirty = false;
    const bounds = flow.getBoundingClientRect();
    const originLeft = bounds.left + flow.clientLeft - flow.scrollLeft;
    const originTop = bounds.top + flow.clientTop - flow.scrollTop;
    const boxes: SegmentBox[] = [];
    const segmentTracks: { fragment: number; top: number; left: number; right: number; source: HTMLElement }[] = [];
    sources.forEach((source, fragment) => {
      source.element.querySelectorAll<HTMLElement>('.editor-segment-pair').forEach(segment => {
        const text = segment.querySelector<HTMLElement>('.editor-segment');
        const bar = segment.querySelector<HTMLElement>('.editor-segment-playback-bar');
        if (!text || !bar) return;
        // Re-adding an existing class emits a mutation and would schedule another frame forever.
        if (!bar.classList.contains('transcript-playback-source')) bar.classList.add('transcript-playback-source');
        const rects = Array.from(text.getClientRects());
        for (const rect of rects) {
          if (!rect.width || !rect.height) continue;
          const box = { fragment, top: rect.top - originTop, left: rect.left - originLeft,
            right: rect.right - originLeft, bottom: rect.bottom - originTop };
          boxes.push(box);
          segmentTracks.push({ ...box, source: bar });
        }
      });
    });
    const rows = playbackRows(boxes);
    const nextLayoutKey = JSON.stringify([rows,
      segmentTracks.map(segment => [segment.fragment, segment.top, segment.left, segment.right, sourceId(segment.source)]),
      sources.map(source => sourceId(source.bar)), sourceId(allBar),
    ]);
    if (nextLayoutKey === layoutKey) {
      // Keep the pressed button alive when only highlighting or availability changes.
      syncTracks.forEach(sync => sync());
      return;
    }
    layoutKey = nextLayoutKey;
    syncTracks = [];
    if (debugBubble) console.info('[bubble-layout-debug] rendering tracks', JSON.stringify({
      rows: rows.length, segments: segmentTracks.length,
      rowReserve: getComputedStyle(flow).getPropertyValue('--transcript-row-reserve'),
      width: bounds.width, height: bounds.height,
    }));
    if (debugHistory && pointerHeld) console.info('[history-playback-debug] rebuilding tracks while pointer held');
    layer.replaceChildren();
    rows.forEach(row => {
      const stack = document.createElement('div');
      stack.className = 'transcript-row-track-stack';
      stack.style.left = `${row.left}px`;
      stack.style.top = `${row.bottom}px`;
      stack.style.width = `${Math.max(0, row.right - row.left)}px`;
      const levels = ['segment', 'fragment', 'all'].map(() => {
        const level = document.createElement('div');
        level.className = 'transcript-row-track-level';
        stack.append(level);
        return level;
      });
      layer.append(stack);

      function track(source: HTMLElement, level: number, left: number, right: number,
        isPlaying = () => source.classList.contains('playing')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `transcript-row-track transcript-row-track-${['segment', 'fragment', 'all'][level]}`;
        const sync = () => {
          button.classList.toggle('playing', isPlaying());
          button.classList.toggle('all-segments-deleted', source.classList.contains('all-segments-deleted'));
          const disabled = (source instanceof HTMLButtonElement && source.disabled)
            || source.classList.contains('disabled') || !!source.closest('.deleted');
          if (button.disabled !== disabled) button.disabled = disabled;
          if (button.title !== source.title) button.title = source.title;
          const label = source.getAttribute('aria-label') || source.title;
          if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        };
        syncTracks.push(sync);
        sync();
        button.style.left = `${left - row.left}px`;
        button.style.width = `${Math.max(0, right - left)}px`;
        button.onclick = event => {
          if (debugHistory) console.info('[history-playback-debug] track handler', JSON.stringify({
            level: ['segment', 'fragment', 'all'][level], disabled: button.disabled,
            source: source.className, hasDirectAction: !!activateSource,
          }));
          const candidates = segmentTracks.filter(segment => Math.abs(segment.top - row.top) < 1.5
            && (level === 2 || sources[segment.fragment].element.contains(source)));
          const segment = event.detail === 0 ? candidates[0]
            : segmentAtPosition(candidates, event.clientX - (flow.getBoundingClientRect().left + flow.clientLeft - flow.scrollLeft));
          if (activateSource) activateSource(source, segment?.source);
          else source.click();
        };
        if (contextSource) {
          button.setAttribute('aria-haspopup', 'menu');
          button.oncontextmenu = event => {
            if (button.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            contextSource(source, event);
          };
        }
        levels[level].append(button);
      }

      segmentTracks.filter(segment => Math.abs(segment.top - row.top) < 1.5).forEach(segment => {
        track(segment.source, 0, segment.left, segment.right, () => segmentTrackIsPlaying(segment.source));
      });
      row.fragments.forEach(fragment => {
        const source = sources[fragment.fragment];
        track(source.bar, 1, fragment.left, fragment.right,
          () => source.playing?.() ?? source.bar.classList.contains('playing'));
      });
      track(allBar, 2, row.left, row.right);
    });
  }
  function schedule(measure = true) {
    layoutDirty ||= measure;
    if (!disposed && frame === null) frame = requestAnimationFrame(update);
  }
  const scheduleLayout = () => schedule();
  const resize = new ResizeObserver(scheduleLayout);
  resize.observe(flow);
  sources.forEach(source => resize.observe(source.element));
  const mutation = new MutationObserver(records => {
    let changed = false;
    let measure = false;
    for (const record of records) {
      if (record.target instanceof Element && record.target.closest('.transcript-row-tracks')) continue;
      if (record.type === 'attributes' && record.target instanceof Element && record.attributeName
        && record.oldValue === record.target.getAttribute(record.attributeName)) continue;
      changed = true;
      if (record.type === 'attributes' && ['disabled', 'aria-label', 'title'].includes(record.attributeName || '')) continue;
      if (record.type === 'attributes' && record.attributeName === 'class' && record.target instanceof Element) {
        if (!playbackClassChangesLayout(record.oldValue || '', record.target.className)) continue;
      }
      measure = true;
    }
    if (changed) schedule(measure);
  });
  mutation.observe(flow, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeOldValue: true, attributeFilter: ['class', 'disabled', 'aria-label', 'title'] });
  window.addEventListener('resize', scheduleLayout);
  document.fonts?.addEventListener('loadingdone', scheduleLayout);
  void document.fonts?.ready.then(scheduleLayout);
  schedule();
  return {
    refresh: scheduleLayout,
    dispose() {
      disposed = true;
      if (debugHistory) {
        console.info('[history-playback-debug] disposed');
        document.removeEventListener('pointerdown', debugInput, true);
        document.removeEventListener('pointerup', debugInput, true);
        document.removeEventListener('click', debugInput, true);
      }
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect(); mutation.disconnect();
      window.removeEventListener('resize', scheduleLayout);
      document.fonts?.removeEventListener('loadingdone', scheduleLayout);
      layer.remove();
    },
  };
}
