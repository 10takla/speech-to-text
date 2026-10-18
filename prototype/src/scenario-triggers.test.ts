import { expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from './config';
import { appendScenarioCopy, createDefaultScenario, createVoiceAnswerScenario } from './scenario';
import { refreshScenarioTriggerClaims, scenarioBindings, scenarioTriggerProblem } from './scenario-triggers';
import { settingsForScenarioTrigger } from './scenario-runtime';

it('registers all enabled scenarios independently of the card being edited', () => {
  const first = createDefaultScenario();
  const second = createVoiceAnswerScenario();
  second.enabled = true; second.steps[0].hotkey = 'Control+Shift+KeyR';
  expect(scenarioBindings([first, second], 'Escape')).toEqual([
    { scenarioId: first.id, shortcut: 'Control+Shift+KeyD' },
    { scenarioId: second.id, shortcut: 'Control+Shift+KeyR' },
  ]);
  second.enabled = false;
  expect(scenarioBindings([first, second], 'Escape')).toHaveLength(1);
});

it('keeps the first trigger and warns only the conflicting scenario', () => {
  const first = createDefaultScenario();
  const second = createVoiceAnswerScenario();
  second.enabled = true; second.steps[0].hotkey = 'Shift+Ctrl+D';
  expect(scenarioBindings([first, second], 'Escape')).toEqual([
    { scenarioId: first.id, shortcut: 'Control+Shift+KeyD' },
  ]);
  expect(scenarioTriggerProblem([first, second], first, 'Escape')).toBeNull();
  expect(scenarioTriggerProblem([first, second], second, 'Escape')).toContain(first.name);
  second.steps[0].hotkey = 'Escape';
  expect(scenarioTriggerProblem([first, second], second, 'Escape')).toContain('отмены');
  second.steps[0].hotkey = '';
  expect(scenarioTriggerProblem([first, second], second, 'Escape')).toContain('Назначьте');
});

it('preserves ownership by assignment order even when the new scenario appears first in the list', () => {
  const first = createDefaultScenario();
  const second = createVoiceAnswerScenario();
  first.enabled = false;
  second.enabled = true; second.steps[0].hotkey = first.steps[0].hotkey;
  const scenarios = [first, second];
  refreshScenarioTriggerClaims(scenarios);
  first.enabled = true;
  refreshScenarioTriggerClaims(scenarios);
  expect(scenarioBindings(scenarios, 'Escape').map(binding => binding.scenarioId)).toEqual([second.id]);
  expect(scenarioTriggerProblem(scenarios, second, 'Escape')).toBeNull();
  expect(scenarioTriggerProblem(scenarios, first, 'Escape')).toContain(second.name);
  const settings = normalizeSettings({ ...defaultSettings(), scenarios });
  expect(scenarioBindings(settings.scenarios, 'Escape').map(binding => binding.scenarioId)).toEqual([second.id]);
  second.enabled = false;
  refreshScenarioTriggerClaims(scenarios);
  expect(scenarioBindings(scenarios, 'Escape').map(binding => binding.scenarioId)).toEqual([first.id]);
  second.enabled = true;
  refreshScenarioTriggerClaims(scenarios);
  expect(scenarioBindings(scenarios, 'Escape').map(binding => binding.scenarioId)).toEqual([first.id]);
});

it('does not take an existing trigger when changing the hotkey of an enabled scenario', () => {
  const first = createDefaultScenario();
  const second = createVoiceAnswerScenario();
  second.enabled = true; second.steps[0].hotkey = 'F8';
  const scenarios = [first, second];
  refreshScenarioTriggerClaims(scenarios);
  first.steps[0].hotkey = 'F8';
  refreshScenarioTriggerClaims(scenarios);
  expect(scenarioBindings(scenarios, 'Escape')).toEqual([{ scenarioId: second.id, shortcut: 'F8' }]);
  expect(scenarioTriggerProblem(scenarios, second, 'Escape')).toBeNull();
});

it.each([true, false])('copies every setting including the trigger and enabled=%s', enabled => {
  const source = createDefaultScenario();
  source.enabled = enabled;
  const original = structuredClone(source);
  const copy = appendScenarioCopy([source], source);
  expect(copy.enabled).toBe(enabled);
  expect(copy.steps[0].hotkey).toBe(source.steps[0].hotkey);
  expect(copy.steps.map(({ id: _id, ...step }) => step)).toEqual(source.steps.map(({ id: _id, ...step }) => step));
  expect(copy.steps[1].transcription).toEqual(source.steps[1].transcription);
  expect(copy.steps[1].transcription).not.toBe(source.steps[1].transcription);
  expect(source).toEqual(original);
});

it('warns only the enabled copy and keeps the original trigger owner after reload', () => {
  const source = createDefaultScenario();
  const scenarios = [source];
  refreshScenarioTriggerClaims(scenarios);
  const copy = appendScenarioCopy(scenarios, source);
  refreshScenarioTriggerClaims(scenarios);
  expect(scenarioTriggerProblem(scenarios, source, 'Escape')).toBeNull();
  expect(scenarioTriggerProblem(scenarios, copy, 'Escape')).toContain(source.name);
  expect(scenarioBindings(scenarios, 'Escape').map(item => item.scenarioId)).toEqual([source.id]);
  const restored = normalizeSettings({ ...defaultSettings(), scenarios });
  expect(scenarioBindings(restored.scenarios, 'Escape').map(item => item.scenarioId)).toEqual([source.id]);
  expect(restored.scenarios.find(item => item.id === copy.id)?.steps[0].hotkey).toBe(source.steps[0].hotkey);
});

it('migrates only the previously selected scenario to enabled', () => {
  const settings = defaultSettings();
  settings.activeScenarioId = settings.scenarios[1].id;
  for (const scenario of settings.scenarios) delete scenario.enabled;
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios.map(scenario => scenario.enabled)).toEqual([false, true]);
  migrated.scenarios[0].enabled = true;
  expect(normalizeSettings(migrated).scenarios.map(scenario => scenario.enabled)).toEqual([true, true]);
});

it('runs the triggered scenario with its own provider settings and a stable snapshot', () => {
  const settings = defaultSettings();
  const voice = settings.scenarios[1];
  voice.enabled = true; voice.steps[0].hotkey = 'F8';
  voice.steps[1].transcription!.apiKey = 'voice-key';
  voice.steps[2].postprocessing!.prompt = 'Ответь';
  const run = settingsForScenarioTrigger(settings, voice.id)!;
  expect(settings.activeScenarioId).toBe(settings.scenarios[0].id);
  expect(run.activeScenarioId).toBe(voice.id);
  expect(run.groqApiKey).toBe('voice-key');
  expect(run.geminiPrompt).toBe('Ответь');
  voice.steps[2].postprocessing!.prompt = 'Изменённый промпт';
  expect(run.scenarios[1].steps[2].postprocessing!.prompt).toBe('Ответь');
  voice.enabled = false;
  expect(settingsForScenarioTrigger(settings, voice.id)).toBeNull();
});
