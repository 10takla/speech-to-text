(() => {
  if (window.__sttWsHookInstalled) return;
  window.__sttWsHookInstalled = true;

  const OrigWS = window.WebSocket;
  if (typeof OrigWS !== 'function') return;

  const TARGET = '/api/ws/speech_to_text/voice_stream';
  let seq = 0;

  function emit(detail) {
    try {
      window.dispatchEvent(new CustomEvent('__stt_ws_event', { detail }));
    } catch {
      // ignore
    }
  }

  function extractType(raw) {
    if (typeof raw !== 'string') return null;
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj.type === 'string' ? obj.type : null;
    } catch {
      return null;
    }
  }

  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      const urlStr = typeof args[0] === 'string' ? args[0] : String(args[0] || '');
      if (urlStr.includes(TARGET)) {
        const id = ++seq;
        ws.addEventListener('open', () => emit({ kind: 'open', id }));
        ws.addEventListener('message', (ev) => {
          const msgType = extractType(ev.data);
          if (msgType === 'TranscriptEndpoint' || msgType === 'TranscriptText') {
            emit({ kind: 'msg', id, msgType });
          }
        });
        ws.addEventListener('close', (ev) => {
          emit({ kind: 'close', id, code: ev.code, clean: ev.wasClean });
        });
        ws.addEventListener('error', () => emit({ kind: 'error', id }));
      }
      return ws;
    },
  });
})();
