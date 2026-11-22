importScripts('config.js');

let es = null;

function post(payload) {
  if (typeof BRIDGE_URL !== 'string' || !BRIDGE_URL) return Promise.resolve();
  return fetch(`${BRIDGE_URL}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function sendToClaudeTab(cmd) {
  chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
    if (!tabs || !tabs.length) {
      void post({ event: 'error', error: 'Вкладка Claude Chat не найдена.' });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { cmd }, () => {
      if (chrome.runtime.lastError) {
        void post({ event: 'error', error: 'Скрипт на странице Claude Chat не отвечает. Обновите страницу.' });
      }
    });
  });
}

function connect() {
  if (typeof BRIDGE_URL !== 'string' || !BRIDGE_URL) return;
  if (es) es.close();
  es = new EventSource(`${BRIDGE_URL}/events`);
  es.onopen = () => {
    void post({ event: 'ready' });
    void post({ event: 'debug', message: 'background: SSE connected' });
  };
  es.onmessage = (e) => {
    void post({ event: 'debug', message: `background: cmd=${e.data}` });
    sendToClaudeTab(e.data);
  };
  es.onerror = () => {
    es.close();
    es = null;
    setTimeout(connect, 1000);
  };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!es) connect();
  if (msg && msg.event) void post(msg);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  if (!es) connect();
  port.onMessage.addListener(() => {
    if (!es) connect();
  });
});

connect();
