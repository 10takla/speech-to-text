(() => {
  let active = false;
  let observer = null;
  let timeoutId = null;

  function clog(...args) {
    console.log('[claude-chat-content]', ...args);
  }
  function cerr(...args) {
    console.error('[claude-chat-content]', ...args);
  }

  function post(payload) {
    if (payload && payload.event === 'error') cerr(payload.error);
    try {
      void chrome.runtime.sendMessage(payload).catch((err) => {
        cerr('post sendMessage failed:', payload?.event, err && err.message ? err.message : String(err));
      });
    } catch (err) {
      cerr('post sync error:', err && err.message ? err.message : String(err));
    }
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
      if (/cancel|discard|close|stop|finish|confirm|отмен|закрыт|заверш|останов|подтверд|attach|voice-mode|голосовой режим/.test(label)) return false;
      return /dictat|диктов/.test(label) || (/mic|микрофон/.test(label) && !/voice-mode/.test(label));
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
      const next = buttons[idx + 1];
      if (next && !/attach|добавить/i.test(buttonLabel(next))) return next;
    }
    return buttons.find((btn) => {
      const label = buttonLabel(btn).toLowerCase();
      if (/cancel|discard|отмен|attach|добавить|voice-mode|голосовой режим/.test(label)) return false;
      return /завершить диктовку|stop.*(dictat|voice|record)|confirm|done|finish|insert|accept|complete|останов|подтверд|встав|принять/.test(label);
    });
  }

  function isDictatingUi() {
    return Boolean(findCancelButton() || findConfirmStopButton());
  }

  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  function clickStartAndConfirm(startBtn) {
    const el = findInput();
    if (el) clearInput(el);
    const clickedAt = Date.now();
    post({ event: 'debug', message: `start: clicking ${JSON.stringify(buttonLabel(startBtn))}` });
    startBtn.click();

    const confirmStarted = () => {
      if (!isDictatingUi()) return false;
      cleanup();
      active = true;
      post({ event: 'debug', message: `start: dictation UI active after ${Date.now() - clickedAt}ms` });
      post({ event: 'started' });
      return true;
    };

    if (confirmStarted()) return;
    cleanup();
    observer = new MutationObserver(() => { confirmStarted(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    timeoutId = setTimeout(() => {
      cleanup();
      const labels = visibleButtonsIn(findComposerRoot()).map(buttonLabel).filter(Boolean);
      post({ event: 'debug', message: `start: dictation UI did not appear in 5s; buttons=${JSON.stringify(labels)}` });
      post({ event: 'error', error: 'Claude Chat не перешёл в режим диктовки. Проверьте доступ к микрофону на странице.' });
    }, 5000);
  }

  function handleStart() {
    cleanup();
    const cancelBtn = findCancelButton();
    if (cancelBtn) {
      post({ event: 'debug', message: 'start: cancelling leftover dictation before starting' });
      cancelBtn.click();
      const waitForStart = () => {
        const startBtn = findStartButton();
        if (!startBtn || findCancelButton()) return false;
        cleanup();
        clickStartAndConfirm(startBtn);
        return true;
      };
      if (waitForStart()) return;
      observer = new MutationObserver(() => { waitForStart(); });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timeoutId = setTimeout(() => {
        cleanup();
        post({ event: 'error', error: 'Не удалось сбросить предыдущую диктовку на странице Claude Chat.' });
      }, 3000);
      return;
    }
    const btn = findStartButton();
    if (!btn) {
      const el = findInput();
      const labels = visibleButtonsIn(findComposerRoot()).map(buttonLabel).filter(Boolean);
      post({ event: 'debug', message: `start: mic button not found; composer buttons=${JSON.stringify(labels)}` });
      post({ event: 'error', error: el ? 'Не найдена кнопка голосового ввода на странице Claude Chat.' : 'Не найдено поле ввода на странице Claude Chat. Войдите в аккаунт.' });
      return;
    }
    clickStartAndConfirm(btn);
  }

  function handleStop() {
    const composer = findComposerRoot();
    const labels = visibleButtonsIn(composer).map(buttonLabel).filter(Boolean);
    const btn = findConfirmStopButton();
    post({ event: 'debug', message: `stop: active=${active}, clicked=${btn ? JSON.stringify(buttonLabel(btn)) : 'none'}, composer buttons=${JSON.stringify(labels)}` });

    if (!active && !btn) {
      cleanup();
      const text = readText(findInput());
      post({ event: 'stopped', text });
      return;
    }

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
    active = false;
    cleanup();
    const btn = findCancelButton();
    post({ event: 'debug', message: `cancel: clicked=${btn ? JSON.stringify(buttonLabel(btn)) : 'none'}` });
    if (btn) btn.click();
    clearInput(findInput());
  }

  async function pollLoop() {
    clog('pollLoop started on', location.href);
    post({ event: 'debug', message: `content: loaded on ${location.href}` });
    let lastErr = '';
    let lastErrAt = 0;
    const reportPollErr = (label, msg) => {
      const now = Date.now();
      if (msg !== lastErr || now - lastErrAt >= 10000) {
        lastErr = msg;
        lastErrAt = now;
        cerr(label, msg);
      }
    };
    while (true) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'poll' });
        if (res && typeof res.cmd === 'string') {
          lastErr = '';
          clog('received cmd:', res.cmd);
          try {
            if (res.cmd === 'start') handleStart();
            else if (res.cmd === 'stop') handleStop();
            else if (res.cmd === 'cancel') handleCancel();
          } catch (err) {
            cerr('cmd handler error:', res.cmd, err);
            post({ event: 'error', error: `Ошибка скрипта: ${err && err.message ? err.message : String(err)}` });
          }
        } else if (!res || res.error) {
          const lastRtErr = chrome.runtime?.lastError?.message;
          const msg = res ? String(res.error) : (lastRtErr ? `empty response (${lastRtErr})` : 'empty response');
          reportPollErr('poll error:', msg);
          await new Promise((r) => setTimeout(r, 500));
        } else {
          lastErr = '';
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        reportPollErr('poll exception:', msg);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  void pollLoop();
})();
