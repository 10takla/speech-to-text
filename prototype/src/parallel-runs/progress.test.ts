// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { observeScenarioProgress, type ScenarioProgress } from '../scenario-progress';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

it('preserves active steps from other runs, including repeated launches of the same scenario', () => {
  const root = document.createElement('main');
  root.innerHTML = '<div class="scenario-step" data-scenario-id="a" data-runtime-step-id="transcribe"></div><div class="scenario-step" data-scenario-id="b" data-runtime-step-id="copy"></div>';
  const dispose = observeScenarioProgress(root);
  const progress = (runId: string, scenarioId: string, active: boolean, id: string) => window.dispatchEvent(new CustomEvent<ScenarioProgress>('scenario-execution-progress', {
    detail: { runId, scenarioId, active, steps: [{ id, type: 'transcribe', status: 'running' }] },
  }));
  try {
    progress('first-a', 'a', true, 'transcribe');
    progress('second-a', 'a', true, 'transcribe');
    progress('first-b', 'b', true, 'copy');
    progress('second-a', 'a', false, 'transcribe');
    expect(root.querySelectorAll('.scenario-step--running')).toHaveLength(2);
    progress('first-b', 'b', false, 'copy');
    expect(root.querySelectorAll('.scenario-step--running')).toHaveLength(1);
    progress('first-a', 'a', false, 'transcribe');
    expect(root.querySelectorAll('.scenario-step--running')).toHaveLength(0);
  } finally { dispose(); }
});
