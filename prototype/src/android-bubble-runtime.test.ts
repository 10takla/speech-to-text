import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function bubbleRuntime(reply: (action: string, payload: Record<string, unknown>) => unknown) {
  const windowStub = {
    AndroidBubble: {
      request(id: string, action: string, json: string) {
        queueMicrotask(() => {
          try { windowStub.bubbleReply!(id, reply(action, JSON.parse(json)), null); }
          catch (error) { windowStub.bubbleReply!(id, null, (error as Error).message); }
        });
      },
      configuration: () => '', maxHeight: () => 300,
    },
    bubbleReply: undefined as ((id: string, result: unknown, error: string | null) => void) | undefined,
  };
  vi.stubGlobal('window', windowStub);
  return import('./android-runtime');
}

it('routes paste through the Bubble bridge without a Tauri activity', async () => {
  const reply = vi.fn(() => null);
  const { bubbleInvoke, isAndroidBubble } = await bubbleRuntime(reply);
  expect(isAndroidBubble).toBe(true);
  await bubbleInvoke('paste_text_into_active_window', { text: 'Проверка' });
  expect(reply).toHaveBeenCalledWith('paste', { text: 'Проверка' });
});

it('decodes native audio bytes in the Bubble WebView', async () => {
  const { androidAudio } = await bubbleRuntime(() => ({ data: btoa(String.fromCharCode(82, 73, 70, 70, 0, 255)) }));
  expect(new Uint8Array(await androidAudio('snapshot'))).toEqual(new Uint8Array([82, 73, 70, 70, 0, 255]));
});

it('rejects a failed native recording request', async () => {
  const { androidCall } = await bubbleRuntime(() => { throw new Error('Микрофон недоступен'); });
  await expect(androidCall('start')).rejects.toThrow('Микрофон недоступен');
});
