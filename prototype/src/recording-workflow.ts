import type { AppSettings } from './config';
import type { HistoryRepository, TextOutputPort, TextPostProcessor, TranscriptionProvider } from './ports';
import type { RecordingFragment, TimeRange } from './recording-editor';
import { combineFragments, mergeRanges, retainedRanges } from './recording-editor';
import { errorMessage } from './error-message';
import { fitTranscriptToAudio } from './transcript-timing';
import { createDefaultScenario, getScenarioStepContract, normalizeClipboardHistoryLevel, validateScenario, type Scenario } from './scenario';
import type { HistoryStep, HistoryStepStatus } from './history-db';

type ScenarioWorkflowSettings = Pick<AppSettings, 'provider' | 'groqApiKey' | 'postProcessProvider' | 'geminiApiKey'>
  & Partial<Pick<AppSettings, 'scenarios' | 'activeScenarioId' | 'postProcessEnabled' | 'autoPasteActiveWindow' | 'geminiPrompt'>>;
type WorkflowSettings = Pick<AppSettings, 'historyMaxItems'> & ScenarioWorkflowSettings;

export interface RecordingWorkflowDependencies {
  history: HistoryRepository;
  transcription: TranscriptionProvider;
  postProcessor: TextPostProcessor;
  output: TextOutputPort;
  getSettings(): WorkflowSettings;
  fragments: RecordingFragment[];
  getFragmentOffset(): number;
  setFragmentOffset(offset: number): void;
  snapshotFragments(): Parameters<HistoryRepository['update']>[1]['fragments'];
  decodeAudio(blob: Blob): Promise<AudioBuffer>;
  cut(buffer: AudioBuffer, ranges: TimeRange[]): Blob;
  onStage(stage: string): void;
  onText(text: string): void;
  onInsertSound?(): void;
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
  if (signal?.aborted) return { status: 'cancelled' };
  const settings = dependencies.getSettings();
  const scenario = getActiveScenario(settings);

  const readinessError = getScenarioReadinessError(settings);
  if (readinessError) {
    return { status: 'error', message: readinessError };
  }

  if (audioBlob.size < 1000) {
    return { status: 'error', message: 'Запись слишком короткая. Попробуйте говорить чуть дольше.' };
  }

  const historySteps: HistoryStep[] = scenario.steps.map(step => ({
    id: step.id,
    type: step.type,
    title: getScenarioStepContract(step.type).title,
    status: !step.enabled ? 'skipped' : step.type === 'startRecording' ? 'success' : 'pending',
  }));
  const transcriptionIndex = scenario.steps.findIndex(step => step.type === 'transcribe');
  let historyEntryId: string | null = null;
  try {
    const entry = await dependencies.history.add(
      { audioBlob, status: 'recorded', scenarioName: scenario.name, steps: historySteps },
      dependencies.getSettings().historyMaxItems || 10,
    );
    historyEntryId = entry.id;
  } catch (error) {
    console.warn('Не удалось сохранить аудиозапись в IndexedDB:', error);
  }
  if (signal?.aborted) return { status: 'cancelled' };

  const persistStepStatus = async (index: number, status: HistoryStepStatus, errorMessage?: string) => {
    if (index < 0) return;
    historySteps[index] = { ...historySteps[index], status, errorMessage };
    if (historyEntryId) await dependencies.history.update(historyEntryId, { steps: historySteps.map(step => ({ ...step })) }).catch(console.warn);
  };

  let transcribedText = '';
  let allRemoved: TimeRange[] = [];
  await persistStepStatus(transcriptionIndex, 'running');
  try {
    const buffer = await dependencies.decodeAudio(audioBlob);
    if (signal?.aborted) return { status: 'cancelled' };
    const fragmentOffset = dependencies.getFragmentOffset();
    if (buffer.duration - fragmentOffset > .01) {
      dependencies.fragments.push({
        audioBlob: dependencies.cut(buffer, [{ start: fragmentOffset, end: buffer.duration }]),
        start: fragmentOffset,
        end: buffer.duration,
        transcript: null,
        removedRanges: [],
      });
      dependencies.setFragmentOffset(buffer.duration);
    }

    if (historyEntryId) await dependencies.history.update(historyEntryId, {
      originalAudioBlob: audioBlob,
      fragments: dependencies.snapshotFragments(),
    }).catch(console.warn);

    for (const fragment of dependencies.fragments) {
      if (signal?.aborted) return { status: 'cancelled' };
      if (!fragment.transcript) fragment.transcript = fitTranscriptToAudio(
        await dependencies.transcription.transcribe(fragment.audioBlob, signal), fragment.end - fragment.start);
      if (signal?.aborted) return { status: 'cancelled' };
      if (historyEntryId) await dependencies.history.update(historyEntryId, {
        fragments: dependencies.snapshotFragments(),
      }).catch(console.warn);
    }

    const combined = combineFragments(dependencies.fragments);
    transcribedText = combined.text;
    allRemoved = mergeRanges(combined.removedRanges, buffer.duration);
    const editedAudio = allRemoved.length
      ? dependencies.cut(buffer, retainedRanges(allRemoved, buffer.duration))
      : audioBlob;
    if (historyEntryId) await dependencies.history.update(historyEntryId, {
      originalAudioBlob: audioBlob,
      audioBlob: editedAudio,
      text: transcribedText,
      fragments: dependencies.snapshotFragments(),
      segments: combined.segments,
      removedRanges: allRemoved,
      status: !transcribedText && allRemoved.length ? 'success' : 'transcribed',
      steps: historySteps.map((step, index) => index === transcriptionIndex ? { ...step, status: 'success' } : { ...step }),
    });
    if (transcriptionIndex >= 0) historySteps[transcriptionIndex] = { ...historySteps[transcriptionIndex], status: 'success', errorMessage: undefined };
    if (!transcribedText && !allRemoved.length) throw new Error('Речь не распознана. Попробуйте ещё раз.');
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' };
    const message = errorMessage(error);
    if (transcriptionIndex >= 0) historySteps[transcriptionIndex] = { ...historySteps[transcriptionIndex], status: 'error', errorMessage: message };
    if (historyEntryId) await dependencies.history.update(historyEntryId, {
      status: 'error', errorStep: 'Транскрибация текста', errorMessage: message,
      steps: historySteps.map(step => ({ ...step })),
    }).catch(console.warn);
    return { status: 'error', message };
  }

  if (signal?.aborted) return { status: 'cancelled' };
  dependencies.onText(transcribedText);
  if (!transcribedText && allRemoved.length) {
    if (historyEntryId) await dependencies.history.update(historyEntryId, { status: 'success' });
    return { status: 'success', text: '' };
  }

  let finalText = transcribedText;
  const actionErrors: string[] = [];
  for (const step of scenario.steps.slice(transcriptionIndex + 1)) {
    if (!step.enabled) continue;
    const stepIndex = scenario.steps.indexOf(step);
    const stage = step.type === 'postprocess' ? 'Пост-процессинг текста'
      : step.type === 'paste' ? 'Вставка в активное поле' : 'Буфер обмена';
    if (signal?.aborted) return { status: 'cancelled' };
    await persistStepStatus(stepIndex, 'running');
    dependencies.onStage(`${stage}...`);
    try {
      if (step.type === 'postprocess') {
        finalText = await dependencies.postProcessor.process(finalText, signal);
        if (signal?.aborted) return { status: 'cancelled' };
        dependencies.onText(finalText);
        if (historyEntryId) await dependencies.history.update(historyEntryId, {
          text: finalText,
          status: 'post-processed',
        });
      } else if (step.type === 'paste') {
        if (signal?.aborted) return { status: 'cancelled' };
        await dependencies.output.paste(finalText);
        dependencies.onInsertSound?.();
      } else if (step.type === 'copy') {
        if (signal?.aborted) return { status: 'cancelled' };
        await dependencies.output.copy(finalText, normalizeClipboardHistoryLevel(step.clipboardHistoryLevel));
      }
      await persistStepStatus(stepIndex, 'success');
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      const message = errorMessage(error);
      console.error(`Ошибка этапа «${stage}»:`, message);
      historySteps[stepIndex] = { ...historySteps[stepIndex], status: 'error', errorMessage: message };
      if (historyEntryId) await dependencies.history.update(historyEntryId, {
        status: 'error', errorStep: stage, errorMessage: message,
        steps: historySteps.map(item => ({ ...item })),
      }).catch(console.warn);
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
    if (historyEntryId) await dependencies.history.update(historyEntryId, {
      status: 'error', errorMessage: actionErrors.join('; '),
      steps: historySteps.map(step => ({ ...step })),
    }).catch(console.warn);
    return { status: 'error', message };
  }
  if (historyEntryId) await dependencies.history.update(historyEntryId, { status: 'success' }).catch(console.warn);
  return { status: 'success', text: finalText };
}

function getActiveScenario(settings: ScenarioWorkflowSettings): Scenario {
  const activeScenario = settings.scenarios?.find(item => item.id === settings.activeScenarioId);
  if (activeScenario) return activeScenario;
  return createDefaultScenario(
    settings.postProcessEnabled ?? true,
    settings.autoPasteActiveWindow === false ? 'copy' : 'paste',
  );
}
