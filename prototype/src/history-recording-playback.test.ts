// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryTranscript } from './history-transcript';
import type { HistoryItem } from './history-db';
import { claimPlayback, stopExclusivePlayback } from './playback-coordinator';

vi.mock('./transcript-playback-layout', () => ({ attachTranscriptPlaybackLayout: () => ({ dispose: vi.fn() }) }));

let root: Root;
let container: HTMLDivElement;
let playing: WeakSet<HTMLMediaElement>;
const audio = new Blob(['saved audio'], { type: 'audio/wav' });
const failed = (): HistoryItem => ({ id: 'failed', timestamp: 1, audioBlob: audio, text: '', status: 'error', steps: [
  { id: 'transcribe', type: 'transcribe', title: 'Транскрибация', status: 'error', errorMessage: 'Ошибка API' },
] });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  playing = new WeakSet();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:history-recording');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return !playing.has(this); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function(this: HTMLMediaElement) {
    playing.add(this); this.dispatchEvent(new Event('play'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) {
    if (playing.delete(this)) this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => { root.unmount(); stopExclusivePlayback(); });
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const render = async (record = failed()) => { await act(async () => { root.render(createElement(HistoryTranscript, { record, inStep: true })); }); };
const bar = () => container.querySelector<HTMLButtonElement>('.history-recording-playback [data-level="all"]')!;

it('shows only the whole-recording track when transcription failed and there are no segments', async () => {
  await render();
  expect(bar()).not.toBeNull(); expect(bar().disabled).toBe(false);
  expect(container.querySelector('.editor-segment-playback-bar')).toBeNull();
  expect(container.querySelector('.history-fragment-playback-bar')).toBeNull();
  expect(container.querySelector('.history-recording-menu-button')).toBeNull();
  expect(container.querySelector('.history-copy-button')).toBeNull();
  expect(container.querySelector('audio')?.controls).toBe(false);
  await act(async () => { bar().click(); });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  expect(bar().classList.contains('playing')).toBe(true);
  await act(async () => { bar().click(); });
  expect(container.querySelector('audio')?.paused).toBe(true);
  expect(bar().classList.contains('playing')).toBe(false);
});

it('keeps the audio actions on the track context menu', async () => {
  await render();
  await act(async () => { bar().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })); });
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Скачать');
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Транскрибировать и скопировать');
});

it('uses original audio when needed, stops on another playback owner, and releases the object URL', async () => {
  await render({ ...failed(), audioBlob: undefined, originalAudioBlob: audio });
  expect(URL.createObjectURL).toHaveBeenCalledWith(audio);
  await act(async () => { bar().click(); });
  const element = container.querySelector('audio')!;
  await act(async () => { claimPlayback({}, vi.fn()); });
  expect(element.paused).toBe(true);
  expect(bar().getAttribute('aria-pressed')).toBe('false');
  await act(async () => { root.render(null); });
  expect(element.getAttribute('src')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-recording');
});

it('does not add the fallback track when normal segment tracks are available, or audio is absent', async () => {
  await render({ ...failed(), steps: undefined, fragments: [{ start: 0, end: 1, audioBlob: audio, text: 'Текст',
    segments: [{ start: 0, end: 1, text: 'Текст' }], removedRanges: [] }] });
  expect(container.querySelector('.history-recording-playback')).toBeNull();
  expect(container.querySelector('.editor-segment-playback-bar')).not.toBeNull();
  await render({ ...failed(), audioBlob: undefined });
  expect(container.querySelector('audio')).toBeNull();
});

it('also makes recordings with empty recognition results playable and reports playback errors', async () => {
  await render({ ...failed(), steps: failed().steps!.map(step => ({ ...step, status: 'success' })), fragments: [
    { start: 0, end: 1, audioBlob: audio, text: '', segments: [], removedRanges: [] },
  ] });
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Cannot decode'));
  await act(async () => { bar().click(); });
  expect(container.textContent).toContain('Не удалось воспроизвести аудиозапись.');
  expect(bar().getAttribute('aria-pressed')).toBe('false');
  expect(container.textContent).not.toContain('Сегменты ещё не получены');
});
