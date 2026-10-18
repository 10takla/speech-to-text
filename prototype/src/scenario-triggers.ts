import type { Scenario } from './scenario';

export function shortcutIdentity(value: string): string {
  return value.split('+').map(part => part.trim().toLowerCase()
    .replace(/^ctrl$/, 'control').replace(/^(win|super|cmd)$/, 'meta').replace(/^(key|digit)/, ''))
    .filter(Boolean).sort().join('+');
}

export function refreshScenarioTriggerClaims(scenarios: Scenario[]): void {
  let order = Math.max(0, ...scenarios.map(scenario => scenario.triggerClaim?.order ?? 0));
  for (const scenario of scenarios) {
    const key = shortcutIdentity(scenario.steps.find(step => step.type === 'startRecording')?.hotkey ?? '');
    if (scenario.enabled === false || !key) { delete scenario.triggerClaim; continue; }
    if (scenario.triggerClaim?.key !== key) scenario.triggerClaim = { key, order: ++order };
  }
}

function triggerOwner(scenarios: readonly Scenario[], key: string): Scenario | undefined {
  return scenarios.filter(item => item.enabled !== false &&
    key === shortcutIdentity(item.steps.find(step => step.type === 'startRecording')?.hotkey ?? ''))
    .sort((left, right) => (left.triggerClaim?.key === key ? left.triggerClaim.order : Infinity)
      - (right.triggerClaim?.key === key ? right.triggerClaim.order : Infinity))[0];
}

export function scenarioTriggerProblem(scenarios: readonly Scenario[], scenario: Scenario, cancel: string): string | null {
  if (scenario.enabled === false) return null;
  const trigger = scenario.steps.find(step => step.type === 'startRecording');
  const key = shortcutIdentity(trigger?.hotkey ?? '');
  if (!key) return 'Назначьте триггер запуска.';
  if (key === shortcutIdentity(cancel) || scenarios.some(item => item.enabled !== false &&
    key === shortcutIdentity(item.steps.find(step => step.type === 'startRecording')?.hotkeyPause ?? ''))) {
    return 'Триггер совпадает с клавишей паузы или отмены.';
  }
  const owner = triggerOwner(scenarios, key);
  return owner && owner.id !== scenario.id ? `Триггер уже назначен сценарию «${owner.name}».` : null;
}

export function scenarioBindings(scenarios: readonly Scenario[], cancel: string) {
  return scenarios.filter(scenario => scenario.enabled !== false && !scenarioTriggerProblem(scenarios, scenario, cancel))
    .map(scenario => ({ scenarioId: scenario.id, shortcut: scenario.steps.find(step => step.type === 'startRecording')!.hotkey! }));
}
