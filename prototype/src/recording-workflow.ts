import { getSpeechMarks, type SpeechMark } from './speech-playback-control';
import type { AppSettings } from './config';
import type { HistoryRepository, TextOutputPort, TextPostProcessor, TranscriptionProvider } from './ports';
import type { RecordingFragment, TimeRange } from './recording-editor';
import { appendRecordingFragments, combineFragments, mergeRanges, retainedRanges } from './recording-editor';
import { errorMessage } from './error-message';
import { fitTranscriptToAudio } from './transcript-timing';
import { createDefaultScenario, getScenarioStepContract, isTriggerStep, normalizeClipboardHistoryLevel, validateScenario, type Scenario } from './scenario';
import type { HistoryStep, HistoryStepStatus } from './history-db';
import type { TranscriptSegment } from './groq';
import type { OverlayStepStatus } from './OverlaySteps';
import { hasScenarioBranches, walkScenarioSteps } from './scenario-tree';
import { runScenarioTree } from './scenario-tree-workflow';
import { createWorkflowHistory } from './workflow-history';
import { googleCloudConfigurationError } from './google-cloud/settings';
import { geminiTranscriptionConfigurationError } from './gemini-transcription/settings';

type ScenarioWorkflowSettings = Pick<AppSettings, 'provider' | 'groqApiKey' | 'postProcessProvider' | 'geminiApiKey'>
  & Partial<Pick<AppSettings, 'scenarios' | 'activeScenarioId' | 'postProcessEnabled' | 'autoPasteActiveWindow' | 'geminiPrompt' | 'googleCloud' | 'geminiTranscription'>>;
type WorkflowSettings = Pick<AppSettings, 'historyMaxItems'> & ScenarioWorkflowSettings;

export interface RecordingWorkflowDependencies {
  initialText?: string;
  history: HistoryRepository;
  transcription: TranscriptionProvider;
  postProcessor: TextPostProcessor;
  transcriptionForStep?(step: import('./scenario').ScenarioStep): TranscriptionProvider;
  postProcessorForStep?(step: import('./scenario').ScenarioStep): TextPostProcessor;
  output: TextOutputPort;
  getSettings(): WorkflowSettings;
  fragments: RecordingFragment[];
  liveTranscript?: { segments: readonly TranscriptSegment[]; throughSeconds: number };
  liveTranscriptForStep?(step: import('./scenario').ScenarioStep): { segments: readonly TranscriptSegment[]; throughSeconds: number } | undefined;
  getFragmentOffset(): number;
  setFragmentOffset(offset: number): void;
  snapshotFragments(): Parameters<HistoryRepository['update']>[1]['fragments'];
  decodeAudio(blob: Blob): Promise<AudioBuffer>;
  cut(buffer: AudioBuffer, ranges: TimeRange[]): Blob;
  onStage(stage: string): void;
  onSteps?(steps: readonly OverlayStepStatus[]): void;
  onStepStatus?(step: { id: string; type: import('./scenario').ScenarioStepType; status: 'running' | 'success' | 'error' }): void;
  onText(text: string): void;
  onInsertSound?(): void;
  speech?: { synthesize(text: string, signal?: AbortSignal, settings?: import('./speech-settings').SystemSpeechSettings): Promise<Blob>; play(audio: Blob, signal?: AbortSignal, settings?: import('./speech-settings').SystemSpeechSettings): Promise<void>;
    // Synthesizes and plays at once (streaming providers); returns the whole audio.
    // `onAudio` gets it once received, so history keeps it even if playback is stopped.
    speak?(text: string, signal?: AbortSignal, onAudio?: (audio: Blob) => void): Promise<Blob> };
  speechForStep?(step: import('./scenario').ScenarioStep): NonNullable<RecordingWorkflowDependencies['speech']>;
  runAction?<T>(step: import('./scenario').ScenarioStep, operation: () => Promise<T>): Promise<T>;
  skipActions?(stepIds: readonly string[]): void;
  signal?: AbortSignal;
}

export type RecordingWorkflowResult =
  | { status: 'success'; text: string }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };

export function getScenarioReadinessError(
  settings: ScenarioWorkflowSettings,
): string | null {
  const scenario = getActiveScenario(settings);
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return scenarioError;
  if (hasScenarioBranches(scenario.steps)) {
    for (const step of walkScenarioSteps(scenario.steps)) {
      if (!step.enabled) continue;
      if (step.type === 'transcribe') {
        const provider = step.transcription?.provider ?? settings.provider;
        const key = step.transcription?.apiKey ?? settings.groqApiKey;
        if (provider === 'none') return 'Провайдер транскрибации не выбран в настройках.';
        if (provider === 'google-cloud') {
          const error = googleCloudConfigurationError(step.transcription?.googleCloud ?? settings.googleCloud);
          if (error) return error;
        } else if (provider === 'gemini') {
          const error = geminiTranscriptionConfigurationError(step.transcription?.geminiTranscription ?? settings.geminiTranscription);
          if (error) return error;
        } else if (!key?.trim()) return 'Провайдер Groq не готов: не указан API ключ.';
      }
      if (step.type === 'postprocess') {
        const provider = step.postprocessing?.provider ?? settings.postProcessProvider;
        const key = step.postprocessing?.apiKey ?? settings.geminiApiKey;
        if (provider === 'none') return 'Провайдер пост-процессинга не выбран в настройках.';
        if (!key?.trim()) return 'Провайдер Gemini не готов: не указан API ключ.';
        if (!(step.postprocessing?.prompt ?? settings.geminiPrompt)?.trim()) return 'Для постобработки укажите промпт преобразования.';
      }
    }
    return null;
  }

  // Описание приложения.md:141-143:
  // Некоторые этапы в сценарии содержат готовность. Если не готов, то ошибка сразу при начале сценария:
  // - трансрибация текста - по готовности выбранного провайдера
  if (scenario.steps.some(step => step.enabled && step.type === 'transcribe') && settings.provider === 'none') {
    return 'Провайдер транскрибации не выбран в настройках.';
  }
  if (scenario.steps.some(step => step.enabled && step.type === 'transcribe') && settings.provider === 'groq' && !settings.groqApiKey?.trim()) {
    return 'Провайдер Groq не готов: не указан API ключ.';
  }

  // - пост-процессинг - по готовности выбранного провайдера
  if (scenario.steps.some(step => step.enabled && step.type === 'transcribe') && settings.provider === 'gemini') {
    const error = geminiTranscriptionConfigurationError(scenario.steps.find(step => step.type === 'transcribe')?.transcription?.geminiTranscription ?? settings.geminiTranscription);
    if (error) return error;
  }
  if (scenario.steps.some(step => step.enabled && step.type === 'transcribe') && settings.provider === 'google-cloud') {
    const error = googleCloudConfigurationError(scenario.steps.find(step => step.type === 'transcribe')?.transcription?.googleCloud ?? settings.googleCloud);
    if (error) return error;
  }
  if (scenario.steps.some(step => step.enabled && step.type === 'postprocess')) {
    if (settings.postProcessProvider === 'none') {
      return 'Провайдер пост-процессинга не выбран в настройках.';
    }
    if (settings.postProcessProvider === 'gemini' && !settings.geminiApiKey?.trim()) {
      return 'Провайдер Gemini не готов: не указан API ключ.';
    }
    if (scenario.steps.some(step => step.enabled && step.type === 'postprocess'
      && !(step.postprocessing?.prompt ?? settings.geminiPrompt)?.trim())) {
      return 'Для постобработки укажите промпт преобразования.';
    }
  }

  return null;
}

export async function runRecordingWorkflow(
  audioBlob: Blob,
  dependencies: RecordingWorkflowDependencies,
): Promise<RecordingWorkflowResult> {
  const signal = dependencies.signal;
  const runAction = <T>(step: import('./scenario').ScenarioStep, operation: () => Promise<T>) =>
    dependencies.runAction ? dependencies.runAction(step, operation) : operation();
  if (signal?.aborted) return { status: 'cancelled' };
  const settings = dependencies.getSettings();
  const scenario = getActiveScenario(settings);

  const readinessError = getScenarioReadinessError(settings);
  if (readinessError) {
    return { status: 'error', message: readinessError };
  }

  if (dependencies.initialText === undefined && audioBlob.size < 1000) {
    return { status: 'error', message: 'Запись слишком короткая. Попробуйте говорить чуть дольше.' };
  }
  if (hasScenarioBranches(scenario.steps)) {
    return runScenarioTree(audioBlob, scenario, dependencies, runRecordingWorkflow);
  }

  const historySteps: HistoryStep[] = scenario.steps.map(step => ({
    id: step.id,
    type: step.type,
    title: getScenarioStepContract(step.type).title,
    status: !step.enabled ? 'skipped' : isTriggerStep(step) ? 'success' : 'pending',
    ...((step.type === 'claudeCode' || step.type === 'selectedText') && dependencies.initialText !== undefined ? { text: dependencies.initialText } : {}),
  }));
  const transcriptionIndex = scenario.steps.findIndex(step => step.type === 'transcribe' || step.type === 'claudeCode' || step.type === 'selectedText');
  let historyEntryId: string | null = null;
  const historyStartedAt = performance.now();
  dependencies.onStage('Сохранение записи...');
  try {
    const entry = await dependencies.history.add(
      // Claude Code delivers text, with the app's parallel recording when there is one.
      { ...(audioBlob.size ? { audioBlob } : {}), ...(dependencies.initialText !== undefined ? { text: dependencies.initialText } : {}),
        status: 'recorded', scenarioName: scenario.name, steps: historySteps },
      dependencies.getSettings().historyMaxItems || 10,
    );
    historyEntryId = entry.id;
  } catch (error) {
    console.warn('Не удалось сохранить аудиозапись в IndexedDB:', error);
  } finally {
    console.info('[recording-timing] history-add', { bytes: audioBlob.size, elapsedMs: Math.round(performance.now() - historyStartedAt) });
  }
  if (signal?.aborted) return { status: 'cancelled' };

  const historyWrites = createWorkflowHistory(dependencies.history, historyEntryId);
  // Enqueue each result immediately; only completion waits for storage.
  const save = (updates: Parameters<HistoryRepository['update']>[1]) => {
    void historyWrites.update(updates).catch(console.warn);
  };
  try {
    let displayedActions: number[] = [];
    let displayedText = '';
    const updateDisplayedActions = () => {
      dependencies.onSteps?.(displayedActions.map(index => {
        const step = historySteps[index];
        return { id: step.id, title: step.title,
          status: step.status === 'running' || step.status === 'success' || step.status === 'error' ? step.status : 'pending',
          // The overlay hides the text by the step's current flag (applyOverlayTextFlags).
          error: step.errorMessage, body: step.status !== 'pending' ? displayedText : undefined };
      }));
    };
    const persistStepStatus = (index: number, status: HistoryStepStatus, errorMessage?: string,
      updates: Parameters<HistoryRepository['update']>[1] = {}) => {
      if (index < 0) return;
      historySteps[index] = { ...historySteps[index], status, errorMessage };
      if (status === 'running' || status === 'success' || status === 'error') {
        dependencies.onStepStatus?.({ id: scenario.steps[index].id, type: scenario.steps[index].type, status });
      }
      if (displayedActions.includes(index)) updateDisplayedActions();
      save({ ...updates, steps: historySteps.slice() });
    };

    let transcribedText = dependencies.initialText ?? '';
    let allRemoved: TimeRange[] = [];
    try {
      if (dependencies.initialText !== undefined) {
        if (!transcribedText.trim()) throw new Error(scenario.steps[transcriptionIndex]?.type === 'selectedText' ? 'Нет выделенного текста.' : 'Речь не распознана.');
        persistStepStatus(transcriptionIndex, 'success', undefined, { text: transcribedText, status: 'transcribed' });
      } else {
      dependencies.onStage('Подготовка аудио...');
      const decodeStartedAt = performance.now();
      const buffer = await dependencies.decodeAudio(audioBlob);
      console.info('[recording-timing] decode', { audioSeconds: buffer.duration, sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels, elapsedMs: Math.round(performance.now() - decodeStartedAt) });
      if (signal?.aborted) return { status: 'cancelled' };
      persistStepStatus(transcriptionIndex, 'running');
      if (scenario.steps[transcriptionIndex]?.transcription?.retranscribeFullRecording) {
        const removedRanges = mergeRanges(dependencies.fragments.flatMap(fragment => fragment.removedRanges.map(range => ({
          start: fragment.start + range.start, end: fragment.start + range.end,
        }))), buffer.duration);
        dependencies.onStage('Распознавание всей записи...');
        const transcript = fitTranscriptToAudio(
          await dependencies.transcription.transcribe(audioBlob, signal), buffer.duration);
        if (signal?.aborted) return { status: 'cancelled' };
        dependencies.fragments.splice(0, dependencies.fragments.length, {
          audioBlob, start: 0, end: buffer.duration, transcript, removedRanges,
        });
        dependencies.setFragmentOffset(buffer.duration);
      } else {
        dependencies.setFragmentOffset(appendRecordingFragments(buffer, dependencies.fragments,
          dependencies.getFragmentOffset(), dependencies.liveTranscript, dependencies.cut));
      }

      if (historyEntryId) save({
        originalAudioBlob: audioBlob,
        fragments: dependencies.snapshotFragments(),
      });

      for (const fragment of dependencies.fragments) {
        if (signal?.aborted) return { status: 'cancelled' };
        if (!fragment.transcript) {
          dependencies.onStage('Распознавание речи...');
          const startedAt = performance.now();
          try {
            fragment.transcript = fitTranscriptToAudio(
              await dependencies.transcription.transcribe(fragment.audioBlob, signal), fragment.end - fragment.start);
          } finally {
            console.info(`Распознавание: аудио ${(fragment.end - fragment.start).toFixed(1)} с, ожидание ${Math.round(performance.now() - startedAt)} мс`);
          }
          if (signal?.aborted) return { status: 'cancelled' };
          if (historyEntryId) save({ fragments: dependencies.snapshotFragments() });
        }
      }

      const combined = combineFragments(dependencies.fragments);
      transcribedText = combined.text;
      allRemoved = mergeRanges(combined.removedRanges, buffer.duration);
      const editedAudio = allRemoved.length
        ? dependencies.cut(buffer, retainedRanges(allRemoved, buffer.duration))
        : audioBlob;
      if (historyEntryId) save({
        originalAudioBlob: audioBlob,
        audioBlob: editedAudio,
        text: transcribedText,
        fragments: dependencies.snapshotFragments(),
        segments: combined.segments,
        removedRanges: allRemoved,
        status: !transcribedText && allRemoved.length ? 'success' : 'transcribed',
        steps: historySteps.map((step, index) => index === transcriptionIndex ? { ...step, status: 'success' } : step),
      });
      if (transcriptionIndex >= 0) historySteps[transcriptionIndex] = { ...historySteps[transcriptionIndex], status: 'success', errorMessage: undefined };
      if (transcriptionIndex >= 0) dependencies.onStepStatus?.({ ...scenario.steps[transcriptionIndex], status: 'success' });
      if (!transcribedText && !allRemoved.length) throw new Error('Речь не распознана. Попробуйте ещё раз.');
      }
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      const message = errorMessage(error);
      if (transcriptionIndex >= 0) historySteps[transcriptionIndex] = { ...historySteps[transcriptionIndex], status: 'error', errorMessage: message };
      if (transcriptionIndex >= 0) dependencies.onStepStatus?.({ ...scenario.steps[transcriptionIndex], status: 'error' });
      if (historyEntryId) save({
        status: 'error', errorStep: 'Транскрибация текста', errorMessage: message,
        steps: historySteps.slice(),
      });
      return { status: 'error', message };
    }

    if (signal?.aborted) return { status: 'cancelled' };
    // A selection is not a recognition result: it is shown only by the steps that ask for it.
    if (scenario.steps[transcriptionIndex]?.type !== 'selectedText') dependencies.onText(transcribedText);
    if (!transcribedText && allRemoved.length) {
      if (historyEntryId) save({ status: 'success' });
      return { status: 'success', text: '' };
    }

    let finalText = transcribedText;
    let currentAudio = audioBlob;
    const actionErrors: string[] = [];
    for (let cursor = transcriptionIndex + 1; cursor < scenario.steps.length; cursor++) {
      const step = scenario.steps[cursor];
      if (!step.enabled) continue;
      const stepIndex = cursor;
      if (step.parallelGroup && getScenarioStepContract(step.type).category === 'action') {
        let end = cursor + 1;
        while (end < scenario.steps.length && scenario.steps[end].parallelGroup === step.parallelGroup
          && getScenarioStepContract(scenario.steps[end].type).category === 'action') end++;
        const indices = Array.from({ length: end - cursor }, (_, offset) => cursor + offset)
          .filter(index => scenario.steps[index].enabled);
        if (signal?.aborted) return { status: 'cancelled' };
        displayedActions = indices;
        displayedText = finalText;
        // Publish the whole group before any side effect starts or history I/O is awaited.
        for (const index of indices) historySteps[index] = { ...historySteps[index], status: 'running' };
        for (const index of indices) dependencies.onStepStatus?.({ ...scenario.steps[index], status: 'running' });
        updateDisplayedActions();
        const inputText = finalText;
        const saveGroup = () => {
          save({ steps: historySteps.slice() });
        };
        saveGroup();
        await Promise.all(indices.map(async index => {
          const action = scenario.steps[index];
          try {
            if (signal?.aborted) return;
            dependencies.onStage(action.type === 'paste' ? 'Вставка в активное поле...' : 'Буфер обмена...');
            if (action.type === 'copy') await runAction(action, () => dependencies.output.copy(inputText, normalizeClipboardHistoryLevel(action.clipboardHistoryLevel)));
            else if (action.type === 'paste') {
              await runAction(action, () => dependencies.output.paste(inputText, action.returnFocusToOriginalWindow === true));
              if (!signal?.aborted) dependencies.onInsertSound?.();
            }
            if (signal?.aborted) return;
            historySteps[index] = { ...historySteps[index], status: 'success', errorMessage: undefined };
            dependencies.onStepStatus?.({ ...action, status: 'success' });
          } catch (error) {
            if (signal?.aborted) return;
            const message = errorMessage(error);
            historySteps[index] = { ...historySteps[index], status: 'error', errorMessage: message };
            actionErrors.push(`${getScenarioStepContract(action.type).title}: ${message}`);
            dependencies.onStepStatus?.({ ...action, status: 'error' });
          }
          updateDisplayedActions();
          saveGroup();
        }));
        if (signal?.aborted) return { status: 'cancelled' };
        cursor = end - 1;
        continue;
      }
      if (getScenarioStepContract(step.type).category === 'action') {
        if (!displayedActions.includes(stepIndex)) {
          displayedText = finalText;
          displayedActions = [];
          for (let index = stepIndex; index < scenario.steps.length; index++) {
            if (getScenarioStepContract(scenario.steps[index].type).category !== 'action') break;
            if (scenario.steps[index].enabled) displayedActions.push(index);
          }
          updateDisplayedActions();
        }
      } else {
        // Speech offers the text it reads; the overlay shows it by the step's flag.
        const speech = step.type === 'speak';
        if (speech) displayedText = finalText;
        displayedActions = speech ? [stepIndex] : [];
        updateDisplayedActions();
      }
      const stage = step.type === 'speak' ? 'Озвучка' : step.type === 'transcribe' ? 'Транскрибация' : step.type === 'postprocess' ? 'Пост-процессинг текста'
        : step.type === 'paste' ? 'Вставка в активное поле' : 'Буфер обмена';
      if (signal?.aborted) return { status: 'cancelled' };
      dependencies.onStage(`${stage}...`);
      persistStepStatus(stepIndex, 'running');
      const startedAt = performance.now();
      try {
        if (step.type === 'speak') {
          const speech = dependencies.speechForStep?.(step) ?? dependencies.speech;
          if (!speech) throw new Error('Провайдер озвучки недоступен.');
          const { speak } = speech;
          // The speech is kept with its text and, when the provider sent them, the marks of its words.
          const keepAudio = (audio: Blob, speechMarks: readonly SpeechMark[] = []) => {
            historySteps[stepIndex] = { ...historySteps[stepIndex], audioBlob: audio, text: finalText,
              ...(speechMarks.length ? { speechMarks: [...speechMarks] } : {}) };
            if (historyEntryId) save({ steps: historySteps.slice() });
          };
          if (speak) currentAudio = await runAction(step, () => speak(finalText, signal, audio => keepAudio(audio, getSpeechMarks())));
          else currentAudio = await speech.synthesize(finalText, signal, step.speechSettings);
          if (signal?.aborted) return { status: 'cancelled' };
          if (!speak) keepAudio(currentAudio);
          if (!speak) await runAction(step, () => speech.play(currentAudio, signal, step.speechSettings));
        } else if (step.type === 'transcribe') {
          finalText = (await dependencies.transcription.transcribe(currentAudio, signal)).text;
          if (signal?.aborted) return { status: 'cancelled' };
          dependencies.onText(finalText);
        } else if (step.type === 'postprocess') {
          finalText = await dependencies.postProcessor.process(finalText, signal);
          if (signal?.aborted) return { status: 'cancelled' };
          historySteps[stepIndex] = { ...historySteps[stepIndex], text: finalText };
          dependencies.onText(finalText);
        } else if (step.type === 'paste') {
          if (signal?.aborted) return { status: 'cancelled' };
          await runAction(step, () => dependencies.output.paste(finalText, step.returnFocusToOriginalWindow === true));
          dependencies.onInsertSound?.();
        } else if (step.type === 'copy') {
          if (signal?.aborted) return { status: 'cancelled' };
          await runAction(step, () => dependencies.output.copy(finalText, normalizeClipboardHistoryLevel(step.clipboardHistoryLevel)));
        }
        console.info(`Этап «${stage}»: ${Math.round(performance.now() - startedAt)} мс`);
        persistStepStatus(stepIndex, 'success', undefined,
          step.type === 'postprocess' ? { text: finalText, status: 'post-processed' } : undefined);
      } catch (error) {
        if (signal?.aborted) return { status: 'cancelled' };
        const message = errorMessage(error);
        console.error(`Ошибка этапа «${stage}» через ${Math.round(performance.now() - startedAt)} мс:`, message);
        historySteps[stepIndex] = { ...historySteps[stepIndex], status: 'error', errorMessage: message };
        dependencies.onStepStatus?.({ ...scenario.steps[stepIndex], status: 'error' });
        if (displayedActions.includes(stepIndex)) updateDisplayedActions();
        if (historyEntryId) save({
          status: 'error', errorStep: stage, errorMessage: message,
          steps: historySteps.slice(),
        });
        if (getScenarioStepContract(step.type).category === 'action') {
          actionErrors.push(`${stage}: ${message}`);
          continue;
        }
        return { status: 'error', message: `${stage}: ${message}` };
      }
    }

    if (signal?.aborted) return { status: 'cancelled' };
    if (actionErrors.length) {
      const message = `Сценарий завершён с ошибками: ${actionErrors.join('; ')}`;
      if (historyEntryId) save({
        status: 'error', errorMessage: actionErrors.join('; '),
        steps: historySteps.slice(),
      });
      return { status: 'error', message };
    }
    if (historyEntryId) save({ status: 'success' });
    return { status: 'success', text: finalText };
  } finally {
    dependencies.skipActions?.(scenario.steps.map(step => step.id));
    await historyWrites.flush();
  }
}

function getActiveScenario(settings: ScenarioWorkflowSettings): Scenario {
  const activeScenario = settings.scenarios?.find(item => item.id === settings.activeScenarioId);
  if (activeScenario) return activeScenario;
  return createDefaultScenario(
    settings.postProcessEnabled ?? true,
    settings.autoPasteActiveWindow === false ? 'copy' : 'paste',
  );
}
