import { describe, expect, it, vi } from 'vitest';
import {
  combineFragments,
  appendRecordingFragments,
  mergeRanges,
  retainedRanges,
  retainedPlaybackOffset,
  textAfterCuts,
  type RecordingFragment,
} from './recording-editor';

describe('preparing pause fragments from live transcription', () => {
  it('reuses all recognised chunks since the previous pause and requests only the tail', () => {
    const previous: RecordingFragment = {
      audioBlob: new Blob(), start: 0, end: 3, removedRanges: [{ start: 0, end: 1 }],
      transcript: { text: 'Ранее', segments: [{ start: 0, end: 1, text: 'Ранее' }] },
    };
    const fragments = [previous];
    const cut = vi.fn((_buffer: AudioBuffer, _ranges: { start: number; end: number }[]) => new Blob());
    const offset = appendRecordingFragments({ duration: 12 } as AudioBuffer, fragments, 3, {
      throughSeconds: 10,
      segments: [
        { start: 0, end: 1, text: 'Устаревший текст' },
        { start: 3, end: 5, text: 'Первый отрывок' },
        { start: 6, end: 9, text: 'Второй отрывок' },
      ],
    }, cut);
    expect(offset).toBe(12);
    expect(fragments[0]).toBe(previous);
    expect(fragments[0].removedRanges).toEqual([{ start: 0, end: 1 }]);
    expect(fragments[1]).toMatchObject({ start: 3, end: 10, transcript: {
      text: 'Первый отрывок Второй отрывок', segments: [
        { start: 0, end: 2, text: 'Первый отрывок' },
        { start: 3, end: 6, text: 'Второй отрывок' },
      ],
    } });
    expect(fragments[2]).toMatchObject({ start: 10, end: 12, transcript: null });
    expect(cut.mock.calls.map(call => call[1])).toEqual([[{ start: 3, end: 10 }], [{ start: 10, end: 12 }]]);
  });

  it('does not create a recognition request when live transcription covers the pause', () => {
    const fragments: RecordingFragment[] = [];
    appendRecordingFragments({ duration: 4 } as AudioBuffer, fragments, 0, {
      throughSeconds: 4, segments: [{ start: 0, end: 3, text: 'Готовый текст' }],
    }, () => new Blob());
    expect(fragments).toHaveLength(1);
    expect(fragments[0].transcript?.text).toBe('Готовый текст');
  });

  it('recognises the new audio in full when live recognition has no result', () => {
    const fragments: RecordingFragment[] = [];
    appendRecordingFragments({ duration: 5 } as AudioBuffer, fragments, 2, undefined, () => new Blob());
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ start: 2, end: 5, transcript: null });
  });
});

describe('recording range helpers', () => {
  it('maps segment starts to edited audio without replaying removed ranges', () => {
    const ranges = [{ start: 1, end: 3 }, { start: 5, end: 9 }];
    expect(retainedPlaybackOffset(ranges, 1)).toBe(0);
    expect(retainedPlaybackOffset(ranges, 5)).toBe(2);
    expect(retainedPlaybackOffset(ranges, 7)).toBe(4);
    expect(retainedPlaybackOffset(ranges, 4)).toBe(2);
    expect(retainedPlaybackOffset([], 7)).toBe(0);
  });
  it('clamps, sorts, and merges overlapping or adjacent removed ranges', () => {
    expect(mergeRanges([
      { start: 5, end: 8 },
      { start: -2, end: 1 },
      { start: 0.5, end: 5 },
      { start: 12, end: 15 },
      { start: 9, end: 9 },
    ], 10)).toEqual([
      { start: 0, end: 8 },
    ]);
  });

  it('returns the retained portions around removed ranges', () => {
    expect(retainedRanges([
      { start: 2, end: 4 },
      { start: 6, end: 8 },
    ], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ]);
  });

  it('returns no retained audio when the full range is removed', () => {
    expect(retainedRanges([{ start: -1, end: 12 }], 10)).toEqual([]);
  });
});

describe('transcript composition', () => {
  const transcript = {
    text: 'Привет, мир! До свидания.',
    segments: [
      { start: 0, end: 0.5, text: 'Привет,' },
      { start: 0.5, end: 1, text: 'мир!' },
      { start: 1, end: 1.5, text: 'До' },
      { start: 1.5, end: 2, text: 'свидания.' },
    ],
  };

  it('removes transcript segments that overlap a cut and keeps punctuation readable', () => {
    expect(textAfterCuts(transcript, [{ start: 0.5, end: 1 }])).toBe('Привет, До свидания.');
  });

  it('offsets fragment timestamps and joins the retained fragment text', () => {
    const fragments: RecordingFragment[] = [
      { audioBlob: new Blob(), start: 0, end: 2, transcript, removedRanges: [{ start: 1, end: 2 }] },
      { audioBlob: new Blob(), start: 4, end: 6, transcript: { text: 'Снова здесь', segments: [
        { start: 0, end: 1, text: 'Снова' }, { start: 1, end: 2, text: 'здесь' },
      ] }, removedRanges: [] },
    ];

    expect(combineFragments(fragments)).toEqual({
      text: 'Привет, мир! Снова здесь',
      segments: [
        ...transcript.segments,
        { start: 4, end: 5, text: 'Снова' },
        { start: 5, end: 6, text: 'здесь' },
      ],
      removedRanges: [{ start: 1, end: 2 }],
    });
  });

  it('rejects composition before every fragment has a transcript', () => {
    expect(() => combineFragments([
      { audioBlob: new Blob(), start: 0, end: 1, transcript: null, removedRanges: [] },
    ])).toThrow('Распознавание отрывков ещё не завершено.');
  });
});
