import { isTriggerStep, scenarioCancelHotkey, type Scenario } from './scenario';

export function shortcutIdentity(value: string): string {
  return value.split('+').map(part => part.trim().toLowerCase()
    .replace(/^ctrl$/, 'control').replace(/^(win|super|cmd)$/, 'meta').replace(/^(key|digit)/, ''))
    .filter(Boolean).sort().join('+');
}

export function refreshScenarioTriggerClaims(scenarios: Scenario[]): void {
  let order = Math.max(0, ...scenarios.map(scenario => scenario.triggerClaim?.order ?? 0));
  for (const scenario of scenarios) {
    const key = shortcutIdentity(scenario.steps.find(step => isTriggerStep(step))?.hotkey ?? '');
    if (scenario.enabled === false || !key) { delete scenario.triggerClaim; continue; }
    if (scenario.triggerClaim?.key !== key) scenario.triggerClaim = { key, order: ++order };
  }
}

function triggerOwner(scenarios: readonly Scenario[], key: string): Scenario | undefined {
  return scenarios.filter(item => item.enabled !== false &&
    key === shortcutIdentity(item.steps.find(step => isTriggerStep(step))?.hotkey ?? ''))
    .sort((left, right) => (left.triggerClaim?.key === key ? left.triggerClaim.order : Infinity)
      - (right.triggerClaim?.key === key ? right.triggerClaim.order : Infinity))[0];
}

// `cancel` is the legacy shared key; a scenario's own cancel key takes precedence.
export function scenarioTriggerProblem(scenarios: readonly Scenario[], scenario: Scenario, cancel?: string): string | null {
  if (scenario.enabled === false) return null;
  const trigger = scenario.steps.find(step => isTriggerStep(step));
  const key = shortcutIdentity(trigger?.hotkey ?? '');
  if (!key) return 'Назначьте триггер запуска.';
  if (key === shortcutIdentity(scenario.hotkeyCancel || cancel || scenarioCancelHotkey(scenario)) || scenarios.some(item => item.enabled !== false &&
    key === shortcutIdentity(item.steps.find(step => isTriggerStep(step))?.hotkeyPause ?? ''))) {
    return 'Триггер совпадает с клавишей паузы или отмены.';
  }
  const stopOwner = scenarios.find(item => item.id !== scenario.id && item.enabled !== false && stopKey(item) === key);
  if (stopOwner) return `Триггер совпадает с клавишей стопа сценария «${stopOwner.name}».`;
  const owner = triggerOwner(scenarios, key);
  return owner && owner.id !== scenario.id ? `Триггер уже назначен сценарию «${owner.name}».` : null;
}

// A recording source can stop on its own key instead of its start key. Text
// from a selection has nothing to stop.
export function scenarioHasStop(scenario: Scenario): boolean {
  const type = scenario.steps.find(step => isTriggerStep(step))?.type;
  return type === 'startRecording' || type === 'claudeCode';
}

function stopKey(scenario: Scenario): string {
  if (!scenarioHasStop(scenario)) return '';
  return shortcutIdentity(scenario.steps.find(step => isTriggerStep(step))?.hotkeyStop ?? '');
}

export function scenarioStopProblem(scenarios: readonly Scenario[], scenario: Scenario): string | null {
  const key = stopKey(scenario);
  if (scenario.enabled === false || !key) return null;
  const trigger = scenario.steps.find(step => isTriggerStep(step));
  if (key === shortcutIdentity(trigger?.hotkey ?? '')) return 'Стоп совпадает со стартом: выберите «Как старт».';
  if (key === shortcutIdentity(scenarioCancelHotkey(scenario)) || key === shortcutIdentity(trigger?.hotkeyPause ?? '')) {
    return 'Стоп совпадает с клавишей паузы или отмены.';
  }
  const other = scenarios.find(item => item.id !== scenario.id && item.enabled !== false
    && (stopKey(item) === key || shortcutIdentity(item.steps.find(step => isTriggerStep(step))?.hotkey ?? '') === key));
  return other ? `Стоп совпадает с клавишей сценария «${other.name}».` : null;
}

// Registered next to the start keys; the `stop:` prefix tells the overlay to stop only.
export const STOP_BINDING_PREFIX = 'stop:';

export function scenarioStopBindings(scenarios: readonly Scenario[], cancel: string) {
  const started = new Set(scenarioBindings(scenarios, cancel).map(binding => binding.scenarioId));
  return scenarios.filter(scenario => started.has(scenario.id) && stopKey(scenario) && !scenarioStopProblem(scenarios, scenario))
    .map(scenario => ({ scenarioId: `${STOP_BINDING_PREFIX}${scenario.id}`, shortcut: scenario.steps.find(step => isTriggerStep(step))!.hotkeyStop! }));
}

export function scenarioBindings(scenarios: readonly Scenario[], cancel: string) {
  return scenarios.filter(scenario => scenario.enabled !== false && !scenarioTriggerProblem(scenarios, scenario, cancel))
    .map(scenario => ({ scenarioId: scenario.id, shortcut: scenario.steps.find(step => isTriggerStep(step))!.hotkey! }));
}
