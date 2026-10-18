import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from './history-db';
import { historyRecordingAudio, historyRecordingFilename, retranscribeHistoryRecording } from './history-recording-actions';

const audio = new Blob(['saved audio'], { type: 'audio/wav' });
const record: HistoryItem = { id: 'saved', timestamp: 1, text: 'Старый текст', audioBlob: audio };
const settings = () => ({
  provider: 'groq' as const, groqApiKey: ' current-key ', groqModel: 'current-model',
  groqPrompt: 'Текущий контекст', groqTemperature: 0, groqLanguage: 'ru',
});
const dependencies = () => ({
  settings, transcribe: vi.fn(async () => ({ text: ' Новый текст ', segments: [] })), copy: vi.fn(async () => {}),
});

describe('history recording actions', () => {
  it('transcribes the saved audio with current settings and copies only the new result without changing history', async () => {
    const services = dependencies();
    const snapshot = { ...record };
    const controller = new AbortController();
    expect(await retranscribeHistoryRecording(record, controller.signal, services)).toBe('Новый текст');
    expect(services.transcribe).toHaveBeenCalledExactlyOnceWith(audio, {
      apiKey: 'current-key', model: 'current-model', prompt: 'Текущий контекст', temperature: 0, language: 'ru',
    }, controller.signal);
    expect(services.copy).toHaveBeenCalledExactlyOnceWith('Новый текст');
    expect(record).toEqual(snapshot);
  });

  it('falls back to original audio when the edited recording is absent or empty', async () => {
    const original = new Blob(['original'], { type: 'audio/webm' });
    const item = { ...record, audioBlob: new Blob([]), originalAudioBlob: original };
    const services = dependencies();
    expect(historyRecordingAudio(item)).toBe(original);
    await retranscribeHistoryRecording(item, undefined, services);
    expect(services.transcribe).toHaveBeenCalledWith(original, expect.any(Object), undefined);
  });

  it('rejects missing audio, unselected providers and empty keys before contacting the API', async () => {
    const services = dependencies();
    await expect(retranscribeHistoryRecording({ ...record, audioBlob: undefined }, undefined, services)).rejects.toThrow('не сохранена');
    await expect(retranscribeHistoryRecording(record, undefined, {
      ...services, settings: () => ({ ...settings(), provider: 'none' }),
    })).rejects.toThrow('Выберите провайдер');
    await expect(retranscribeHistoryRecording(record, undefined, {
      ...services, settings: () => ({ ...settings(), groqApiKey: ' ' }),
    })).rejects.toThrow('API-ключ');
    expect(services.transcribe).not.toHaveBeenCalled();
    expect(services.copy).not.toHaveBeenCalled();
  });

  it('preserves the clipboard on empty recognition or provider failure', async () => {
    const services = dependencies();
    services.transcribe.mockResolvedValueOnce({ text: ' ', segments: [] });
    await expect(retranscribeHistoryRecording(record, undefined, services)).rejects.toThrow('Речь не распознана');
    services.transcribe.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(retranscribeHistoryRecording(record, undefined, services)).rejects.toThrow('API unavailable');
    expect(services.copy).not.toHaveBeenCalled();
  });

  it('does not copy results returned after cancellation', async () => {
    const controller = new AbortController();
    const services = dependencies();
    services.transcribe.mockImplementationOnce(async () => {
      controller.abort(); return { text: 'Отменённый результат', segments: [] };
    });
    await expect(retranscribeHistoryRecording(record, controller.signal, services)).rejects.toThrow();
    expect(services.copy).not.toHaveBeenCalled();
    await expect(retranscribeHistoryRecording(record, controller.signal, services)).rejects.toThrow();
    expect(services.transcribe).toHaveBeenCalledOnce();
  });

  it.each([['audio/wav', 'wav'], ['audio/webm;codecs=opus', 'webm'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg']])(
    'names a %s download without changing its actual format', (type, extension) => {
      expect(historyRecordingFilename(record, new Blob(['audio'], { type })))
        .toBe(`recording-1970-01-01T00-00-00-001Z.${extension}`);
    },
  );
});
