import type { OverlayConfig, OverlayState } from '../config';
import { loadConfig, SETTINGS_STORAGE_KEY } from '../config';
import { getScenarioStepContract, isTriggerStep, type ScenarioStep } from '../scenario';
import { playSound } from '../audio';
import { appendRecordingFragments, createFragmentEditors, cutAudio } from '../recording-editor';
import type { RecordingFragment } from '../recording-editor';
import { createRunHistoryRepository } from '../history-repository';
import { errorMessage } from '../error-message';
import { transitionOverlayState } from '../recording-state';
import { invokeCommand } from '../tauri-commands';
import { createGeminiTextPostProcessor, createTranscriptionProvider } from '../provider-adapters';
import type { AudioCapturePort, TextOutputPort } from '../ports';
import { createLiveTranscriber, type LiveTranscriber } from '../live-transcription';
import { getScenarioReadinessError, runRecordingWorkflow } from '../recording-workflow';
import { isAndroid, androidCall } from '../android-runtime';
import { normalizeAfterStopMs, waitForStopTail } from '../recording-stop';
import { decodeAudio } from '../audio-decoding';
import { recordingPreviewFragments, retainedPreviewSegments } from '../recording-transcript';
import { overlayRetention } from '../overlay-retention';
import { publishScenarioProgress, type ScenarioProgress } from '../scenario-progress';
import { synthesizeSystemSpeech, playSpeechAudio } from '../system-speech';
import { createSpeechProvider } from '../speech-providers';
import { prepareEdgeSpeech } from '../edge-speech';
import { clearActiveSpeech } from '../speech-playback-control';

import type { OverlayWindowController } from '../overlay-window';
import type { WindowAutoSizer } from '../auto-size';
import { applyOverlayTextFlags, type OverlayStepStatus } from '../OverlaySteps';
import { walkScenarioSteps } from '../scenario-tree';
import { textOutputQueue, speechPlaybackQueue } from './runtime';

interface SessionHost {
  runId: string;
  settings: OverlayConfig;
  container: HTMLElement;
  invoke: typeof import('@tauri-apps/api/core').invoke | null;
  audioCapture: AudioCapturePort | null;
  textOutput: TextOutputPort | null;
  windowController: OverlayWindowController | null;
  autoSizer: WindowAutoSizer | null;
  prepareWindow?(): Promise<void>;
  onChange(): void;
  onRecordingReleased(): void;
  hide(): Promise<boolean>;
}

export function createRecordingSession(host: SessionHost) {
  const { invoke, audioCapture, textOutput, container } = host;
  const overlayWindowController = host.windowController;
  const overlayAutoSizer = host.autoSizer;
  let displayedSteps: readonly OverlayStepStatus[] = [];
  const waitingSteps = new Map<string, OverlayStepStatus>();
  // Text flags are read from the saved settings, not from the run's snapshot: changing one shows at once.
  const savedScenarioSteps = () => loadConfig().scenarios.flatMap(scenario => [...walkScenarioSteps(scenario.steps)]);
  let textFlagSteps = savedScenarioSteps();
  const publishSteps = () => container.dispatchEvent(new CustomEvent('overlay-steps', { detail: applyOverlayTextFlags([
    ...displayedSteps.map(step => waitingSteps.has(step.id) ? { ...step, ...waitingSteps.get(step.id) } : step),
    ...[...waitingSteps.values()].filter(step => !displayedSteps.some(item => item.id === step.id)),
  ], textFlagSteps) }));
  const showOverlaySteps = (steps: readonly OverlayStepStatus[]) => { displayedSteps = steps; publishSteps(); };
  function waitingFor(step: ScenarioStep | undefined, reason: string, waiting: boolean) {
    if (!step || disposed) return;
    if (waiting) waitingSteps.set(step.id, { id: step.id, title: getScenarioStepContract(step.type).title, status: 'pending', waiting: reason });
    else waitingSteps.delete(step.id);
    publishSteps();
  }
  let completed = false;
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const executionProgress = new Map<string, ScenarioProgress['steps'][number]>();
  function reportExecutionProgress(step?: ScenarioProgress['steps'][number], active = true) {
    if (step) executionProgress.set(step.id, step);
    if (!active) executionProgress.clear();
    publishScenarioProgress({ runId: host.runId, scenarioId: config.activeScenarioId, active, steps: [...executionProgress.values()] });
  }

  const statusText = container.querySelector('[data-role=overlay-status-text]') as HTMLElement;
  const livePreview = container.querySelector('[data-role=live-preview]') as HTMLElement;
  const errorBanner = container.querySelector('[data-role=error-banner]') as HTMLElement;
  const btnOpenMicSettings = container.querySelector('[data-role=btn-open-mic-settings]') as HTMLButtonElement | null;
  const waveformBars = Array.from(container.querySelectorAll('[data-role=waveform] .bar')) as HTMLElement[];
  function listenStorage(listener: (event: StorageEvent) => void) {
    window.addEventListener('storage', listener);
    cleanups.push(() => window.removeEventListener('storage', listener));
  }
  let lastPreviewText = '';
  let previewHasContent = false;
  let livePreviewProcessing = false;
  let editingPreviewPending = false;
  function setLivePreviewText(text: string, structured = false) {
    lastPreviewText = text;
    const fragments = structured ? recordingPreviewFragments(recordingFragments, liveTranscriber.segments) : [];
    previewHasContent = fragments.length > 0 || !!text.trim() || livePreviewProcessing;
    container.dispatchEvent(new CustomEvent('overlay-transcription-preview', { detail: { text, fragments, processing: livePreviewProcessing } }));
    livePreview.classList.toggle('hidden', (state === 'editing' && !editingPreviewPending) || !previewHasContent);

  }

  function setLivePreviewProcessing(processing: boolean) {
    if (livePreviewProcessing === processing) return;
    livePreviewProcessing = processing;
    setLivePreviewText(lastPreviewText, true);
  }

  let state: OverlayState = 'idle';
  let config: OverlayConfig = host.settings;
  let executionConfig: OverlayConfig | null = host.settings;
  const loadRuntimeConfig = () => executionConfig ?? loadConfig();

  const transcriptionProvider = createTranscriptionProvider(() => ({
    provider: config.provider, googleCloud: config.googleCloud,
    geminiTranscription: config.geminiTranscription,
    apiKey: config.groqApiKey,
    model: config.groqModel,
    prompt: config.groqPrompt,
    temperature: config.groqTemperature,
    language: config.groqLanguage,
  }), fetch, waiting => waitingFor(config.scenarios.find(item => item.id === config.activeScenarioId)?.steps.find(step => step.type === 'transcribe'), 'Ожидание провайдера…', waiting));
  function transcriptionProviderForStep(step: ScenarioStep) {
    const settings = step.transcription;
    return settings ? createTranscriptionProvider(() => ({
      provider: settings.provider, googleCloud: settings.googleCloud,
      geminiTranscription: settings.geminiTranscription,
      apiKey: settings.apiKey, model: settings.model, prompt: settings.prompt,
      temperature: settings.temperature, language: settings.language,
    }), fetch, waiting => waitingFor(step, 'Ожидание провайдера…', waiting)) : transcriptionProvider;
  }
  const textPostProcessor = createGeminiTextPostProcessor(() => ({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    instructionPrompt: config.geminiPrompt,
    generationConfig: config.scenarios.find(scenario => scenario.id === config.activeScenarioId)
      ?.steps.find(step => step.type === 'postprocess')?.postprocessing?.generationConfig,
  }), fetch, waiting => waitingFor(config.scenarios.find(item => item.id === config.activeScenarioId)?.steps.find(step => step.type === 'postprocess'), 'Ожидание провайдера…', waiting));

  function getAudioCapture(): AudioCapturePort {
    if (!audioCapture) throw new Error('Системный захват аудио недоступен.');
    return audioCapture;
  }

  function getTextOutput(): TextOutputPort {
    if (!textOutput) throw new Error('Системный вывод текста недоступен.');
    return textOutput;
  }
  let mediaStream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let recordedChunks: Blob[] = [];
  let nativeRecording = false;
  const usesClaude = () => config.scenarios.find(item => item.id === config.activeScenarioId)?.steps[0]?.type === 'claudeCode';
  // The scenario starts from the text selected in another application, without recording.
  const usesSelection = () => config.scenarios.find(item => item.id === config.activeScenarioId)?.steps[0]?.type === 'selectedText';
  let claudeRecording = false;
  let claudePoll: ReturnType<typeof setInterval> | undefined;
  let claudePolling = false;
  // Claude Code records the voice itself. A parallel capture of the default
  // microphone drives the level indicator and keeps the audio for history.
  let claudeMeter = false;
  // Returns whether the parallel capture was running; `keepCapture` leaves it
  // for the caller to stop and collect.
  function stopClaudePolling(keepCapture = false) {
    clearInterval(claudePoll); claudePoll = undefined;
    if (!claudeMeter) return false;
    claudeMeter = false;
    stopVolumeAnalysis();
    if (!keepCapture) void getAudioCapture().cancel().catch(console.warn);
    return true;
  }
  // Starts together with Claude rather than after it confirms its microphone
  // (polled every 150 ms), so the saved recording keeps the first words.
  function startClaudeCapture(): Promise<boolean> {
    claudeMeter = true;
    return getAudioCapture().start(undefined).then(() => true, error => {
      claudeMeter = false;
      console.warn('Параллельная запись и индикатор Claude Code недоступны:', error);
      return false;
    });
  }
  async function releaseClaudeCapture(capture: Promise<boolean>) {
    if (!await capture || !claudeMeter) return;
    claudeMeter = false;
    await getAudioCapture().cancel().catch(() => {});
  }
  let captureStopPending = false;
  let activeEditor: ReturnType<typeof createFragmentEditors> | null = null;
  let recordingFragments: RecordingFragment[] = [];
  let fragmentOffset = 0;
  let pausePending = false;
  let pauseAction: ((finish: boolean) => void) | null = null;
  function confirmPausedRecording(finish: boolean) {
    if (activeEditor?.ready) activeEditor.confirm(finish);
    else pauseAction?.(finish);
  }
  let recordingGeneration = 0;
  let startingRecording = false;
  function syncControlHotkeyScope() { host.onChange(); return Promise.resolve(); }
  let workflowAbortController: AbortController | null = null;
  const branchLiveTranscribers = new Map<string, { step: ScenarioStep; engine: LiveTranscriber }>();
  const liveTranscriber: LiveTranscriber = createLiveTranscriber({
    getState: () => state,
    getSettings: () => config,
    snapshotAudio: () => getAudioCapture().snapshot(),
    provider: transcriptionProvider,
    cutAudio,
    onPreview: text => {
      setLivePreviewText(text, true);
    },
    onError: error => console.warn('Не удалось обновить live-транскрибацию:', error),
    onProcessing: status => {
      setLivePreviewProcessing(status === 'running' && state === 'recording');
      if (state !== 'recording' && state !== 'editing') return;
      const step = config.scenarios.find(item => item.id === config.activeScenarioId)?.steps.find(item => item.type === 'transcribe');
      if (!step) return;
      if (status === 'idle') {
        executionProgress.delete(step.id);
        reportExecutionProgress();
      } else reportExecutionProgress({ id: step.id, type: step.type, status });
    },
  });

  listenStorage(event => {
    if (event.key !== SETTINGS_STORAGE_KEY) return;
    textFlagSteps = savedScenarioSteps();
    publishSteps();
    const positionWasSaved = config.position !== null;
    config = loadRuntimeConfig();
    if (positionWasSaved && config.position === null && !invoke) {
      void overlayWindowController?.moveToCursorMonitor(true);
    }
    overlayWindowController?.syncMonitorTracking();
    setLivePreviewText(liveTranscriber.text, true);
  });

  // Измерение громкости микрофона в реальном времени
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let animFrameId: number | null = null;
  let nativeVolumeTimer: number | null = null;
  let smoothedVolumeLevel = 0;
  function stopLiveTranscription() {
    liveTranscriber.stop();
    branchLiveTranscribers.forEach(({ engine }) => engine.stop());
  }

  function startLiveTranscription(reset = false) {
    if (reset) {
      branchLiveTranscribers.forEach(({ engine }) => engine.stop());
      branchLiveTranscribers.clear();
      const primary = config.scenarios.find(item => item.id === config.activeScenarioId)?.steps.find(step => step.type === 'transcribe');
      const add = (step: ScenarioStep) => {
        for (const lane of step.parallelBranches ?? []) {
          const head = lane[0];
          if (head?.type !== 'transcribe') continue;
          const engine = createLiveTranscriber({
            getState: () => state,
            getSettings: () => head.transcription ?? config,
            snapshotAudio: () => getAudioCapture().snapshot(), provider: transcriptionProviderForStep(head), cutAudio,
            onPreview: () => {}, onError: error => console.warn('Ошибка транскрибации ветки:', error),
            onProcessing: status => {
              if (state !== 'recording' && state !== 'editing') return;
              if (status === 'idle') { executionProgress.delete(head.id); reportExecutionProgress(); }
              else reportExecutionProgress({ id: head.id, type: head.type, status });
            },
          });
          branchLiveTranscribers.set(head.id, { step: head, engine });
          add(head);
        }
      };
      if (primary) add(primary);
    }
    liveTranscriber.start(reset);
    branchLiveTranscribers.forEach(({ engine }) => engine.start(reset));
  }

  function updateVolumeIndicator(rms: number) {
    liveTranscriber.observeSpeechLevel(rms);
    branchLiveTranscribers.forEach(({ engine }) => engine.observeSpeechLevel(rms));
    const rawLevel = Math.max(0, Math.min(1, (rms - 0.004) * 82));
    smoothedVolumeLevel += (rawLevel - smoothedVolumeLevel) * (rawLevel > smoothedVolumeLevel ? 0.55 : 0.22);
    const normalized = smoothedVolumeLevel;
    container.style.setProperty('--volume-scale', (1 + normalized * 0.8).toFixed(2));
    container.style.setProperty('--volume-glow', `${Math.round(normalized * 14)}px`);
    container.classList.toggle('audio-active', normalized > 0.04);
    waveformBars.forEach((bar, idx) => {
      const factor = 1 - Math.abs(idx - (waveformBars.length - 1) / 2) * 0.16;
      const height = Math.max(3, Math.min(12, Math.round(3 + normalized * 9 * factor)));
      bar.style.setProperty('--bar-scale', String(height / 12));
    });
  }

  function startNativeVolumeAnalysis() {
    stopVolumeAnalysis();
    if (!invoke) return;
    let requestPending = false;
    nativeVolumeTimer = window.setInterval(async () => {
      if (state !== 'recording') {
        stopVolumeAnalysis();
        return;
      }
      if (requestPending) return;
      requestPending = true;
      try {
        const rms = await getAudioCapture().inputLevel();
        if (state === 'recording') updateVolumeIndicator(rms);
      } catch (error) {
        console.warn('Не удалось получить уровень микрофона:', error);
        stopVolumeAnalysis();
      } finally {
        requestPending = false;
      }
    }, 40);
  }

  function startVolumeAnalysis(stream: MediaStream) {
    stopVolumeAnalysis();
    try {
      const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const context = new AudioCtx();
      audioContext = context;
      const currentAnalyser = context.createAnalyser();
      currentAnalyser.fftSize = 256;
      analyser = currentAnalyser;
      micSource = context.createMediaStreamSource(stream);
      micSource.connect(currentAnalyser);

      if (context.state === 'suspended') {
        void context.resume().catch(error => console.warn('Не удалось возобновить анализ аудио:', error));
      }

      const dataArray = new Uint8Array(currentAnalyser.fftSize);
      const checkVolume = () => {
        if ((!startingRecording && state !== 'recording') || analyser !== currentAnalyser) {
          stopVolumeAnalysis();
          return;
        }

        currentAnalyser.getByteTimeDomainData(dataArray);
        let squareSum = 0;
        for (const sample of dataArray) {
          const normalizedSample = (sample - 128) / 128;
          squareSum += normalizedSample * normalizedSample;
        }
        const rms = Math.sqrt(squareSum / dataArray.length);
        updateVolumeIndicator(rms);
        animFrameId = requestAnimationFrame(checkVolume);
      };

      animFrameId = requestAnimationFrame(checkVolume);
    } catch (error) {
      console.warn('Не удалось запустить аудио-анализатор:', error);
    }
  }

  function stopVolumeAnalysis() {
    if (nativeVolumeTimer !== null) {
      window.clearInterval(nativeVolumeTimer);
      nativeVolumeTimer = null;
    }
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch (e) {}
      micSource = null;
    }
    if (analyser) {
      analyser = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { void audioContext.close(); } catch (e) {}
      audioContext = null;
    }
    smoothedVolumeLevel = 0;
    container.style.removeProperty('--volume-scale');
    container.style.removeProperty('--volume-glow');
    container.classList.remove('audio-active');
    waveformBars.forEach((bar) => { bar.style.removeProperty('--bar-scale'); });
  }

  function emitSound(event: 'start_record' | 'insert_text' | 'cancel' | 'error'): Promise<void> {
    config = loadRuntimeConfig();
    const scenario = config.scenarios.find(item => item.id === config.activeScenarioId);
    const trigger = scenario?.steps.find(step => step.type === 'startRecording');
    if (!trigger || trigger.soundEnabled === false) return Promise.resolve();
    if (isAndroid) {
      if (event === 'start_record' && trigger.sound === 'none') return Promise.resolve();
      if (event === 'insert_text' && scenario?.steps.find(step => step.type === 'paste')?.soundSuccess === 'none') return Promise.resolve();
      return androidCall('playSound', { state: event }).catch(error => { console.warn('Не удалось воспроизвести сигнал:', error); });
    }

    if (event === 'start_record') {
      if (trigger.sound === 'none') return Promise.resolve();
      return playSound(event, trigger.soundProfile ?? config.soundProfile);
    }
    if (event === 'insert_text') {
      const paste = scenario?.steps.find(step => step.type === 'paste' && step.enabled);
      if (!paste || paste.soundSuccess === 'none') return Promise.resolve();
      return playSound(event, paste.soundSuccess ?? config.soundSuccess);
    }
    return playSound(event, trigger.soundProfile ?? config.soundProfile);
  }

  listenStorage(event => {
    if (event.key !== SETTINGS_STORAGE_KEY && event.key !== null) return;
    config = loadRuntimeConfig();
    overlayWindowController?.scheduleMaxWidthUpdate();
  });

  // Ошибки кратко показываются и автоматически скрываются.
  let errorAutoHideTimer: number | null = null;

  function clearErrorAutoHideTimer() {
    if (errorAutoHideTimer !== null) {
      window.clearTimeout(errorAutoHideTimer);
      errorAutoHideTimer = null;
    }
  }

  // Состояния UI
  function setOverlayState(newState: OverlayState, errorMsg?: string, showMicSettings = false, preserveContent = false) {
    clearErrorAutoHideTimer();
    try {
      state = transitionOverlayState(state, newState);
    } catch (error) {
      console.error(errorMessage(error));
      return;
    }
    host.onChange();
    if (state === 'idle' || state === 'error') reportExecutionProgress(undefined, false);
    if (state !== 'recording') setLivePreviewProcessing(false);
    void syncControlHotkeyScope().catch(console.warn);
    if (state !== 'idle' && state !== 'error') {
      const trigger = config.scenarios.find(item => item.id === config.activeScenarioId)?.steps.find(step => isTriggerStep(step));
      if (trigger) reportExecutionProgress({ id: trigger.id, type: trigger.type, status: state === 'transcribing' ? 'success' : 'running' });
    }
    if (preserveContent) {
      container.classList.remove('recording', 'editing');
      return;
    }
    if (state !== 'transcribing' && state !== 'error') showOverlaySteps([]);
    container.classList.remove('recording', 'has-error');
    container.classList.toggle('overlay-content-hidden', state === 'idle');
    errorBanner.classList.add('hidden');
    if (btnOpenMicSettings) btnOpenMicSettings.classList.toggle('hidden', !showMicSettings);

    container.classList.toggle('editing', state === 'editing');
    livePreview.classList.toggle('hidden', (state === 'editing' && !editingPreviewPending) || !previewHasContent);
    container.querySelector('[data-role=waveform]')?.classList.toggle('hidden', state === 'editing');
    switch (state) {
      case 'editing':
        statusText.textContent = 'Редактирование записи';
        break;
      case 'idle':
        statusText.textContent = 'Ожидание';
        break;

      case 'recording':
        container.classList.add('recording');
        statusText.textContent = 'Запись речи...';
        break;

      case 'transcribing':
        statusText.textContent = 'Распознавание речи...';
        break;

      case 'error':
        host.onRecordingReleased();
        if (overlayWindowController?.window) void overlayWindowController.window.show();
        else container.classList.remove('hidden');
        container.classList.add('has-error');
        statusText.textContent = 'Ошибка';
        errorBanner.textContent = errorMsg || 'Неизвестная ошибка записи';
        errorBanner.classList.remove('hidden');
        emitSound('error');
        errorAutoHideTimer = window.setTimeout(() => {
          errorAutoHideTimer = null;
          if (state === 'error') void completeOverlayProcess();
        }, 3000);
        break;
    }
  }

  function describeMicrophoneError(error: unknown): { message: string; showSettings: boolean } {
    const details = error as { name?: string; message?: string } | null;
    const name = details?.name || '';
    // Tauri commands reject with plain strings.
    const message = typeof error === 'string' ? error : details?.message || '';

    if (
      name === 'NotAllowedError' ||
      name === 'PermissionDeniedError' ||
      name === 'SecurityError' ||
      /permission denied|notallowed|доступ к микрофону не предоставлен/i.test(message)
    ) {
      if (isAndroid) {
        return {
          message: 'Доступ к микрофону не предоставлен. Разрешите его в настройках приложения.',
          showSettings: true,
        };
      }
      return {
        message: 'Windows запретила доступ к микрофону. В настройках включите доступ к микрофону и доступ для классических приложений; отдельной строки Speech to Text может не быть.',
        showSettings: true,
      };
    }

    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return { message: 'Микрофон не найден. Подключите устройство и повторите попытку.', showSettings: false };
    }

    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return { message: 'Не удалось включить микрофон. Проверьте, не занят ли он другим приложением.', showSettings: false };
    }

    return { message: 'Не удалось начать запись: ' + (message || 'неизвестная ошибка.'), showSettings: false };
  }

  async function completeOverlayProcess() {
    stopLiveTranscription();
    clearErrorAutoHideTimer();
    completed = true;
    setOverlayState('idle', undefined, false, true);

    if (!overlayRetention.pinned || isAndroid) await hideOverlay();
  }
  async function hideOverlay() { return host.hide(); }

  async function startRecording(scenarioId?: string) {
    if (state === 'recording' || startingRecording) return;

    const selected = host.settings;
    if (scenarioId && scenarioId !== selected.activeScenarioId) return;
    if (!selected) return;
    completed = false;
    clearActiveSpeech();

    executionProgress.clear();
    reportExecutionProgress(undefined, false);
    showOverlaySteps([]);
    errorBanner.classList.add('hidden');
    startingRecording = true;
    stopLiveTranscription();
    executionConfig = config = selected;
    recordingGeneration++;
    const generation = recordingGeneration;
    if (invoke && !isAndroid) {
      try {
        const shortcut = (value: string) => value.split('+').map(part =>
          part === 'Control' ? 'Ctrl' : part === 'Meta' ? 'Super' : part.replace(/^(Key|Digit)/, '')).join('+');
        await invokeCommand(invoke, 'set_control_hotkeys', {
          pauseShortcut: shortcut(config.hotkeyPause || 'Control+Alt+KeyD'),
          cancelShortcut: shortcut(config.hotkeyCancel || 'Escape'),
        });
        await syncControlHotkeyScope();
      } catch (error) {
        startingRecording = false;
        setOverlayState('error', errorMessage(error));
        return;
      }
    }
    if (generation !== recordingGeneration) return;
    pausePending = false;
    clearErrorAutoHideTimer();
    recordedChunks = [];
    recordingFragments = [];
    fragmentOffset = 0;
    setLivePreviewText('');
    await overlayAutoSizer?.resizeNow();
    if (generation !== recordingGeneration) return;

    // Описание приложения.md:141-143:
    // Некоторые этапы в сценарии содержат готовность. Если не готов, то ошибка сразу при начале сценария
    let readinessError = getScenarioReadinessError(config);
    // Connecting to Edge takes about a second: it runs while the text is being obtained.
    if (!readinessError) prepareEdgeSpeech(config.scenarios.find(item => item.id === config.activeScenarioId)?.steps ?? []);
    // The selection must be read before the overlay appears, while the application
    // holding it is still in the foreground.
    let selectedText = '';
    if (!readinessError && usesSelection()) {
      try {
        if (!invoke || isAndroid) throw new Error('Текст по выделению доступен в приложении Windows.');
        selectedText = await invokeCommand(invoke, 'get_selected_text', { runId: host.runId });
      } catch (error) {
        readinessError = errorMessage(error);
      }
      if (generation !== recordingGeneration) return;
    }
    if (readinessError) {
      startingRecording = false;
      container.classList.remove('overlay-content-hidden');
      await host.prepareWindow?.();
      if (generation !== recordingGeneration) return;
      if (config.overlayFollowCursorMonitor) {
        await overlayWindowController?.moveToCursorMonitor();
      }
      if (generation !== recordingGeneration) return;
      if (overlayWindowController?.window && invoke) {
        try { await invokeCommand(invoke, 'show_overlay'); } catch (e) {}
      } else if (overlayWindowController?.window) {
        try { await overlayWindowController.window.show(); } catch (e) {}
      }
      if (generation !== recordingGeneration) return;
      setOverlayState('error', readinessError);
      return;
    }

    container.classList.remove('overlay-content-hidden');
    await host.prepareWindow?.();
    if (generation !== recordingGeneration) return;
    if (config.overlayFollowCursorMonitor) {
      await overlayWindowController?.moveToCursorMonitor();
    }
    if (generation !== recordingGeneration) return;
    if (!isAndroid && overlayWindowController?.window && invoke) {
      try {
        await invokeCommand(invoke, 'show_overlay');
      } catch (error) {
        console.error('Нативная команда показа оверлея не сработала:', error);
        try {
          await overlayWindowController.window.show();
        } catch (fallbackError) {
          console.error('Не удалось показать окно оверлея:', fallbackError);
        }
      }
    } else if (overlayWindowController?.window) {
      try {
        await overlayWindowController.window.show();
      } catch (error) {
        console.error('Не удалось показать окно оверлея:', error);
      }
    } else {
      container.classList.remove('hidden');
    }
    if (generation !== recordingGeneration) return;

    if (!config.position && !invoke) {
      await overlayWindowController?.moveToCursorMonitor();
    }
    await overlayWindowController?.updateMaxWidth();
    if (generation !== recordingGeneration) return;

    try {
      if (usesSelection()) {
        // Nothing to record: the selected text goes straight into the scenario.
        startingRecording = false;
        setOverlayState('recording');
        const controller = new AbortController();
        workflowAbortController = controller;
        setOverlayState('transcribing');
        statusText.textContent = 'Обработка выделенного текста...';
        host.onRecordingReleased();
        // Not awaited: the run must not hold the trigger while the scenario works.
        void processRecordedAudio(new Blob(), generation, controller.signal, selectedText).catch(error => {
          if (generation === recordingGeneration && !controller.signal.aborted) setOverlayState('error', errorMessage(error));
        });
        return;
      }
      if (usesClaude()) {
        if (!invoke || isAndroid) throw new Error('Диктовка Claude Code доступна в приложении Windows.');
        setOverlayState('recording');
        statusText.textContent = 'Подготовка Claude Code…';
        const capture = startClaudeCapture();
        try { await invokeCommand(invoke, 'start_claude_dictation', { runId: host.runId }); }
        catch (error) { await releaseClaudeCapture(capture); throw error; }
        if (generation !== recordingGeneration) {
          await releaseClaudeCapture(capture);
          await invokeCommand(invoke, 'cancel_claude_code', { runId: host.runId });
          return;
        }
        claudeRecording = true;
        startingRecording = false;
        setOverlayState('recording');
        void capture.then(started => {
          if (started && claudeMeter && claudeRecording && generation === recordingGeneration) startNativeVolumeAnalysis();
        });
        const live = config.scenarios.find(item => item.id === config.activeScenarioId)?.steps[0]?.liveTranscription !== false;
        claudePoll = setInterval(() => {
          if (claudePolling || !claudeRecording || state !== 'recording' || !invoke) return;
          claudePolling = true;
          void invokeCommand(invoke, 'poll_claude_dictation', { runId: host.runId, live }).then(({ finished, text }) => {
            if (generation !== recordingGeneration || state !== 'recording') return;
            // Claude's interim transcript; the final text still arrives through its hook.
            if (live && text !== null && text !== lastPreviewText) setLivePreviewText(text);
            if (finished) void finishRecording();
          }).catch(error => {
            if (generation !== recordingGeneration) return;
            stopClaudePolling();
            claudeRecording = false;
            void invokeCommand(invoke!, 'cancel_claude_code', { runId: host.runId }).catch(console.warn);
            setOverlayState('error', errorMessage(error));
          }).finally(() => { claudePolling = false; });
        }, 250);
        return;
      }
      await emitSound('start_record');
      await new Promise<void>(resolve => window.setTimeout(resolve, 120));
      if (generation !== recordingGeneration) return;

      if (invoke) {
        const scenario = config.scenarios.find(item => item.id === config.activeScenarioId);
        await getAudioCapture().start(scenario?.steps.find(step => step.type === 'startRecording')?.microphoneId);
        if (generation !== recordingGeneration) {
          await getAudioCapture().cancel().catch(() => {});
          return;
        }
        nativeRecording = true;
      } else {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: (() => {
              const scenario = config.scenarios.find(item => item.id === config.activeScenarioId);
              const id = scenario?.steps.find(step => step.type === 'startRecording')?.microphoneId;
              return id ? { exact: id } : undefined;
            })(),
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        if (generation !== recordingGeneration) {
          mediaStream.getTracks().forEach(track => track.stop());
          mediaStream = null;
          return;
        }
        const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? { mimeType: 'audio/webm;codecs=opus' }
          : undefined;
        mediaRecorder = new MediaRecorder(mediaStream, options);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.start(200);
      }

      setOverlayState('recording');
      startingRecording = false;
      startLiveTranscription(true);
      if (nativeRecording && invoke) startNativeVolumeAnalysis();
      else if (mediaStream) startVolumeAnalysis(mediaStream);
    } catch (err: unknown) {
      if (generation !== recordingGeneration) return;
      startingRecording = false;
      stopVolumeAnalysis();
      if (invoke) {
        if (usesClaude()) await invokeCommand(invoke, 'cancel_claude_code', { runId: host.runId }).catch(() => {});
        else await getAudioCapture().cancel().catch(() => {});
      }
      console.error('Ошибка доступа к микрофону:', err);
      const details = describeMicrophoneError(err);
      setOverlayState('error', details.message, details.showSettings);
    }
  }

  function snapshotHistoryFragments() {
    return recordingFragments.map(fragment => ({
      start: fragment.start, end: fragment.end, audioBlob: fragment.audioBlob,
      text: fragment.transcript?.text || '', segments: fragment.transcript?.segments || [],
      removedRanges: fragment.removedRanges.map(range => ({ ...range })),
    }));
  }

  async function processRecordedAudio(audioBlob: Blob, generation: number, signal: AbortSignal, initialText?: string) {

    const workflowStartedAt = performance.now();
    let stageStartedAt = workflowStartedAt;
    let previousStage = 'start';
    console.info('[recording-timing] workflow-start', { generation, bytes: audioBlob.size });
    const output: TextOutputPort = invoke
      ? getTextOutput()
      : {
        copy: (text, historyLevel) => {
          if (historyLevel !== 0) {
            return Promise.reject(new Error('Выбор уровня в истории буфера обмена доступен в приложении Windows. Для браузера выберите уровень 0.'));
          }
          return navigator.clipboard.writeText(text);
        },
        paste: text => navigator.clipboard.writeText(text),
      };
    const history = createRunHistoryRepository(config.historyMaxItems);
    const result = await runRecordingWorkflow(audioBlob, {
      initialText,
      history: history.repository,
      transcription: transcriptionProvider,
      postProcessor: textPostProcessor,
      transcriptionForStep: transcriptionProviderForStep,
      postProcessorForStep: step => {
        const settings = step.postprocessing;
        return settings ? createGeminiTextPostProcessor(() => ({
          apiKey: settings.apiKey, model: settings.model, instructionPrompt: settings.prompt,
          generationConfig: settings.generationConfig,
        }), fetch, waiting => waitingFor(step, 'Ожидание провайдера…', waiting)) : textPostProcessor;
      },
      output,
      getSettings: () => config,
      fragments: recordingFragments,
      liveTranscriptForStep: step => {
        const engine = branchLiveTranscribers.get(step.id)?.engine;
        return engine ? { segments: engine.segments, throughSeconds: engine.committedThroughSeconds } : undefined;
      },
      liveTranscript: {
        segments: liveTranscriber.segments,
        throughSeconds: liveTranscriber.committedThroughSeconds,
      },
      getFragmentOffset: () => fragmentOffset,
      setFragmentOffset: offset => { fragmentOffset = offset; },
      snapshotFragments: snapshotHistoryFragments,
      decodeAudio: async blob => decodeAudio(await blob.arrayBuffer()),
      cut: cutAudio,
      onStage: stage => {
        const now = performance.now();
        console.info('[recording-timing] stage', { generation, previousStage, nextStage: stage,
          stageMs: Math.round(now - stageStartedAt), totalMs: Math.round(now - workflowStartedAt) });
        previousStage = stage;
        stageStartedAt = now;
        statusText.textContent = stage;
      },
      onSteps: steps => {
        if (generation === recordingGeneration && !signal.aborted) showOverlaySteps(steps);
      },
      onStepStatus: step => {
        if (generation === recordingGeneration && !signal.aborted) reportExecutionProgress(step);
      },
      onText: text => {
        setLivePreviewText(text);
        if (isAndroid) void androidCall('setOutputText', {text}).catch(console.warn);
      },
      onInsertSound: () => { void emitSound('insert_text'); },
      speech: { synthesize: synthesizeSystemSpeech, play: playSpeechAudio },
      speechForStep: step => createSpeechProvider(step, waiting => waitingFor(step, 'Ожидание провайдера…', waiting)),
      runAction: (step, operation) => {
        const queue = step.type === 'speak' ? speechPlaybackQueue : textOutputQueue;
        return queue.execute(host.runId, step.id, operation, waiting => {
          waitingFor(step, step.type === 'speak' ? 'Ожидание воспроизведения…' : 'Ожидание вывода текста…', waiting);
        });
      },
      skipActions: ids => { textOutputQueue.skip(host.runId, ids); speechPlaybackQueue.skip(host.runId, ids); },
      signal,
    }).finally(() => history.release().catch(console.warn));
    console.info('[recording-timing] workflow-complete', { generation, status: result.status,
      elapsedMs: Math.round(performance.now() - workflowStartedAt) });
    if (generation !== recordingGeneration || signal.aborted || result.status === 'cancelled') return;
    if (workflowAbortController?.signal === signal) workflowAbortController = null;
    if (result.status === 'error') {
      setOverlayState('error', result.message);
      return;
    }
    await completeOverlayProcess();
  }
  async function finishRecording() {
    if (state !== 'recording' || pausePending || startingRecording) return;
    if (claudeRecording && invoke) {
      const stopRequestedAtMs = Date.now();
      const afterStopMs = normalizeAfterStopMs(config.scenarios
        .find(item => item.id === config.activeScenarioId)?.steps[0]?.afterStopMs);
      const captured = stopClaudePolling(true);
      claudeRecording = false;
      const generation = recordingGeneration;
      const controller = new AbortController();
      workflowAbortController = controller;
      setOverlayState('transcribing');
      // The parallel capture ends on the same boundary as Claude and is kept for
      // history; without it the run still succeeds with the text alone.
      const audio = captured
        ? getAudioCapture().stop(stopRequestedAtMs, afterStopMs, controller.signal)
          .then(bytes => new Blob([bytes], { type: 'audio/wav' }))
          .catch(error => { console.warn('Не удалось сохранить аудио записи Claude Code:', error); return new Blob(); })
        : Promise.resolve(new Blob());
      try {
        // Claude Code keeps recording for the tail so the last words are not cut off.
        await waitForStopTail(stopRequestedAtMs, afterStopMs, controller.signal);
        if (generation !== recordingGeneration || controller.signal.aborted) throw new DOMException('Запись отменена', 'AbortError');
        const text = await invokeCommand(invoke, 'stop_claude_dictation', { runId: host.runId });
        const audioBlob = await audio;
        host.onRecordingReleased();
        if (generation !== recordingGeneration || controller.signal.aborted) return;
        await processRecordedAudio(audioBlob, generation, controller.signal, text);
      } catch (error) {
        await invokeCommand(invoke, 'cancel_claude_code', { runId: host.runId }).catch(console.warn);
        host.onRecordingReleased();
        if (generation === recordingGeneration && !controller.signal.aborted) setOverlayState('error', errorMessage(error));
      }
      return;
    }
    const stopRequestedAtMs = Date.now();
    const afterStopMs = normalizeAfterStopMs(config.scenarios.find(item => item.id === config.activeScenarioId)
      ?.steps.find(step => step.type === 'startRecording')?.afterStopMs);
    stopLiveTranscription();
    stopVolumeAnalysis();
    const generation = recordingGeneration;
    const workflowController = new AbortController();
    workflowAbortController?.abort();
    workflowAbortController = workflowController;
    setOverlayState('transcribing');

    if (nativeRecording && invoke) {
      mediaStream?.getTracks().forEach(track => track.stop());
      mediaStream = null;
      nativeRecording = false;
        try {
        const stopStartedAt = performance.now();
        captureStopPending = true;
        const wavBytes = await getAudioCapture().stop(stopRequestedAtMs, afterStopMs, workflowController.signal)
          .finally(() => { captureStopPending = false; host.onRecordingReleased(); });
        console.info('[recording-timing] stop-native', { generation, bytes: wavBytes.byteLength,
          elapsedMs: Math.round(performance.now() - stopStartedAt) });
        if (generation !== recordingGeneration) return;
        await processRecordedAudio(new Blob([wavBytes], { type: 'audio/wav' }), generation, workflowController.signal);
      } catch (err: unknown) {
        if (generation !== recordingGeneration) return;
        host.onRecordingReleased();
        console.error('Ошибка завершения записи:', err);
        setOverlayState('error', `Не удалось завершить запись: ${errorMessage(err)}`);
      }
      return;
    }

    if (!mediaRecorder) {
      host.onRecordingReleased();
      await completeOverlayProcess();
      return;
    }

    const recorder = mediaRecorder;
    const stream = mediaStream;
    try { await waitForStopTail(stopRequestedAtMs, afterStopMs, workflowController.signal); }
    catch (error) { if (workflowController.signal.aborted) return; throw error; }
    if (generation !== recordingGeneration) return;
    recorder.onstop = async () => {
      if (generation !== recordingGeneration) return;
      const mime = recorder.mimeType || 'audio/webm';
      host.onRecordingReleased();
      await processRecordedAudio(new Blob(recordedChunks, { type: mime }), generation, workflowController.signal);
      recordedChunks = [];
      mediaRecorder = null;
    };

    try {
      recorder.stop();
    } catch (e) {
      console.warn(e);
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  async function cancelScenario() {

    const wasActive = state !== 'idle' || startingRecording;
    stopClaudePolling();
    if (usesClaude() && invoke) {
      claudeRecording = false;
      // Invalidate callbacks before waiting for a native startup or stop to finish.
      recordingGeneration++;
      workflowAbortController?.abort();
      await invokeCommand(invoke, 'cancel_claude_code', { runId: host.runId }).catch(console.warn);
    }
    recordingGeneration++;
    startingRecording = false;
    pausePending = false;
    pauseAction?.(false);
    pauseAction = null;
    clearErrorAutoHideTimer();
    workflowAbortController?.abort();
    workflowAbortController = null;
    stopLiveTranscription();
    activeEditor?.cancel();
    activeEditor = null;
    stopVolumeAnalysis();
    if (nativeRecording && invoke) {
      nativeRecording = false;
        try {
        await getAudioCapture().cancel();
      } catch (err) {
        console.warn('Не удалось отменить запись:', err);
      }
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.ondataavailable = null;
      try { mediaRecorder.stop(); } catch (e) { console.warn(e); }
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }

    mediaRecorder = null;
    recordedChunks = [];
    recordingFragments = [];
    fragmentOffset = 0;
    if (state !== 'idle') setOverlayState('idle');
    await syncControlHotkeyScope().catch(console.warn);
    setLivePreviewText('');
    if (wasActive) void emitSound('cancel');
    if (overlayWindowController?.previewActive) {
      await overlayWindowController.previewWidth(null);
    }

    if (!captureStopPending) host.onRecordingReleased();
    await hideOverlay();
  }
  btnOpenMicSettings?.addEventListener('click', async () => {
    try {
      if (isAndroid) { await androidCall('microphoneSettings'); return; }
      if (!invoke) throw new Error('Открытие настроек доступно только в десктопном приложении.');
      await invokeCommand(invoke, 'open_microphone_settings');
    } catch (err) {
      console.error('Не удалось открыть настройки микрофона:', err);
      errorBanner.textContent = 'Откройте Параметры Windows → Конфиденциальность и безопасность → Микрофон.';
    }
  });

  async function toggleRecordingPause() {
    if (state !== 'recording' || pausePending) return;
    pausePending = true;
    editingPreviewPending = true;
    const generation = recordingGeneration;
    let sessionClosed = false;
    const action = new Promise<{ kind: 'action'; finish: boolean }>(resolve => {
      pauseAction = finish => resolve({ kind: 'action', finish });
    });
    try {
      const preparation = (async () => {
        let audioBlob: Blob;
        if (nativeRecording && invoke) {
          await getAudioCapture().pause();
          if (generation !== recordingGeneration) return null;
          stopLiveTranscription();
          stopVolumeAnalysis();
          setOverlayState('editing');
          const bytes = await getAudioCapture().snapshot();
          audioBlob = new Blob([bytes], { type: 'audio/wav' });
        } else if (mediaRecorder) {
          const recorder = mediaRecorder;
          recorder.pause();
          stopLiveTranscription();
          stopVolumeAnalysis();
          setOverlayState('editing');
          await new Promise<void>((resolve, reject) => {
            recorder.addEventListener('dataavailable', () => resolve(), { once: true });
            try { recorder.requestData(); } catch (error) { reject(error); }
          });
          audioBlob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
        } else return null;
        if (sessionClosed || generation !== recordingGeneration) return null;
        const buffer = await decodeAudio(await audioBlob.arrayBuffer());
        if (sessionClosed || generation !== recordingGeneration) return null;
        fragmentOffset = appendRecordingFragments(buffer, recordingFragments, fragmentOffset, {
          segments: liveTranscriber.segments,
          throughSeconds: liveTranscriber.committedThroughSeconds,
        });
        if (!recordingFragments.length) return { kind: 'action' as const, finish: false };
        activeEditor = createFragmentEditors(container.querySelector('.overlay-body')!, recordingFragments,
          (blob, signal) => transcriptionProvider.transcribe(blob, signal));
        const editor = activeEditor;
        void editor.loadedPreview.then(() => {
          if (activeEditor !== editor || generation !== recordingGeneration || state !== 'editing') return;
          editingPreviewPending = false;
          livePreview.classList.add('hidden');
        });
        return { kind: 'edited' as const, value: await activeEditor.result };
      })().catch(error => {
        if (sessionClosed || generation !== recordingGeneration) return null;
        if (state !== 'editing') throw error;
        activeEditor = null;
        errorBanner.textContent = `${errorMessage(error)} Можно продолжить или завершить запись.`;
        errorBanner.classList.remove('hidden');
        // Keep the recorded audio and paused controls usable after a network failure.
        return action;
      });
      const outcome = await Promise.race([preparation, action]);
      sessionClosed = true;
      pauseAction = null;
      if (generation !== recordingGeneration) return;
      if (!outcome || (outcome.kind === 'edited' && !outcome.value)) { await cancelScenario(); return; }
      let finish = outcome.kind === 'action' ? outcome.finish : outcome.value!.finish;
      if (outcome.kind === 'action') {
        activeEditor?.preserve();
        activeEditor?.cancel();
      } else {
        outcome.value!.fragments.forEach((result, index) => {
          recordingFragments[index].removedRanges = result.removedRanges;
          recordingFragments[index].transcript = result.transcript;
        });
      }
      activeEditor = null;
      liveTranscriber.replaceFinalizedTranscript(retainedPreviewSegments(
        recordingPreviewFragments(recordingFragments, liveTranscriber.segments)));
      liveTranscriber.resumeAfterPause(fragmentOffset, config.liveChunkOverlapSeconds);
      branchLiveTranscribers.forEach(({ step, engine }) => {
        engine.resumeAfterPause(fragmentOffset, step.transcription?.liveChunkOverlapSeconds ?? config.liveChunkOverlapSeconds);
      });
      if (finish) {
        setOverlayState('recording');
        pausePending = false;
        await finishRecording();
        return;
      }
      if (nativeRecording && invoke) await getAudioCapture().resume();
      else mediaRecorder?.resume();
      setOverlayState('recording');
      startLiveTranscription();
      if (nativeRecording && invoke) startNativeVolumeAnalysis();
      else if (mediaStream) startVolumeAnalysis(mediaStream);
    } catch (error: unknown) {
      if (generation !== recordingGeneration) return;
      stopLiveTranscription();
      activeEditor?.cancel(); activeEditor = null;
      if (nativeRecording && invoke) await getAudioCapture().cancel().catch(() => {});
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.ondataavailable = null;
        try { mediaRecorder.stop(); } catch {}
      }
      mediaRecorder = null; recordedChunks = []; nativeRecording = false;
      stopVolumeAnalysis();
      mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = null;
      setOverlayState('error', errorMessage(error));
    } finally {
      sessionClosed = true;
      if (generation === recordingGeneration) { pausePending = false; pauseAction = null; editingPreviewPending = false; }
    }
  }

  setOverlayState('idle');
  return {
    get state() { return state; },
    get starting() { return startingRecording; },
    get completed() { return completed; },
    get scenarioId() { return config.activeScenarioId; },
    start: startRecording,
    stop: finishRecording,
    pause() { return usesClaude() ? Promise.resolve() : state === 'editing' ? Promise.resolve(confirmPausedRecording(false)) : toggleRecordingPause(); },
    confirmStop() { confirmPausedRecording(true); },
    cancel: cancelScenario,
    abort() { workflowAbortController?.abort(); },
    showError(message: string) { setOverlayState('error', message, true); },
    restoreRecording(paused: boolean) {
      nativeRecording = true;
      setOverlayState('recording');
      if (paused) void toggleRecordingPause();
      else { startNativeVolumeAnalysis(); startLiveTranscription(true); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopClaudePolling();
      clearErrorAutoHideTimer();
      stopLiveTranscription();
      stopVolumeAnalysis();
      cleanups.forEach(cleanup => cleanup());
      reportExecutionProgress(undefined, false);
    },
  };
}
export type RecordingSession = ReturnType<typeof createRecordingSession>;
