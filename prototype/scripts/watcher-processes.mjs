import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

export function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { child.kill('SIGTERM'); }
  }
}

const children = new Set();

export function spawnTracked(file, args, options) {
  const child = spawn(file, args, { ...options, detached: process.platform !== 'win32' });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

export function stopChildren() {
  for (const child of children) stopProcessTree(child);
}

export function windowsProcesses() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Не удалось проверить работающие процессы.');
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function stopWindowsProcess(pid) {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true,
  });
  if (result.error) throw result.error;
}
