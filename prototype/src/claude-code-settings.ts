import { invoke, isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from './tauri-commands';
import { isAndroid } from './android-runtime';
import { errorMessage } from './error-message';
import type { ScenarioStep } from './scenario';
import { normalizeAfterStopMs, normalizeFirstWordWaitMs } from './recording-stop';

type WindowCommands = {
  open: 'open_claude_code' | 'open_antigravity_cli' | 'open_claude_chat';
  hide: 'hide_claude_code' | 'hide_antigravity_cli' | 'hide_claude_chat';
  visible: 'claude_code_visible' | 'antigravity_cli_visible' | 'claude_chat_visible';
};

function mountAfterStopSetting(root: HTMLElement, step: ScenarioStep, save: () => void, label: string) {
  const afterStopLabel = document.createElement('label');
  afterStopLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
  afterStopLabel.textContent = 'Время после стопа:';
  const afterStopInput = document.createElement('input');
  afterStopInput.type = 'number';
  afterStopInput.min = '0';
  afterStopInput.step = '1';
  afterStopInput.value = String(normalizeAfterStopMs(step.afterStopMs));
  afterStopInput.setAttribute('aria-label', 'Время после стопа, мс');
  afterStopInput.title = `Продолжать запись в ${label} после стопа, чтобы не обрезать последние слова; 0 — остановить сразу.`;
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
}

function mountWindowToggleButton(root: HTMLElement, label: string, commands: WindowCommands) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn secondary';
  let visible = false;
  const updateLabel = () => { toggle.textContent = visible ? `Скрыть ${label}` : `Открыть ${label}`; };
  updateLabel();
  const canUse = isTauri() && !isAndroid && /Windows/i.test(navigator.userAgent);
  toggle.disabled = !canUse;
  if (toggle.disabled) toggle.title = 'Доступно в приложении для Windows';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const syncVisible = async () => {
    if (!canUse || !toggle.isConnected) return;
    try {
      visible = await invokeCommand(invoke, commands.visible);
      updateLabel();
    } catch {}
  };
  if (canUse) {
    void syncVisible();
    const onFocus = () => {
      if (!toggle.isConnected) { window.removeEventListener('focus', onFocus); return; }
      void syncVisible();
    };
    window.addEventListener('focus', onFocus);
  }
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    status.hidden = true;
    try {
      if (visible) {
        await invokeCommand(invoke, commands.hide);
        visible = false;
      } else {
        await invokeCommand(invoke, commands.open);
        visible = true;
      }
      updateLabel();
    }
    catch (error) { status.textContent = errorMessage(error); status.hidden = false; }
    finally { toggle.disabled = false; }
  });
  root.append(toggle, status);
}

function mountCliDictationSettings(
  root: HTMLElement,
  step: ScenarioStep,
  save: () => void,
  label: string,
  commands: WindowCommands,
) {
  mountAfterStopSetting(root, step, save, label);
  const firstWordLabel = document.createElement('label');
  firstWordLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
  firstWordLabel.textContent = 'Ожидание первого слова:';
  const firstWordInput = document.createElement('input');
  firstWordInput.type = 'number';
  firstWordInput.min = '0';
  firstWordInput.step = '1';
  firstWordInput.value = String(normalizeFirstWordWaitMs(step.firstWordWaitMs));
  firstWordInput.setAttribute('aria-label', 'Ожидание первого слова, мс');
  firstWordInput.title = `Если к стопу ${label} ещё не распознал ни слова, ждать первое слово не дольше этого времени; без слова — «Речь не распознана».`;
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
  const liveLabel = document.createElement('label');
  liveLabel.className = 'checkbox-label';
  const liveToggle = document.createElement('input');
  liveToggle.type = 'checkbox';
  liveToggle.checked = step.liveTranscription !== false;
  liveToggle.addEventListener('change', () => { step.liveTranscription = liveToggle.checked; save(); });
  liveLabel.title = `Показывать в оверлее промежуточный текст, который ${label} распознаёт во время записи.`;
  liveLabel.append(liveToggle, 'Текст в реальном времени');
  root.append(liveLabel);
  mountWindowToggleButton(root, label, commands);
}

export function mountClaudeCodeSettings(root: HTMLElement, step: ScenarioStep, save: () => void) {
  mountCliDictationSettings(root, step, save, 'Claude Code CLI', {
    open: 'open_claude_code',
    hide: 'hide_claude_code',
    visible: 'claude_code_visible',
  });
}

export function mountAntigravityCliSettings(root: HTMLElement, step: ScenarioStep, save: () => void) {
  mountCliDictationSettings(root, step, save, 'Antigravity CLI', {
    open: 'open_antigravity_cli',
    hide: 'hide_antigravity_cli',
    visible: 'antigravity_cli_visible',
  });
}

export function mountClaudeChatSettings(root: HTMLElement, step: ScenarioStep, save: () => void) {
  mountAfterStopSetting(root, step, save, 'Claude Chat');
  mountWindowToggleButton(root, 'Claude Chat', {
    open: 'open_claude_chat',
    hide: 'hide_claude_chat',
    visible: 'claude_chat_visible',
  });
}
