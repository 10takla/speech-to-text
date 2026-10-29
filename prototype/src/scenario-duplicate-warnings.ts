import { findScenarioDuplicates } from './scenario-duplicates';
import type { Scenario, ScenarioStepSettingsDefaults } from './scenario';

const observedRoots = new WeakSet<HTMLElement>();

function positionWarningPanel(details: HTMLDetailsElement) {
  const row = details.closest('.scenario-step');
  const panel = row?.querySelector<HTMLElement>('.scenario-duplicate-panel');
  if (!row || !panel) return;
  if (details.open) details.querySelector(':scope > summary')?.after(panel);
  else row.append(panel);
}

export function renderDuplicateWarnings(root: HTMLElement, scenarios: Scenario[], defaults: ScenarioStepSettingsDefaults, clipboardHistory: boolean, scenarioId?: string) {
  if (!observedRoots.has(root)) {
    observedRoots.add(root);
    root.addEventListener('toggle', event => {
      if (event.target instanceof HTMLDetailsElement && event.target.classList.contains('scenario-step-details')) {
        positionWarningPanel(event.target);
      }
    }, true);
  }
  for (const card of root.querySelectorAll<HTMLDetailsElement>('.scenario-card')) {
    if (scenarioId && card.dataset.scenarioId !== scenarioId) continue;
    const scenario = scenarios.find(item => item.id === card.dataset.scenarioId);
    if (!scenario) continue;
    const duplicates = findScenarioDuplicates(scenario, defaults, clipboardHistory);
    const signature = JSON.stringify([...duplicates]);
    if (card.dataset.duplicateWarnings === signature) continue;
    card.dataset.duplicateWarnings = signature;
    card.querySelectorAll('[data-duplicate-warning]').forEach(element => element.remove());
    const rows = [...card.querySelectorAll<HTMLElement>('.scenario-step')];
    const show = (id: string) => {
      card.open = true;
      const row = rows.find(item => item.dataset.runtimeStepId === id);
      if (!row) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ block: 'center', inline: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
      row.tabIndex = -1; row.focus({ preventScroll: true });
      row.animate([{ boxShadow: 'inset 0 0 0 2px #fbbf24' }, { boxShadow: 'inset 0 0 0 2px transparent' }],
        { duration: reducedMotion ? 0 : 1200 });
    };
    for (const [id, matches] of duplicates) {
      const row = rows.find(item => item.dataset.runtimeStepId === id);
      const summary = row?.querySelector('summary');
      if (!row || !summary) continue;
      const panel = document.createElement('div');
      panel.className = 'scenario-duplicate-panel'; panel.hidden = true; panel.dataset.duplicateWarning = '';
      panel.id = `duplicate-${scenario.id}-${id}`;
      panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Возможные повторы шага');
      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.className = 'scenario-duplicate-badge'; toggle.dataset.duplicateWarning = '';
      toggle.textContent = '⚠'; toggle.title = 'Возможный повтор шага';
      toggle.setAttribute('aria-label', 'Возможный повтор шага');
      toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', panel.id);
      toggle.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
      });
      for (const match of matches) {
        const line = document.createElement('div');
        const text = document.createElement('span');
        text.textContent = `Возможный повтор шага «${match.title}» (шаг ${match.position}).`;
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'btn secondary'; button.textContent = 'Показать шаг';
        button.addEventListener('click', () => show(match.id));
        line.append(text, button); panel.append(line);
      }
      summary.append(toggle); row.append(panel);
      positionWarningPanel(summary.parentElement as HTMLDetailsElement);
    }
    if (duplicates.size) {
      const badge = document.createElement('button'); badge.type = 'button';
      badge.className = 'scenario-duplicate-badge'; badge.dataset.duplicateWarning = '';
      badge.textContent = `⚠ ${duplicates.size}`;
      badge.title = `Шагов с возможными повторами: ${duplicates.size}`;
      badge.setAttribute('aria-label', badge.title);
      badge.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); show(duplicates.keys().next().value!); });
      card.querySelector('.scenario-card-name')?.after(badge);
    }
  }
}
