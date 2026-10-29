import type { TimedTranscript, TranscriptSegment } from './groq';

/** Both word and phrase timestamps are local to the submitted audio fragment. */
export function fitTranscriptToAudio(transcript: TimedTranscript, duration: number): TimedTranscript {
  const fit = (segments: TranscriptSegment[]) => segments
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .map(segment => ({ ...segment, start: Math.max(0, segment.start), end: Math.min(duration, segment.end) }))
    .filter(segment => segment.start < segment.end)
    .sort((a, b) => a.start - b.start);
  const words = fit(transcript.segments);
  const { fallbackSegments, ...result } = transcript;
  return { ...result, segments: words.length ? words : fit(fallbackSegments || []) };
}
