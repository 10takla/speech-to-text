import type { TranscriptSegment } from './groq';
import type { RecordingFragment } from './recording-editor';

export interface RecordingPreviewFragment {
  segments: (TranscriptSegment & { deleted: boolean })[];
}

/** Editor fragments take precedence over provisional live recognition of the same audio. */
export function recordingPreviewFragments(
  fragments: RecordingFragment[], liveSegments: readonly TranscriptSegment[],
): RecordingPreviewFragment[] {
  const result = fragments.map(fragment => {
    const localSegments = fragment.transcript?.segments.length ? fragment.transcript.segments
      : fragment.transcript?.text ? [{ start: 0, end: fragment.end - fragment.start, text: fragment.transcript.text }] : null;
    const segments = localSegments
      ? localSegments.map(segment => ({ ...segment, start: segment.start + fragment.start, end: segment.end + fragment.start }))
      : liveSegments.filter(segment => segment.start >= fragment.start && segment.start < fragment.end);
    return { segments: segments.map(segment => ({ ...segment, deleted: fragment.removedRanges.some(range =>
      range.start + fragment.start < segment.end && segment.start < range.end + fragment.start) })) };
  });
  const tail = liveSegments.filter(segment => !fragments.some(fragment =>
    segment.start >= fragment.start && segment.start < fragment.end));
  if (tail.length) result.push({ segments: tail.map(segment => ({ ...segment, deleted: false })) });
  return result.filter(fragment => fragment.segments.length > 0);
}

export function retainedPreviewSegments(fragments: RecordingPreviewFragment[]): TranscriptSegment[] {
  return fragments.flatMap(fragment => fragment.segments.filter(segment => !segment.deleted)
    .map(({ start, end, text }) => ({ start, end, text })));
}

export interface RecordingPreview {
  text: string;
  fragments: RecordingPreviewFragment[];
  processing?: boolean;
}
