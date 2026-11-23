let bridgeUrl = '';
let es = null;

async function loadBridgeUrl() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    const cfg = await res.json();
    if (cfg && typeof cfg.bridgeUrl === 'string' && cfg.bridgeUrl) {
      bridgeUrl = cfg.bridgeUrl;
    }
  } catch {}
  return bridgeUrl;
}

async function post(payload) {
  const url = bridgeUrl || await loadBridgeUrl();
  if (!url) return;
  return fetch(`${url}/state`, {
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
    const target = tabs.find((t) => t.active) || tabs[0];
    chrome.tabs.sendMessage(target.id, { cmd }, () => {
      if (chrome.runtime.lastError) {
        void post({ event: 'error', error: 'Скрипт на странице Claude Chat не отвечает. Обновите страницу.' });
      }
    });
  });
}

async function connect() {
  const url = await loadBridgeUrl();
  if (!url) {
    setTimeout(connect, 1000);
    return;
  }
  if (es) es.close();
  es = new EventSource(`${url}/events`);
  es.onopen = () => {
    void post({ event: 'ready' });
    void post({ event: 'debug', message: `background: SSE connected (${url})` });
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
  if (!es) void connect();
  if (msg && msg.event) void post(msg);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  if (!es) void connect();
  port.onMessage.addListener(() => {
    if (!es) void connect();
  });
});

void connect();
