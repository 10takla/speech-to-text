import { expect, it, vi } from 'vitest';
import type { invoke as TauriInvoke } from '@tauri-apps/api/core';
import { createTauriAudioCapture, createTauriTextOutput } from './tauri-adapters';

it('preserves the original stop event time when invoking native capture', async () => {
  const invoke = vi.fn<typeof TauriInvoke>().mockResolvedValue(new ArrayBuffer(0));
  await createTauriAudioCapture(invoke as typeof TauriInvoke).stop(1234567890);
  expect(invoke).toHaveBeenCalledWith('stop_audio_recording', { requestedAtMs: 1234567890, afterStopMs: 150 });
});

it('passes an explicit zero tail and cancels a pending native stop', async () => {
  let finish!: (audio: ArrayBuffer) => void;
  const invoke = vi.fn().mockImplementation((command: string) => command === 'stop_audio_recording'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const controller = new AbortController();
  const stopping = createTauriAudioCapture(invoke as typeof TauriInvoke).stop(1234567890, 0, controller.signal);
  expect(invoke).toHaveBeenCalledWith('stop_audio_recording', { requestedAtMs: 1234567890, afterStopMs: 0 });
  controller.abort();
  expect(invoke).toHaveBeenCalledWith('cancel_audio_recording', undefined);
  finish(new ArrayBuffer(0));
  await stopping;
});

it('passes the default and explicit paste focus choices to the native command', async () => {
  const invoke = vi.fn<typeof TauriInvoke>().mockResolvedValue(undefined);
  const output = createTauriTextOutput(invoke as typeof TauriInvoke);
  await output.paste('Первый');
  await output.paste('Второй', true);
  expect(invoke.mock.calls).toEqual([
    ['paste_text_into_active_window', { text: 'Первый', returnFocusToOriginalWindow: false }],
    ['paste_text_into_active_window', { text: 'Второй', returnFocusToOriginalWindow: true }],
  ]);
});
