import type { ScenarioStep } from './scenario';

export function* walkScenarioSteps(steps: readonly ScenarioStep[]): Generator<ScenarioStep> {
  for (const step of steps) {
    yield step;
    for (const branch of step.parallelBranches ?? []) yield* walkScenarioSteps(branch);
  }
}

export function hasScenarioBranches(steps: readonly ScenarioStep[]): boolean {
  return steps.some(step => !!step.parallelBranches?.length);
}
