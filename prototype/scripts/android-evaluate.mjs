// Evaluate a diagnostic expression inside this prototype's Android WebView.
const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
const args = process.argv.slice(2);
const bubble = args.includes('--bubble');
const page = bubble
  ? pages.find(item => item.type === 'page' && /\/bubble\.html/.test(item.url))
  : pages.find(item => item.type === 'page' && /5174|tauri|localhost/.test(item.url)) || pages.find(item => item.type === 'page');
if (!page) throw new Error('Android WebView is not available for debugging');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const expression = args.find(arg => arg !== '--bubble') || '({title: document.title, android: /Android/.test(navigator.userAgent), panel: !!document.getElementById("control-panel-app"), buttons: [...document.querySelectorAll(".android-record-controls button")].map(button => button.textContent)})';
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Android evaluation timed out')), 20000);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
    else resolve(message.result.result.value);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
});
console.log(JSON.stringify(result));
socket.close();
