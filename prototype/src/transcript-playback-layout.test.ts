import { expect, it } from 'vitest';
import { playbackRows, playbackClassChangesLayout, segmentAtPosition, segmentTrackIsPlaying } from './transcript-playback-layout';

it('highlights the segment track for both direct and fragment or global playback', () => {
  const source = (direct: boolean, currentSegment: boolean) => ({
    classList: { contains: (name: string) => name === 'playing' && direct },
    closest: (selector: string) => selector === '.fragment-segment-playing' && currentSegment ? {} : null,
  }) as unknown as HTMLElement;
  expect(segmentTrackIsPlaying(source(true, false))).toBe(true);
  expect(segmentTrackIsPlaying(source(false, true))).toBe(true);
  expect(segmentTrackIsPlaying(source(false, false))).toBe(false);
});

it('selects a whole segment by text width, including gaps and track edges', () => {
  const segments = [{ left: 10, right: 80 }, { left: 90, right: 110 }];
  expect(segmentAtPosition(segments, 70)).toBe(segments[0]);
  expect(segmentAtPosition(segments, 100)).toBe(segments[1]);
  expect(segmentAtPosition(segments, 87)).toBe(segments[1]);
  expect(segmentAtPosition(segments, 0)).toBe(segments[0]);
  expect(segmentAtPosition(segments, 120)).toBe(segments[1]);
  expect(segmentAtPosition([], 20)).toBeUndefined();
});

it('splits a wrapped fragment into independent playback rows', () => {
  const rows = playbackRows([
    { fragment: 0, top: 0, left: 0, right: 40, bottom: 22 },
    { fragment: 0, top: 0, left: 45, right: 90, bottom: 22 },
    { fragment: 0, top: 42, left: 0, right: 30, bottom: 64 },
  ]);
  expect(rows).toEqual([
    { top: 0, bottom: 22, left: 0, right: 90, fragments: [{ fragment: 0, left: 0, right: 90 }] },
    { top: 42, bottom: 64, left: 0, right: 30, fragments: [{ fragment: 0, left: 0, right: 30 }] },
  ]);
});

it('keeps separate fragment bars and one combined bar when fragments share a line', () => {
  expect(playbackRows([
    { fragment: 1, top: .4, left: 50, right: 100, bottom: 23 },
    { fragment: 0, top: 0, left: 0, right: 45, bottom: 22 },
  ])).toEqual([{ top: 0, bottom: 23, left: 0, right: 100, fragments: [
    { fragment: 0, left: 0, right: 45 }, { fragment: 1, left: 50, right: 100 },
  ] }]);
});

it('does not place later rows at the bottom of the whole fragment', () => {
  const rows = playbackRows([
    { fragment: 0, top: 12, left: 10, right: 150, bottom: 34 },
    { fragment: 0, top: 54, left: 10, right: 70, bottom: 76 },
    { fragment: 1, top: 96, left: 10, right: 110, bottom: 118 },
  ]);
  expect(rows.map(row => [row.bottom, row.right - row.left])).toEqual([[34, 140], [76, 60], [118, 100]]);
});

it('preserves row tolerance at the boundary and aggregates recurring fragments', () => {
  const boxes = [
    { fragment: 0, top: 1.5, left: 0, right: 20, bottom: 12 },
    { fragment: 0, top: 0, left: 0, right: 20, bottom: 10 },
    { fragment: 1, top: 1, left: 21, right: 40, bottom: 11 },
    { fragment: 0, top: 1.49, left: 41, right: 60, bottom: 12 },
  ];
  expect(playbackRows(boxes)).toEqual([
    { top: 0, bottom: 12, left: 0, right: 60, fragments: [
      { fragment: 0, left: 0, right: 60 }, { fragment: 1, left: 21, right: 40 },
    ] },
    { top: 1.5, bottom: 12, left: 0, right: 20, fragments: [{ fragment: 0, left: 0, right: 20 }] },
  ]);
  expect(boxes[0].top).toBe(1.5);
});

it('updates playback highlighting without invalidating geometry, but remeasures text layout changes', () => {
  expect(playbackClassChangesLayout('editor-segment-pair', 'editor-segment-pair fragment-segment-playing')).toBe(false);
  expect(playbackClassChangesLayout('bar playing disabled', 'bar all-segments-deleted')).toBe(false);
  expect(playbackClassChangesLayout('bar playing', 'bar')).toBe(false);
  expect(playbackClassChangesLayout('editor-segment-pair', 'editor-segment-pair deleted')).toBe(true);
  expect(playbackClassChangesLayout('flow', 'flow hidden')).toBe(true);
});
