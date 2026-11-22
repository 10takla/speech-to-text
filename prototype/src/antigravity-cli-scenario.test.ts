import { expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from './config';
import { isScenarioTemplate, scenarioTemplates, validateScenario } from './scenario';
import { scenarioBindings, scenarioTriggerProblem } from './scenario-triggers';
import { settingsForScenarioTrigger } from './scenario-runtime';

it('preserves and registers the Antigravity CLI trigger and detects conflicts', () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios.find(item => item.id === 'antigravity-cli-test')!;
  scenario.enabled = true;
  scenario.steps[0].hotkey = 'Control+Alt+KeyA';
  const restored = normalizeSettings(settings);
  expect(scenarioBindings(restored.scenarios, restored.hotkeyCancel)).toContainEqual({ scenarioId: scenario.id, shortcut: 'Control+Alt+KeyA' });
  expect(settingsForScenarioTrigger(restored, scenario.id)?.hotkeyRecord).toBe('Control+Alt+KeyA');
  scenario.steps[0].hotkey = settings.scenarios[0].steps[0].hotkey;
  expect(scenarioTriggerProblem(settings.scenarios, scenario, 'Escape')).toContain('уже назначен');
  scenario.steps[0].hotkey = 'Escape';
  expect(scenarioTriggerProblem(settings.scenarios, scenario, 'Escape')).toContain('отмены');
});

it('adds an ordinary voice-input scenario with Antigravity CLI replacing capture and transcription', () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios.find(item => item.id === 'antigravity-cli-test')!;
  expect(scenario.steps.map(step => step.type)).toEqual(['antigravityCli', 'postprocess', 'paste', 'copy']);
  expect(scenario.steps[1].enabled).toBe(false);
  expect(validateScenario(scenario)).toBeNull();
  expect(validateScenario({ ...scenario, steps: [scenario.steps[0]] })).toBeNull();
  expect(isScenarioTemplate(scenario)).toBe(false);
  expect(scenarioTemplates().some(item => item.id === scenario.id)).toBe(false);
});

it('migrates the Antigravity CLI scenario once and respects later deletion', () => {
  const settings = defaultSettings();
  settings.scenarioVersion = 25;
  settings.scenarios = settings.scenarios.filter(item => item.id !== 'antigravity-cli-test');
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios.filter(item => item.id === 'antigravity-cli-test')).toHaveLength(1);
  const reloaded = normalizeSettings(migrated);
  expect(reloaded.scenarios.filter(item => item.id === 'antigravity-cli-test')).toHaveLength(1);
  reloaded.scenarios = reloaded.scenarios.filter(item => item.id !== 'antigravity-cli-test');
  expect(normalizeSettings(reloaded).scenarios.some(item => item.id === 'antigravity-cli-test')).toBe(false);
});
