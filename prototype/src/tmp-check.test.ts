// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { mountSpeechProvider } from './speech-settings-editor';
import { createStep } from './scenario';
import { hasStepSettings } from './step-settings-block';
it('tmp', () => {
  const content = document.createElement('div');
  mountSpeechProvider(content, createStep('speak'), () => {}, () => {});
  console.log('TMP', content.outerHTML.slice(0, 400), hasStepSettings(content));
  expect(1).toBe(1);
});
