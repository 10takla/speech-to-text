import type { HistoryFragment, HistoryItem } from './history-db';
import { attachTranscriptPlaybackLayout } from './transcript-playback-layout';
import { claimPlayback, releasePlayback } from './playback-coordinator';
import type { HistoryAudioExcerpt } from './history-audio-excerpt';

const labelTime = (time: number) => `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, '0')}`;
export const segmentIsDeleted = (segment: { start: number; end: number }, ranges: { start: number; end: number }[]) =>
  ranges.some(range => range.start < segment.end && segment.start < range.end);

export function retainedHistoryText(record: HistoryItem): string {
  return historyFragments(record)
    .map(fragment => fragment.segments
      .filter(segment => !segmentIsDeleted(segment, fragment.removedRanges))
      .map(segment => segment.text)
      .join(' '))
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function historyFragments(record: HistoryItem): HistoryFragment[] {
  if (record.fragments?.length) return record.fragments;
  if (!record.segments?.length) return [];
  // Ранее сохранённые временные метки отображаем одним отрывком.
  return [{ start: 0, end: Math.max(...record.segments.map(s => s.end), ...(record.removedRanges || []).map(r => r.end)),
    text: record.text || '', audioBlob: record.originalAudioBlob || record.audioBlob,
    segments: record.segments, removedRanges: record.removedRanges || [] }];
}

export function renderHistoryFragments(record: HistoryItem,
  onContextMenu?: (event: MouseEvent, excerpt: HistoryAudioExcerpt) => void) {
  const fragments = historyFragments(record);
  if (!fragments.length) return null;
  const element = document.createElement('div');
  element.className = 'history-fragments recording-editor';
  const audioPlayers: (HTMLAudioElement | null)[] = [];
  const objectUrls: string[] = [];
  const segmentBars: HTMLButtonElement[][] = [];
  const fragmentBars: HTMLButtonElement[] = [];
  const fragmentSections: HTMLElement[] = [];
  const playbackActions = new WeakMap<HTMLElement, () => void>();
  type PlaybackTarget = { fragmentIndex: number; start: number; end: number };
  const excerpts = new WeakMap<HTMLElement, { label: string; filenameSuffix: string; targets(): PlaybackTarget[] }>();
  const openContextMenu = (source: HTMLElement, event: MouseEvent) => {
    const selection = excerpts.get(source);
    if (!selection || !onContextMenu) return;
    const parts = selection.targets().flatMap(target => {
      const audio = fragments[target.fragmentIndex].audioBlob;
      return audio?.size ? [{ audio, start: target.start, end: target.end }] : [];
    });
    if (!parts.length) return;
    event.preventDefault(); event.stopPropagation();
    onContextMenu(event, { label: selection.label, filenameSuffix: selection.filenameSuffix, parts });
  };
  let playbackQueue: PlaybackTarget[] = [];
  let queueIndex = 0;
  let activeAudio: HTMLAudioElement | null = null;
  let activeOwner: HTMLButtonElement | null = null;
  let playbackToken = 0;
  const playbackOwner = {};
  // Temporary history playback diagnostics.
  const debug = (stage: string, details: unknown) => {
    if (import.meta.env.DEV) console.info(`[history-playback-debug] ${stage}`, JSON.stringify(details));
  };

  const retainedRanges = (fragment: HistoryFragment) => {
    const duration = Math.max(
      0,
      fragment.end - fragment.start,
      ...fragment.segments.map(segment => segment.end),
      ...fragment.removedRanges.map(range => range.end),
    );
    let cursor = 0;
    const ranges: { start: number; end: number }[] = [];
    for (const cut of [...fragment.removedRanges].sort((a, b) => a.start - b.start)) {
      const start = Math.max(0, Math.min(duration, cut.start));
      const end = Math.max(start, Math.min(duration, cut.end));
      if (start > cursor) ranges.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    }
    if (cursor < duration) ranges.push({ start: cursor, end: duration });
    return ranges.filter(range => range.end - range.start > 0.01);
  };

  const updateHighlights = () => {
    fragments.forEach((fragment, fragmentIndex) => {
      const audio = fragment.audioBlob ? audioPlayers[fragmentIndex] : null;
      const isCurrent = !!audio && audio === activeAudio && !audio.paused;
      fragment.segments.forEach((segment, segmentIndex) => {
        const active = isCurrent && audio!.currentTime >= segment.start && audio!.currentTime < segment.end;
        segmentBars[fragmentIndex]?.[segmentIndex]?.classList.toggle('playing', active);
      });
      const activeFragment = playbackQueue[queueIndex]?.fragmentIndex === fragmentIndex && isCurrent;
      fragmentBars[fragmentIndex]?.classList.toggle('playing',
        fragmentBars[fragmentIndex] === activeOwner || (activeOwner?.dataset.level === 'all' && activeFragment));
    });
    if (activeOwner?.dataset.level === 'all') activeOwner.classList.add('playing');
  };

  const stopPlayback = () => {
    releasePlayback(playbackOwner);
    playbackToken++;
    const audio = activeAudio;
    activeAudio = null;
    playbackQueue = [];
    queueIndex = 0;
    activeOwner?.classList.remove('playing');
    activeOwner = null;
    segmentBars.flat().forEach(bar => bar.classList.remove('playing'));
    fragmentBars.forEach(bar => bar.classList.remove('playing'));
    audio?.pause();
  };

  const playNext = (token: number) => {
    if (token !== playbackToken) return;
    const target = playbackQueue[queueIndex];
    if (!target) {
      stopPlayback();
      return;
    }
    const audio = audioPlayers[target.fragmentIndex];
    if (!audio) {
      queueIndex++;
      playNext(token);
      return;
    }
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    debug('audio.play requested', { record: record.id, target, readyState: audio.readyState,
      paused: audio.paused, duration: audio.duration, currentTime: audio.currentTime });
    audio.currentTime = target.start;
    updateHighlights();
    void audio.play().then(() => {
      debug('audio.play resolved', { paused: audio.paused, currentTime: audio.currentTime });
      updateHighlights();
    }).catch(error => {
      debug('audio.play rejected', { name: error?.name, message: String(error) });
      if (token !== playbackToken) return;
      queueIndex++;
      playNext(token);
    });
  };

  const startPlayback = (targets: PlaybackTarget[], owner: HTMLButtonElement) => {
    debug('startPlayback', { record: record.id, targets, owner: owner.className, toggleOff: activeOwner === owner });
    if (activeOwner === owner) {
      stopPlayback();
      return;
    }
    stopPlayback();
    playbackQueue = targets;
    if (!playbackQueue.length) return;
    claimPlayback(playbackOwner, stopPlayback);
    activeOwner = owner;
    owner.classList.add('playing');
    const token = playbackToken;
    playNext(token);
  };

  fragments.forEach((fragment, index) => {
    const section = document.createElement('section'); section.className = 'history-fragment';
    fragmentSections.push(section);
    const segments = document.createElement('div');
    segments.className = 'editor-segments history-fragment-segments';
    segments.setAttribute('aria-label', `Сегменты транскрипции отрывка ${index + 1}`);
    const audioBlob = fragment.audioBlob;
    const audio = audioBlob ? document.createElement('audio') : null;
    audioPlayers.push(audio);
    if (audio) {
      audio.preload = 'metadata';
      const url = URL.createObjectURL(audioBlob!); objectUrls.push(url); audio.src = url;
    }
    const bars: HTMLButtonElement[] = [];
    segmentBars.push(bars);
    fragment.segments.forEach((segment, i) => {
      const deleted = segmentIsDeleted(segment, fragment.removedRanges);
      const pair = document.createElement('span');
      pair.className = `editor-segment-pair ${deleted ? 'deleted' : 'kept'}`;
      const text = document.createElement('span');
      text.className = 'editor-segment'; text.textContent = segment.text;
      text.title = `${deleted ? 'Исключён' : 'Оставлен'} · ${labelTime(segment.start)}–${labelTime(segment.end)}`;
      const audioBar = document.createElement('span');
      audioBar.className = 'editor-audio-segment'; audioBar.setAttribute('aria-hidden', 'true');
      const playBar = document.createElement('button');
      playBar.type = 'button'; playBar.className = 'editor-segment-playback-bar';
      playBar.disabled = !audio || deleted;
      playBar.title = playBar.disabled
        ? deleted ? 'Сегмент исключён' : 'Аудио сегмента недоступно'
        : `Воспроизвести сегмент: ${segment.text}`;
      playBar.setAttribute('aria-label', playBar.title);
      const playSegment = () => {
        if (!audio) return;
        startPlayback([{ fragmentIndex: index, start: segment.start, end: segment.end }], playBar);
      };
      playBar.addEventListener('click', playSegment);
      playbackActions.set(playBar, playSegment);
      excerpts.set(playBar, { label: `Сегмент ${i + 1} отрывка ${index + 1}`,
        filenameSuffix: `fragment-${index + 1}-segment-${i + 1}`,
        targets: () => [{ fragmentIndex: index, start: segment.start, end: segment.end }] });
      playBar.addEventListener('contextmenu', event => { if (!playBar.disabled) openContextMenu(playBar, event); });
      pair.append(text, audioBar, playBar);
      if (i > 0) segments.append(document.createTextNode(' '));
      segments.append(pair);
      bars.push(playBar);
    });
    if (!fragment.segments.length) {
      const pending = document.createElement('p'); pending.className = 'history-fragment-legend';
      pending.textContent = fragment.text || 'Сегменты ещё не получены.'; segments.append(pending);
    }
    audio?.addEventListener('timeupdate', () => {
      const target = playbackQueue[queueIndex];
      if (audio === activeAudio && target?.fragmentIndex === index && audio.currentTime >= target.end) {
        audio.pause();
        queueIndex++;
        playNext(playbackToken);
      } else updateHighlights();
    });
    audio?.addEventListener('play', () => {
      updateHighlights();
    });

    const fragmentBar = document.createElement('button');
    fragmentBar.type = 'button';
    fragmentBar.className = 'fragment-playback-bar history-fragment-playback-bar';
    fragmentBar.dataset.level = 'fragment';
    fragmentBar.disabled = !audio || retainedRanges(fragment).length === 0;
    fragmentBar.title = `Отрывок ${index + 1} · ${labelTime(fragment.start)}–${labelTime(fragment.end)}\nВоспроизвести отрывок`;
    fragmentBar.setAttribute('aria-label', `Воспроизвести отрывок ${index + 1}, ${labelTime(fragment.start)}–${labelTime(fragment.end)}`);
    const playFragment = () => {
      startPlayback(retainedRanges(fragment).map(range => ({ fragmentIndex: index, ...range })), fragmentBar);
    };
    fragmentBar.addEventListener('click', playFragment);
    playbackActions.set(fragmentBar, playFragment);
    excerpts.set(fragmentBar, { label: `Отрывок ${index + 1}`, filenameSuffix: `fragment-${index + 1}`,
      targets: () => retainedRanges(fragment).map(range => ({ fragmentIndex: index, ...range })) });
    fragmentBar.addEventListener('contextmenu', event => { if (!fragmentBar.disabled) openContextMenu(fragmentBar, event); });
    fragmentBars.push(fragmentBar);

    section.append(segments);
    section.append(fragmentBar);
    if (audio) section.append(audio);
    if (index > 0) element.append(document.createTextNode(' '));
    element.append(section);
  });

  const allPlaybackBar = document.createElement('button');
  allPlaybackBar.type = 'button';
  allPlaybackBar.className = 'all-fragments-playback-bar history-all-fragments-playback-bar';
  allPlaybackBar.dataset.level = 'all';
  allPlaybackBar.disabled = !fragments.some((fragment, index) => audioPlayers[index] && retainedRanges(fragment).length > 0);
  allPlaybackBar.title = 'Воспроизвести все отрывки';
  allPlaybackBar.setAttribute('aria-label', allPlaybackBar.title);
  const playAll = () => {
    const targets = fragments.flatMap((fragment, fragmentIndex) =>
      retainedRanges(fragment).map(range => ({ fragmentIndex, ...range })));
    startPlayback(targets, allPlaybackBar);
  };
  allPlaybackBar.addEventListener('click', playAll);
  playbackActions.set(allPlaybackBar, playAll);
  excerpts.set(allPlaybackBar, { label: 'Вся запись', filenameSuffix: 'all',
    targets: () => fragments.flatMap((fragment, fragmentIndex) =>
      retainedRanges(fragment).map(range => ({ fragmentIndex, ...range }))) });
  allPlaybackBar.addEventListener('contextmenu', event => { if (!allPlaybackBar.disabled) openContextMenu(allPlaybackBar, event); });
  element.append(allPlaybackBar);

  const playbackLayout = attachTranscriptPlaybackLayout(element,
    fragmentSections.map((section, index) => ({ element: section, bar: fragmentBars[index] })), allPlaybackBar,
    source => {
      const action = playbackActions.get(source);
      debug('source action', { record: record.id, source: source.className, found: !!action });
      action?.();
    }, onContextMenu ? openContextMenu : undefined);

  function dispose() {
    playbackLayout.dispose();
    stopPlayback();
    audioPlayers.filter((audio): audio is HTMLAudioElement => audio !== null)
      .forEach(audio => { audio.pause(); audio.removeAttribute('src'); audio.load(); });
    objectUrls.forEach(url => URL.revokeObjectURL(url)); element.remove();
  }
  return { element, dispose };
}
