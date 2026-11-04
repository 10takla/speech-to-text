import { createResourceQueue } from './resource-queue';
import { walkScenarioSteps } from '../scenario-tree';
import type { ScenarioStep } from '../scenario';
import { speechHasOwnPlayer } from '../speech-providers';

export const textOutputQueue = createResourceQueue();
export const speechPlaybackQueue = createResourceQueue();
let recording = false;
const recordingListeners = new Set<(value: boolean) => void>();

export function setRecordingResourceBusy(value: boolean) {
  recording = value;
  speechPlaybackQueue.setPaused(value);
  recordingListeners.forEach(listener => listener(value));
}

export function observeRecordingResource(listener: (value: boolean) => void) {
  recordingListeners.add(listener);
  listener(recording);
  return () => { recordingListeners.delete(listener); };
}

export function registerRunResources(runId: string, steps: ScenarioStep[]) {
  const enabled = [...walkScenarioSteps(steps)].filter(step => step.enabled);
  const output = enabled.filter(step => step.type === 'copy' || step.type === 'paste');
  textOutputQueue.register(runId, output.map(step => step.id), output.filter(step => step.type === 'paste').map(step => step.id));
  // A speech with its own player plays on the user's choice, not in turn.
  speechPlaybackQueue.register(runId, enabled.filter(step => step.type === 'speak' && !speechHasOwnPlayer(step)).map(step => step.id));
}

export function finishRunResources(runId: string) {
  textOutputQueue.finish(runId);
  speechPlaybackQueue.finish(runId);
}
