import { isTauri } from '@tauri-apps/api/core';
import type { ScenarioStepType } from './scenario';
import { scenarioSignalPath } from './scenario-signal-path';

export interface ScenarioProgress {
  runId?: string;
  scenarioId: string;
  active: boolean;
  steps: { id: string; type: ScenarioStepType; status: 'running' | 'success' | 'error' }[];
}
const eventName = 'scenario-execution-progress';
const channel = !isTauri() && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(eventName) : null;

export function publishScenarioProgress(progress: ScenarioProgress) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: progress }));
  if (isTauri()) void import('@tauri-apps/api/event').then(({ emit }) => emit(eventName, progress)).catch(console.warn);
  else channel?.postMessage(progress);
}

export function observeScenarioProgress(root: HTMLElement) {
  const activeRuns = new Map<string, ScenarioProgress>();
  const lastAnchors = new Map<string, string>();
  const signals = new Set<HTMLElement>();
  const clearSignals = () => { signals.forEach(signal => signal.remove()); signals.clear(); };
  const inputRail = (row: HTMLElement) => {
    const column = row.closest<HTMLElement>('.scenario-tree-column');
    if (!column || column.dataset.flowBranch !== row.dataset.runtimeStepId) return undefined;
    return [...column.parentElement!.querySelectorAll<HTMLElement>(':scope > .scenario-tree-input-rail')]
      .find(rail => rail.dataset.flowBranch === column.dataset.flowBranch);
  };
  const illuminate = (from: HTMLElement, to: HTMLElement) => {
    const flow = to.closest<HTMLElement>('.scenario-flow');
    const fromControl = from.querySelector<HTMLElement>('.scenario-step-type');
    const toControl = to.querySelector<HTMLElement>('.scenario-step-type');
    if (!flow || !fromControl || !toControl || from.closest('.scenario-flow') !== flow) return;
    const fromRect = fromControl.getBoundingClientRect();
    const toRect = toControl.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();
    const railOffset = (row: HTMLElement) => {
      const column = row.closest<HTMLElement>('.scenario-tree-column');
      return (column?.getBoundingClientRect().left ?? flowRect.left) - flowRect.left;
    };
    const fromX = railOffset(from);
    const toX = railOffset(to);
    const rail = inputRail(to);
    const railRect = rail?.getBoundingClientRect();
    const path = scenarioSignalPath(
      { x: fromX, y: fromRect.top + fromRect.height / 2 - flowRect.top },
      { x: toX, y: toRect.top + toRect.height / 2 - flowRect.top },
      railRect && fromX !== toX ? railRect.top + railRect.height / 2 - flowRect.top : undefined,
    );
    const totalLength = path.reduce((sum, segment) => sum + segment.length, 0);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let distance = 0;
    for (const segment of path) {
      const signal = document.createElement('span');
      signal.className = `scenario-line-signal${segment.horizontal ? ' scenario-line-signal--horizontal' : ''}`;
      signal.setAttribute('aria-hidden', 'true');
      signal.style.top = `${segment.y}px`;
      signal.style.left = `calc(var(--scenario-rail-center) + ${segment.x}px)`;
      signal.style[segment.horizontal ? 'width' : 'height'] = `${segment.length}px`;
      const head = document.createElement('span');
      head.className = 'scenario-line-signal-head';
      signal.append(head);
      flow.append(signal);
      signals.add(signal);
      const delay = reducedMotion ? 0 : distance / totalLength * 120;
      const duration = reducedMotion ? 80 : segment.length / totalLength * 120;
      const axis = segment.horizontal ? 'X' : 'Y';
      const start = segment.reverse ? segment.length : 0;
      const end = segment.reverse ? 0 : segment.length;
      if (!reducedMotion) head.animate([
        { transform: `translate${axis}(calc(${start}px - 50%))` },
        { transform: `translate${axis}(calc(${end}px - 50%))` },
      ], { duration, delay, easing: 'linear', fill: 'both' });
      const fade = signal.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: duration + (reducedMotion ? 0 : 60), delay, fill: 'both' });
      void fade.finished.then(() => { signal.remove(); signals.delete(signal); }).catch(() => {});
      distance += segment.length;
    }
  };
  const apply = () => {
    root.querySelectorAll<HTMLElement>('.scenario-step').forEach(row => {
      const candidates = [...activeRuns.values()].filter(run => run.scenarioId === row.dataset.scenarioId)
        .flatMap(run => run.steps.filter(step => step.id === row.dataset.runtimeStepId));
      const step = candidates.find(step => step.status === 'running') ?? candidates.find(step => step.status === 'error') ?? candidates[0];
      row.classList.toggle('scenario-step--running', step?.status === 'running');
      row.classList.toggle('scenario-step--execution-error', step?.status === 'error');
      if (step?.status === 'running') row.setAttribute('aria-busy', 'true');
      else row.removeAttribute('aria-busy');
    });
  };
  const accept = (progress: ScenarioProgress) => {
    const key = progress.runId ?? progress.scenarioId;
    const previous = activeRuns.get(key);
    if (progress.active) activeRuns.set(key, progress);
    else {
      activeRuns.delete(key);
      for (const anchor of lastAnchors.keys()) if (anchor.startsWith(`${key}:`)) lastAnchors.delete(anchor);
    }
    root.dataset.executingScenarioId = [...new Set([...activeRuns.values()].map(run => run.scenarioId))].join(' ');
    if (!activeRuns.size) clearSignals();
    apply();
    if (!progress.active) return;
    const rows = [...root.querySelectorAll<HTMLElement>('.scenario-step')]
      .filter(row => row.dataset.scenarioId === progress.scenarioId);
    const starting = progress.steps.filter(step => step.status === 'running'
      && !(previous?.active && previous.scenarioId === progress.scenarioId
        && previous.steps.some(old => old.id === step.id && old.status === 'running')));
    const previousAnchors = new Map(lastAnchors);
    starting.forEach(step => {
      const target = rows.find(row => row.dataset.runtimeStepId === step.id);
      if (!target) return;
      const branch = `${key}:${target.closest<HTMLElement>('.scenario-tree-column')?.dataset.flowBranch ?? 'root'}`;
      const inputIds: string[] = JSON.parse(inputRail(target)?.dataset.inputStepIds ?? '[]');
      const from = rows.find(row => inputIds.includes(row.dataset.runtimeStepId ?? '') && !row.classList.contains('scenario-step--disabled'))
        ?? rows.find(row => row.dataset.runtimeStepId === (previousAnchors.get(branch) ?? previousAnchors.get(`${key}:root`)));
      const recording = step.type === 'transcribe' ? progress.steps.find(item => item.type === 'startRecording' && item.status === 'running') : undefined;
      const origin = recording ? rows.find(row => row.dataset.runtimeStepId === recording.id) : from;
      if (origin) illuminate(origin, target);
      lastAnchors.set(branch, step.id);
    });
  };
  const local = (event: Event) => accept((event as CustomEvent<ScenarioProgress>).detail);
  const remote = (event: MessageEvent<ScenarioProgress>) => accept(event.data);
  window.addEventListener(eventName, local);
  channel?.addEventListener('message', remote);
  const mutations = new MutationObserver(apply);
  mutations.observe(root, { childList: true, subtree: true });
  let disposed = false;
  let unlisten: (() => void) | undefined;
  if (isTauri()) void import('@tauri-apps/api/event').then(async ({ listen }) => {
    const stop = await listen<ScenarioProgress>(eventName, event => accept(event.payload));
    if (disposed) stop(); else unlisten = stop;
  }).catch(console.warn);
  return () => {
    disposed = true;
    clearSignals();
    unlisten?.();
    mutations.disconnect();
    window.removeEventListener(eventName, local);
    channel?.removeEventListener('message', remote);
  };
}
