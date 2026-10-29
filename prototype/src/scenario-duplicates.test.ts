import { expect, it } from 'vitest';
import { createStep, DEFAULT_SCENARIO_STEP_SETTINGS, type ScenarioStep } from './scenario';
import { findScenarioDuplicates } from './scenario-duplicates';

const matches = (steps: ScenarioStep[]) => findScenarioDuplicates({ id: 'test', name: 'Test', steps });
const input = () => [createStep('startRecording'), createStep('transcribe')];

it('treats different paste focus destinations as distinct on Windows', () => {
  const first = createStep('paste'), second = createStep('paste');
  delete first.returnFocusToOriginalWindow;
  expect(matches([...input(), first, second]).size).toBe(2);
  second.returnFocusToOriginalWindow = true;
  expect(matches([...input(), first, second]).size).toBe(0);
  expect(findScenarioDuplicates({ id: 'android', name: 'Android', steps: [...input(), first, second] },
    DEFAULT_SCENARIO_STEP_SETTINGS, false).size).toBe(2);
});

it('warns about all parallel matches without modifying the scenario', () => {
  const first = createStep('transcribe'), second = createStep('transcribe'), third = createStep('transcribe');
  first.parallelBranches = [[second], [third]];
  const steps = [createStep('startRecording'), first], before = JSON.stringify(steps);
  const result = matches(steps);
  expect(result.size).toBe(3); expect(result.get(first.id)?.map(item => item.id)).toEqual([second.id, third.id]);
  expect(JSON.stringify(steps)).toBe(before);
});

it('compares sequential actions across other actions and disabled transformations', () => {
  const first = createStep('copy'), disabled = createStep('postprocess'), second = createStep('copy');
  disabled.enabled = false;
  expect(matches([...input(), first, createStep('paste'), disabled, second]).size).toBe(2);
  disabled.enabled = true;
  expect(matches([...input(), first, disabled, second]).size).toBe(0);
});

it('finds a transformation in another branch after pass-through steps', () => {
  const first = createStep('postprocess'), second = createStep('postprocess'), action = createStep('copy');
  action.parallelBranches = [[first]];
  expect(matches([...input(), action, createStep('paste'), second]).size).toBe(2);
});

it('does not merge independent transformation outputs or sequential transformations', () => {
  const a = createStep('transcribe'), b = createStep('transcribe');
  a.parallelBranches = [[b, createStep('paste')]];
  const result = matches([createStep('startRecording'), a, createStep('paste')]);
  expect([...result.keys()].sort()).toEqual([a.id, b.id].sort());
  expect(matches([...input(), createStep('postprocess'), createStep('postprocess')]).size).toBe(0);
});

it('ignores disabled matches but traverses their branches', () => {
  const first = createStep('copy'), second = createStep('copy'); first.enabled = false;
  first.parallelBranches = [[second]];
  const result = matches([...input(), first, createStep('copy')]);
  expect(result.size).toBe(2);
  expect(result.has(first.id)).toBe(false);
});

it('compares effective defaults and ignores notification/display settings', () => {
  const a = createStep('copy'), b = createStep('copy');
  delete a.clipboardHistoryLevel; b.clipboardHistoryLevel = -1; b.showTextInOverlay = true; b.soundEnabled = false;
  expect(matches([...input(), a, b]).size).toBe(2);
  b.clipboardHistoryLevel = 0;
  expect(matches([...input(), a, b]).size).toBe(0);
  expect(findScenarioDuplicates({id:'test',name:'Test',steps:[...input(),a,b]},DEFAULT_SCENARIO_STEP_SETTINGS,false).size).toBe(2);
});

it('respects model, prompt, generation values and ignores property order', () => {
  const a = createStep('postprocess'), b = createStep('postprocess'); a.parallelBranches = [[b]];
  a.postprocessing!.generationConfig = {temperature:.3,topP:.8};
  b.postprocessing!.generationConfig = {topP:.8,temperature:.3};
  expect(matches([...input(), a]).size).toBe(2);
  b.postprocessing!.prompt += ' different'; expect(matches([...input(), a]).size).toBe(0);
});

it('ignores inactive chunk parameters and inactive speech providers', () => {
  const a = createStep('transcribe'), b = createStep('transcribe'); a.parallelBranches = [[b]];
  a.transcription!.liveTranscriptionEnabled = b.transcription!.liveTranscriptionEnabled = false;
  b.transcription!.liveSilenceDurationMs += 50;
  expect(matches([createStep('startRecording'),a]).size).toBe(2);
  b.transcription!.model += '-other'; expect(matches([createStep('startRecording'),a]).size).toBe(0);
  const s1=createStep('speak'),s2=createStep('speak');s1.parallelBranches=[[s2]];
  // Absent settings read as the system voice; new steps start with the language picked by the text.
  delete s1.speechSettings; s2.speechSettings!.language = '';
  expect(matches([...input(),s1]).size).toBe(2);
  s2.speechSettings!.volume=.5; expect(matches([...input(),s1]).size).toBe(0);
});

it('uses inherited settings when step-specific settings are absent', () => {
  const a=createStep('transcribe'),b=createStep('transcribe');a.parallelBranches=[[b]];
  delete a.transcription;
  expect(matches([createStep('startRecording'),a]).size).toBe(2);
});

it('compares members of an action group and later actions on the shared input', () => {
  const a=createStep('copy'),b=createStep('copy'),c=createStep('copy');a.parallelGroup=b.parallelGroup='g';
  expect(matches([...input(),a,b,c]).size).toBe(3);
});
