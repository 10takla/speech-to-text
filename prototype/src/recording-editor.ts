import type { TimedTranscript, TranscriptSegment } from './groq';
import { decodeAudio } from './audio-decoding';
import { attachTranscriptPlaybackLayout } from './transcript-playback-layout';
import { claimPlayback, ownsPlayback, releasePlayback } from './playback-coordinator';
import { fitTranscriptToAudio } from './transcript-timing';
import { attachSegmentPainting } from './segment-painting';
import { attachTranscriptCopy } from './transcript-copy';

export type TimeRange = { start: number; end: number };

export function retainedPlaybackOffset(ranges: TimeRange[], start: number): number {
  return ranges.reduce((offset, range) => offset + Math.max(0, Math.min(start, range.end) - range.start), 0);
}
export interface EditedRecording {
  audioBlob: Blob;
  transcript: TimedTranscript;
  finish: boolean;
  text: string;
  segments: TranscriptSegment[];
  removedRanges: TimeRange[];
}

export function mergeRanges(ranges: TimeRange[], duration: number): TimeRange[] {
  const sorted = ranges.map(r => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export function retainedRanges(removed: TimeRange[], duration: number): TimeRange[] {
  const kept: TimeRange[] = [];
  let start = 0;
  for (const r of mergeRanges(removed, duration)) {
    if (r.start > start) kept.push({ start, end: r.start });
    start = r.end;
  }
  if (start < duration) kept.push({ start, end: duration });
  return kept;
}

const intersects = (a: TimeRange, b: TimeRange) => a.start < b.end && b.start < a.end;
const timeLabel = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const segmentPainters = new WeakMap<HTMLElement, { setDeleted: (deleted: boolean) => boolean; refresh: () => void }>();

export function cutAudio(buffer: AudioBuffer, ranges: TimeRange[]): Blob {
  const frames = ranges.map(r => ({ start: Math.round(r.start * buffer.sampleRate), end: Math.min(buffer.length, Math.round(r.end * buffer.sampleRate)) }));
  const length = frames.reduce((n, r) => n + Math.max(0, r.end - r.start), 0);
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (const range of frames) for (let i = range.start; i < range.end; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((n, c) => n + c[i], 0) / channels.length));
    view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    offset += 2;
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export function nearestBoundary(time: number, boundaries: number[]): number {
  return boundaries.reduce((best, point) => Math.abs(point - time) < Math.abs(best - time) ? point : best, boundaries[0] || 0);
}

export function textAfterCuts(transcript: TimedTranscript, removed: TimeRange[]): string {
  if (!removed.length) return transcript.text;
  return transcript.segments.filter(s => !removed.some(r => intersects(r, s)))
    .map(s => s.text).join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

export function createRecordingEditor(
  host: HTMLElement,
  blob: Blob,
  transcribe: (signal: AbortSignal) => Promise<TimedTranscript>,
  actionLabel: string,
  initialRemoved: TimeRange[] = [],
  leadingSpace = false,
  sharedPainting = false,
) {
  const element = document.createElement('section');
  element.className = 'recording-editor';
  element.innerHTML = `
    <p class="editor-status sr-only" role="status" aria-live="polite">Распознаём речь…</p>
    <div class="editor-segments" aria-label="Сегменты транскрипции"><audio preload="metadata"></audio></div>
    <div class="fragment-playback-bar" title="Воспроизвести отрывок" role="button" aria-label="Воспроизвести отрывок"></div>
    <div class="overlay-controls"><button class="btn secondary editor-cancel">Отмена</button><button class="btn secondary editor-finish" disabled>Завершить запись</button><button class="btn primary editor-apply" disabled></button></div>`;
  host.append(element);
  const stopCopy = sharedPainting ? () => {} : attachTranscriptCopy(element);
  const query = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!;
  const status = query<HTMLElement>('.editor-status');
  const segmentList = query<HTMLElement>('.editor-segments');
  const playButton = query<HTMLElement>('.fragment-playback-bar');
  const audio = query<HTMLAudioElement>('audio');
  const finishButton = query<HTMLButtonElement>('.editor-finish');
  let boundaries: number[] = [0];
  let requestedFinish: boolean | null = null;
  const apply = query<HTMLButtonElement>('.editor-apply');
  apply.textContent = actionLabel;
  const controller = new AbortController();
  let buffer: AudioBuffer | null = null;
  let transcript: TimedTranscript | null = null;
  let removed: TimeRange[] = initialRemoved.map(r => ({ ...r }));
  let selection: TimeRange = { start: 0, end: 0 };
  let playbackRanges: TimeRange[] = [];
  let segmentPlaybackFrame: number | null = null;
  let closed = false;
  let previewUrl: string | null = null;
  let segmentPlayback: { bar: HTMLElement; stop(): void } | null = null;
  let resolve!: (value: EditedRecording | null) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<EditedRecording | null>((yes, no) => { resolve = yes; reject = no; });

  function dispose() {
    if (closed) return;
    closed = true;
    stopCopy();
    segmentPlayback?.stop();
    releasePlayback(playButton);
    stopSegmentPlaybackAnimation();
    controller.abort();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    element.remove();
  }
  function cancel() { resolve(null); dispose(); }
  function isRemoved(segment: TimeRange) { return removed.some(r => intersects(r, segment)); }
  function currentText() {
    return transcript ? textAfterCuts(transcript, removed) : '';
  }
  function snap(range: TimeRange) {
    const touched = transcript?.segments.filter(s => intersects(s, range)) || [];
    return { start: Math.min(range.start, ...touched.map(s => s.start)), end: Math.max(range.end, ...touched.map(s => s.end)) };
  }
  function setSelection(start: number, end: number) {
    const duration = buffer?.duration || 0;
    if (transcript) { start = nearestBoundary(start, boundaries); end = nearestBoundary(end, boundaries); }
    selection = { start: Math.max(0, Math.min(start, end, duration)), end: Math.max(0, Math.min(Math.max(start, end), duration)) };
    draw();
  }
  function draw() {
    if (!transcript) return;
    segmentList.querySelectorAll<HTMLElement>('[data-segment]').forEach((pair, index) => {
      pair.classList.toggle('selected', intersects(transcript!.segments[index], selection));
    });
  }
  function refresh() {
    if (!buffer || closed) return;
    segmentPlayback?.stop();
    removed = mergeRanges(removed, buffer.duration);
    playbackRanges = retainedRanges(removed, buffer.duration);
    audio.pause();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(cutAudio(buffer, playbackRanges));
    audio.src = previewUrl;
    audio.currentTime = 0;
    const keptDuration = playbackRanges.reduce((total, range) => total + range.end - range.start, 0);
    const allSegmentsDeleted = !!transcript?.segments.length && transcript.segments.every(segment => isRemoved(segment));
    playButton.classList.toggle('disabled', keptDuration < .01 || allSegmentsDeleted);
    playButton.classList.toggle('all-segments-deleted', allSegmentsDeleted);
    apply.disabled = !transcript;
    finishButton.disabled = !transcript;
    if (transcript) status.textContent = 'Редактор готов.';
    segmentList.querySelectorAll<HTMLElement>('[data-segment]').forEach((pair, i) => {
      const deleted = isRemoved(transcript!.segments[i]);
      pair.classList.toggle('deleted', deleted);
      pair.setAttribute('aria-pressed', String(deleted));
      pair.title = `${deleted ? 'Восстановить' : 'Исключить'} · ${timeLabel(transcript!.segments[i].start)}–${timeLabel(transcript!.segments[i].end)}`;
    });
    draw();
  }
  function syncSegmentPlayback() {
    let originalTime: number | null = null;
    if (!closed && !audio.paused && !audio.ended) {
      let remainingTime = audio.currentTime;
      for (const range of playbackRanges) {
        const duration = range.end - range.start;
        if (remainingTime < duration) {
          originalTime = range.start + remainingTime;
          break;
        }
        remainingTime -= duration;
      }
    }
    segmentList.querySelectorAll<HTMLElement>('[data-segment]').forEach((pair, index) => {
      const segment = transcript?.segments[index];
      pair.classList.toggle('fragment-segment-playing', originalTime !== null && !!segment
        && originalTime >= segment.start && originalTime < segment.end && !isRemoved(segment));
    });
  }
  function stopSegmentPlaybackAnimation() {
    if (segmentPlaybackFrame !== null) cancelAnimationFrame(segmentPlaybackFrame);
    segmentPlaybackFrame = null;
    syncSegmentPlayback();
  }
  function animateSegmentPlayback() {
    segmentPlaybackFrame = null;
    syncSegmentPlayback();
    if (!closed && !audio.paused && !audio.ended) segmentPlaybackFrame = requestAnimationFrame(animateSegmentPlayback);
  }
  const syncPlayButton = () => {
    const playing = !closed && !audio.paused && !audio.ended;
    if (!playing) releasePlayback(playButton);
    element.classList.toggle('playing', playing);
    playButton.setAttribute('aria-label', playing ? 'Приостановить отрывок' : 'Воспроизвести отрывок');
    playButton.title = playing ? 'Приостановить отрывок' : 'Воспроизвести отрывок';
    stopSegmentPlaybackAnimation();
    if (playing) animateSegmentPlayback();
  };
  playButton.addEventListener('click', () => {
    if (playButton.classList.contains('disabled')) return;
    if (ownsPlayback(playButton) && !audio.paused) { audio.pause(); releasePlayback(playButton); return; }
    claimPlayback(playButton, () => { audio.pause(); syncPlayButton(); });
    void audio.play().catch(error => {
      releasePlayback(playButton);
      status.textContent = `Не удалось воспроизвести отрывок: ${String(error)}`;
    });
  });
  audio.addEventListener('play', syncPlayButton);
  audio.addEventListener('pause', syncPlayButton);
  audio.addEventListener('ended', syncPlayButton);
  audio.addEventListener('timeupdate', syncSegmentPlayback);
  audio.addEventListener('seeked', syncSegmentPlayback);
  function restore(range: TimeRange) {
    removed = removed.flatMap(r => !intersects(r, range) ? [r] : [
      { start: r.start, end: Math.min(r.end, range.start) },
      { start: Math.max(r.start, range.end), end: r.end },
    ].filter(r => r.end > r.start));
  }
  let painted = false;
  if (!sharedPainting) {
    let paintStart: { index: number; x: number; y: number; pointer: number; remove: boolean } | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    function paint(index: number) {
      if (!paintStart || !transcript) return;
      painted = true;
      for (let i = Math.min(paintStart.index, index); i <= Math.max(paintStart.index, index); i++) {
        const s = transcript.segments[i];
        if (paintStart.remove) {
          if (!isRemoved(s)) removed.push({ start: s.start, end: s.end });
        } else restore(s);
      }
      refresh();
    }
    segmentList.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const target = (e.target as HTMLElement).closest('.editor-segment')?.closest<HTMLElement>('[data-segment]');
      if (!target) return;
      painted = false;
      paintStart = { index: Number(target.dataset.segment), x: e.clientX, y: e.clientY, pointer: e.pointerId, remove: !isRemoved(transcript!.segments[Number(target.dataset.segment)]) };
      holdTimer = setTimeout(() => {
        if (!paintStart) return;
        segmentList.setPointerCapture(paintStart.pointer);
        paint(paintStart.index);
      }, 220);
    });
    segmentList.addEventListener('pointermove', e => {
      if (!paintStart || (!painted && Math.hypot(e.clientX - paintStart.x, e.clientY - paintStart.y) < 5)) return;
      if (holdTimer) clearTimeout(holdTimer);
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.editor-segment')?.closest<HTMLElement>('[data-segment]');
      if (target && segmentList.contains(target)) {
        segmentList.setPointerCapture(e.pointerId);
        paint(Number(target.dataset.segment));
      }
    });
    const endPaint = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (paintStart && painted) refresh();
      paintStart = null;
      setTimeout(() => { painted = false; }, 0);
    };
    window.addEventListener('pointerup', endPaint, { signal: controller.signal });
    window.addEventListener('pointercancel', endPaint, { signal: controller.signal });
    controller.signal.addEventListener('abort', () => { if (holdTimer) clearTimeout(holdTimer); });
  }
  query('.editor-cancel').addEventListener('click', cancel);
  function confirm(finish = false) {
    if (closed) return;
    if (!buffer || !transcript) {
      requestedFinish = finish;
      status.textContent = finish ? 'Завершаем распознавание перед вставкой…' : 'Завершаем распознавание перед продолжением…';
      return;
    }
    resolve({ audioBlob: cutAudio(buffer, playbackRanges), text: currentText(), transcript, finish,
      segments: transcript.segments, removedRanges: removed.map(r => ({ ...r })) });
    dispose();
  }
  apply.addEventListener('click', () => confirm(false));
  finishButton.addEventListener('click', () => confirm(true));
  const decoded = Promise.resolve().then(async () => {
    const decodedBuffer = await decodeAudio(await blob.arrayBuffer());
    if (closed) return;
    buffer = decodedBuffer;
    // Редактирование включается после получения точных границ сегментов.
    setSelection(0, buffer.duration);
    refresh();
  });
  void Promise.all([decoded, transcribe(controller.signal)]).then(([, response]) => {
    if (closed || !buffer) return;
    if (!response.text) throw new Error('Речь не распознана. Попробуйте ещё раз.');
    if (!response.segments.length && !response.fallbackSegments?.length) throw new Error('Транскрибатор не вернул временные метки. Редактирование недоступно для этой записи.');
    transcript = fitTranscriptToAudio(response, buffer.duration);
    if (!transcript.segments.length) throw new Error('Временные метки не соответствуют записи.');
    boundaries = [...new Set([0, buffer.duration, ...transcript.segments.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
    removed = removed.map(snap);
    transcript.segments.forEach((segment, index) => {
      const pair = document.createElement('span');
      pair.className = 'editor-segment-pair';
      pair.dataset.segment = String(index); pair.setAttribute('role', 'button'); pair.tabIndex = 0;
      const text = document.createElement('span');
      text.className = 'editor-segment'; text.textContent = segment.text;
      const audioBar = document.createElement('span');
      audioBar.className = 'editor-audio-segment';
      audioBar.setAttribute('aria-hidden', 'true');
      const segmentPlayBar = document.createElement('span');
      segmentPlayBar.className = 'editor-segment-playback-bar';
      segmentPlayBar.title = `Воспроизвести сегмент: ${segment.text}`;
      segmentPlayBar.setAttribute('aria-label', `Воспроизвести сегмент: ${segment.text}`);
      segmentPlayBar.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!buffer || isRemoved(segment)) return;
        if (segmentPlayback?.bar === segmentPlayBar) { segmentPlayback.stop(); return; }
        const segAudioBlob = cutAudio(buffer, [{ start: segment.start, end: segment.end }]);
        const segAudioUrl = URL.createObjectURL(segAudioBlob);
        const segAudio = new Audio(segAudioUrl);
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          segAudio.pause();
          segAudio.removeAttribute('src');
          segAudio.load();
          segmentPlayBar.classList.remove('playing');
          URL.revokeObjectURL(segAudioUrl);
          releasePlayback(segmentPlayBar);
          if (segmentPlayback?.stop === stop) segmentPlayback = null;
        };
        claimPlayback(segmentPlayBar, stop);
        segmentPlayback = { bar: segmentPlayBar, stop };
        segAudio.addEventListener('ended', stop, { once: true });
        segAudio.addEventListener('pause', stop, { once: true });
        segAudio.addEventListener('error', stop, { once: true });
        segmentPlayBar.classList.add('playing');
        void segAudio.play().catch(stop);
      });
      pair.append(text, audioBar, segmentPlayBar);
      segmentPainters.set(pair, {
        setDeleted: deleted => {
          if (isRemoved(segment) === deleted) return false;
          if (deleted) removed.push({ start: segment.start, end: segment.end });
          else restore(segment);
          return true;
        },
        refresh,
      });
      const toggleSegment = (e?: Event) => {
        if ((e?.target as HTMLElement)?.closest('.editor-segment-playback-bar')) return;
        if (painted) return;
        if (isRemoved(segment)) restore(segment); else removed.push({ start: segment.start, end: segment.end });
        setSelection(segment.start, segment.end); refresh();
      };
      text.addEventListener('click', toggleSegment);
      pair.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSegment(); }
      });
      if (index > 0 || (leadingSpace && index === 0)) segmentList.append(document.createTextNode(' '));
      segmentList.append(pair);
    });
    refresh();
    if (requestedFinish !== null) confirm(requestedFinish);
  }).catch(error => { if (!closed) { reject(error); dispose(); } });
  return {
    result, cancel, confirm,
    playbackOffset(segmentIndex: number) {
      const start = transcript?.segments[segmentIndex]?.start ?? 0;
      return retainedPlaybackOffset(playbackRanges, start);
    },
    get ready() { return Boolean(buffer && transcript); },
    snapshot: () => ({ transcript, removedRanges: removed.map(range => ({ ...range })) }),
  };
}


export interface RecordingFragment {
  audioBlob: Blob;
  start: number;
  end: number;
  transcript: TimedTranscript | null;
  removedRanges: TimeRange[];
}

export function createFragmentEditors(
  host: HTMLElement,
  fragments: RecordingFragment[],
  transcribe: (blob: Blob, signal: AbortSignal) => Promise<TimedTranscript>,
) {
  const panel = document.createElement('section');
  panel.className = 'fragment-editors';
  const fragmentFlow = document.createElement('div');
  fragmentFlow.className = 'fragment-editor-flow';
  const stopCopy = attachTranscriptCopy(fragmentFlow);
  panel.append(fragmentFlow);
  const editors = fragments.map((fragment, index) => {
    const section = document.createElement('span');
    section.className = 'fragment-editor';
    fragmentFlow.append(section);
    return createRecordingEditor(section, fragment.audioBlob,
      signal => fragment.transcript ? Promise.resolve(fragment.transcript) : transcribe(fragment.audioBlob, signal),
      'Продолжить запись', fragment.removedRanges, index > 0, true);
  });

  // Третий уровень: общая линия воспроизведения для всех отрывков вместе
  const globalPlayBar = document.createElement('button');
  globalPlayBar.type = 'button';
  globalPlayBar.className = 'all-fragments-playback-bar';
  globalPlayBar.title = 'Воспроизвести все отрывки вместе';
  globalPlayBar.setAttribute('aria-label', 'Общее воспроизведение всех строк транскрипции');

  let currentGlobalAudio: HTMLAudioElement | null = null;
  let isGlobalPlaying = false;
  let globalPlaybackController: AbortController | null = null;

  const stopGlobalPlayback = () => {
    globalPlaybackController?.abort();
    globalPlaybackController = null;
    releasePlayback(globalPlayBar);
    if (currentGlobalAudio) {
      currentGlobalAudio.pause();
      currentGlobalAudio = null;
    }
    isGlobalPlaying = false;
    panel.classList.remove('global-playing');
    globalPlayBar.classList.remove('playing');
  };

  const toggleGlobalPlayback = async (startIndex = 0, startOffset = 0) => {
    if (isGlobalPlaying) {
      stopGlobalPlayback();
      return;
    }

    const audios = Array.from(panel.querySelectorAll<HTMLAudioElement>('audio'));
    if (!audios.length) return;

    claimPlayback(globalPlayBar, stopGlobalPlayback);
    const session = new AbortController();
    globalPlaybackController = session;
    isGlobalPlaying = true;
    panel.classList.add('global-playing');
    globalPlayBar.classList.add('playing');

    let currentIndex = startIndex;
    const playNext = () => {
      if (session.signal.aborted) return;
      if (!isGlobalPlaying || currentIndex >= audios.length) {
        stopGlobalPlayback();
        return;
      }
      const audio = audios[currentIndex];
      currentGlobalAudio = audio;
      audio.currentTime = currentIndex === startIndex ? startOffset : 0;
      audio.addEventListener('ended', () => {
        currentIndex++;
        playNext();
      }, { once: true, signal: session.signal });
      audio.addEventListener('pause', () => {
        if (currentGlobalAudio === audio && audio.paused && !audio.ended) stopGlobalPlayback();
      }, { signal: session.signal });
      void audio.play().catch(() => {
        if (session.signal.aborted) return;
        currentIndex++;
        playNext();
      });
    };

    playNext();
  };
  globalPlayBar.addEventListener('click', () => { void toggleGlobalPlayback(); });

  fragmentFlow.append(globalPlayBar);
  host.append(panel);

  const playbackLayout = attachTranscriptPlaybackLayout(fragmentFlow,
    Array.from(fragmentFlow.querySelectorAll<HTMLElement>('.fragment-editor')).map(section => ({
      element: section,
      bar: section.querySelector<HTMLElement>('.fragment-playback-bar')!,
      playing: () => section.querySelector('.recording-editor')!.classList.contains('playing'),
    })), globalPlayBar, (source, segment) => {
      if (!segment || source.classList.contains('editor-segment-playback-bar')) {
        source.click();
        return;
      }
      const sections = Array.from(fragmentFlow.querySelectorAll<HTMLElement>('.fragment-editor'));
      const index = sections.findIndex(section => section.contains(segment));
      const pair = segment.closest<HTMLElement>('[data-segment]');
      if (index < 0 || !pair) return;
      const offset = editors[index].playbackOffset(Number(pair.dataset.segment));
      if (source === globalPlayBar) {
        void toggleGlobalPlayback(index, offset);
      } else {
        const audio = sections[index].querySelector<HTMLAudioElement>('audio')!;
        if (!ownsPlayback(source) || audio.paused) audio.currentTime = offset;
        source.click();
      }
    });
  const stopPainting = attachSegmentPainting(panel, segmentPainters);
  let closed = false;
  let finishRequested = false;
  function confirm(finish = false) {
    if (closed) return;
    finishRequested = finish;
    editors.forEach(editor => editor.confirm(finish));
  }
  function cancel() {
    stopGlobalPlayback();
    stopCopy();
    stopPainting();
    playbackLayout.dispose();

    if (!closed) editors.forEach(editor => editor.cancel());
  }
  const result = Promise.all(editors.map(editor => editor.result)).then(values => {
    if (values.some(value => value === null)) return null;
    return { fragments: values as EditedRecording[], finish: finishRequested };
  }).finally(() => { stopGlobalPlayback(); cancel(); closed = true; panel.remove(); });
  return {
    result, cancel, confirm,
    get ready() { return editors.every(editor => editor.ready); },
    preserve() {
      editors.forEach((editor, index) => {
        const snapshot = editor.snapshot();
        if (snapshot.transcript) fragments[index].transcript = snapshot.transcript;
        fragments[index].removedRanges = snapshot.removedRanges;
      });
    },
  };
}

export function combineFragments(fragments: RecordingFragment[]) {
  if (fragments.some(fragment => !fragment.transcript)) throw new Error('Распознавание отрывков ещё не завершено.');
  return {
    text: fragments.map(fragment => textAfterCuts(fragment.transcript!, fragment.removedRanges)).filter(Boolean).join(' ').trim(),
    segments: fragments.flatMap(fragment => fragment.transcript!.segments.map(segment => ({
      ...segment, start: fragment.start + segment.start, end: fragment.start + segment.end,
    }))),
    removedRanges: fragments.flatMap(fragment => fragment.removedRanges.map(range => ({
      start: fragment.start + range.start, end: fragment.start + range.end,
    }))),
  };
}
