// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { defaultSettings, saveSettings } from '../config';
import { createDefaultScenario } from '../scenario';
import { overlayRetention } from '../overlay-retention';
import { initializeOverlayHost } from './overlay-host';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SpeechControls from '../SpeechControls';
import { clearActiveSpeech, setActiveSpeech } from '../speech-playback-control';

const runtime = vi.hoisted(() => ({ sessions: [] as any[], windowEvents: [] as string[], height: 300, y: 740 }));
vi.mock('../logger', () => ({ initLoggerForwarding() {} }));
vi.mock('../auto-size', () => ({ enableWindowAutoSizing: () => ({ resizeNow: async () => {
  runtime.windowEvents.push('resize');
  if (document.querySelector('.overlay-run:not(.overlay-content-hidden)')) runtime.height = 54;
} }) }));
vi.mock('../overlay-window', () => ({ createOverlayWindowController: (dependencies: any) => ({
  initializeBrowser() {}, syncMonitorTracking() {}, scheduleMaxWidthUpdate() {}, restoreSavedPosition: async () => {
    runtime.windowEvents.push('restore');
    runtime.y = Math.min(dependencies.getConfig().position.y, 1040 - runtime.height);
  },
}) }));
vi.mock('../android-runtime', () => ({ isAndroid: false, isAndroidBubble: false, androidCall: vi.fn() }));
vi.mock('./recording-session', () => ({ createRecordingSession: (host: any) => {
  const session = { state: 'idle', starting: false, completed: false, scenarioId: host.settings.activeScenarioId,
    abort: vi.fn(), dispose: vi.fn(), host,
    start: vi.fn(async () => {
      session.state = 'recording'; host.container.classList.remove('overlay-content-hidden');
      await host.prepareWindow?.(); host.onChange();
    }),
    stop: vi.fn(async () => { session.state = 'transcribing'; host.onRecordingReleased(); host.onChange(); }),
    pause: vi.fn(), confirmStop: vi.fn(),
    cancel: vi.fn(async () => { session.abort(); host.onRecordingReleased(); await host.hide(); }),
    complete: async () => {
      session.state = 'idle'; session.completed = true; host.onChange();
      if (!overlayRetention.pinned) await host.hide();
    },
  };
  runtime.sessions.push(session);
  return session;
} }));

it('routes triggers and Escape to individual runs, retaining pinned blocks until released', async () => {
  document.body.innerHTML = '<div id="overlay-container"><div id="overlay-runs"></div><div id="overlay-width-skeleton-preview"></div></div>';
  const a = createDefaultScenario(), b = createDefaultScenario();
  a.id = 'a'; b.id = 'b';
  a.steps[0].hotkey = 'Control+Shift+KeyD'; b.steps[0].hotkey = 'Control+Shift+KeyF';
  saveSettings({ ...defaultSettings(), scenarios: [a, b], activeScenarioId: a.id, position: { x: 700, y: 986, centerX: 830 } });
  const host = initializeOverlayHost();
  await host.trigger('a');
  expect(runtime.windowEvents).toEqual(['resize', 'restore']);
  expect(runtime.y).toBe(986);
  const first = runtime.sessions[0];
  await host.trigger('b');
  expect(runtime.sessions).toHaveLength(1); // Another trigger is ignored while recording.
  await host.trigger('a');
  expect(first.stop).toHaveBeenCalledOnce();
  await host.trigger('a');
  const repeated = runtime.sessions[1];
  expect(document.querySelectorAll('.overlay-run')).toHaveLength(2);
  await host.cancel(); // Current recording takes priority over old processing.
  expect(repeated.cancel).toHaveBeenCalledOnce();
  expect(first.abort).not.toHaveBeenCalled();
  await host.trigger('b');
  await host.trigger('b');
  const second = runtime.sessions[2];
  await host.cancel(); // Without a recording, cancel the last unfinished run.
  expect(second.cancel).toHaveBeenCalledOnce();
  expect(first.abort).not.toHaveBeenCalled();
  overlayRetention.setPinned(true);
  await first.complete();
  expect(document.querySelectorAll('.overlay-run')).toHaveLength(1);
  await host.trigger('b');
  overlayRetention.setPinned(false);
  await Promise.resolve();
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('.overlay-run')).toHaveLength(1);
  expect(host.state).toBe('recording');
  await host.cancel();
  expect(document.querySelectorAll('.overlay-run')).toHaveLength(0);
  // A hidden native window retains its expanded size after the old run closes.
  runtime.height = 300; runtime.y = 740; runtime.windowEvents.length = 0;
  await host.trigger('a');
  expect(runtime.windowEvents).toEqual(['resize', 'restore']);
  expect(runtime.y).toBe(986);
  await host.cancel();
});

it('keeps speech controls connected when an outside click unpins an unfinished run', async () => {
  document.body.innerHTML = '<div id="overlay-container"><div id="overlay-runs"></div><div id="overlay-width-skeleton-preview"></div></div>';
  const settings = defaultSettings();
  saveSettings({ ...settings, scenarios: [settings.scenarios[0]], position: { x: 0, y: 0 } });
  const host = initializeOverlayHost();
  await host.trigger(settings.scenarios[0].id);
  const run = runtime.sessions.at(-1);
  await host.trigger(settings.scenarios[0].id);
  const probe = document.createElement('div');
  document.getElementById('overlay-container')!.append(probe);
  const controls = createRoot(probe);
  const audio = document.createElement('audio');
  let paused = false;
  Object.defineProperties(audio, {
    duration: { value: 10 }, paused: { get: () => paused },
    buffered: { value: { length: 1, end: () => 10 } },
  });
  audio.currentTime = 3;
  const play = vi.spyOn(audio, 'play').mockImplementation(async () => { paused = false; audio.dispatchEvent(new Event('play')); });
  vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; audio.dispatchEvent(new Event('pause')); });
  const cleanup = vi.fn(() => audio.pause());
  try {
    flushSync(() => { setActiveSpeech(audio, cleanup); controls.render(createElement(SpeechControls)); });
    overlayRetention.setPinned(true);
    flushSync(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(overlayRetention.pinned).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(probe.textContent).toContain('0:03 / 0:10');
    const pause = probe.querySelector<HTMLButtonElement>('[aria-label="Пауза"]')!;
    expect(pause.disabled).toBe(false);
    flushSync(() => pause.click());
    expect(audio.paused).toBe(true);
    flushSync(() => probe.querySelector<HTMLButtonElement>('[aria-label="Продолжить"]')!.click());
    expect(play).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(3);
    expect(document.querySelectorAll('.overlay-run')).toHaveLength(1);
    audio.currentTime = 10; paused = true; audio.dispatchEvent(new Event('ended'));
    await run.complete();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(document.querySelectorAll('.overlay-run')).toHaveLength(0);
  } finally {
    flushSync(() => controls.unmount());
    clearActiveSpeech();
    await host.cancel();
  }
});
