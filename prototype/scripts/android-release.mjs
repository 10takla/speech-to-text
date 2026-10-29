import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAndroidEnvironment } from './android-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'src-tauri', 'gen', 'android');
configureAndroidEnvironment(root);
process.env.TAURI_CONFIG = JSON.stringify({ build: { frontendDist: '../dist-android-release' } });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Android release JDK: ${process.env.JAVA_HOME}`);
run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')]);
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', 'dist-android-release']);
run('cargo', ['build', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml'),
  '--target', 'aarch64-linux-android', '--release', '--lib', '--features', 'tauri/custom-protocol']);
const jniDir = path.join(androidDir, 'app/src/release/jniLibs/arm64-v8a');
mkdirSync(jniDir, { recursive: true });
copyFileSync(path.join(root, 'src-tauri/target/aarch64-linux-android/release/libapp_lib.so'), path.join(jniDir, 'libapp_lib.so'));
console.log('Release library copied. Assembling APK...');
const args = [':app:assembleArm64Release', '-x', ':app:rustBuildArm64Release', '--console=plain',
  '--build-cache', '--no-configuration-cache', '--project-cache-dir', path.join(root, '.gradle-android-release'),
  '-Dorg.gradle.vfs.watch=false', '-Dorg.gradle.internal.instrumentation.agent=false'];
if (process.platform === 'win32') {
  run(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'gradlew.bat', ...args], androidDir);
} else {
  run('./gradlew', args, androidDir);
}
