// Layout of the speech step settings, the same as the transcription and
// post-processing cards: a header with the status and «Тест», the check
// result under it, then a grid of fields with their own notes.

export type PanelState = 'idle' | 'ready' | 'error';

export interface SpeechPanel {
  status: HTMLSpanElement;
  test: HTMLButtonElement;
  details: HTMLParagraphElement;
  // Provider grid: the provider list and the key/address next to it.
  grid: HTMLDivElement;
  // Provider-specific fields.
  body: HTMLDivElement;
}

export function setPanelStatus(panel: SpeechPanel, state: PanelState, text: string, details: string): void {
  panel.status.className = `status-pill status-pill--${state}`;
  panel.status.textContent = text;
  panel.status.title = details;
  panel.details.textContent = details;
}

export function formGrid(parent: HTMLElement): HTMLDivElement {
  const grid = document.createElement('div');
  grid.className = 'form-grid';
  parent.append(grid);
  return grid;
}

export function formField(parent: HTMLElement, title: string, control: HTMLElement, required = false): HTMLDivElement {
  const field = document.createElement('div');
  field.className = `form-field${required ? ' form-field--important' : ''}`;
  const label = document.createElement('label');
  label.append(`${title}:`);
  if (required) {
    const marker = document.createElement('span');
    marker.className = 'req-marker'; marker.title = 'Обязательная настройка'; marker.textContent = '*';
    label.append(' ', marker);
  }
  const input = control.matches('select, input, textarea') ? control : control.querySelector('select, input, textarea');
  input?.setAttribute('aria-label', title);
  if (required) input?.setAttribute('aria-required', 'true');
  field.append(label, control);
  parent.append(field);
  return field;
}

/** A status line under a field: list sizes, model facts. */
export function fieldNote(field: HTMLElement): HTMLSpanElement {
  const facts = document.createElement('div');
  facts.className = 'speech-field-facts';
  const note = document.createElement('span');
  note.className = 'model-load-status';
  note.setAttribute('role', 'status');
  facts.append(note);
  field.append(facts);
  return note;
}

export function showField(field: HTMLElement, visible: boolean): void {
  field.style.display = visible ? '' : 'none';
}

/** When the sound starts: while the audio streams in, or after the whole synthesis. */
export function playbackMode(field: HTMLElement, streaming: boolean): HTMLSpanElement {
  const mode = document.createElement('span');
  setPlaybackMode(mode, streaming);
  (field.querySelector('.speech-field-facts') ?? field).append(mode);
  return mode;
}

export function setPlaybackMode(mode: HTMLElement, streaming: boolean): void {
  mode.className = `speech-playback-mode status-pill status-pill--${streaming ? 'ready' : 'idle'}`;
  mode.textContent = streaming ? 'Потоково' : 'После синтеза';
  mode.title = streaming ? 'Звук начинает играть сразу, по мере получения.' : 'Звук начинает играть после полного синтеза текста.';
}

export function refreshButton(title: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn secondary model-refresh-btn'; button.textContent = '↻';
  button.title = title; button.setAttribute('aria-label', title);
  button.addEventListener('click', action);
  return button;
}

export function modelPicker(control: HTMLSelectElement, refresh: HTMLButtonElement): HTMLDivElement {
  const picker = document.createElement('div');
  picker.className = 'model-picker';
  picker.append(control, refresh);
  return picker;
}
