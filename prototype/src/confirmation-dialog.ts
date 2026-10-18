let confirmationOpen = false;

export function confirmAction(options: { title: string; message?: string; confirmLabel: string }): Promise<boolean> {
  if (confirmationOpen) return Promise.resolve(false);
  confirmationOpen = true;
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.setAttribute('aria-labelledby', 'confirmation-title');
    const title = document.createElement('h2');
    title.id = 'confirmation-title';
    title.textContent = options.title;
    dialog.append(title);
    if (options.message) {
      const message = document.createElement('p');
      message.id = 'confirmation-message';
      message.textContent = options.message;
      dialog.setAttribute('aria-describedby', message.id);
      dialog.append(message);
    }
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'btn-group';
    const cancel = document.createElement('button');
    cancel.className = 'btn secondary';
    cancel.value = 'cancel';
    cancel.textContent = 'Отмена';
    cancel.autofocus = true;
    const confirm = document.createElement('button');
    confirm.className = 'btn primary';
    confirm.value = 'confirm';
    confirm.textContent = options.confirmLabel;
    form.append(cancel, confirm);
    dialog.append(form);
    dialog.addEventListener('close', () => {
      confirmationOpen = false;
      dialog.remove();
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
