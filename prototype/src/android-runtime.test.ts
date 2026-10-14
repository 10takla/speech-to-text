import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { androidAudio } from './android-runtime';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
beforeEach(() => vi.mocked(invoke).mockReset());

describe('Android audio IPC', () => {
  it('converts the numeric array returned by Android IPC into binary audio bytes', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ data: 'audio' }).mockResolvedValueOnce([82, 73, 70, 70, 0, 255]);
    const buffer = await androidAudio('snapshot');
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([82, 73, 70, 70, 0, 255]);
  });
  it('preserves a binary IPC response when supported by the runtime', async () => {
    const bytes = new Uint8Array([82, 73, 70, 70]).buffer;
    vi.mocked(invoke).mockResolvedValueOnce({ data: 'audio' }).mockResolvedValueOnce(bytes);
    expect(await androidAudio('stop')).toBe(bytes);
  });
});
