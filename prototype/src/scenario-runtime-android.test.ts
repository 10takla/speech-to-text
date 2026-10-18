import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./android-runtime', () => ({ isAndroid: true, androidCall: vi.fn(async () => {}) }));

import { defaultSettings, loadSettings, normalizeSettings, resetGeneralSettings, saveSettings } from './config';
import { androidCall } from './android-runtime';
import { settingsForScenarioTrigger } from './scenario-runtime';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('runs the selected overlay scenario without desktop enablement or a keyboard trigger', () => {
  const settings = defaultSettings();
  const voice = settings.scenarios[1];
  settings.androidScenarioId = voice.id;
  voice.enabled = false;
  voice.steps[0].hotkey = '';
  voice.steps[1].transcription!.apiKey = 'voice-key';
  const run = settingsForScenarioTrigger(settings)!;
  expect(run.activeScenarioId).toBe(voice.id);
  expect(run.groqApiKey).toBe('voice-key');
  expect(settings.activeScenarioId).toBe(settings.scenarios[0].id);
  expect(settings.scenarios[0].enabled).toBe(true);
  expect(voice.enabled).toBe(false);
});

it('keeps overlay selection independent of the card being edited and freezes running settings', () => {
  const settings = defaultSettings();
  const voice = settings.scenarios[1];
  settings.androidScenarioId = voice.id;
  settings.activeScenarioId = settings.scenarios[0].id;
  const run = settingsForScenarioTrigger(normalizeSettings(settings))!;
  settings.androidScenarioId = settings.scenarios[0].id;
  voice.steps[2].postprocessing!.prompt = 'Изменённый промпт';
  expect(run.activeScenarioId).toBe(voice.id);
  expect(run.scenarios[1].steps[2].postprocessing!.prompt).not.toBe('Изменённый промпт');
  expect(settingsForScenarioTrigger(settings)!.activeScenarioId).toBe(settings.scenarios[0].id);
});

it('migrates the previous selection and falls back when the selected scenario was deleted', () => {
  const legacy: Partial<ReturnType<typeof defaultSettings>> = defaultSettings();
  delete legacy.androidScenarioId;
  legacy.activeScenarioId = legacy.scenarios![1].id;
  const settings = normalizeSettings(legacy);
  expect(settings.androidScenarioId).toBe(legacy.activeScenarioId);
  settings.scenarios = settings.scenarios.filter(scenario => scenario.id !== settings.androidScenarioId);
  const restored = normalizeSettings(settings);
  expect(restored.androidScenarioId).toBe(restored.scenarios[0].id);
  expect(settingsForScenarioTrigger(restored)!.activeScenarioId).toBe(restored.scenarios[0].id);
});

it('saves the overlay choice across reloads and forwards it to the Android overlay', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  const settings = defaultSettings();
  settings.androidScenarioId = settings.scenarios[1].id;
  saveSettings(settings);
  const restored = loadSettings();
  expect(restored.androidScenarioId).toBe(settings.scenarios[1].id);
  expect(settingsForScenarioTrigger(restored)!.activeScenarioId).toBe(settings.scenarios[1].id);
  expect(androidCall).toHaveBeenCalledWith('saveBubbleConfiguration', { text: JSON.stringify(settings) });
  expect(resetGeneralSettings(settings).androidScenarioId).toBe(settings.androidScenarioId);
});

it('does not start a different scenario when none is selected or available', () => {
  const settings = normalizeSettings({ ...defaultSettings(), scenarios: [] });
  expect(settings.androidScenarioId).toBe('');
  expect(settingsForScenarioTrigger(settings)).toBeNull();
  expect(settingsForScenarioTrigger(defaultSettings(), 'missing')).toBeNull();
});
