import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function configureAndroidEnvironment(root) {
  const toolsDir = path.join(root, '.android-tools');
  const androidDir = path.join(root, 'src-tauri', 'gen', 'android');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const shellScript = process.platform === 'win32' ? '.cmd' : '';
  const androidHost = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64') : 'linux-x86_64';
  const fail = message => { throw new Error(message); };
  function findSdk() {
    const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean);
    return candidates.find(candidate => existsSync(path.join(candidate, 'platform-tools', `adb${exe}`)));
  }

  const androidHome = findSdk();
  if (!androidHome) fail('Android SDK не найден: задайте ANDROID_HOME или ANDROID_SDK_ROOT.');
  const adb = path.join(androidHome, 'platform-tools', `adb${exe}`);

  const javaCandidates = [process.env.JAVA_HOME,
    ...(() => {
      const bundled = path.join(toolsDir, 'java');
      try { return readdirSync(bundled).map(name => path.join(bundled, name)).sort().reverse(); }
      catch { return []; }
    })()];
  const javaHome = javaCandidates.find(candidate => candidate && existsSync(path.join(candidate, 'bin', `javac${exe}`)));
  if (!javaHome) fail('JDK не найден: задайте JAVA_HOME или установите его в .android-tools/java.');

  const ndkHome = [process.env.NDK_HOME, process.env.ANDROID_NDK_HOME,
    ...(() => {
      try { return readdirSync(path.join(androidHome, 'ndk')).sort().reverse().map(name => path.join(androidHome, 'ndk', name)); }
      catch { return []; }
    })()].find(candidate => candidate && existsSync(path.join(candidate, 'toolchains', 'llvm', 'prebuilt', androidHost)));
  if (!ndkHome) fail(`Android NDK для ${androidHost} не найден.`);

  process.env.ANDROID_HOME = androidHome;
  process.env.JAVA_HOME = javaHome;
  process.env.NDK_HOME = ndkHome;
  process.env.GRADLE_USER_HOME = path.join(root, '.gradle');
  process.env.PATH = [path.join(javaHome, 'bin'), path.join(androidHome, 'platform-tools'), process.env.PATH]
    .filter(Boolean).join(path.delimiter);

  const linker = path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', androidHost, 'bin',
    `aarch64-linux-android24-clang${shellScript}`);
  const strip = path.join(ndkHome, 'toolchains', 'llvm', 'prebuilt', androidHost, 'bin', `llvm-strip${exe}`);
  process.env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = linker;

  const packageEnv = {
    TAURI_ANDROID_PACKAGE_PREFIX: 'com.speechtotext',
    TAURI_ANDROID_PACKAGE_NAME: 'app',
    WRY_ANDROID_PACKAGE: 'com.speechtotext.app',
    WRY_ANDROID_LIBRARY: 'app_lib',
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR: path.join(androidDir, 'app', 'src', 'main', 'java', 'com', 'speechtotext', 'app', 'generated'),
    TAURI_ANDROID_PROJECT_PATH: androidDir,
  };
  Object.assign(process.env, packageEnv);
  return { adb, strip };
}
