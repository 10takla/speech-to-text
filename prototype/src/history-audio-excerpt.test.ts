import { describe, expect, it, vi } from 'vitest';
import { extractHistoryAudio, type HistoryAudioExcerpt } from './history-audio-excerpt';

function buffer(channels: number[][], sampleRate = 8): AudioBuffer {
  const data = channels.map(values => new Float32Array(values));
  return { sampleRate, length: data[0].length, duration: data[0].length / sampleRate,
    numberOfChannels: data.length, getChannelData: (index: number) => data[index] } as AudioBuffer;
}
function excerpt(parts: HistoryAudioExcerpt['parts']): HistoryAudioExcerpt {
  return { label: 'Отрывок', filenameSuffix: 'fragment-1', parts };
}
async function pcm(audio: Blob) {
  const view = new DataView(await audio.arrayBuffer());
  return { rate: view.getUint32(24, true), channels: view.getUint16(22, true),
    values: Array.from({ length: (view.byteLength - 44) / 2 }, (_, index) => view.getInt16(44 + index * 2, true)) };
}
const encode = (values: number[]) => values.map(value => Math.round(value * (value < 0 ? 32768 : 32767)));

describe('history audio excerpts', () => {
  it('exports only the selected segment, clamping its boundaries to the source audio', async () => {
    const audio = new Blob(['source']);
    const decode = vi.fn(async () => buffer([[0, .125, .25, .375, .5, .625, .75, .875]]));
    const selected = await extractHistoryAudio(excerpt([{ audio, start: .5, end: 3 }]), undefined, decode);
    expect(selected.type).toBe('audio/wav');
    expect(await pcm(selected)).toEqual({ rate: 8, channels: 1, values: encode([.5, .625, .75, .875]) });
  });

  it('joins retained ranges in order without restoring excluded audio or repeatedly decoding a fragment', async () => {
    const audio = new Blob(['source']);
    const decode = vi.fn(async () => buffer([[.125, .25, .375, .5, .625, .75, .875, 1]]));
    const selected = await extractHistoryAudio(excerpt([
      { audio, start: 0, end: .25 }, { audio, start: .75, end: 1 },
    ]), undefined, decode);
    expect((await pcm(selected)).values).toEqual(encode([.125, .25, .875, 1]));
    expect(decode).toHaveBeenCalledOnce();
  });

  it('combines fragments with different sample rates while keeping selected boundaries', async () => {
    const first = new Blob(['first']), second = new Blob(['second']);
    const decode = vi.fn(async (audio: Blob) => audio === first ? buffer([[.125, .25]], 8) : buffer([[-.5, .5, 1, 1]], 4));
    const selected = await extractHistoryAudio(excerpt([
      { audio: first, start: 0, end: .25 }, { audio: second, start: 0, end: .5 },
    ]), undefined, decode);
    expect(await pcm(selected)).toEqual({ rate: 8, channels: 1, values: encode([.125, .25, -.5, 0, .5, .5]) });
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('mixes source channels into the same mono WAV format as recording exports', async () => {
    const audio = new Blob(['stereo']);
    const selected = await extractHistoryAudio(excerpt([{ audio, start: 0, end: .25 }]), undefined,
      async () => buffer([[0, .5], [.5, .5]]));
    expect((await pcm(selected)).values).toEqual(encode([.25, .5]));
  });

  it('rejects empty ranges instead of falling back to the full recording', async () => {
    const audio = new Blob(['source']);
    await expect(extractHistoryAudio(excerpt([{ audio, start: 2, end: 3 }]), undefined,
      async () => buffer([[.5, .5]]))).rejects.toThrow('нет аудио');
    await expect(extractHistoryAudio(excerpt([]))).rejects.toThrow('недоступно');
  });

  it('stops on cancellation before or after decoding', async () => {
    const audio = new Blob(['source']);
    const controller = new AbortController();
    const decode = vi.fn(async () => { controller.abort(); return buffer([[.5]]); });
    const selection = excerpt([{ audio, start: 0, end: .125 }]);
    await expect(extractHistoryAudio(selection, controller.signal, decode)).rejects.toThrow();
    await expect(extractHistoryAudio(selection, controller.signal, decode)).rejects.toThrow();
    expect(decode).toHaveBeenCalledOnce();
  });
});
