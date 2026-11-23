let bridgeUrl = '';

function log(...args) {
  console.log('[claude-chat-bg]', ...args);
}
function logErr(...args) {
  console.error('[claude-chat-bg]', ...args);
  if (bridgeUrl) {
    void fetch(`${bridgeUrl}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'debug', message: `[bg-err] ${args.map(String).join(' ')}` }),
    }).catch(() => {});
  }
}

async function reportBg(message) {
  try {
    const url = await loadBridgeUrl();
    if (!url) return;
    await fetch(`${url}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'debug', message: `[bg] ${message}` }),
    });
  } catch {
    // ignore
  }
}

self.addEventListener('error', (event) => {
  const msg = event?.error?.stack || event?.message || String(event);
  logErr('uncaught error:', msg);
  void reportBg(`uncaught error: ${msg}`);
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const msg = reason?.stack || reason?.message || String(reason);
  logErr('unhandledrejection:', msg);
  void reportBg(`unhandledrejection: ${msg}`);
});

log('service worker evaluated');
void reportBg('service worker evaluated');

async function loadBridgeUrl(force = false) {
  if (bridgeUrl && !force) return bridgeUrl;
  try {
    const configUrl = chrome.runtime.getURL('config.json');
    const res = await fetch(configUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`config.json HTTP ${res.status}`);
    const cfg = await res.json();
    if (cfg && typeof cfg.bridgeUrl === 'string' && cfg.bridgeUrl) {
      bridgeUrl = cfg.bridgeUrl;
      log('loaded bridgeUrl:', bridgeUrl);
    } else {
      logErr('config.json missing bridgeUrl:', JSON.stringify(cfg));
    }
  } catch (err) {
    logErr('loadBridgeUrl failed:', err && err.message ? err.message : String(err));
  }
  return bridgeUrl;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const url = await loadBridgeUrl();
    if (!url) {
      logErr('no bridgeUrl for msg:', JSON.stringify(msg));
      sendResponse({ error: 'no-url' });
      return;
    }
    if (msg && msg.type === 'poll') {
      const res = await fetch(`${url}/poll`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.cmd) log('poll received cmd:', data.cmd, 'tab:', sender?.tab?.id);
      sendResponse(data);
      return;
    }
    if (msg && msg.event) {
      const res = await fetch(`${url}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw new Error(`state HTTP ${res.status}`);
      sendResponse({ ok: true });
      return;
    }
    log('ignored unknown msg:', JSON.stringify(msg));
    sendResponse({ ok: false });
  })().catch((err) => {
    logErr('message handler failed:', msg?.type || msg?.event, err && err.message ? err.message : String(err));
    bridgeUrl = '';
    sendResponse({ error: err && err.message ? err.message : 'fetch-failed' });
  });
  return true;
});
