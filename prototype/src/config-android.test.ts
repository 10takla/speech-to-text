import { expect, it, vi } from 'vitest';

vi.mock('./android-runtime', () => ({ isAndroid: true, androidCall: vi.fn() }));

import { defaultSettings, normalizeSettings } from './config';

it('enables paste and copying by default on Android', () => {
  const settings = defaultSettings();
  expect(settings.autoPasteActiveWindow).toBe(true);
  expect(settings.scenarios[0].steps.find(step => step.type === 'paste')?.enabled).toBe(true);
  expect(settings.scenarios[0].steps.find(step => step.type === 'copy')?.enabled).toBe(true);
});

it('reverses the previous Android paste migration once, then preserves manual changes', () => {
  const settings = defaultSettings();
  settings.scenarioVersion = 9;
  settings.scenarios[0].steps.find(step => step.type === 'paste')!.enabled = false;
  const migrated = normalizeSettings(settings);
  expect(migrated.autoPasteActiveWindow).toBe(true);
  migrated.scenarios[0].steps.find(step => step.type === 'paste')!.enabled = false;
  expect(normalizeSettings(migrated).autoPasteActiveWindow).toBe(false);
});
