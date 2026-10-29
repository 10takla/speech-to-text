import { invoke, isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from './tauri-commands';
import { isAndroid } from './android-runtime';
import { errorMessage } from './error-message';
import type { ScenarioStep } from './scenario';
import { normalizeAfterStopMs } from './recording-stop';

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
