import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, loadSettings, normalizeSettings, parseSettingsJson, saveSettings, saveOverlayPosition, saveSettingsPreservingOverlayPosition, SETTINGS_STORAGE_KEY } from './config';
import { normalizeSpeechProviders } from './speech-provider-settings';

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
  it.each(['piper', 'gemini', 'elevenlabs'] as const)('preserves %s and all independent provider settings through saving and JSON import', provider => {
    const settings = defaultSettings();
    const step = settings.scenarios.find(scenario => scenario.id === 'voice-answer-scenario')!.steps.find(step => step.type === 'speak')!;
    step.speechProvider = provider;
    step.speechProviders = normalizeSpeechProviders({
      piper: { url: 'http://192.168.1.2:5000', voice: 'ru_RU-irina-medium', speakerId: 2, volume: 0, noiseScale: 0 },
      gemini: { apiKey: 'test-gemini', model: 'gemini-flash-tts', voice: 'Kore', style: 'спокойно' },
      elevenlabs: { apiKey: 'test-eleven', model: 'eleven_multilingual_v2', voice: 'voice', volume: .3 },
    });
    saveSettings(settings);
    for (const restored of [loadSettings(), parseSettingsJson(JSON.stringify(settings))]) {
      const actual = restored.scenarios.find(scenario => scenario.id === 'voice-answer-scenario')!.steps.find(candidate => candidate.id === step.id)!;
      expect(actual.speechProvider).toBe(provider);
      expect(actual.speechProviders).toEqual(step.speechProviders);
    }
  });
  it('preserves an unselected speech provider instead of restoring system', () => {
    const settings = defaultSettings();
    const scenario = settings.scenarios.find(item => item.id === 'voice-answer-scenario')!;
    scenario.steps.find(step => step.type === 'speak')!.speechProvider = 'none';
    const restored = parseSettingsJson(JSON.stringify(settings));
    expect(restored.scenarios.find(item => item.id === scenario.id)?.steps.find(step => step.type === 'speak')?.speechProvider).toBe('none');
  });
  it('preserves separate system speech settings through export and import', () => {
    const settings = defaultSettings();
    const scenario = settings.scenarios[0];
    const speak = { id: 'speak-settings', type: 'speak' as const, output: 'audio' as const, enabled: true,
      speechProvider: 'system' as const, speechSettings: { voiceId: 'voice', language: 'ru-RU', rate: 1.4, pitch: .9, volume: 0 } };
    scenario.steps.push(speak);
    const imported = parseSettingsJson(JSON.stringify(settings));
    expect(imported.scenarios[0].steps.at(-1)?.speechSettings).toEqual(speak.speechSettings);
  });
  it('defaults overlay text off and preserves each delivery step setting independently', () => {
    const settings = defaultSettings();
    const copy = settings.scenarios[0].steps.find(step => step.type === 'copy')!;
    const paste = settings.scenarios[0].steps.find(step => step.type === 'paste')!;
    expect(copy.showTextInOverlay).toBe(false);
    expect(paste.showTextInOverlay).toBe(false);
    copy.showTextInOverlay = true;
    saveSettings(settings);
    const saved = loadSettings().scenarios[0].steps;
    expect(saved.find(step => step.type === 'copy')?.showTextInOverlay).toBe(true);
    expect(saved.find(step => step.type === 'paste')?.showTextInOverlay).toBe(false);
    delete copy.showTextInOverlay;
    expect(normalizeSettings(settings).scenarios[0].steps.find(step => step.type === 'copy')?.showTextInOverlay).toBe(false);
  });
  it('migrates default delivery to a parallel group and preserves it through saving', () => {
    const settings = defaultSettings();
    settings.scenarioVersion = 10;
    settings.scenarios[0].steps.forEach(step => { delete step.parallelGroup; });
    const migrated = normalizeSettings(settings);
    const delivery = migrated.scenarios[0].steps.filter(step => step.type === 'copy' || step.type === 'paste');
    expect(delivery.map(step => step.parallelGroup)).toEqual(['default-delivery', 'default-delivery']);
    saveSettings(migrated);
    expect(loadSettings().scenarios[0].steps.filter(step => step.type === 'copy' || step.type === 'paste')
      .map(step => step.parallelGroup)).toEqual(['default-delivery', 'default-delivery']);
  });
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
      hotkeyRecord: 'Control+Shift+KeyD',
      hotkeyPause: 'Control+Alt+KeyD',
      hotkeyResume: 'Control+Alt+KeyD',
      historyMaxItems: 10,
    });
  });

  it('preserves saved pause hotkeys in settings and scenarios', () => {
    const settings = defaultSettings();
    settings.hotkeyPause = 'Control+Digit2';
    settings.hotkeyResume = 'Control+Digit2';
    const trigger = settings.scenarios[0].steps.find(step => step.type === 'startRecording')!;
    trigger.hotkeyPause = 'Control+Digit2';
    const migrated = parseSettingsJson(JSON.stringify(settings));
    expect(migrated.hotkeyPause).toBe('Control+Digit2');
    expect(migrated.hotkeyResume).toBe('Control+Digit2');
    expect(migrated.scenarios[0].steps.find(step => step.type === 'startRecording')?.hotkeyPause).toBe('Control+Digit2');

    settings.hotkeyPause = 'Control+KeyP';
    settings.hotkeyResume = 'Control+KeyP';
    trigger.hotkeyPause = 'Control+KeyP';
    const custom = parseSettingsJson(JSON.stringify(settings));
    expect(custom.hotkeyPause).toBe('Control+KeyP');
    expect(custom.hotkeyResume).toBe('Control+KeyP');
    expect(custom.scenarios[0].steps.find(step => step.type === 'startRecording')?.hotkeyPause).toBe('Control+KeyP');
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

  it('assigns the voice answer shortcut when migrating its previously empty trigger', () => {
    const settings = defaultSettings();
    settings.scenarioVersion = 12;
    const voice = settings.scenarios.find(item => item.id === 'voice-answer-scenario')!;
    voice.steps[0].hotkey = '';
    const copy = structuredClone(voice);
    copy.id = 'voice-copy';
    settings.scenarios.push(copy);
    const migrated = normalizeSettings(settings);
    expect(migrated.scenarios.find(item => item.id === voice.id)?.steps[0].hotkey).toBe('Control+Shift+KeyR');
    expect(migrated.scenarios.find(item => item.id === copy.id)?.steps[0].hotkey).toBe('');
    expect(migrated.scenarioVersion).toBe(16);
    voice.steps[0].hotkey = 'F8';
    expect(normalizeSettings(settings).scenarios.find(item => item.id === voice.id)?.steps[0].hotkey).toBe('F8');
  });

  it('uses defaults and logs a malformed stored configuration', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{ invalid');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadSettings()).toEqual(defaultSettings());
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
