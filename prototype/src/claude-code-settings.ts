import { invoke, isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from './tauri-commands';
import { isAndroid } from './android-runtime';
import { errorMessage } from './error-message';
import type { ScenarioStep } from './scenario';
import { normalizeAfterStopMs, normalizeEmptyPromptWaitMs, normalizeFirstWordWaitMs } from './recording-stop';

export function mountClaudeCodeSettings(root: HTMLElement, step: ScenarioStep, save: () => void) {
  const afterStopLabel = document.createElement('label');
  afterStopLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
  afterStopLabel.textContent = 'Время после стопа:';
  const afterStopInput = document.createElement('input');
  afterStopInput.type = 'number';
  afterStopInput.min = '0';
  afterStopInput.step = '1';
  afterStopInput.value = String(normalizeAfterStopMs(step.afterStopMs));
  afterStopInput.setAttribute('aria-label', 'Время после стопа, мс');
  afterStopInput.title = 'Продолжать запись в Claude Code после стопа, чтобы не обрезать последние слова; 0 — остановить сразу.';
  afterStopInput.addEventListener('change', () => {
    const value = afterStopInput.valueAsNumber;
    if (!Number.isSafeInteger(value) || value < 0) {
      afterStopInput.value = String(normalizeAfterStopMs(step.afterStopMs));
      return;
    }
    step.afterStopMs = value;
    save();
  });
  afterStopLabel.append(afterStopInput, document.createTextNode(' мс'));
  root.append(afterStopLabel);
  const firstWordLabel = document.createElement('label');
  firstWordLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
  firstWordLabel.textContent = 'Ожидание первого слова:';
  const firstWordInput = document.createElement('input');
  firstWordInput.type = 'number';
  firstWordInput.min = '0';
  firstWordInput.step = '1';
  firstWordInput.value = String(normalizeFirstWordWaitMs(step.firstWordWaitMs));
  firstWordInput.setAttribute('aria-label', 'Ожидание первого слова, мс');
  firstWordInput.title = 'Если к стопу Claude Code ещё не распознал ни слова, ждать первое слово не дольше этого времени; без слова — «Речь не распознана».';
  firstWordInput.addEventListener('change', () => {
    const value = firstWordInput.valueAsNumber;
    if (!Number.isSafeInteger(value) || value < 0) {
      firstWordInput.value = String(normalizeFirstWordWaitMs(step.firstWordWaitMs));
      return;
    }
    step.firstWordWaitMs = value;
    save();
  });
  firstWordLabel.append(firstWordInput, document.createTextNode(' мс'));
  root.append(firstWordLabel);
  const emptyLabel = document.createElement('label');
  emptyLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
  emptyLabel.textContent = 'Ожидание пустой строки:';
  const emptyInput = document.createElement('input');
  emptyInput.type = 'number';
  emptyInput.min = '0';
  emptyInput.step = '1';
  emptyInput.value = String(normalizeEmptyPromptWaitMs(step.emptyPromptWaitMs));
  emptyInput.setAttribute('aria-label', 'Ожидание пустой строки, мс');
  emptyInput.title = 'Сколько строка ввода Claude Code остаётся пустой после стопа, прежде чем «Речь не распознана».';
  emptyInput.addEventListener('change', () => {
    const value = emptyInput.valueAsNumber;
    if (!Number.isSafeInteger(value) || value < 0) {
      emptyInput.value = String(normalizeEmptyPromptWaitMs(step.emptyPromptWaitMs));
      return;
    }
    step.emptyPromptWaitMs = value;
    save();
  });
  emptyLabel.append(emptyInput, document.createTextNode(' мс'));
  root.append(emptyLabel);
  const liveLabel = document.createElement('label');
  liveLabel.className = 'checkbox-label';
  const liveToggle = document.createElement('input');
  liveToggle.type = 'checkbox';
  liveToggle.checked = step.liveTranscription !== false;
  liveToggle.addEventListener('change', () => { step.liveTranscription = liveToggle.checked; save(); });
  liveLabel.title = 'Показывать в оверлее промежуточный текст, который Claude Code распознаёт во время записи.';
  liveLabel.append(liveToggle, 'Текст в реальном времени');
  root.append(liveLabel);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn secondary';
  open.textContent = 'Открыть Claude Code';
  open.disabled = !isTauri() || isAndroid || !/Windows/i.test(navigator.userAgent);
  if (open.disabled) open.title = 'Доступно в приложении для Windows';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.hidden = true;
  open.addEventListener('click', async () => {
    open.disabled = true;
    status.hidden = true;
    try { await invokeCommand(invoke, 'open_claude_code'); }
    catch (error) { status.textContent = errorMessage(error); status.hidden = false; }
    finally { open.disabled = false; }
  });
  root.append(open, status);
}
