import { expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from './config';
import { isScenarioTemplate, scenarioTemplates, validateScenario } from './scenario';
import { scenarioBindings, scenarioTriggerProblem } from './scenario-triggers';
import { settingsForScenarioTrigger } from './scenario-runtime';

it('repairs the saved early single-step Claude scenario without changing its trigger or enabled state', () => {
  const settings = defaultSettings();
  settings.scenarioVersion = 19;
  const claude = settings.scenarios.find(item => item.id === 'claude-code-test')!;
  claude.steps = [claude.steps[0]];
  claude.steps[0].hotkey = 'F8';
  claude.enabled = true;
  const repaired = normalizeSettings(settings).scenarios.find(item => item.id === claude.id)!;
  expect(repaired.steps.map(step => step.type)).toEqual(['claudeCode', 'postprocess', 'copy', 'paste']);
  expect(repaired.steps[0].hotkey).toBe('F8');
  expect(repaired.enabled).toBe(true);
  expect(validateScenario(repaired)).toBeNull();
  expect(validateScenario({ ...repaired, steps: [repaired.steps[0]] })).toBeNull();
});

it('preserves and registers the Claude Code trigger and detects conflicts', () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios.find(item => item.id === 'claude-code-test')!;
  scenario.enabled = true;
  scenario.steps[0].hotkey = 'Control+Alt+KeyC';
  const restored = normalizeSettings(settings);
  expect(scenarioBindings(restored.scenarios, restored.hotkeyCancel)).toContainEqual({ scenarioId: scenario.id, shortcut: 'Control+Alt+KeyC' });
  expect(settingsForScenarioTrigger(restored, scenario.id)?.hotkeyRecord).toBe('Control+Alt+KeyC');
  scenario.steps[0].hotkey = settings.scenarios[0].steps[0].hotkey;
  expect(scenarioTriggerProblem(settings.scenarios, scenario, 'Escape')).toContain('уже назначен');
  scenario.steps[0].hotkey = 'Escape';
  expect(scenarioTriggerProblem(settings.scenarios, scenario, 'Escape')).toContain('отмены');
});

it('adds an ordinary voice-input scenario with Claude Code replacing capture and transcription', () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios.find(item => item.id === 'claude-code-test')!;
  expect(scenario.steps.map(step => step.type)).toEqual(['claudeCode', 'postprocess', 'copy', 'paste']);
  expect(scenario.steps[1].enabled).toBe(false);
  expect(validateScenario(scenario)).toBeNull();
  expect(isScenarioTemplate(scenario)).toBe(false);
  expect(scenarioTemplates().some(item => item.id === scenario.id)).toBe(false);
  expect(normalizeSettings(settings).scenarios.find(item => item.id === scenario.id)?.steps).toEqual(scenario.steps);
});

it('migrates the test scenario once and respects later deletion', () => {
  const settings = defaultSettings();
  settings.scenarioVersion = 17;
  settings.scenarios = settings.scenarios.filter(item => item.id !== 'claude-code-test');
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios.filter(item => item.id === 'claude-code-test')).toHaveLength(1);
  const reloaded = normalizeSettings(migrated);
  expect(reloaded.scenarios.filter(item => item.id === 'claude-code-test')).toHaveLength(1);
  reloaded.scenarios = reloaded.scenarios.filter(item => item.id !== 'claude-code-test');
  expect(normalizeSettings(reloaded).scenarios.some(item => item.id === 'claude-code-test')).toBe(false);
});
