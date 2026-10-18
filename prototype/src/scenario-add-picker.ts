/** Reveal the step choices only when the user requests an addition. */
export function scenarioAddPicker(select: HTMLSelectElement): HTMLElement {
  [...select.options].filter(option => !option.value).forEach(option => option.remove());
  const empty = new Option('', '', true, true);
  empty.hidden = true;
  empty.disabled = true;
  select.insertBefore(empty, select.firstChild);
  select.hidden = true;
  const container = document.createElement('span');
  container.className = 'scenario-add-picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn secondary scenario-add-button';
  button.textContent = '+';
  button.title = select.getAttribute('aria-label') ?? 'Добавить шаг';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'listbox');
  const close = () => {
    select.hidden = true;
    button.hidden = false;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    select.value = '';
    select.size = 1;
    select.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    select.focus();
    try {
      select.showPicker();
    } catch {
      // The transparent select over the button remains clickable in older webviews.
    }
  });
  select.addEventListener('blur', close);
  select.addEventListener('change', close);
  select.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
    button.focus();
  });
  container.append(button, select);
  return container;
}
