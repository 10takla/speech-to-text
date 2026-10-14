import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, loadSettings, normalizeSettings, parseSettingsJson, saveSettings, saveOverlayPosition, saveSettingsPreservingOverlayPosition, SETTINGS_STORAGE_KEY } from './config';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
});

describe('settings parsing', () => {
  it('preserves model generation settings across saving and import', () => {
    const settings = defaultSettings();
    const step = settings.scenarios[0].steps.find(step => step.type === 'postprocess')!;
    const generationConfig = { temperature: 0, topP: 0.9, topK: 30, maxOutputTokens: 1000 };
    step.postprocessing!.generationConfig = generationConfig;
    saveSettings(settings);
    expect(loadSettings().scenarios[0].steps.find(step => step.type === 'postprocess')?.postprocessing?.generationConfig).toEqual(generationConfig);
    expect(parseSettingsJson(JSON.stringify(settings)).scenarios[0].steps.find(step => step.type === 'postprocess')?.postprocessing?.generationConfig).toEqual(generationConfig);
  });
  it('preserves the scenario microphone across saving and import, with a system default for older settings', () => {
    const settings = defaultSettings();
    const recording = settings.scenarios[0].steps.find(step => step.type === 'startRecording')!;
    recording.microphoneId = 'USB Microphone';
    saveSettings(settings);
    expect(loadSettings().scenarios[0].steps[0].microphoneId).toBe('USB Microphone');
    expect(parseSettingsJson(JSON.stringify(settings)).scenarios[0].steps[0].microphoneId).toBe('USB Microphone');
    delete recording.microphoneId;
    expect(normalizeSettings(settings).scenarios[0].steps[0].microphoneId).toBe('');
  });

  it('defaults missing clipboard levels to -1 and persists the selected level', () => {
    const settings = defaultSettings();
    const step = settings.scenarios[0].steps.find(step => step.type === 'copy')!;
    expect(step.clipboardHistoryLevel).toBe(-1);
    step.clipboardHistoryLevel = -7;
    saveSettings(settings);
    expect(loadSettings().scenarios[0].steps.find(step => step.type === 'copy')?.clipboardHistoryLevel).toBe(-7);

    delete step.clipboardHistoryLevel;
    expect(normalizeSettings(settings).scenarios[0].steps.find(step => step.type === 'copy')?.clipboardHistoryLevel).toBe(-1);
  });

  it.each([1, -1.5, Infinity, '-2'])('rejects invalid saved clipboard level %s', level => {
    const settings = defaultSettings();
    const step = settings.scenarios[0].steps.find(step => step.type === 'copy')!;
    Object.assign(step, { clipboardHistoryLevel: level });
    expect(normalizeSettings(settings).scenarios[0].steps.find(step => step.type === 'copy')?.clipboardHistoryLevel).toBe(-1);
  });

  it('preserves a saved center and accepts legacy positions without a center', () => {
    expect(normalizeSettings({ position: { x: -500, y: 80, centerX: -200 } }).position)
      .toEqual({ x: -500, y: 80, centerX: -200 });
    expect(normalizeSettings({ position: { x: -500, y: 80 } }).position)
      .toEqual({ x: -500, y: 80 });
    expect(normalizeSettings({ position: { x: 10, y: 20, centerX: Infinity } }).position)
      .toEqual({ x: 10, y: 20 });
  });

  it('does not replace a new overlay position with the panels stale coordinates', () => {
    const panel = defaultSettings();
    panel.position = { x: 100, y: 80 };
    saveSettings(panel);
    const dragged = { x: 700, y: 500, centerX: 900 };
    saveOverlayPosition(dragged);
    panel.overlayMaxWidthPercent = 80;
    saveSettingsPreservingOverlayPosition(panel);
    expect(loadSettings()).toMatchObject({ position: dragged, overlayMaxWidthPercent: 80 });

    // Запись позиции тоже должна сохранить свежие настройки панели.
    saveOverlayPosition({ x: 200, y: 100, centerX: 400 });
    expect(loadSettings()).toMatchObject({
      position: { x: 200, y: 100, centerX: 400 }, overlayMaxWidthPercent: 80,
    });
  });

  it('migrates legacy hotkeys and fills missing settings with defaults', () => {
    expect(parseSettingsJson(JSON.stringify({ hotkeyRecord: 'Space', hotkeyPause: 'F2' }))).toMatchObject({
      hotkeyRecord: 'Control+Digit1',
      hotkeyPause: 'Control+Digit2',
      hotkeyResume: 'Control+Digit2',
      historyMaxItems: 10,
    });
  });

  it('falls back to defaults for values with invalid types or enum values', () => {
    expect(normalizeSettings({
      soundEnabled: 'yes',
      soundProfile: 'loud',
      liveMaxChunkDurationSeconds: Number.NaN,
      position: { x: 'left', y: 0 },
    })).toMatchObject({
      soundEnabled: true,
      soundProfile: 'default',
      liveMaxChunkDurationSeconds: 9,
      position: null,
    });
  });

  it('rejects malformed JSON instead of partially applying it', () => {
    expect(() => parseSettingsJson('{ invalid')).toThrow(SyntaxError);
  });

  it('uses defaults and logs a malformed stored configuration', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{ invalid');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadSettings()).toEqual(defaultSettings());
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
