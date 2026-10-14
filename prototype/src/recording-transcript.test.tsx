import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecordingFragment } from './recording-editor';
import { recordingPreviewFragments, retainedPreviewSegments } from './recording-transcript';
import RecordingTranscriptPreview from './RecordingTranscriptPreview';

function fragment(start: number, end: number, words: string[]): RecordingFragment {
  return { start, end, audioBlob: new Blob(), removedRanges: [], transcript: {
    text: words.join(' '), segments: words.map((text, index) => ({
      start: index * (end - start) / words.length, end: (index + 1) * (end - start) / words.length, text,
    })),
  } };
}

it('shows all reviewed fragments and the new live tail while preserving repeated words', () => {
  const preview = recordingPreviewFragments([
    fragment(0, .24, ['Продолжение']), fragment(.24, .73, ['Продолжение', 'следует...']),
  ], [
    { start: 0, end: .24, text: 'Устаревший live-текст' },
    { start: .8, end: 1.1, text: 'Новый' },
  ]);
  expect(preview.map(fragment => fragment.segments.map(segment => segment.text))).toEqual([
    ['Продолжение'], ['Продолжение', 'следует...'], ['Новый'],
  ]);
});

it('retains deletion marks for display but removes those words from the live baseline', () => {
  const edited = fragment(0, 1, ['Первое', 'Второе']);
  edited.removedRanges = [{ start: 0, end: .5 }];
  const preview = recordingPreviewFragments([edited], []);
  expect(preview[0].segments.map(segment => segment.deleted)).toEqual([true, false]);
  expect(retainedPreviewSegments(preview)).toEqual([{ start: .5, end: 1, text: 'Второе' }]);
});

it('keeps provisional segments in a fragment whose editor recognition is not ready yet', () => {
  const pending = fragment(0, 1, []);
  pending.transcript = null;
  const preview = recordingPreviewFragments([pending], [{ start: .2, end: .6, text: 'Текст' }]);
  expect(retainedPreviewSegments(preview)).toEqual([{ start: .2, end: .6, text: 'Текст' }]);
});

it('renders editor segment and fragment boundaries without any playback controls', () => {
  const fragments = recordingPreviewFragments([
    fragment(0, 1, ['Раз', 'два']), fragment(1, 2, ['три']),
  ], []);
  const html = renderToStaticMarkup(<RecordingTranscriptPreview text="Раз два три" fragments={fragments} />);
  expect(html.match(/class="fragment-editor transcript-fragment"/g)).toHaveLength(2);
  expect(html.match(/class="editor-segment-pair selected"/g)).toHaveLength(3);
  expect(html).not.toMatch(/playback|<button|<audio/);
});
