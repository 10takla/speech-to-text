// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../config';
import { createDefaultScenario, createStep } from '../scenario';
import { createOverlayRunView } from './OverlayRun';
import { createRecordingSession } from './recording-session';
import { overlayRetention } from '../overlay-retention';
import { runRecordingWorkflow, type RecordingWorkflowResult } from '../recording-workflow';

vi.mock('../recording-workflow', () => ({ getScenarioReadinessError: () => null, runRecordingWorkflow: vi.fn() }));
vi.mock('../history-repository', () => ({ createRunHistoryRepository: () => ({ repository: {}, release: async () => {} }) }));
vi.mock('../scenario-progress', () => ({ publishScenarioProgress: vi.fn() }));
vi.mock('../audio', () => ({ playSound: async () => {} }));
vi.mock('../android-runtime', () => ({ isAndroid: false, androidCall: vi.fn() }));
vi.mock('../live-transcription', () => ({ createLiveTranscriber: () => ({
  segments: [], committedThroughSeconds: 0, text: '', start() {}, stop() {}, observeSpeechLevel() {},
  replaceFinalizedTranscript() {}, resumeAfterPause() {},
}) }));

const disposals: (() => void)[] = [];
const workflows: { audio: Blob; dependencies: Parameters<typeof runRecordingWorkflow>[1]; finish(result: RecordingWorkflowResult): void }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="overlay-runs"></div>';
  workflows.length = 0;
  vi.mocked(runRecordingWorkflow).mockImplementation((audio, dependencies) => new Promise(resolve => {
    workflows.push({ audio, dependencies, finish: resolve });
  }));
});
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); overlayRetention.setPinned(false); vi.useRealTimers(); });

function fixture(id: string, prepareWindow?: () => Promise<void>) {
  const scenario = createDefaultScenario(); scenario.id = id; scenario.name = id;
  scenario.steps[0].soundEnabled = false;
  const settings = { ...defaultSettings(), activeScenarioId: id, scenarios: [scenario], overlayFollowCursorMonitor: false };
  const view = createOverlayRunView(id);
  const capture = { start: vi.fn(async () => {}), stop: vi.fn(async () => new ArrayBuffer(1000)),
    pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), snapshot: vi.fn(async () => new ArrayBuffer(1000)),
    cancel: vi.fn(async () => {}), inputLevel: vi.fn(async () => 0) };
  const release = vi.fn(), hide = vi.fn(async () => true);
  const invoke = vi.fn(async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined);
  const session = createRecordingSession({ runId: id, settings, container: view.element,
    invoke: invoke as typeof import('@tauri-apps/api/core').invoke,
    audioCapture: capture, textOutput: { copy: async () => {}, paste: async () => {} },
    windowController: null, autoSizer: null, prepareWindow, onChange() {}, onRecordingReleased: release, hide,
  });
  disposals.push(() => { session.dispose(); view.dispose(); });
  return { session, view: view.element, capture, release, hide, settings, invoke };
}

it('records through Claude with the overlay visible and passes native text to the existing workflow', async () => {
  const item = fixture('claude');
  item.settings.scenarios[0].steps.splice(0, 2, createStep('claudeCode'));
  let captureBeforeClaude = false;
  item.invoke.mockImplementation(async command => {
    if (command === 'start_claude_dictation') captureBeforeClaude = item.capture.start.mock.calls.length === 1;
    return command === 'stop_claude_dictation' ? 'Проверка диктовки' : command === 'poll_claude_dictation' ? { finished: false, text: 'Проверка' } : undefined;
  });
  const previews: string[] = [];
  item.view.addEventListener('overlay-transcription-preview', event => previews.push((event as CustomEvent<{ text: string }>).detail.text));
  await start(item.session);
  expect(item.session.state).toBe('recording');
  expect(item.view.classList.contains('overlay-content-hidden')).toBe(false);
  expect(item.invoke).toHaveBeenCalledWith('start_claude_dictation', { runId: 'claude' });
  // The parallel capture starts with Claude, not after it confirms its
  // microphone, so the saved recording keeps the first words.
  expect(item.capture.start).toHaveBeenCalledOnce();
  expect(captureBeforeClaude).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(item.capture.inputLevel).toHaveBeenCalled();
  // Claude's interim text from its prompt is shown while recording.
  await vi.advanceTimersByTimeAsync(250);
  expect(item.invoke).toHaveBeenCalledWith('poll_claude_dictation', { runId: 'claude', live: true });
  expect(previews).toContain('Проверка');
  const stopped = item.session.stop();
  // Claude keeps recording for the step's after-stop tail (150 ms by default).
  await vi.advanceTimersByTimeAsync(100);
  expect(item.invoke).not.toHaveBeenCalledWith('stop_claude_dictation', { runId: 'claude' });
  await vi.advanceTimersByTimeAsync(60);
  expect(item.invoke).toHaveBeenCalledWith('stop_claude_dictation', { runId: 'claude' });
  expect(workflows[0].dependencies.initialText).toBe('Проверка диктовки');
  // The parallel capture ends on the same stop boundary and goes to history.
  expect(item.capture.stop).toHaveBeenCalledWith(expect.any(Number), 150, expect.any(AbortSignal));
  expect(item.capture.cancel).not.toHaveBeenCalled();
  expect(workflows[0].audio.size).toBe(1000);
  workflows[0].finish({ status: 'success', text: 'Проверка диктовки' });
  await stopped;
  expect(item.hide).toHaveBeenCalledOnce();
});

it('cancels Claude recording without invoking the text workflow or ordinary capture', async () => {
  const item = fixture('claude-cancel');
  item.settings.scenarios[0].steps.splice(0, 2, createStep('claudeCode'));
  await start(item.session);
  await item.session.cancel();
  expect(item.invoke).toHaveBeenCalledWith('cancel_claude_code', { runId: 'claude-cancel' });
  expect(workflows).toHaveLength(0);
  expect(item.capture.stop).not.toHaveBeenCalled();
  // The level-only capture is released with the dictation.
  expect(item.capture.cancel).toHaveBeenCalled();
});
async function start(session: ReturnType<typeof fixture>['session']) {
  const starting = session.start(); await vi.advanceTimersByTimeAsync(250); await starting;
}

it('exposes the new block for measurement before restoring its window position and starting capture', async () => {
  const prepare = vi.fn(async () => {
    expect(first.view.classList.contains('overlay-content-hidden')).toBe(false);
    expect(first.capture.start).not.toHaveBeenCalled();
  });
  const first = fixture('first', prepare);
  await start(first.session);
  expect(prepare).toHaveBeenCalledOnce();
  await first.session.cancel();
});

it('releases capture before processing, preserving independent snapshots, blocks and progress callbacks', async () => {
  const first = fixture('first'); await start(first.session);
  const processing = first.session.stop();
  expect(first.capture.stop).toHaveBeenCalledWith(Date.now(), 150, expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(0);
  expect(first.release).toHaveBeenCalled();
  expect(workflows).toHaveLength(1);
  const second = fixture('second'); await start(second.session);
  expect(second.session.state).toBe('recording');
  expect(workflows[0].dependencies.getSettings().activeScenarioId).toBe('first');
  workflows[0].dependencies.onStage('Первая обработка');
  expect(first.view.textContent).toContain('Первая обработка');
  expect(second.view.textContent).toContain('Запись речи');
  workflows[0].finish({ status: 'success', text: 'Первый текст' });
  await processing;
  expect(first.hide).toHaveBeenCalledOnce();
  expect(second.hide).not.toHaveBeenCalled();
  expect(second.session.state).toBe('recording');
  await second.session.cancel();
});

it('cancels only the selected processing run and never cancels another microphone owner', async () => {
  const first = fixture('first'); await start(first.session);
  const a = first.session.stop(); await vi.advanceTimersByTimeAsync(0);
  const second = fixture('second'); await start(second.session);
  const b = second.session.stop(); await vi.advanceTimersByTimeAsync(0);
  await second.session.cancel();
  expect(workflows[0].dependencies.signal?.aborted).toBe(false);
  expect(workflows[1].dependencies.signal?.aborted).toBe(true);
  expect(first.capture.cancel).not.toHaveBeenCalled();
  expect(second.capture.cancel).not.toHaveBeenCalled();
  workflows[0].finish({ status: 'success', text: 'first' });
  workflows[1].finish({ status: 'cancelled' });
  await Promise.all([a, b]);
});

it('retains an error block after its timer expires while pinned', async () => {
  const first = fixture('first'); await start(first.session);
  const processing = first.session.stop(); await vi.advanceTimersByTimeAsync(0);
  workflows[0].finish({ status: 'error', message: 'Ошибка первого запуска' }); await processing;
  overlayRetention.setPinned(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(first.session.completed).toBe(true);
  expect(first.hide).not.toHaveBeenCalled();
  expect(first.view.textContent).toContain('Ошибка первого запуска');
});

it('holds the microphone reservation until a pending native stop finishes, even after cancellation', async () => {
  const first = fixture('first'); await start(first.session);
  let finishStop!: (audio: ArrayBuffer) => void;
  first.capture.stop.mockImplementationOnce(() => new Promise(resolve => { finishStop = resolve; }));
  const stopped = first.session.stop();
  await first.session.cancel();
  expect(first.release).not.toHaveBeenCalled();
  finishStop(new ArrayBuffer(1000)); await stopped;
  expect(first.release).toHaveBeenCalledOnce();
  expect(workflows).toHaveLength(0);
});
