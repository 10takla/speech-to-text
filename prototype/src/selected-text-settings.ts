// Settings of the "Выделенный текст" step. Its start key is in the scenario header.
export function mountSelectedTextSettings(root: HTMLElement) {
  const note = document.createElement('p');
  note.className = 'scenario-step-note';
  note.textContent = 'Выделите текст в любом приложении и нажмите сочетание: он будет передан следующим шагам.';
  root.append(note);
}
