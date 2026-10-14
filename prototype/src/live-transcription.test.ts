import { describe, expect, it, vi } from 'vitest';
import { createLiveTranscriber } from './live-transcription';

vi.mock('./audio-decoding', () => ({ decodeAudio: vi.fn(async () => ({ duration: 1.73 })) }));

describe('live transcription service', () => {
  it('replaces the edited baseline, preserves real repeated words, and publishes the complete preview', () => {
    const onPreview = vi.fn();
    const live = createLiveTranscriber({
      getState: () => 'idle',
      getSettings: () => ({
        liveTranscriptionEnabled: true,
        liveSilenceDurationMs: 700,
        liveMaxChunkDurationSeconds: 9,
        liveChunkOverlapSeconds: 0.5,
      }),
      snapshotAudio: async () => new ArrayBuffer(0),
      provider: { transcribe: vi.fn(async () => ({ text: '', segments: [] })) },
      cutAudio: vi.fn(),
      onPreview,
      onError: vi.fn(),
    });

    live.replaceFinalizedTranscript([
      { start: 0, end: .24, text: 'Продолжение' },
      { start: .24, end: .5, text: 'Продолжение' },
      { start: .5, end: .73, text: 'следует...' },
    ]);

    expect(live.text).toBe('Продолжение Продолжение следует...');
    expect(live.segments).toHaveLength(3);
    expect(onPreview).toHaveBeenLastCalledWith('Продолжение Продолжение следует...');
    live.replaceFinalizedTranscript([{ start: .5, end: .73, text: 'следует...' }]);
    expect(live.text).toBe('следует...');
    expect(live.segments).toHaveLength(1);
  });

  it('adds new timed speech after resume without dropping a genuinely repeated word', async () => {
    vi.stubGlobal('window', globalThis);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const live = createLiveTranscriber({
      getState: () => 'recording',
      getSettings: () => ({ liveTranscriptionEnabled: true, liveSilenceDurationMs: 700,
        liveMaxChunkDurationSeconds: 9, liveChunkOverlapSeconds: .5 }),
      snapshotAudio: async () => new ArrayBuffer(0),
      provider: { transcribe: vi.fn(async () => ({ text: 'следует... Продолжение', segments: [
        { start: .1, end: .3, text: 'следует...' },
        { start: .7, end: 1, text: 'Продолжение' },
      ] })) },
      cutAudio: () => new Blob(), onPreview: vi.fn(), onError: vi.fn(),
    });
    try {
      live.replaceFinalizedTranscript([
        { start: 0, end: .24, text: 'Продолжение' },
        { start: .24, end: .5, text: 'Продолжение' },
        { start: .5, end: .73, text: 'следует...' },
      ]);
      live.resumeAfterPause(.73, .5);
      live.start();
      live.observeSpeechLevel(.02);
      await vi.advanceTimersByTimeAsync(1500);
      expect(live.text).toBe('Продолжение Продолжение следует... Продолжение');
      expect(live.segments).toHaveLength(4);
      expect(live.segments[3].start).toBeCloseTo(.93);
    } finally {
      live.stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('clears the previous session even when live recognition is disabled', () => {
    const live = createLiveTranscriber({
      getState: () => 'recording',
      getSettings: () => ({ liveTranscriptionEnabled: false, liveSilenceDurationMs: 700,
        liveMaxChunkDurationSeconds: 9, liveChunkOverlapSeconds: .5 }),
      snapshotAudio: async () => new ArrayBuffer(0), provider: { transcribe: vi.fn() },
      cutAudio: vi.fn(), onPreview: vi.fn(), onError: vi.fn(),
    });
    live.replaceFinalizedTranscript([{ start: 0, end: 1, text: 'Старая запись' }]);
    live.start(true);
    expect(live.text).toBe('');
    expect(live.segments).toEqual([]);
  });
});
