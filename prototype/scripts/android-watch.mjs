import { configureAndroidEnvironment } from './android-environment.mjs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, lstatSync, writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnTracked, stopChildren, stopWindowsProcess, windowsProcesses } from './watcher-processes.mjs';
import { createDeviceResolver, savedDeviceConnections } from './android-device-state.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, '..');
const tauriDir = path.join(root, 'src-tauri');
const androidDir = path.join(tauriDir, 'gen', 'android');
const toolsDir = path.join(root, '.android-tools');
const logsDir = path.join(root, 'logs');
const exe = process.platform === 'win32' ? '.exe' : '';
const gradleScript = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'arm64', 'debug', 'app-arm64-debug.apk');
const savedDevicesPath = path.join(toolsDir, 'devices.json');
const lockPath = path.join(toolsDir, 'watch.lock');

function fail(message) { throw new Error(message); }

const { adb, strip } = configureAndroidEnvironment(root);
process.env.TAURI_CONFIG = JSON.stringify({
  build: { devUrl: 'http://127.0.0.1:5174' },
  app: { windows: [{ label: 'main', title: 'Speech to Text', url: 'index.html' }] },
});

const rustPaths = ['src', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'tauri.android.conf.json', 'capabilities']
  .map(name => path.join(tauriDir, name));
const nativePaths = [...rustPaths,
  path.join(tauriDir, 'android'),
  path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml'),
  path.join(androidDir, 'app', 'src', 'main', 'java', 'com', 'speechtotext', 'app', 'MainActivity.kt'),
  path.join(androidDir, 'app', 'src', 'main', 'res'),
  ...['app/build.gradle.kts', 'app/tauri.build.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'settings.gradle', 'settings.gradle.kts']
    .map(name => path.join(androidDir, name)),
  path.join(scriptsDir, 'android-watch.mjs'), path.join(scriptsDir, 'android-device-state.mjs'), path.join(scriptsDir, 'android-environment.mjs')];

function signature(paths) {
  const entries = [];
  function add(item) {
    if (!existsSync(item)) return;
    const stat = statSync(item);
    if (stat.isFile()) entries.push(`${item}:${stat.mtimeMs}:${stat.size}`);
    else if (stat.isDirectory()) for (const name of readdirSync(item).sort()) add(path.join(item, name));
  }
  for (const item of paths) add(item);
  return entries.join('|');
}

function run(file, args, options = {}) {
  return new Promise(resolve => {
    const child = spawnTracked(file, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.logPrefix ? ['ignore', 'pipe', 'pipe'] : options.stdio ?? 'inherit',
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(file),
      timeout: options.timeout ?? (file === adb ? 60000 : undefined),
      windowsHide: true,
    });
    if (options.logPrefix) {
      for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        createInterface({ input, crlfDelay: Infinity }).on('line', line => output.write(`${options.logPrefix} ${line}\n`));
      }
    }
    child.once('error', error => {
      if (options.logPrefix) console.warn(`${options.logPrefix} ${error.message}`);
      resolve({ code: 1, error });
    });
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

function capture(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(file),
    timeout: file === adb ? 5000 : 15000 });
  if (result.error?.code === 'ETIMEDOUT' && file === adb) {
    console.warn(`ADB не отвечает: ${args.join(' ')}. Продолжу проверять подключение.`);
  }
  return result.error || result.status !== 0 ? '' : result.stdout ?? '';
}

function captureAdb(args) {
  return new Promise(resolve => {
    let output = '';
    const child = spawnTracked(adb, args, {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => resolve(''));
    child.once('close', code => resolve(code === 0 ? output : ''));
  });
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

let viteProcess;
let lockFd;
let stopping = false;
function stop() {
  stopping = true;
  stopChildren();
  releaseLock();
}
function releaseLock() {
  if (lockFd === undefined) return;
  closeSync(lockFd);
  lockFd = undefined;
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (owner.pid === process.pid) rmSync(lockPath, { force: true });
  } catch { /* A replaced or already-removed lock belongs to another process. */ }
}
process.once('exit', stop);
process.once('SIGINT', () => { stop(); process.exit(130); });
process.once('SIGTERM', () => { stop(); process.exit(143); });

function ownsLock(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  const command = capture('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`]);
  return command.replaceAll('\\', '/').includes('scripts/android-watch.mjs');
}

function acquireLock() {
  mkdirSync(toolsDir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      lockFd = openSync(lockPath, 'wx');
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        const contents = readFileSync(lockPath, 'utf8');
        try { owner = JSON.parse(contents); } catch { owner = { pid: Number(contents) }; }
        if (typeof owner === 'number') owner = { pid: owner };
      } catch { continue; }
      if (ownsLock(owner.pid)) fail('Android watcher уже запущен.');
      const stalePath = `${lockPath}.${process.pid}.${attempt}.stale`;
      try { renameSync(lockPath, stalePath); }
      catch (renameError) {
        if (renameError.code === 'ENOENT' || renameError.code === 'EEXIST') continue;
        throw renameError;
      }
      rmSync(stalePath, { force: true });
    }
  }
  fail('Не удалось безопасно захватить lock Android watcher.');
}

async function startVite() {
  if (await portOpen(5174)) {
    const normalizedRoot = root.replaceAll('\\', '/').toLowerCase();
    for (const item of windowsProcesses()) {
      const command = item.CommandLine?.replaceAll('\\', '/').toLowerCase() ?? '';
      if (command.includes(`${normalizedRoot}/node_modules/`) && command.includes('/vite/')
        && /["\s]5174(?:["\s]|$)/.test(command)) stopWindowsProcess(item.ProcessId);
    }
    if (await portOpen(5174)) fail('Порт 5174 занят другим процессом. Android Vite не запущен.');
  }
  mkdirSync(logsDir, { recursive: true });
  const out = await import('node:fs').then(fs => fs.createWriteStream(path.join(logsDir, 'android-vite.log'), { flags: 'a' }));
  const err = await import('node:fs').then(fs => fs.createWriteStream(path.join(logsDir, 'android-vite-errors.log'), { flags: 'a' }));
  viteProcess = spawnTracked(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5174', '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  viteProcess.stdout.pipe(out);
  viteProcess.stderr.pipe(err);
  viteProcess.stdout.pipe(process.stdout, { end: false });
  viteProcess.stderr.pipe(process.stderr, { end: false });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (viteProcess.exitCode !== null) fail('Не удалось запустить Vite; подробности в logs/android-vite-errors.log.');
    if (await portOpen(5174)) return;
    await delay(200);
  }
  fail('Vite не открыл порт 5174.');
}

function loadSavedDevices() {
  try {
    return savedDeviceConnections(JSON.parse(readFileSync(savedDevicesPath, 'utf8')));
  } catch { return new Map(); }
}
const savedDevices = loadSavedDevices();
const deviceResolver = createDeviceResolver({
  capture: captureAdb,
  savedDevices,
});
const { identify: identifyDevice, resolve: resolveDevices } = deviceResolver;
function sourceDeviceArgument() {
  const index = process.argv.indexOf('--device');
  const value = process.argv.find(arg => arg.startsWith('--device='));
  return value ? value.slice('--device='.length) : index >= 0 ? process.argv[index + 1] ?? '' : '';
}

async function gradleBuild() {
  const wrapper = path.join(androidDir, gradleScript);
  const args = ['-p', androidDir, ':app:assembleArm64Debug', '-x', ':app:rustBuildArm64Debug', '--console=plain', '--daemon', '--build-cache',
    '--configuration-cache', '-Dorg.gradle.vfs.watch=false', '-Dorg.gradle.internal.instrumentation.agent=false'];
  const logPath = path.join(logsDir, 'android-gradle.log');
  mkdirSync(logsDir, { recursive: true });
  let configurationCache = true;
  for (let attempt = 0; attempt < 30; attempt++) {
    const actualArgs = args.slice();
    if (!configurationCache) actualArgs[actualArgs.indexOf('--configuration-cache')] = '--no-configuration-cache';
    const result = await runGradleWithLog(wrapper, actualArgs, logPath);
    if (result.code === 0) return true;
    const log = readFileSync(logPath, 'utf8');
    if (configurationCache && /configuration cache|configuration-cache/i.test(log)) { configurationCache = false; continue; }
    if (process.platform === 'win32' && /Could not move temporary workspace/i.test(log)) {
      repairGradleCache();
      continue;
    }
    console.error(`Gradle завершился с кодом ${result.code}.`);
    return false;
  }
  return false;
}

async function runGradleWithLog(wrapper, args, logPath) {
  const logStream = (await import('node:fs')).createWriteStream(logPath, { flags: 'w' });
  const command = process.platform === 'win32' ? wrapper : existsSync(wrapper) ? wrapper : 'bash';
  const commandArgs = command === 'bash' ? [wrapper, ...args] : args;
  const result = await new Promise(resolve => {
    const child = spawnTracked(command, commandArgs, { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' });
    child.stdout.on('data', chunk => { process.stdout.write(chunk); logStream.write(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); logStream.write(chunk); });
    child.once('error', error => { console.error(error.message); resolve({ code: 1 }); });
    child.once('close', code => resolve({ code: code ?? 1 }));
  });
  await new Promise(resolve => logStream.end(resolve));
  return result;
}

function repairGradleCache() {
  for (const kind of ['groovy-dsl', 'kotlin-dsl/scripts', 'kotlin-dsl/accessors', 'transforms']) {
    const cacheRoot = path.join(process.env.GRADLE_USER_HOME, 'caches', '8.11.1', kind);
    if (!existsSync(cacheRoot)) continue;
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^([a-f0-9]{32}(?:-[A-Z]+)?)-[a-f0-9-]{36}$/);
      if (!match) continue;
      const source = path.join(cacheRoot, entry.name);
      const destination = path.join(cacheRoot, match[1]);
      if (!existsSync(destination) && existsSync(path.join(source, 'metadata.bin'))) {
        try { cpSync(source, destination, { recursive: true }); } catch { /* Gradle retries if the cache is still locked. */ }
      }
    }
  }
}

async function buildApk(buildRust) {
  const started = Date.now();
  const jniDir = path.join(androidDir, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
  const library = path.join(jniDir, 'libapp_lib.so');
  if (buildRust || !existsSync(library) || lstatSync(library).isSymbolicLink()) {
    const result = await run('cargo', ['build', '--manifest-path', path.join(tauriDir, 'Cargo.toml'), '--target', 'aarch64-linux-android', '--lib']);
    if (result.code !== 0) return false;
    mkdirSync(jniDir, { recursive: true });
    if (lstatSync(library, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(library);
    copyFileSync(path.join(tauriDir, 'target', 'aarch64-linux-android', 'debug', 'libapp_lib.so'), library);
    const stripped = await run(strip, ['--strip-debug', library]);
    if (stripped.code !== 0) return false;
  }
  if (!await gradleBuild()) return false;
  console.log(`Build: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

async function ensureReverse(endpoint, serial = endpoint) {
  const rules = await captureAdb(['-s', endpoint, 'reverse', '--list']);
  if (rules.split(/\r?\n/).some(line => /(?:^|\s)tcp:5174\s+tcp:5174(?:\s|$)/.test(line))) return true;
  return (await run(adb, ['-s', endpoint, 'reverse', 'tcp:5174', 'tcp:5174'], { timeout: 10000, logPrefix: `[${serial}]` })).code === 0;
}

async function installApk({ serial, endpoint }) {
  const started = Date.now();
  if (await identifyDevice(endpoint) !== serial) {
    console.warn(`[${serial}] ADB ${endpoint}: устройство сменилось или не отвечает. Установка отменена; повторно обнаружу телефон.`);
    return false;
  }
  if (!await ensureReverse(endpoint, serial)) return false;
  for (const args of [
    ['-s', endpoint, 'install', '-r', apk],
    ['-s', endpoint, 'shell', 'am', 'force-stop', 'com.speechtotext.app.debug'],
    ['-s', endpoint, 'shell', 'am', 'start', '-n', 'com.speechtotext.app.debug/com.speechtotext.app.MainActivity'],
  ]) if ((await run(adb, args, { logPrefix: `[${serial}]` })).code !== 0) return false;
  console.log(`[${serial}] Install and launch: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

async function main() {
  acquireLock();
  try {
    const requestedDevice = sourceDeviceArgument();
    let requestedSerial;
    if (requestedDevice) {
      if (!savedDevices.has(requestedDevice)) fail(`Серийный номер ${requestedDevice} отсутствует в devices.json.`);
      requestedSerial = requestedDevice;
      console.log(`Выбран телефон: ${requestedSerial}. Адрес подключения может меняться.`);
    }
    await startVite();
    let lastAttemptSignature = '';
    let lastRustSignature = '';
    let candidate = '';
    let changedAt = Date.now();
    let lastConnectionCheck = 0;
    let apkReady = false;
    const installedDeviceSerials = new Set();
    const lastInstallAttempts = new Map();
    let lastEndpoints = new Map();
    let waitingMessageShown = false;
    console.log('Android watcher активен. Изменения интерфейса обновляются через Vite; нативные — пересобираются и устанавливаются. Ctrl+C — остановить.');
    while (!stopping) {
      const currentSignature = signature(nativePaths);
      if (currentSignature !== candidate) { candidate = currentSignature; changedAt = Date.now(); }
      if (candidate !== lastAttemptSignature && Date.now() - changedAt >= 2000) {
        lastAttemptSignature = candidate;
        const rustSignature = signature(rustPaths);
        apkReady = false;
        if (await buildApk(rustSignature !== lastRustSignature)) {
          lastRustSignature = rustSignature;
          apkReady = true;
          installedDeviceSerials.clear();
          lastInstallAttempts.clear();
          waitingMessageShown = false;
          console.log('APK готов к установке.');
        } else console.warn('Сборка не прошла; установленная версия сохранена. Ожидаю изменения файлов.');
        if (signature(nativePaths) !== lastAttemptSignature) { apkReady = false; continue; }
      }
      if (Date.now() - lastConnectionCheck >= 10000) {
        lastConnectionCheck = Date.now();
        const devices = (await resolveDevices(true)).filter(device => !requestedSerial || device.serial === requestedSerial);
        const currentEndpoints = new Map(devices.map(device => [device.serial, device.endpoint]));
        for (const [serial] of lastEndpoints) {
          if (!currentEndpoints.has(serial)) console.log(`ADB-устройство отключено: ${serial}. Ожидаю повторного подключения.`);
        }
        const results = await Promise.allSettled(devices.map(async device => {
          if (lastEndpoints.get(device.serial) !== device.endpoint) {
            console.log(`ADB-устройство подключено: ${device.serial} (${device.endpoint})`);
            lastInstallAttempts.delete(device.serial);
          }
          if (!await ensureReverse(device.endpoint, device.serial)) {
            console.warn(`ADB ${device.endpoint}: не удалось восстановить доступ к Vite. Повторю проверку подключения.`);
            return;
          }
          if (apkReady && !installedDeviceSerials.has(device.serial)
            && Date.now() - (lastInstallAttempts.get(device.serial) ?? 0) >= 30000) {
            lastInstallAttempts.set(device.serial, Date.now());
            console.log(`Устанавливаю APK: ${device.serial} (${device.endpoint}).`);
            if (await installApk(device)) installedDeviceSerials.add(device.serial);
            else console.warn(`Не удалось установить APK на ${device.endpoint}. Повторю попытку через 30 секунд.`);
          }
        }));
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') console.warn(`ADB ${devices[index].endpoint}: ${result.reason?.message ?? result.reason}`);
        }
        if (apkReady && !devices.length && !waitingMessageShown) {
          console.log('ADB-устройства не найдены. APK собран; ожидаю подключения устройства.');
          waitingMessageShown = true;
        } else if (devices.length) waitingMessageShown = false;
        lastEndpoints = currentEndpoints;
      }
      await delay(1000);
    }
  } finally { stop(); }
}

main().catch(error => { console.error(error.message); stop(); process.exitCode = 1; });
