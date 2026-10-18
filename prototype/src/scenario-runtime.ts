import { normalizeSettings, type AppSettings } from './config';
import { scenarioBindings } from './scenario-triggers';
import { isAndroid } from './android-runtime';

export function settingsForScenarioTrigger(settings: AppSettings, scenarioId?: string): AppSettings | null {
  if (isAndroid) {
    const id = scenarioId ?? settings.androidScenarioId;
    if (!settings.scenarios.some(scenario => scenario.id === id)) return null;
    return normalizeSettings(structuredClone({ ...settings, activeScenarioId: id }));
  }
  const bindings = scenarioBindings(settings.scenarios, settings.hotkeyCancel);
  const id = scenarioId ?? bindings.find(item => item.scenarioId === settings.activeScenarioId)?.scenarioId
    ?? bindings[0]?.scenarioId;
  if (!id || !bindings.some(item => item.scenarioId === id)) return null;
  // A run owns its configuration; choosing/editing another card cannot change it mid-flight.
  return normalizeSettings(structuredClone({ ...settings, activeScenarioId: id }));
}
