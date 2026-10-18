import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSpeechSettings } from './speech-settings';
import { getSystemSpeechCapabilities, synthesizeSystemSpeech } from './system-speech';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isAndroid: false, androidCall: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock('./android-runtime', () => ({ get isAndroid() { return native.isAndroid; }, androidCall: native.androidCall }));

beforeEach(() => { native.isAndroid = false; native.invoke.mockReset(); native.androidCall.mockReset(); });

describe('system speech settings', () => {
  it('normalizes defaults and rejects non-finite numeric settings without losing mute', () => {
    expect(normalizeSpeechSettings()).toEqual({ voiceId: '', language: '', rate: 1, pitch: 1, volume: 1 });
    expect(normalizeSpeechSettings({ voiceId: 'voice', language: 'ru-RU', rate: NaN, pitch: Infinity, volume: 0 }))
      .toEqual({ voiceId: 'voice', language: 'ru-RU', rate: 1, pitch: 1, volume: 0 });
  });
  it('discovers Windows voices without generating audio', async () => {
    const capabilities = { voices: [{ id: 'voice', name: 'Voice', language: 'ru-RU' }], defaultVoiceId: 'voice' };
    native.invoke.mockResolvedValue(capabilities);
    expect(await getSystemSpeechCapabilities()).toEqual(capabilities);
    expect(native.invoke.mock.calls).toEqual([['system_speech_capabilities']]);
  });
  it('passes per-step voice and synthesis parameters to Windows', async () => {
    native.invoke.mockResolvedValue([82, 73, 70, 70]);
    const settings = normalizeSpeechSettings({ voiceId: 'voice', language: 'ru-RU', rate: 1.5, pitch: .8, volume: .2 });
    expect((await synthesizeSystemSpeech('Текст', undefined, settings)).size).toBe(4);
    expect(native.invoke).toHaveBeenCalledWith('synthesize_system_speech', { text: 'Текст', settings });
  });
  it('discovers Android voices separately from synthesis and forwards settings', async () => {
    native.isAndroid = true;
    native.androidCall.mockResolvedValueOnce({ voices: [], defaultVoiceId: '' }).mockResolvedValueOnce({ data: 'UklGRg==' });
    await getSystemSpeechCapabilities();
    expect(native.androidCall).toHaveBeenCalledWith('speechCapabilities');
    const settings = normalizeSpeechSettings({ voiceId: 'android-voice', rate: .7 });
    await synthesizeSystemSpeech('Текст', undefined, settings);
    expect(native.androidCall).toHaveBeenCalledWith('synthesizeSpeech', expect.objectContaining({ text: 'Текст', ...settings }));
  });
  it('does not call an engine for an already cancelled request', async () => {
    const signal = AbortSignal.abort();
    await expect(synthesizeSystemSpeech('Текст', signal)).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
