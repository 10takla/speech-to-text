// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { appendRecordingFragments, createFragmentEditors, createRecordingEditor, type RecordingFragment } from './recording-editor';
import type { TimedTranscript } from './groq';

vi.mock('./transcript-playback-layout', () => ({ attachTranscriptPlaybackLayout: () => ({ dispose() {} }) }));
vi.mock('./audio-decoding', () => ({ decodeAudio: async (bytes: ArrayBuffer) => {
  const duration = Number(new TextDecoder().decode(bytes));
  return { duration, sampleRate: 10, length: duration * 10, numberOfChannels: 1,
    getChannelData: () => new Float32Array(duration * 10) };
} }));

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('allows editing all live text while the tail request is still pending, then appends the tail', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:editor');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const host = document.createElement('div'); document.body.append(host);
  const fragments: RecordingFragment[] = [];
  appendRecordingFragments({ duration: 6 } as AudioBuffer, fragments, 0, {
    throughSeconds: 4, segments: [
      { start: 0, end: 1, text: 'Первый' }, { start: 2, end: 3, text: 'Второй' },
    ],
  }, (_buffer, ranges) => new Blob([String(ranges[0].end - ranges[0].start)]));
  let completeTail!: (result: TimedTranscript) => void;
  const transcribe = vi.fn(() => new Promise<TimedTranscript>(resolve => { completeTail = resolve; }));
  const editor = createFragmentEditors(host, fragments, transcribe);
  try {
    await editor.loadedPreview;
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(fragments[1].audioBlob, expect.any(AbortSignal));
    expect(editor.ready).toBe(false);
    expect(host.querySelectorAll('.transcription-pending')).toHaveLength(1);
    const words = host.querySelectorAll<HTMLElement>('.editor-segment');
    expect(Array.from(words, word => word.textContent)).toEqual(['Первый', 'Второй']);
    words[0].click();
    expect(words[0].closest('[data-segment]')?.classList.contains('deleted')).toBe(true);

    completeTail({ text: 'Хвост', segments: [{ start: 0, end: 1, text: 'Хвост' }] });
    await vi.waitFor(() => expect(editor.ready).toBe(true));
    expect(host.querySelector('.transcription-pending')).toBeNull();
    expect(Array.from(host.querySelectorAll('.editor-segment'), word => word.textContent))
      .toEqual(['Первый', 'Второй', 'Хвост']);
    editor.confirm();
    const result = await editor.result;
    expect(result?.fragments[0].text).toBe('Второй');
    expect(result?.fragments[1].text).toBe('Хвост');
  } finally { editor.cancel(); await editor.result; }
});

it.each(['error', 'cancel'] as const)('removes the recognition indicator on %s', async outcome => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:editor');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const host = document.createElement('div'); document.body.append(host);
  let fail!: (error: Error) => void;
  const editor = createRecordingEditor(host, new Blob(['2']), () => new Promise((_resolve, reject) => {
    fail = reject;
  }), 'Продолжить');
  const result = editor.result.catch(error => error);
  expect(host.querySelectorAll('.transcription-pending')).toHaveLength(1);
  if (outcome === 'error') fail(new Error('Ошибка распознавания'));
  else editor.cancel();
  await result;
  expect(host.querySelector('.transcription-pending')).toBeNull();
});
