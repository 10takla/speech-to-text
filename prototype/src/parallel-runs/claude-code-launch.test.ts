// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings, saveSettings } from '../config';
import { initializeOverlayHost } from './overlay-host';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, ..._args: unknown[]) => undefined), listen: vi.fn(async () => () => {}), record: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: async () => {} }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../logger', () => ({ initLoggerForwarding() {} }));
vi.mock('../android-runtime', () => ({ isAndroid: false, isAndroidBubble: false }));
vi.mock('../auto-size', () => ({ enableWindowAutoSizing: () => ({ resizeNow: async () => {} }) }));
vi.mock('../overlay-window', () => ({ createOverlayWindowController: () => ({ initialize: async () => {}, syncMonitorTracking() {} }) }));
vi.mock('./recording-session', () => ({ createRecordingSession: mocks.record }));

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('launches the Claude CLI from its trigger and cancels it without starting audio capture', async () => {
  const session = { state: 'idle', completed: false, starting: false, scenarioId: 'claude-code-test',
    start: vi.fn(async () => { session.state = 'recording'; }),
    cancel: vi.fn(async () => {}), abort: vi.fn(), dispose: vi.fn() };
  mocks.record.mockReturnValue(session);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  document.body.innerHTML = '<div id="overlay-container"><div id="overlay-runs"></div><div id="overlay-width-skeleton-preview"></div></div>';
  const settings = defaultSettings();
  const claude = settings.scenarios.find(item => item.id === 'claude-code-test')!;
  claude.enabled = true;
  claude.steps[0].hotkey = 'F8';
  saveSettings(settings);
  const host = initializeOverlayHost();
  await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
  await host.trigger(claude.id);
  try {
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(session.start).toHaveBeenCalledWith(claude.id);
    expect(document.querySelector('.overlay-run')).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('open_claude_code', undefined);
    expect(mocks.invoke).not.toHaveBeenCalledWith('start_audio_recording', expect.anything());
  } finally { await host.cancel(); }
  expect(session.cancel).toHaveBeenCalledOnce();
});
