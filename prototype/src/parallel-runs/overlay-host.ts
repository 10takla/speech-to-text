import type { invoke as TauriInvoke } from '@tauri-apps/api/core';
import { loadConfig, SETTINGS_STORAGE_KEY, type OverlayState } from '../config';
import { settingsForScenarioTrigger } from '../scenario-runtime';
import { scenarioBindings, scenarioStopBindings, STOP_BINDING_PREFIX } from '../scenario-triggers';
import { createTauriAudioCapture, createTauriTextOutput } from '../tauri-adapters';
import { enableWindowAutoSizing } from '../auto-size';
import { createOverlayWindowController } from '../overlay-window';
import { overlayRetention } from '../overlay-retention';
import { createControlHotkeyScope } from '../control-hotkey-scope';
import { invokeCommand } from '../tauri-commands';
import { initLoggerForwarding } from '../logger';
import { errorMessage } from '../error-message';
import { androidCall, bubbleInvoke, isAndroid, isAndroidBubble } from '../android-runtime';
import { isBrowserOverlayPreviewEnabled, listenForOverlayWidthPreview } from '../browser-overlay-preview';
import { createOverlayRunView } from './OverlayRun';
import { createRecordingSession, type RecordingSession } from './recording-session';
import { registerRunResources, finishRunResources, setRecordingResourceBusy } from './runtime';
import { clearActiveSpeech } from '../speech-playback-control';

type Run = { id: string; session: RecordingSession; disposeView(): void; outputFinished: boolean };
export function initializeOverlayHost() {
  const runs: Run[] = [];
  let microphoneOwner: Run | undefined;
  let starting = false;
  let pendingHide: Promise<void> = Promise.resolve();
  let stoppingAndroidService: Promise<void> = Promise.resolve();
  let invoke: typeof TauriInvoke | null = null;
  let config = loadConfig();
  const container = document.getElementById('overlay-container')!;
  const skeleton = document.getElementById('overlay-width-skeleton-preview')!;
  if (isAndroid) container.style.setProperty('--overlay-max-height', `${window.AndroidBubble?.maxHeight() ?? window.screen.availHeight}px`);
  const state = (): OverlayState => microphoneOwner?.session.state ?? (runs.some(run => !run.session.completed) ? 'transcribing' : runs.length ? 'error' : 'idle');
  const autoSizer = enableWindowAutoSizing('overlay-container', {
    nativeResizeCommand: 'resize_overlay_to_content', resizeDelayMs: 16,
    keepCenterOnResize: () => windowController?.preserveCenterOnResize ?? false,
    onResizeSettled: () => { windowController?.finishPreviewResize(); void windowController?.keepWithinMonitor(); },
  });
  const windowController = isAndroid ? null : createOverlayWindowController({
    container, dragHandle: container, skeletonPreview: skeleton,
    getConfig: () => config, getState: state, getInvoke: () => invoke,
    isPinned: () => overlayRetention.pinned, settleResize: async () => { await autoSizer?.resizeNow(); },
  });
  const setControlScope = createControlHotkeyScope(async active => {
    if (invoke && !isAndroid) await invokeCommand(invoke, 'set_control_hotkeys_active', { active });
  });

  function finishOutput(run: Run) {
    if (run.outputFinished) return;
    run.outputFinished = true;
    finishRunResources(run.id);
    if (invoke && !isAndroid) void invokeCommand(invoke, 'finish_scenario_output', { runId: run.id }).catch(console.warn);
  }

  function update() {
    container.classList.toggle('overlay-content-hidden', runs.length === 0);
    container.classList.remove('hidden');
    windowController?.syncMonitorTracking();
    for (const run of runs) if (run.session.completed || run.session.state === 'error') finishOutput(run);
    void setControlScope(runs.length > 0 || overlayRetention.pinned).catch(console.warn);
    if (isAndroid) {
      // The recording controls become available as soon as capture is released.
      const controlState = microphoneOwner?.session.state ?? 'idle';
      document.body.dataset.recordingState = controlState;
      window.dispatchEvent(new CustomEvent('android-ui-state', { detail: controlState }));
      void androidCall('updateState', { state: state(), status: '' }).catch(console.warn);
    }
  }

  async function removeRun(run: Run) {
    const index = runs.indexOf(run);
    if (index < 0) return true;
    runs.splice(index, 1);
    finishOutput(run);
    run.session.dispose();
    run.disposeView();
    update();
    if (runs.length || windowController?.previewActive) return true;
    if (isAndroid) {
      stoppingAndroidService = androidCall('stopRecordingService').catch(console.warn);
      await stoppingAndroidService;
    }
    if (invoke && !isAndroid) {
      const nativeInvoke = invoke;
      pendingHide = pendingHide.then(async () => {
        if (runs.length || windowController?.previewActive) return;
        // All blocks disappeared, so a pin no longer retains any content.
        clearActiveSpeech();
        overlayRetention.setPinned(false);
        await invokeCommand(nativeInvoke, 'set_overlay_pinned', { pinned: false });
        if (!runs.length && !windowController?.previewActive) await invokeCommand(nativeInvoke, 'hide_overlay');
      }).catch(console.warn);
      await pendingHide;
    } else if (windowController?.window) {
      pendingHide = windowController.window.hide().catch(console.warn);
      await pendingHide;
    }
    return true;
  }

  function releaseMicrophone(run: Run) {
    if (microphoneOwner !== run) return;
    microphoneOwner = undefined;
    setRecordingResourceBusy(false);
    update();
  }

  // A scenario with its own stop key: its start key only starts, the stop key only stops.
  function hasOwnStop(scenarioId: string) {
    const keys = loadConfig();
    return scenarioStopBindings(keys.scenarios, keys.hotkeyCancel).some(item => item.scenarioId === `${STOP_BINDING_PREFIX}${scenarioId}`);
  }

  function stopRecording(scenarioId?: string) {
    const session = microphoneOwner?.session;
    if (!session || scenarioId && scenarioId !== session.scenarioId) return;
    if (session.state === 'editing') session.confirmStop();
    else if (session.state === 'recording') void session.stop().catch(error => session.showError(errorMessage(error)));
  }

  async function trigger(scenarioId?: string, existingRecording?: { paused: boolean }) {
    if (starting) return;
    if (microphoneOwner) {
      if (scenarioId && hasOwnStop(scenarioId)) return;
      stopRecording(scenarioId);
      return;
    }
    const selected = settingsForScenarioTrigger(loadConfig(), scenarioId);
    if (!selected) return;
    starting = true;
    const first = runs.length === 0;
    const id = crypto.randomUUID();
    const view = createOverlayRunView(id, !isAndroidBubble);
    const run = { id, disposeView: view.dispose, outputFinished: false } as Run;
    run.session = createRecordingSession({
      runId: id, container: view.element, settings: selected,
      invoke, audioCapture: invoke ? createTauriAudioCapture(invoke) : null,
      textOutput: invoke ? createTauriTextOutput(invoke, id) : null,
      windowController, autoSizer,
      prepareWindow: async () => {
        // Fit the new block before restoring its anchor; the hidden native
        // window can still have the previous run's expanded dimensions.
        await autoSizer?.resizeNow();
        if (first && runs.includes(run)) await windowController?.restoreSavedPosition();
      },
      onChange: () => { queueMicrotask(update); },
      onRecordingReleased: () => releaseMicrophone(run),
      hide: () => removeRun(run),
    });
    runs.push(run);
    registerRunResources(id, selected.scenarios.find(item => item.id === selected.activeScenarioId)!.steps);
    microphoneOwner = run;
    setRecordingResourceBusy(true);
    try {
      await stoppingAndroidService;
      await pendingHide;
      if (invoke && !isAndroid) await invokeCommand(invoke, 'begin_scenario_output', { runId: id });
      if (!runs.includes(run)) return;
      if (existingRecording) run.session.restoreRecording(existingRecording.paused);
      else await run.session.start(selected.activeScenarioId);
    } catch (error) { if (runs.includes(run)) run.session.showError(errorMessage(error)); }
    finally {
      starting = false;
      if (!runs.includes(run) || run.session.state !== 'recording' && run.session.state !== 'editing') releaseMicrophone(run);
      update();
    }
  }

  async function cancel() {
    const latest = [...runs].reverse();
    const run = microphoneOwner ?? latest.find(run => run.session.state === 'transcribing' || run.session.starting)
      ?? latest.find(run => run.session.state === 'error') ?? latest[0];
    if (!run) return;
    run.session.abort();
    finishRunResources(run.id);
    if (invoke && !isAndroid) await invokeCommand(invoke, 'cancel_scenario_output', { runId: run.id }).catch(console.warn);
    await run.session.cancel();
  }

  function matches(event: KeyboardEvent, shortcut: string) {
    const parts = shortcut.split('+');
    return event.ctrlKey === parts.includes('Control') && event.altKey === parts.includes('Alt')
      && event.shiftKey === parts.includes('Shift') && event.metaKey === parts.includes('Meta')
      && (event.code === parts.at(-1) || event.key === parts.at(-1));
  }

  window.addEventListener('keydown', event => {
    if (invoke || event.repeat) return;
    const keys = loadConfig();
    const binding = scenarioBindings(keys.scenarios, keys.hotkeyCancel).find(item => matches(event, item.shortcut));
    const stop = scenarioStopBindings(keys.scenarios, keys.hotkeyCancel).find(item => matches(event, item.shortcut));
    if (binding) { event.preventDefault(); void trigger(binding.scenarioId); }
    else if (stop) { event.preventDefault(); stopRecording(stop.scenarioId.slice(STOP_BINDING_PREFIX.length)); }
    else if (runs.length && matches(event, keys.hotkeyCancel || 'Escape')) { event.preventDefault(); void cancel(); }
    else if (microphoneOwner && matches(event, keys.hotkeyPause)) { event.preventDefault(); void microphoneOwner.session.pause(); }
  });
  window.addEventListener('storage', event => {
    if (event.key && event.key !== SETTINGS_STORAGE_KEY) return;
    config = loadConfig();
    windowController?.scheduleMaxWidthUpdate();
    windowController?.syncMonitorTracking();
  });
  overlayRetention.subscribe(pinned => {
    container.classList.toggle('overlay-pinned', pinned);
    if (invoke && !isAndroid) void invokeCommand(invoke, 'set_overlay_pinned', { pinned }).catch(console.warn);
    if (!pinned) {
      clearActiveSpeech();
      for (const run of [...runs]) if (run.session.completed) void removeRun(run);
    }
    update();
  });
  document.addEventListener('mousedown', event => {
    if (isAndroid || !runs.length) return;
    overlayRetention.setPinned(event.target instanceof Node && container.contains(event.target));
  }, true);

  async function initializeAndroid() {
    window.addEventListener('android-runtime-event', event => {
      const { action, text } = (event as CustomEvent<{ action: string; text: string }>).detail;
      if (action === 'record-hotkey') void trigger();
      else if (action === 'pause-hotkey') void microphoneOwner?.session.pause();
      else if (action === 'cancel-hotkey') void cancel();
      else if (action === 'native-error') { const run = microphoneOwner; void cancel().then(() => run?.session.showError(text)); }
    });
    const recording = await androidCall<{ recording: boolean; paused: boolean }>('recordingStatus');
    if (recording.recording) await trigger(undefined, { paused: recording.paused });
    await androidCall('frontendReady');
    window.dispatchEvent(new Event('android-bubble-ready'));
  }

  async function initialize() {
    if (isAndroidBubble) { invoke = bubbleInvoke; await initializeAndroid(); return; }
    if (!('__TAURI_INTERNALS__' in window)) {
      windowController?.initializeBrowser();
      if (isBrowserOverlayPreviewEnabled()) container.classList.remove('overlay-content-hidden');
      listenForOverlayWidthPreview(percent => { void windowController?.previewWidth(percent); });
      return;
    }
    const [core, native, events] = await Promise.all([
      import('@tauri-apps/api/core'), import('@tauri-apps/api/window'), import('@tauri-apps/api/event'),
    ]);
    invoke = core.invoke;
    if (isAndroid) { await initializeAndroid(); return; }
    const currentWindow = native.getCurrentWindow();
    await currentWindow.hide();
    await windowController?.initialize(currentWindow);
    await events.listen<boolean>('overlay-pin-changed', event => overlayRetention.setPinned(event.payload));
    await events.listen<string | null>('record-hotkey', event => {
      const id = event.payload;
      if (id?.startsWith(STOP_BINDING_PREFIX)) stopRecording(id.slice(STOP_BINDING_PREFIX.length));
      else void trigger(id ?? undefined);
    });
    await events.listen('pause-hotkey', () => { void microphoneOwner?.session.pause(); });
    await events.listen('cancel-hotkey', () => { void cancel(); });
    await events.listen<number | null>('overlay-width-preview', event => { void windowController?.previewWidth(event.payload); });
    await events.listen<boolean>('overlay-monitor-movement-setting', event => {
      config.overlayFollowCursorMonitor = event.payload;
      windowController?.syncMonitorTracking();
      if (event.payload && runs.length) void windowController?.moveToCursorMonitor();
    });
    update();
  }

  initLoggerForwarding('overlay');
  void initialize().catch(console.error);

  return { trigger, cancel, get state() { return state(); } };
}
