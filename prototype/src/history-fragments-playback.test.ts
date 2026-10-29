// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHistoryFragments } from './history-fragments';
import { stopExclusivePlayback } from './playback-coordinator';
import type { HistoryItem } from './history-db';

let rendered: ReturnType<typeof renderHistoryFragments>;
let frames: FrameRequestCallback[];
let playing: WeakSet<HTMLMediaElement>;
const words = ['Первый', 'Второй', 'Третий', 'Четвёртый', 'Пятый', 'Шестой'];

beforeEach(() => {
  frames = []; playing = new WeakSet();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:history');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return !playing.has(this); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function(this: HTMLMediaElement) {
    playing.add(this); this.dispatchEvent(new Event('play'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { playing.delete(this); });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function(this: HTMLElement) {
    const index = this.classList.contains('editor-segment') ? words.indexOf(this.textContent || '') : -1;
    return (index < 0 ? [] : [new DOMRect(index * 50, 0, 40, 20)]) as unknown as DOMRectList;
  });
  const record: HistoryItem = { id: 'saved', timestamp: 1, fragments: [0, 1].map(index => ({
    start: index * 6, end: (index + 1) * 6, audioBlob: new Blob(['audio']), text: words.slice(index * 3, index * 3 + 3).join(' '),
    segments: words.slice(index * 3, index * 3 + 3).map((text, segment) => ({ start: segment * 2, end: segment * 2 + 1, text })),
    removedRanges: index === 0 ? [{ start: 3, end: 4 }] : [],
  })) };
  rendered = renderHistoryFragments(record);
  document.body.append(rendered!.element);
  frames.shift()!(0);
});

afterEach(() => {
  rendered?.dispose(); stopExclusivePlayback();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

it.each(['segment', 'fragment', 'all'])('starts the %s track at the segment under the click, including a later fragment', async level => {
  const element = rendered!.element;
  const track = level === 'segment'
    ? element.querySelectorAll<HTMLButtonElement>('.transcript-row-track-segment')[4]
    : level === 'fragment' ? element.querySelectorAll<HTMLButtonElement>('.transcript-row-track-fragment')[1]
    : element.querySelector<HTMLButtonElement>('.transcript-row-track-all')!;
  track.dispatchEvent(new MouseEvent('click', { clientX: 220, detail: 1, bubbles: true }));
  await Promise.resolve();
  const audio = element.querySelectorAll('audio');
  expect(audio[0].paused).toBe(true);
  expect(audio[1].paused).toBe(false);
  expect(audio[1].currentTime).toBe(2);
  expect(element.querySelectorAll('.editor-segment-playback-bar')[4].classList.contains('playing')).toBe(true);
});

it.each(['fragment', 'all'])('skips excluded audio and respects the end of the %s track', async level => {
  const element = rendered!.element;
  const track = element.querySelector<HTMLButtonElement>(`.transcript-row-track-${level}`)!;
  track.dispatchEvent(new MouseEvent('click', { clientX: 70, detail: 1, bubbles: true }));
  await Promise.resolve();
  const audio = element.querySelectorAll('audio');
  expect(audio[0].currentTime).toBe(2);
  audio[0].currentTime = 3; audio[0].dispatchEvent(new Event('timeupdate'));
  await Promise.resolve();
  expect(audio[0].currentTime).toBe(4);
  audio[0].currentTime = 6; audio[0].dispatchEvent(new Event('timeupdate'));
  await Promise.resolve();
  expect(audio[1].paused).toBe(level === 'fragment');
  if (level === 'all') expect(audio[1].currentTime).toBe(0);
});

it.each(['fragment', 'all'])('clears %s highlighting when audio ends just before its saved boundary and can replay immediately', async level => {
  const element = rendered!.element;
  const track = level === 'fragment'
    ? element.querySelectorAll<HTMLButtonElement>('.transcript-row-track-fragment')[1]
    : element.querySelector<HTMLButtonElement>('.transcript-row-track-all')!;
  const click = () => track.dispatchEvent(new MouseEvent('click', { clientX: 220, detail: 1, bubbles: true }));
  click(); await Promise.resolve();
  const audio = element.querySelectorAll('audio')[1];
  audio.currentTime = 5.97; // Stored fragment end is 6 seconds.
  playing.delete(audio);
  vi.spyOn(audio, 'ended', 'get').mockReturnValue(true);
  audio.dispatchEvent(new Event('timeupdate'));
  audio.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  frames.splice(0).forEach(frame => frame(0));
  expect(element.querySelectorAll('.playing')).toHaveLength(0);
  click(); await Promise.resolve();
  expect(audio.paused).toBe(false);
  expect(audio.currentTime).toBe(2);
});

it('continues whole-recording playback after the actual end of a shorter fragment and ignores its later end events', async () => {
  const element = rendered!.element;
  const track = element.querySelector<HTMLButtonElement>('.transcript-row-track-all')!;
  track.dispatchEvent(new MouseEvent('click', { clientX: 120, detail: 1, bubbles: true }));
  await Promise.resolve();
  const audio = element.querySelectorAll('audio');
  audio[0].currentTime = 5.97;
  playing.delete(audio[0]);
  vi.spyOn(audio[0], 'ended', 'get').mockReturnValue(true);
  audio[0].dispatchEvent(new Event('ended'));
  await Promise.resolve();
  expect(audio[1].paused).toBe(false);
  expect(audio[1].currentTime).toBe(0);
  audio[1].currentTime = .5;
  audio[0].dispatchEvent(new Event('ended'));
  expect(audio[1].currentTime).toBe(.5);
  expect(audio[1].paused).toBe(false);
});

it.each(['fragment', 'all'])('previews only the remaining %s track without highlighting text or playing', level => {
  const element = rendered!.element;
  const track = element.querySelector<HTMLButtonElement>(`.transcript-row-track-${level}`)!;
  const move = (x: number) => track.dispatchEvent(new PointerEvent('pointermove', { clientX: x }));
  move(70);
  const marker = () => element.querySelector<HTMLElement>('.transcript-track-preview')!;
  expect(marker().parentElement).toBe(track);
  expect(marker().style.left).toBe('50px');
  expect(marker().style.width).toBe(level === 'fragment' ? '90px' : '240px');
  expect(element.querySelector('.playback-start-preview')).toBeNull();
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  move(120);
  expect(element.querySelectorAll('.transcript-track-preview')).toHaveLength(1);
  expect(marker().style.left).toBe('100px');
  expect(marker().style.width).toBe(level === 'fragment' ? '40px' : '190px');
  track.dispatchEvent(new PointerEvent('pointerleave'));
  expect(element.querySelector('.transcript-track-preview')).toBeNull();
});

it('previews the next included segment for excluded text and plays from that same segment', async () => {
  const element = rendered!.element;
  // Exclude the middle word without rebuilding the shared playback tracks.
  element.querySelectorAll('.editor-segment-pair')[1].classList.add('deleted');
  const track = element.querySelector<HTMLButtonElement>('.transcript-row-track-all')!;
  track.dispatchEvent(new PointerEvent('pointermove', { clientX: 70 }));
  expect(element.querySelector<HTMLElement>('.transcript-track-preview')?.style.left).toBe('100px');
  track.dispatchEvent(new MouseEvent('click', { clientX: 70, detail: 1, bubbles: true }));
  await Promise.resolve();
  expect(element.querySelector('audio')?.currentTime).toBe(4);
  rendered!.dispose(); rendered = null;
  expect(element.querySelector('.transcript-track-preview')).toBeNull();
});

it.each(['fragment', 'all'])('continues the %s preview over wrapped lines only within its playback range', level => {
  vi.mocked(HTMLElement.prototype.getClientRects).mockImplementation(function(this: HTMLElement) {
    const index = this.classList.contains('editor-segment') ? words.indexOf(this.textContent || '') : -1;
    return (index < 0 ? [] : [new DOMRect((index % 3) * 50, Math.floor(index / 3) * 40, 40, 20)]) as unknown as DOMRectList;
  });
  window.dispatchEvent(new Event('resize'));
  frames.splice(0).forEach(frame => frame(0));
  const element = rendered!.element;
  element.querySelector<HTMLButtonElement>(`.transcript-row-track-${level}`)!
    .dispatchEvent(new PointerEvent('pointermove', { clientX: 70 }));
  const markers = Array.from(element.querySelectorAll<HTMLElement>('.transcript-track-preview'));
  expect(markers.map(marker => [marker.style.left, marker.style.width]))
    .toEqual(level === 'fragment' ? [['50px', '90px']] : [['50px', '90px'], ['0px', '140px']]);
  expect(element.querySelector('.playback-start-preview')).toBeNull();
});

it('leaves a gap in the preview for an excluded segment', () => {
  const element = rendered!.element;
  element.querySelectorAll('.editor-segment-pair')[1].classList.add('deleted');
  element.querySelector<HTMLButtonElement>('.transcript-row-track-all')!
    .dispatchEvent(new PointerEvent('pointermove', { clientX: 20 }));
  const markers = Array.from(element.querySelectorAll<HTMLElement>('.transcript-track-preview'));
  expect(markers.map(marker => [marker.style.left, marker.style.width]))
    .toEqual([['0px', '40px'], ['100px', '190px']]);
});
