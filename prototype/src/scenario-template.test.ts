import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings, parseSettingsJson, resetGeneralSettings } from './config';
import { appendScenarioCopy, appendScenarioFromTemplate, resetScenarioToTemplate, canResetScenarioToTemplate, isScenarioTemplate, scenarioTemplates, type ScenarioTemplateId } from './scenario';
import { settingsForScenarioTrigger } from './scenario-runtime';
import { walkScenarioSteps } from './scenario-tree';
import { VOICE_TRANSCRIPTION_PROMPT, LEGACY_VOICE_TRANSCRIPTION_PROMPT, VOICE_INPUT_CLEANUP_PROMPT, VOICE_ANSWER_PROMPT } from './scenario-prompts';
import { LEGACY_MULTILINGUAL_TRANSCRIPTION_PROMPT, LEGACY_VOICE_INPUT_CLEANUP_PROMPT, LEGACY_VOICE_ANSWER_PROMPT } from './scenario-prompts';

it('defaults paste focus return to off for new and old settings and preserves an explicit opt-in', () => {
  const settings = defaultSettings();
  const paste = settings.scenarios[0].steps.find(step => step.type === 'paste')!;
  expect(paste.returnFocusToOriginalWindow).toBe(false);
  delete paste.returnFocusToOriginalWindow;
  expect(normalizeSettings(settings).scenarios[0].steps.find(step => step.type === 'paste')!.returnFocusToOriginalWindow).toBe(false);
  paste.returnFocusToOriginalWindow = true;
  const restored = parseSettingsJson(JSON.stringify(settings));
  expect(restored.scenarios[0].steps.find(step => step.type === 'paste')!.returnFocusToOriginalWindow).toBe(true);
  const copy = appendScenarioCopy(restored.scenarios, restored.scenarios[0]);
  expect(copy.steps.find(step => step.type === 'paste')!.returnFocusToOriginalWindow).toBe(true);
  expect(resetGeneralSettings(restored).scenarios[0].steps.find(step => step.type === 'paste')!.returnFocusToOriginalWindow).toBe(true);
});

it('updates previous built-in prompts in copies and branches without replacing user prompts', () => {
  const settings = defaultSettings(); settings.scenarioVersion = 16;
  const input = settings.scenarios[0];
  input.steps[1].transcription!.prompt = LEGACY_MULTILINGUAL_TRANSCRIPTION_PROMPT;
  input.steps[2].postprocessing!.prompt = LEGACY_VOICE_INPUT_CLEANUP_PROMPT;
  const copy = appendScenarioCopy(settings.scenarios, input);
  copy.steps[1].parallelBranches = [[structuredClone(input.steps[1])]];
  copy.steps[1].transcription!.prompt = 'Мой словарь';
  copy.steps[2].postprocessing!.prompt = '';
  settings.scenarios[1].steps[2].postprocessing!.prompt = LEGACY_VOICE_ANSWER_PROMPT;
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios[0].steps[1].transcription!.prompt).toBe('');
  expect(migrated.scenarios[0].steps[2].postprocessing!.prompt).toBe(VOICE_INPUT_CLEANUP_PROMPT);
  expect(migrated.scenarios[1].steps[2].postprocessing!.prompt).toBe(VOICE_ANSWER_PROMPT);
  const migratedCopy = migrated.scenarios.find(item => item.id === copy.id)!;
  expect(migratedCopy.steps[1].transcription!.prompt).toBe('Мой словарь');
  expect(migratedCopy.steps[2].postprocessing!.prompt).toBe('');
  expect(migratedCopy.steps[1].parallelBranches![0][0].transcription!.prompt).toBe('');
  expect(normalizeSettings(migrated)).toEqual(migrated);
});

it('replaces only the previous language-specific prompt, including copied branches', () => {
  const settings = defaultSettings(); settings.scenarioVersion = 15;
  settings.scenarios[0].steps[1].transcription!.prompt = LEGACY_VOICE_TRANSCRIPTION_PROMPT;
  appendScenarioCopy(settings.scenarios, settings.scenarios[0]);
  settings.scenarios[1].steps[1].transcription!.prompt = 'Custom vocabulary';
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios[0].steps[1].transcription?.prompt).toBe(VOICE_TRANSCRIPTION_PROMPT);
  expect(migrated.scenarios[4].steps[1].transcription?.prompt).toBe(VOICE_TRANSCRIPTION_PROMPT);
  expect(migrated.scenarios[1].steps[1].transcription?.prompt).toBe('Custom vocabulary');
});

it('initializes both templates with transcription guidance and their own postprocessing prompts', () => {
  const [input, answer] = scenarioTemplates();
  expect(input.steps[1].transcription?.prompt).toBe(VOICE_TRANSCRIPTION_PROMPT);
  expect(answer.steps[1].transcription?.prompt).toBe(VOICE_TRANSCRIPTION_PROMPT);
  expect(input.steps[2].postprocessing?.prompt).toBe(VOICE_INPUT_CLEANUP_PROMPT);
  expect(input.steps[2].enabled).toBe(false);
  expect(answer.steps[2].postprocessing?.prompt).toBe(VOICE_ANSWER_PROMPT);
});

it('migrates old built-in prompts once, preserving custom prompts and copies', () => {
  const settings = defaultSettings(); settings.scenarioVersion = 14;
  settings.scenarios[0].steps[1].transcription!.prompt = '';
  settings.scenarios[0].steps[2].postprocessing!.prompt = 'Моя очистка';
  settings.scenarios[1].steps[1].transcription!.prompt = 'Мой словарь';
  settings.scenarios[1].steps[2].postprocessing!.prompt = 'Ответь на запрос пользователя кратко и по существу. Текст ответа будет прочитан вслух.';
  const copy = appendScenarioCopy(settings.scenarios, settings.scenarios[0]);
  const migrated = normalizeSettings(settings);
  expect(migrated.scenarios[0].steps[1].transcription?.prompt).toBe(VOICE_TRANSCRIPTION_PROMPT);
  expect(migrated.scenarios[0].steps[2].postprocessing?.prompt).toBe('Моя очистка');
  expect(migrated.scenarios[1].steps[1].transcription?.prompt).toBe('Мой словарь');
  expect(migrated.scenarios[1].steps[2].postprocessing?.prompt).toBe(VOICE_ANSWER_PROMPT);
  expect(migrated.scenarios.find(item => item.id === copy.id)?.steps[1].transcription?.prompt).toBe('');
  migrated.scenarios[0].steps[1].transcription!.prompt = '';
  expect(normalizeSettings(migrated).scenarios[0].steps[1].transcription?.prompt).toBe('');
});

const templateIds: ScenarioTemplateId[] = ['default-scenario', 'voice-answer-scenario'];

describe('reset availability', () => {
  it('restores settings without changing the identity of surviving steps', () => {
    const scenario = appendScenarioFromTemplate([], 'default-scenario');
    const before = [...scenario.steps];
    const ids = before.map(step => step.id);
    scenario.steps[0].hotkey = 'F12';
    scenario.steps[1].transcription!.prompt = 'Custom';
    scenario.steps[3].showTextInOverlay = true;
    scenario.steps[1].parallelBranches = [[structuredClone(scenario.steps[2])]];
    expect(resetScenarioToTemplate(scenario)).toBe(true);
    scenario.steps.forEach((step, index) => {
      expect(step).toBe(before[index]);
      expect(step.id).toBe(ids[index]);
    });
    expect(scenario.steps[0].hotkey).not.toBe('F12');
    expect(scenario.steps[1].transcription!.prompt).not.toBe('Custom');
    expect(scenario.steps[1].parallelBranches).toBeUndefined();
    expect(scenario.steps[3].showTextInOverlay).not.toBe(true);
    expect(canResetScenarioToTemplate(scenario)).toBe(false);
  });

  it('keeps surviving step identities after removing or reordering steps, assigning fresh IDs only to missing steps', () => {
    const scenario = appendScenarioFromTemplate([], 'voice-answer-scenario');
    const [record, transcribe, postprocess, speak] = scenario.steps;
    scenario.steps = [record, speak, transcribe];
    resetScenarioToTemplate(scenario);
    expect(scenario.steps[0]).toBe(record);
    expect(scenario.steps[1]).toBe(transcribe);
    expect(scenario.steps[3]).toBe(speak);
    expect(scenario.steps[2].type).toBe('postprocess');
    expect(scenario.steps[2].id).not.toBe(postprocess.id);
    expect(new Set(scenario.steps.map(step => step.id)).size).toBe(4);
    expect(canResetScenarioToTemplate(scenario)).toBe(false);
  });

  it.each(templateIds)('stays unavailable for unchanged %s, including copies and saved settings', id => {
    const settings = normalizeSettings(defaultSettings());
    const source = settings.scenarios.find(item => item.id === id)!;
    expect(canResetScenarioToTemplate(source)).toBe(false);
    const copy = appendScenarioCopy(settings.scenarios, source);
    copy.name = 'Другое имя'; copy.enabled = !copy.enabled;
    copy.triggerClaim = { key: 'old', order: 99 };
    expect(canResetScenarioToTemplate(copy)).toBe(false);
  });

  it('detects nested settings and becomes unavailable after reverting or restoring', () => {
    const scenario = normalizeSettings(defaultSettings()).scenarios[1];
    const prompt = scenario.steps[2].postprocessing!.prompt;
    scenario.steps[2].postprocessing!.prompt = 'Свой промпт';
    expect(canResetScenarioToTemplate(scenario)).toBe(true);
    scenario.steps[2].postprocessing!.prompt = prompt;
    expect(canResetScenarioToTemplate(scenario)).toBe(false);
    scenario.steps[3].speechSettings!.volume = .4;
    expect(canResetScenarioToTemplate(scenario)).toBe(true);
    resetScenarioToTemplate(scenario);
    expect(canResetScenarioToTemplate(scenario)).toBe(false);
  });

  it('detects removed steps, branches, and grouping changes without treating group identifiers as settings', () => {
    const scenario = defaultSettings().scenarios[0];
    scenario.steps.filter(step => step.parallelGroup).forEach(step => { step.parallelGroup = 'new-id'; });
    expect(canResetScenarioToTemplate(scenario)).toBe(false);
    delete scenario.steps[3].parallelGroup;
    expect(canResetScenarioToTemplate(scenario)).toBe(true);
    resetScenarioToTemplate(scenario);
    scenario.steps.shift();
    expect(canResetScenarioToTemplate(scenario)).toBe(true);
    resetScenarioToTemplate(scenario);
    scenario.steps[1].parallelBranches = [[structuredClone(scenario.steps[1])]];
    expect(canResetScenarioToTemplate(scenario)).toBe(true);
  });
});

describe('editable initial scenarios', () => {
  it.each(templateIds)('keeps edits to %s in place after repeated saving and loading', id => {
    const settings = normalizeSettings(defaultSettings());
    const scenario = settings.scenarios.find(item => item.id === id)!;
    settings.activeScenarioId = id;
    scenario.name = 'Мой сценарий'; scenario.enabled = true;
    scenario.steps[0].hotkey = 'F8'; scenario.steps[1].transcription!.apiKey = 'test';
    scenario.steps[2].postprocessing!.prompt = 'Мой промпт';
    const saved = structuredClone(scenario.steps);
    const first = parseSettingsJson(JSON.stringify(settings));
    const second = parseSettingsJson(JSON.stringify(first));
    expect(second.scenarios).toHaveLength(4);
    expect(second.activeScenarioId).toBe(id);
    expect(second.scenarios.find(item => item.id === id)).toMatchObject({ name: 'Мой сценарий', enabled: true, steps: saved });
  });

  it.each(['По умолчанию', 'Стандартный сценарий'])('migrates the old name %s once without renaming copies', previousName => {
    const settings = normalizeSettings(defaultSettings()); settings.scenarioVersion = 13;
    settings.scenarios[0].name = previousName;
    const copy = appendScenarioCopy(settings.scenarios, settings.scenarios[0]);
    const migrated = normalizeSettings(settings);
    expect(migrated.scenarios[0].name).toBe('Голосовой ввод');
    expect(migrated.scenarios[0].steps).toEqual(settings.scenarios[0].steps);
    expect(migrated.scenarios.find(item => item.id === copy.id)?.name).toBe(copy.name);
    migrated.scenarios[0].name = previousName;
    expect(normalizeSettings(migrated).scenarios[0].name).toBe(previousName);
  });

  it('does not restore deleted scenarios, including an empty list', () => {
    const settings = defaultSettings(); settings.scenarios.splice(0, 1);
    expect(normalizeSettings(settings).scenarios.map(item => item.id)).toEqual(['voice-answer-scenario', 'selected-text-speech-scenario', 'claude-code-test']);
    settings.scenarios = [];
    const empty = parseSettingsJson(JSON.stringify(settings));
    expect(empty.scenarios).toEqual([]); expect(empty.activeScenarioId).toBe('');
    expect(settingsForScenarioTrigger(empty)).toBeNull();
    expect(scenarioTemplates()).toHaveLength(3);
  });

  it('keeps edited scenarios and selection when resetting general settings', () => {
    const settings = defaultSettings(); settings.scenarios[0].steps[0].hotkeyPause = 'F6';
    settings.overlayMaxWidthPercent = 80; settings.hotkeyCancel = 'F9';
    const snapshot = structuredClone(settings.scenarios), reset = resetGeneralSettings(settings);
    expect(reset.scenarios).toBe(settings.scenarios); expect(reset.scenarios).toEqual(snapshot);
    expect(reset.activeScenarioId).toBe(settings.activeScenarioId);
    expect(reset.hotkeyPause).toBe('F6'); expect(reset.hotkeyCancel).toBe('Escape');
  });
});

describe('immutable templates and explicit creation', () => {
  it('marks only original templates, while their copies remain ordinary scenarios', () => {
    const settings = defaultSettings();
    for (const source of settings.scenarios.filter(item => item.templateId)) {
      expect(isScenarioTemplate(source)).toBe(true);
      const copy = appendScenarioCopy(settings.scenarios, source);
      expect(copy.templateId).toBe(source.templateId);
      expect(isScenarioTemplate(copy)).toBe(false);
    }
  });
  it.each(templateIds)('creates an independent disabled scenario from %s', id => {
    const settings = defaultSettings();
    const template = scenarioTemplates().find(item => item.id === id)!;
    const created = appendScenarioFromTemplate(settings.scenarios, id);
    expect(created.enabled).toBe(false); expect(created.templateId).toBe(id); expect(created.id).not.toBe(id);
    expect(new Set(settings.scenarios.map(item => item.name)).size).toBe(settings.scenarios.length);
    const templateSteps = [...walkScenarioSteps(template.steps)], createdSteps = [...walkScenarioSteps(created.steps)];
    expect(createdSteps.map(({ id: _id, ...step }) => step)).toEqual(templateSteps.map(({ id: _id, ...step }) => step));
    expect(createdSteps.every(step => !templateSteps.some(original => original.id === step.id))).toBe(true);
    created.steps[0].hotkey = 'F10';
    expect(scenarioTemplates().find(item => item.id === id)?.steps[0].hotkey).toBe(template.steps[0].hotkey);
    expect(normalizeSettings(settings).scenarios.find(item => item.id === created.id)?.templateId).toBe(id);
  });

  it('restores the template only on explicit reset, keeping scenario identity, name and enabled state', () => {
    const settings = defaultSettings();
    const created = appendScenarioFromTemplate(settings.scenarios, 'voice-answer-scenario');
    created.name = 'Свой ответ'; created.enabled = true; created.steps.pop(); created.steps[2].postprocessing!.prompt = 'Изменение';
    const id = created.id;
    expect(resetScenarioToTemplate(created)).toBe(true);
    expect(created).toMatchObject({ id, name: 'Свой ответ', enabled: true, templateId: 'voice-answer-scenario' });
    expect(created.steps.map(step => step.type)).toEqual(['startRecording', 'transcribe', 'postprocess', 'speak']);
    expect(created.steps[2].postprocessing!.prompt).toBe(scenarioTemplates()[1].steps[2].postprocessing!.prompt);
    expect(settings.scenarios).toHaveLength(5);
  });

  it('retains manual-copy settings and template association without inheriting trigger ownership', () => {
    const settings = defaultSettings(), source = settings.scenarios[0];
    source.triggerClaim = { key: 'Ctrl+Shift+D', order: 0 }; source.steps[1].transcription!.apiKey = 'test';
    const copy = appendScenarioCopy(settings.scenarios, source);
    expect(copy.enabled).toBe(source.enabled); expect(copy.templateId).toBe(source.templateId);
    expect(copy.steps[1].transcription).toEqual(source.steps[1].transcription);
    expect(copy.triggerClaim).toBeUndefined();
  });
});
