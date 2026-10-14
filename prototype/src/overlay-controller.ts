import type { OverlayConfig, OverlayState } from './config';
import { loadConfig, SETTINGS_STORAGE_KEY } from './config';
import { playSound } from './audio';
import { createFragmentEditors, cutAudio } from './recording-editor';
import type { RecordingFragment } from './recording-editor';
import { enableWindowAutoSizing } from './auto-size';
import { indexedDbHistoryRepository } from './history-repository';
import { initLoggerForwarding } from './logger';
import { errorMessage } from './error-message';
import { transitionOverlayState } from './recording-state';
import { invokeCommand } from './tauri-commands';
import { createGeminiTextPostProcessor, createGroqTranscriptionProvider } from './provider-adapters';
import { createTauriAudioCapture, createTauriTextOutput } from './tauri-adapters';
import type { AudioCapturePort, TextOutputPort } from './ports';
import { createLiveTranscriber, type LiveTranscriber } from './live-transcription';
import { createOverlayWindowController, type OverlayWindowController } from './overlay-window';
import { getScenarioReadinessError, runRecordingWorkflow } from './recording-workflow';
import { isBrowserOverlayPreviewEnabled, listenForOverlayWidthPreview } from './browser-overlay-preview';
import { isAndroid, isAndroidBubble, androidCall, bubbleInvoke } from './android-runtime';
import { decodeAudio } from './audio-decoding';
import { recordingPreviewFragments, retainedPreviewSegments } from './recording-transcript';

initLoggerForwarding('overlay');

let overlayWindowController: OverlayWindowController | null = null;

// Окно оверлея адаптивно подстраивает свои размеры под контент
const overlayAutoSizer = enableWindowAutoSizing('overlay-container', {
  nativeResizeCommand: 'resize_overlay_to_content',
  resizeDelayMs: 16,
  keepCenterOnResize: () => overlayWindowController?.preserveCenterOnResize ?? false,
  onResizeSettled: () => overlayWindowController?.finishPreviewResize(),
});

// Tauri API
let invoke: typeof import('@tauri-apps/api/core').invoke | null = null;
let audioCapture: AudioCapturePort | null = null;
let textOutput: TextOutputPort | null = null;
let overlayWindowInitialized = false;
let queuedOverlayWidthPreview: number | null | undefined;

function initializeBrowserWindow() {
  overlayWindowController?.initializeBrowser();
}

async function initializeAndroidRuntime() {
  window.addEventListener('android-runtime-event', async event => {
    const { action, text } = (event as CustomEvent<{ action: string; text: string }>).detail;
    if (action === 'record-hotkey') {
      if (state === 'recording') await finishRecording();
      else if (state === 'editing') confirmPausedRecording(true);
      else if (state === 'idle' || state === 'error') await startRecording();
    } else if (action === 'pause-hotkey') {
      if (state === 'recording') await toggleRecordingPause();
      else if (state === 'editing') confirmPausedRecording(false);
    } else if (action === 'cancel-hotkey') await cancelScenario();
    else if (action === 'native-error') { await cancelScenario(); setOverlayState('error', text, true); }
  });
  const recording = await androidCall<{ recording: boolean; paused: boolean }>('recordingStatus');
  if (recording.recording) {
    nativeRecording = true;
    setOverlayState('recording');
    if (recording.paused) void toggleRecordingPause();
    else { startNativeVolumeAnalysis(); startLiveTranscription(true); }
  }
  await androidCall('frontendReady');
  window.dispatchEvent(new Event('android-bubble-ready'));
}

if (isAndroidBubble) {
  invoke = bubbleInvoke;
  audioCapture = createTauriAudioCapture(bubbleInvoke);
  textOutput = createTauriTextOutput(bubbleInvoke);
  // Wait until the rest of this module has initialized its state and DOM references.
  queueMicrotask(() => { void initializeAndroidRuntime().catch(error => setOverlayState('error', errorMessage(error))); });
} else try {
  Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ]).then(async ([coreMod, winMod, eventMod]) => {
    invoke = coreMod.invoke;
    audioCapture = createTauriAudioCapture(coreMod.invoke);
    textOutput = createTauriTextOutput(coreMod.invoke);
    if (isAndroid) {
      await initializeAndroidRuntime();
      return;
    }
    const nativeWindow = winMod.getCurrentWindow();
    await eventMod.listen('show-overlay-content', () => {
      container.classList.remove('overlay-content-hidden');
    });
    await eventMod.listen<number | null>('overlay-width-preview', async (event) => {
      if (!overlayWindowInitialized) {
        queuedOverlayWidthPreview = event.payload;
        return;
      }
      await overlayWindowController?.previewWidth(event.payload);
    });
    await eventMod.listen<boolean>('overlay-monitor-movement-setting', event => {
      config.overlayFollowCursorMonitor = event.payload;
      overlayWindowController?.syncMonitorTracking();
      if (event.payload && state !== 'idle') void overlayWindowController?.moveToCursorMonitor();
    });
    try {
      await nativeWindow.hide();
    } catch (e) {}
    await overlayWindowController?.initialize(nativeWindow);
    overlayWindowInitialized = true;
    if (queuedOverlayWidthPreview !== undefined) {
      const pendingPreview = queuedOverlayWidthPreview;
      queuedOverlayWidthPreview = undefined;
      await overlayWindowController?.previewWidth(pendingPreview);
    }
    eventMod.listen('record-hotkey', async () => {
      if (state === 'recording') await finishRecording();
      else if (state === 'editing') confirmPausedRecording(true);
      else if (state === 'idle' || state === 'error') await startRecording();
    });
    eventMod.listen('pause-hotkey', async () => {
      if (state === 'recording') await toggleRecordingPause();
      else if (state === 'editing') confirmPausedRecording(false);
    });
    eventMod.listen('cancel-hotkey', async () => {
      await cancelScenario();
    });
  }).catch(() => {
    console.log('Браузерный режим без Tauri');
    initializeBrowserWindow();
  });
} catch (e) {
  initializeBrowserWindow();
}

// Элементы интерфейса
const container = document.getElementById('overlay-container') as HTMLElement;
const dragHandle = document.getElementById('overlay-drag-handle') as HTMLElement;
const statusText = document.getElementById('overlay-status-text') as HTMLElement;
const livePreview = document.getElementById('live-preview') as HTMLElement;
const errorBanner = document.getElementById('error-banner') as HTMLElement;
const overlayWidthSkeletonPreview = document.getElementById('overlay-width-skeleton-preview') as HTMLElement;
const btnOpenMicSettings = document.getElementById('btn-open-mic-settings') as HTMLButtonElement | null;
const waveformBars = Array.from(document.querySelectorAll('#waveform .bar')) as HTMLElement[];
overlayWindowController = createOverlayWindowController({
  container,
  dragHandle,
  skeletonPreview: overlayWidthSkeletonPreview,
  getConfig: () => config,
  getState: () => state,
  getInvoke: () => invoke,
  settleResize: async () => { await overlayAutoSizer?.resizeNow(); },
});
if (isAndroid) overlayWindowController = null;
if (isBrowserOverlayPreviewEnabled()) {
  container.classList.remove('overlay-content-hidden');
  listenForOverlayWidthPreview(percent => { void overlayWindowController?.previewWidth(percent); });
}

let lastPreviewText = '';
let previewHasContent = false;
function setLivePreviewText(text: string, structured = false) {
  lastPreviewText = text;
  const fragments = structured ? recordingPreviewFragments(recordingFragments, liveTranscriber.segments) : [];
  previewHasContent = fragments.length > 0 || !!text.trim();
  window.dispatchEvent(new CustomEvent('overlay-transcription-preview', { detail: { text, fragments } }));
  livePreview.classList.toggle('hidden', state === 'editing' || !previewHasContent);
  if (isAndroid && invoke) void androidCall('updateState', { state, status: statusText.textContent || '', text }).catch(console.warn);
}

let state: OverlayState = 'idle';
let config: OverlayConfig = loadConfig();
const transcriptionProvider = createGroqTranscriptionProvider(() => ({
  apiKey: config.groqApiKey,
  model: config.groqModel,
  prompt: config.groqPrompt,
  temperature: config.groqTemperature,
  language: config.groqLanguage,
}));
const textPostProcessor = createGeminiTextPostProcessor(() => ({
  apiKey: config.geminiApiKey,
  model: config.geminiModel,
  instructionPrompt: config.geminiPrompt,
  generationConfig: config.scenarios.find(scenario => scenario.id === config.activeScenarioId)
    ?.steps.find(step => step.type === 'postprocess')?.postprocessing?.generationConfig,
}));

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
let workflowAbortController: AbortController | null = null;
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
});

window.addEventListener('storage', event => {
  if (event.key !== SETTINGS_STORAGE_KEY) return;
  const positionWasSaved = config.position !== null;
  config = loadConfig();
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
}

function suspendLiveTranscription() {
  liveTranscriber.suspend();
}

function startLiveTranscription(reset = false) {
  liveTranscriber.start(reset);
}

function updateVolumeIndicator(rms: number) {
  liveTranscriber.observeSpeechLevel(rms);
  const rawLevel = Math.max(0, Math.min(1, (rms - 0.004) * 82));
  smoothedVolumeLevel += (rawLevel - smoothedVolumeLevel) * (rawLevel > smoothedVolumeLevel ? 0.55 : 0.22);
  const normalized = smoothedVolumeLevel;
  container.style.setProperty('--volume-scale', (1 + normalized * 0.8).toFixed(2));
  container.style.setProperty('--volume-glow', `${Math.round(normalized * 14)}px`);
  container.classList.toggle('audio-active', normalized > 0.04);
  waveformBars.forEach((bar, idx) => {
    const factor = 1 - Math.abs(idx - (waveformBars.length - 1) / 2) * 0.16;
    bar.style.height = `${Math.max(3, Math.min(12, Math.round(3 + normalized * 9 * factor)))}px`;
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
      if (invoke) {
        const rms = await getAudioCapture().inputLevel();
        if (state === 'recording') updateVolumeIndicator(rms);
      }
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
  waveformBars.forEach((bar) => { bar.style.height = ''; });
}

function emitSound(event: 'start_record' | 'insert_text' | 'cancel' | 'error'): Promise<void> {
  config = loadConfig();
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

window.addEventListener('storage', event => {
  if (event.key !== SETTINGS_STORAGE_KEY && event.key !== null) return;
  config = loadConfig();
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
function setOverlayState(newState: OverlayState, errorMsg?: string, showMicSettings = false) {
  clearErrorAutoHideTimer();
  try {
    state = transitionOverlayState(state, newState);
  } catch (error) {
    console.error(errorMessage(error));
    return;
  }
  overlayWindowController?.syncMonitorTracking();
  container.classList.remove('recording', 'has-error');
  container.classList.toggle('overlay-content-hidden', state === 'idle');
  errorBanner.classList.add('hidden');
  if (btnOpenMicSettings) btnOpenMicSettings.classList.toggle('hidden', !showMicSettings);

  container.classList.toggle('editing', state === 'editing');
  livePreview.classList.toggle('hidden', state === 'editing' || !previewHasContent);
  document.getElementById('waveform')?.classList.toggle('hidden', state === 'editing');
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
  if (isAndroid) {
    document.body.dataset.recordingState = state;
    window.dispatchEvent(new CustomEvent('android-ui-state', { detail: state }));
    void androidCall('updateState', { state, status: errorMsg || statusText.textContent || '', text: lastPreviewText }).catch(console.warn);
  }
}

function describeMicrophoneError(error: unknown): { message: string; showSettings: boolean } {
  const details = error as { name?: string; message?: string } | null;
  const name = details?.name || '';
  const message = details?.message || '';

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
  setLivePreviewText('');
  setOverlayState('idle');
  if (isAndroid) await androidCall('stopRecordingService').catch(console.warn);
  await hideOverlay();
}
async function hideOverlay() {
  if (isAndroid) { container.classList.add('overlay-content-hidden'); return; }
  if (overlayWindowController?.previewActive) return;
  if (invoke) {
    try {
      await invokeCommand(invoke, 'hide_overlay');
      return;
    } catch (error) {
      console.warn('Нативная команда скрытия оверлея не сработала:', error);
    }
  }

  if (overlayWindowController?.window) {
    try {
      await overlayWindowController.window.hide();
      return;
    } catch (error) {
      console.warn('Не удалось скрыть окно оверлея:', error);
    }
  }
  container.classList.add('hidden');
}

async function startRecording() {
  if (state === 'recording' || startingRecording) return;

  startingRecording = true;
  stopLiveTranscription();
  config = loadConfig();
  recordingGeneration++;
  const generation = recordingGeneration;
  pausePending = false;
  clearErrorAutoHideTimer();
  recordedChunks = [];
  recordingFragments = [];
  fragmentOffset = 0;
  setLivePreviewText('');
  await overlayAutoSizer?.resizeNow();
  if (generation !== recordingGeneration) return;
  await overlayWindowController?.restoreSavedPosition();
  if (generation !== recordingGeneration) return;

  // Описание приложения.md:141-143:
  // Некоторые этапы в сценарии содержат готовность. Если не готов, то ошибка сразу при начале сценария
  const readinessError = getScenarioReadinessError(config);
  if (readinessError) {
    startingRecording = false;
    container.classList.remove('overlay-content-hidden');
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

  if (config.overlayFollowCursorMonitor) {
    await overlayWindowController?.moveToCursorMonitor();
  }
  if (generation !== recordingGeneration) return;
  container.classList.remove('overlay-content-hidden');
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
    if (invoke) await getAudioCapture().cancel().catch(() => {});
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

async function processRecordedAudio(audioBlob: Blob, generation: number, signal: AbortSignal) {
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
  const result = await runRecordingWorkflow(audioBlob, {
    history: indexedDbHistoryRepository,
    transcription: transcriptionProvider,
    postProcessor: textPostProcessor,
    output,
    getSettings: () => config,
    fragments: recordingFragments,
    getFragmentOffset: () => fragmentOffset,
    setFragmentOffset: offset => { fragmentOffset = offset; },
    snapshotFragments: snapshotHistoryFragments,
    decodeAudio: async blob => decodeAudio(await blob.arrayBuffer()),
    cut: cutAudio,
    onStage: stage => { statusText.textContent = stage; },
    onText: text => {
      setLivePreviewText(text);
      if (isAndroid) void androidCall('setOutputText', {text}).catch(console.warn);
    },
    onInsertSound: () => { void emitSound('insert_text'); },
    signal,
  });
  if (generation !== recordingGeneration || signal.aborted || result.status === 'cancelled') return;
  if (workflowAbortController?.signal === signal) workflowAbortController = null;
  if (result.status === 'error') {
    setOverlayState('error', result.message);
    return;
  }
  await completeOverlayProcess();
}
async function finishRecording() {
  if (state !== 'recording' || pausePending) return;
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
      const wavBytes = await getAudioCapture().stop();
      if (generation !== recordingGeneration) return;
      await processRecordedAudio(new Blob([wavBytes], { type: 'audio/wav' }), generation, workflowController.signal);
    } catch (err: unknown) {
      if (generation !== recordingGeneration) return;
      console.error('Ошибка завершения записи:', err);
      setOverlayState('error', `Не удалось завершить запись: ${errorMessage(err)}`);
    }
    return;
  }

  if (!mediaRecorder) {
    await completeOverlayProcess();
    return;
  }

  const recorder = mediaRecorder;
  const stream = mediaStream;
  recorder.onstop = async () => {
    if (generation !== recordingGeneration) return;
    const mime = recorder.mimeType || 'audio/webm';
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
  setLivePreviewText('');
  if (wasActive) void emitSound('cancel');
  if (overlayWindowController?.previewActive) {
    await overlayWindowController.previewWidth(null);
  }
  if (isAndroid) await androidCall('stopRecordingService').catch(console.warn);
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
        suspendLiveTranscription();
        stopVolumeAnalysis();
        setOverlayState('editing');
        const bytes = await getAudioCapture().snapshot();
        audioBlob = new Blob([bytes], { type: 'audio/wav' });
      } else if (mediaRecorder) {
        const recorder = mediaRecorder;
        recorder.pause();
        suspendLiveTranscription();
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
      if (buffer.duration - fragmentOffset > .01) {
        recordingFragments.push({
          audioBlob: cutAudio(buffer, [{ start: fragmentOffset, end: buffer.duration }]),
          start: fragmentOffset, end: buffer.duration, transcript: null, removedRanges: [],
        });
        fragmentOffset = buffer.duration;
      }
      if (!recordingFragments.length) return { kind: 'action' as const, finish: false };
      activeEditor = createFragmentEditors(container.querySelector('.overlay-body')!, recordingFragments,
        (blob, signal) => transcriptionProvider.transcribe(blob, signal));
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
    if (generation === recordingGeneration) { pausePending = false; pauseAction = null; }
  }
}
function matchesHotkey(e: KeyboardEvent, configuredKey: string): boolean {
  if (!configuredKey) return false;
  const parts = configuredKey.split('+');
  const mainKey = parts[parts.length - 1];
  const requiresCtrl = parts.includes('Control');
  const requiresAlt = parts.includes('Alt');
  const requiresShift = parts.includes('Shift');
  const requiresMeta = parts.includes('Meta');

  if (e.ctrlKey !== requiresCtrl) return false;
  if (e.altKey !== requiresAlt) return false;
  if (e.shiftKey !== requiresShift) return false;
  if (e.metaKey !== requiresMeta) return false;

  return e.code === mainKey || e.key === mainKey || (mainKey === 'Digit1' && (e.code === 'Digit1' || e.key === '1')) || (mainKey === 'Digit2' && (e.code === 'Digit2' || e.key === '2'));
}

window.addEventListener('keydown', (e) => {
  // В Tauri эти клавиши обрабатываются глобально Rust-плагином.
  if (invoke) return;
  const keys = loadConfig();
  if (matchesHotkey(e, keys.hotkeyCancel || 'Escape')) {
    e.preventDefault();
    void cancelScenario();
    return;
  }
  if (state === 'editing') {
    if (matchesHotkey(e, keys.hotkeyPause)) { e.preventDefault(); confirmPausedRecording(false); }
    else if (matchesHotkey(e, keys.hotkeyRecord)) { e.preventDefault(); confirmPausedRecording(true); }
    return;
  }
  const currentConfig = keys;
  const pauseKey = currentConfig.hotkeyPause || 'Control+Digit2';
  const resumeKey = currentConfig.hotkeyResume || 'Control+Digit2';

  if ((matchesHotkey(e, pauseKey) || matchesHotkey(e, resumeKey)) && state === 'recording') {
    e.preventDefault();
    void toggleRecordingPause();
  }
});

setOverlayState('idle');
