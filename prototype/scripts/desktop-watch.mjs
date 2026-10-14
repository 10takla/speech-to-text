import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnTracked, stopChildren, stopWindowsProcess, windowsProcesses } from './watcher-processes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const devPort = 5175;
const tauriConfig = JSON.stringify({
  build: {
    devUrl: `http://127.0.0.1:${devPort}`,
    beforeDevCommand: `pnpm dev --port ${devPort} --strictPort`,
  },
});
let stopping = false;
let lockFd;
const lockPath = path.join(root, '.android-tools', 'desktop-watch.lock');
const lockContents = JSON.stringify({ pid: process.pid });

function stop() {
  stopping = true;
  stopChildren();
}
function releaseLock() {
  if (lockFd === undefined) return;
  closeSync(lockFd);
  lockFd = undefined;
  try {
    if (readFileSync(lockPath, 'utf8') === lockContents) rmSync(lockPath, { force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.once('exit', () => { stop(); releaseLock(); });
process.once('SIGINT', () => { stop(); process.exit(130); });
process.once('SIGTERM', () => { stop(); process.exit(143); });

try {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const processes = windowsProcesses();
  try { lockFd = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    let alive = false;
    try { process.kill(owner.pid, 0); alive = true; } catch { /* Previous watcher has exited. */ }
    if (alive && (process.platform !== 'win32' || processes.some(item =>
      item.ProcessId === owner.pid && item.CommandLine?.replaceAll('\\', '/').includes('scripts/desktop-watch.mjs')))) {
      throw new Error('Desktop watcher уже запущен. Остановите предыдущую задачу watch:all.');
    }
    rmSync(lockPath, { force: true });
    lockFd = openSync(lockPath, 'wx');
  }
  writeFileSync(lockFd, lockContents);

  // A forcibly closed terminal can leave Vite and the native app alive.
  const normalizedRoot = root.replaceAll('\\', '/').toLowerCase();
  for (const item of processes) {
    const command = item.CommandLine?.replaceAll('\\', '/').toLowerCase() ?? '';
    const executable = item.ExecutablePath?.replaceAll('\\', '/').toLowerCase() ?? '';
    if (executable === `${normalizedRoot}/src-tauri/target/debug/app.exe`
      || command.includes(`${normalizedRoot}/node_modules/@tauri-apps/cli/tauri.js`)
      || (command.includes(`${normalizedRoot}/node_modules/`) && command.includes('/vite/')
        && /["\s]5175(?:["\s]|$)/.test(command))) {
      console.log(`Завершаю оставшийся процесс предыдущего запуска: ${item.ProcessId}.`);
      stopWindowsProcess(item.ProcessId);
    }
  }
  const code = await new Promise(resolve => {
    const child = spawnTracked(process.execPath, [tauriCli, 'dev', '--config', tauriConfig], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (!stopping) process.exitCode = code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stop();
  releaseLock();
}
