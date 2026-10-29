import type { ScenarioStep } from './scenario';

// The "start" shortcut field of a source step that starts a scenario on a hotkey.
export function mountTriggerHotkey(root: HTMLElement, step: ScenarioStep, title: string, save: () => void,
  formatHotkey: (value: string) => string) {
  const triggerOptions = document.createElement('div');
  triggerOptions.className = 'scenario-trigger-options';
  root.append(triggerOptions);
  const label = document.createElement('label');
  label.className = 'form-field--important';
  const input = document.createElement('input');
  input.type = 'text'; input.readOnly = true;
  input.value = formatHotkey(step.hotkey ?? ''); input.placeholder = 'Нажмите сочетание';
  input.title = 'Нажмите, затем введите сочетание клавиш';
  input.setAttribute('aria-required', 'true');
  input.addEventListener('focus', () => { input.value = 'Нажмите сочетание…'; });
  input.addEventListener('blur', () => { input.value = formatHotkey(step.hotkey ?? ''); });
  input.setAttribute('aria-label', title);
  input.addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const parts = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code || event.key].filter(Boolean);
    step.hotkey = ['Backspace', 'Delete'].includes(event.key) ? '' : parts.join('+');
    save();
  });
  const caption = document.createElement('span');
  caption.textContent = title;
  const required = document.createElement('span');
  required.className = 'req-marker'; required.textContent = '*'; required.setAttribute('aria-hidden', 'true');
  caption.append(required);
  label.append(caption, input); triggerOptions.append(label);
}
