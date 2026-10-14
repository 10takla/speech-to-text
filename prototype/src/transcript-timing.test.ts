import { expect, it } from 'vitest';
import { fitTranscriptToAudio } from './transcript-timing';
import { combineFragments } from './recording-editor';

it('uses real phrase timestamps if word timestamps fall outside a short audio fragment', () => {
  expect(fitTranscriptToAudio({ text: 'Да', segments: [{ text: 'Да', start: .4, end: .8 }],
    fallbackSegments: [{ text: 'Да', start: 0, end: .13 }],
  }, .125)).toEqual({ text: 'Да', segments: [{ text: 'Да', start: 0, end: .125 }] });
});

it('retains valid word-level editing when phrase timestamps are also available', () => {
  const words = [{ text: 'Первый', start: .1, end: .4 }, { text: 'отрывок', start: .5, end: .9 }];
  expect(fitTranscriptToAudio({ text: 'Первый отрывок', segments: words,
    fallbackSegments: [{ text: 'Первый отрывок', start: 0, end: 1 }],
  }, 1).segments).toEqual(words);
});

it('keeps local timestamps separate from offsets accumulated over multiple pauses', () => {
  const transcript = fitTranscriptToAudio({ text: 'Да', segments: [{ text: 'Да', start: .4, end: .8 }],
    fallbackSegments: [{ text: 'Да', start: 0, end: .125 }],
  }, .125);
  const fragments = [0, 4, 8].map(start => ({ audioBlob: new Blob(), start, end: start + .125, transcript, removedRanges: [] }));
  expect(combineFragments(fragments).segments).toEqual([
    { text: 'Да', start: 0, end: .125 }, { text: 'Да', start: 4, end: 4.125 }, { text: 'Да', start: 8, end: 8.125 },
  ]);
});

it('does not invent timestamps when neither alignment matches the audio', () => {
  expect(fitTranscriptToAudio({ text: 'Да', segments: [{ text: 'Да', start: 1, end: 2 }],
    fallbackSegments: [{ text: 'Да', start: 3, end: 4 }],
  }, .125).segments).toEqual([]);
});
