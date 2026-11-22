(() => {
  let active = false;
  let observer = null;
  let timeoutId = null;

  function post(payload) {
    try { chrome.runtime.sendMessage(payload); } catch {}
  }

  function findInput() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea');
  }

  function readText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return (el.value || '').trim();
    return (el.innerText || el.textContent || '').trim();
  }

  function clearInput(el) {
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }

  function buttonLabel(btn) {
    return [
      btn.getAttribute('aria-label'),
      btn.getAttribute('title'),
      btn.getAttribute('data-testid'),
      btn.textContent,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function visibleButtonsIn(root) {
    return Array.from((root || document).querySelectorAll('button')).filter((btn) => {
      if (btn.disabled) return false;
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function findComposerRoot() {
    const anchor = document.querySelector('[data-testid="chat-input-attach"]')
      || findInput()
      || visibleButtonsIn(document).find((b) => /отменить диктовку|cancel dictation/i.test(buttonLabel(b)));
    if (!anchor) return document.querySelector('main') || document.body;
    return anchor.closest('form')
      || anchor.closest('fieldset')
      || anchor.parentElement?.parentElement?.parentElement
      || document.querySelector('main')
      || document.body;
  }

  function findStartButton() {
    const root = findComposerRoot();
    return visibleButtonsIn(root).find((btn) => {
      const label = buttonLabel(btn).toLowerCase();
      if (/cancel|discard|close|отмен|закрыт|attach/.test(label)) return false;
      return /dictat|voice|mic|record|диктов|голос|микрофон/.test(label);
    });
  }

  function findCancelButton() {
    const root = findComposerRoot();
    return visibleButtonsIn(root).find((btn) => /отменить диктовку|cancel.*(dictat|voice|record)|discard/i.test(buttonLabel(btn)));
  }

  function findConfirmStopButton() {
    const root = findComposerRoot();
    const buttons = visibleButtonsIn(root);
    const cancelBtn = buttons.find((btn) => /отменить диктовку|cancel.*(dictat|voice|record)|discard/i.test(buttonLabel(btn)));
    if (cancelBtn) {
      const idx = buttons.indexOf(cancelBtn);
      // Confirm button is placed right next to Cancel dictation inside the composer.
      const next = buttons[idx + 1];
      if (next && !/attach|добавить/i.test(buttonLabel(next))) return next;
    }
    return buttons.find((btn) => {
      const label = buttonLabel(btn).toLowerCase();
      if (/cancel|discard|отмен|attach|добавить/.test(label)) return false;
      return /stop|confirm|done|finish|insert|accept|complete|останов|подтверд|встав|принять|диктов|dictat|voice/.test(label);
    });
  }

  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  function handleStart() {
    const el = findInput();
    if (el) clearInput(el);
    const btn = findStartButton();
    if (!btn) {
      const labels = visibleButtonsIn(findComposerRoot()).map(buttonLabel).filter(Boolean);
      post({ event: 'debug', message: `start: mic button not found; composer buttons=${JSON.stringify(labels)}` });
      post({ event: 'error', error: el ? 'Не найдена кнопка голосового ввода на странице Claude Chat.' : 'Не найдено поле ввода на странице Claude Chat. Войдите в аккаунт.' });
      return;
    }
    post({ event: 'debug', message: `start: clicking ${JSON.stringify(buttonLabel(btn))}` });
    active = true;
    btn.click();
    post({ event: 'started' });
  }

  function handleStop() {
    if (!active) return;
    const composer = findComposerRoot();
    const labels = visibleButtonsIn(composer).map(buttonLabel).filter(Boolean);
    const btn = findConfirmStopButton();
    post({ event: 'debug', message: `stop: clicked=${btn ? JSON.stringify(buttonLabel(btn)) : 'none'}, composer buttons=${JSON.stringify(labels)}` });
    if (btn) btn.click();

    const stoppedAt = Date.now();
    let lastText = '';
    const finish = (reason) => {
      active = false;
      cleanup();
      const input = findInput();
      const finalText = readText(input);
      post({ event: 'debug', message: `stop +${Date.now() - stoppedAt}ms: finished (${reason}), len=${finalText.length}, preview=${JSON.stringify(finalText.slice(0, 80))}` });
      post({ event: 'stopped', text: finalText });
    };

    const schedule = (ms, reason) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => finish(reason), ms);
    };

    const onChange = () => {
      if (findCancelButton()) return;
      const text = readText(findInput());
      if (text && text !== lastText) {
        lastText = text;
        post({ event: 'debug', message: `stop +${Date.now() - stoppedAt}ms: text len=${text.length}` });
        // claude.ai inserts the transcript in chunks (~50-110 ms apart); wait 300 ms of quiet.
        schedule(300, 'settled');
      }
    };

    cleanup();
    observer = new MutationObserver(onChange);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule(8000, 'timeout-8s');
    onChange();
  }

  function handleCancel() {
    const wasActive = active;
    active = false;
    cleanup();
    if (wasActive) {
      const btn = findCancelButton();
      post({ event: 'debug', message: `cancel: clicked=${btn ? JSON.stringify(buttonLabel(btn)) : 'none'}` });
      if (btn) btn.click();
    }
    clearInput(findInput());
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      const cmd = msg && msg.cmd;
      if (cmd === 'start') handleStart();
      else if (cmd === 'stop') handleStop();
      else if (cmd === 'cancel') handleCancel();
      sendResponse({ ok: true });
    } catch (err) {
      post({ event: 'error', error: `Ошибка скрипта: ${err && err.message ? err.message : String(err)}` });
      sendResponse({ ok: false });
    }
  });

  function startKeepalive() {
    let port = null;
    let pingTimer = null;
    const reconnect = () => {
      clearInterval(pingTimer);
      try {
        port = chrome.runtime.connect({ name: 'keepalive' });
        port.onDisconnect.addListener(() => {
          clearInterval(pingTimer);
          setTimeout(reconnect, 1000);
        });
        pingTimer = setInterval(() => {
          try { port.postMessage({ type: 'ping' }); } catch {}
        }, 20000);
      } catch {
        setTimeout(reconnect, 2000);
      }
    };
    reconnect();
  }

  startKeepalive();
  post({ event: 'debug', message: `content: loaded on ${location.href}` });
  post({ event: 'ready' });
})();
