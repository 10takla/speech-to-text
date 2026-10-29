import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { downloadHistoryRecording } from './history-recording-actions';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('./android-runtime', () => ({ isAndroid: false, isAndroidBubble: false, androidCall: vi.fn() }));

beforeEach(() => vi.mocked(invoke).mockReset());

it('sends exact binary audio to the native save command and waits for its result', async () => {
  const audio = new Blob([new Uint8Array([0, 255, 1, 128])], { type: 'audio/wav' });
  let finish!: (saved: boolean) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let completed = false;
  const saving = downloadHistoryRecording({ id: 'record', timestamp: 1, audioBlob: audio })
    .then(result => { completed = true; return result; });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('save_recording_file', {
    filename: 'recording-1970-01-01T00-00-00-001Z.wav', data: 'AP8BgA==',
  }));
  expect(completed).toBe(false);
  finish(true);
  expect(await saving).toBe(true);
});

it('returns cancellation without reporting a saved file', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(false);
  expect(await downloadHistoryRecording({ id: 'record', timestamp: 1, audioBlob: new Blob(['audio']) })).toBe(false);
});

it('uses a separate filename for the selected excerpt', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(true);
  await downloadHistoryRecording({ id: 'record', timestamp: 1, audioBlob: new Blob(['part'], { type: 'audio/wav' }) }, 'fragment-2-segment-3');
  expect(invoke).toHaveBeenCalledWith('save_recording_file', {
    filename: 'recording-1970-01-01T00-00-00-001Z-fragment-2-segment-3.wav', data: 'cGFydA==',
  });
});

it('propagates file dialog and write errors instead of reporting a successful download', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Нет доступа к файлу'));
  await expect(downloadHistoryRecording({ id: 'record', timestamp: 1, audioBlob: new Blob(['audio']) }))
    .rejects.toThrow('Нет доступа к файлу');
});
