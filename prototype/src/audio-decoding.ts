/** Native recording is PCM WAV; decode it without starting a browser audio device. */
export async function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const view = new DataView(bytes);
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  if (bytes.byteLength >= 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let channels = 0, sampleRate = 0, format = 0, bits = 0;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + size > bytes.byteLength) break;
      if (tag(offset) === 'fmt ' && size >= 16) {
        format = view.getUint16(start, true);
        channels = view.getUint16(start + 2, true);
        sampleRate = view.getUint32(start + 4, true);
        bits = view.getUint16(start + 14, true);
      }
      if (tag(offset) === 'data' && format === 1 && bits === 16 && channels > 0 && sampleRate > 0) {
        const length = Math.floor(size / (channels * 2));
        if (!length) throw new Error('Запись не содержит аудио.');
        const buffer = new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
        for (let channel = 0; channel < channels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let frame = 0; frame < length; frame++) {
            samples[frame] = view.getInt16(start + (frame * channels + channel) * 2, true) / 32768;
          }
        }
        return buffer;
      }
      offset = start + size + (size % 2);
    }
  }
  return new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes);
}
