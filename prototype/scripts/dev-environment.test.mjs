import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

test('arbitrary Vite environment variables are exposed only in development', async () => {
  const values = { VITE_TEST_SETTING: 'first-value', VITE_OTHER_TEST_SETTING: 'second-value', PRIVATE_TEST_SETTING: 'private-value' };
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    for (const environment of [
      { command: 'serve', mode: 'development' },
      { command: 'build', mode: 'production' },
      { command: 'build', mode: 'development' },
      { command: 'serve', mode: 'test' },
      { command: 'serve', mode: 'production', isPreview: true },
    ]) {
      const loaded = await loadConfigFromFile(environment, configFile);
      assert.ok(loaded);
      const env = loadEnv(environment.mode, root, loaded.config.envPrefix);
      const development = environment.command === 'serve' && environment.mode === 'development';
      assert.equal(env.VITE_TEST_SETTING, development ? values.VITE_TEST_SETTING : undefined);
      assert.equal(env.VITE_OTHER_TEST_SETTING, development ? values.VITE_OTHER_TEST_SETTING : undefined);
      assert.equal(env.PRIVATE_TEST_SETTING, undefined);
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
