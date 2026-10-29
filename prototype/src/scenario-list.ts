import type { AppSettings } from './config';
import { appendScenarioCopy, resetScenarioToTemplate, canResetScenarioToTemplate, isScenarioTemplate, createStep, type Scenario } from './scenario';
import { scenarioTriggerProblem } from './scenario-triggers';
import { confirmAction } from './confirmation-dialog';
import { isAndroid } from './android-runtime';

export function createScenarioList() {
  const expanded = new Set<string>();
  let initialized = false;
  let renameId: string | undefined;

  return (root: HTMLElement, settings: AppSettings, save: (scenario?: Scenario, inline?: boolean, restored?: boolean) => void,
    renderBody: (body: HTMLElement, scenario: Scenario) => void,
    retainedCards = new Map<string, HTMLElement>()) => {
    if (!initialized) { expanded.add(settings.activeScenarioId); initialized = true; }
    for (const scenario of settings.scenarios) {
      const retained = retainedCards.get(scenario.id);
      if (retained) continue;
      const template = isScenarioTemplate(scenario);
      const card = document.createElement('details');
      card.className = 'scenario-card';
      card.classList.toggle('scenario-card--template', template);
      card.dataset.scenarioId = scenario.id;
      card.open = expanded.has(scenario.id);
      card.addEventListener('toggle', () => {
        if (!card.isConnected) return;
        if (card.open) expanded.add(scenario.id); else expanded.delete(scenario.id);
      });
      const header = document.createElement('summary');
      header.className = 'scenario-card-header';
      if (!isAndroid) card.addEventListener('click', event => {
        if (event.target !== card) return;
        const bounds = header.getBoundingClientRect();
        if (event.clientY >= bounds.top && event.clientY <= bounds.bottom) card.open = !card.open;
      });
      const title = document.createElement('span');
      title.className = 'scenario-card-name';
      title.textContent = scenario.name;
      if (template) {
        const tag = document.createElement('span');
        tag.className = 'scenario-template-tag'; tag.textContent = 'Шаблон';
        tag.title = 'Готовый сценарий: можно редактировать и восстановить исходные настройки';
        title.append(document.createTextNode(' '), tag);
      }
      if (!template) {
        title.classList.add('scenario-card-name--editable');
        title.title = 'Двойной клик — переименовать';
      }
      if (!template) title.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      const rename = document.createElement('input');
      rename.type = 'text';
      rename.maxLength = 64;
      rename.value = scenario.name;
      rename.setAttribute('aria-label', 'Название сценария');
      rename.readOnly = template;
      rename.hidden = template || renameId !== scenario.id;
      title.hidden = !rename.hidden;
      const error = document.createElement('p');
      error.className = 'scenario-name-error';
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const startRename = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (template) return;
        renameId = scenario.id;
        rename.value = scenario.name;
        rename.removeAttribute('aria-invalid');
        error.hidden = true;
        title.hidden = true;
        rename.hidden = false;
        rename.focus();
        rename.select();
      };
      if (!template) title.addEventListener('dblclick', startRename);
      const finishRename = () => {
        if (template || renameId !== scenario.id) return;
        const name = rename.value.trim();
        if (!name || settings.scenarios.some(item => item.id !== scenario.id &&
          item.name.trim().toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
          error.textContent = name ? 'Сценарий с таким названием уже существует.' : 'Введите название сценария.';
          error.hidden = false;
          rename.setAttribute('aria-invalid', 'true');
          return;
        }
        scenario.name = name;
        renameId = undefined;
        save(scenario);
      };
      rename.addEventListener('click', event => event.stopPropagation());
      rename.addEventListener('blur', finishRename);
      rename.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finishRename(); }
        if (event.key === 'Escape') {
          event.preventDefault();
          renameId = undefined; rename.hidden = true; title.hidden = false; error.hidden = true;
        }
      });
      if (!isAndroid) {
        const enabledLabel = document.createElement('label');
        enabledLabel.className = 'scenario-card-enabled';
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.setAttribute('role', 'switch');
        enabled.checked = scenario.enabled !== false;
        enabled.setAttribute('aria-label', `Включить сценарий «${scenario.name}»`);
        enabled.addEventListener('click', event => event.stopPropagation());
        enabled.addEventListener('change', () => { scenario.enabled = enabled.checked; save(scenario, true); });
        enabledLabel.addEventListener('click', event => event.stopPropagation());
        const track = document.createElement('span');
        track.className = 'scenario-card-switch';
        track.setAttribute('aria-hidden', 'true');
        enabledLabel.append(enabled, track);
        header.append(enabledLabel);
      }
      const actions = document.createElement('div');
      actions.className = 'scenario-card-actions';
      const action = (label: string, icon: 'copy' | 'delete' | 'reset', run: () => void, disabled = false) => {
        const button = document.createElement('button');
        button.type = 'button'; button.disabled = disabled;
        button.className = 'btn secondary scenario-button';
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${scenario.name}`);
        button.innerHTML = scenarioActionIcon(icon);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); run();
        });
        actions.append(button);
        return button;
      };
      action('Создать копию сценария', 'copy', () => {
        const copy = appendScenarioCopy(settings.scenarios, scenario); expanded.add(copy.id); save(copy);
      });
      if (scenario.templateId) {
        const reset = action('Восстановить исходный сценарий', 'reset', () => { void (async () => {
        if (!await confirmAction({ title: 'Восстановить исходный сценарий?',
          message: `Шаги, триггеры и настройки сценария «${scenario.name}» будут заменены исходным шаблоном.`, confirmLabel: 'Восстановить' })) return;
        resetScenarioToTemplate(scenario); expanded.add(scenario.id); save(scenario, false, true);
        })(); }, !canResetScenarioToTemplate(scenario));
        reset.dataset.resetScenarioId = scenario.id;
      }
      if (!template) action('Удалить сценарий', 'delete', () => { void (async () => {
        if (!await confirmAction({ title: 'Удалить сценарий?', message: `Сценарий «${scenario.name}» будет удалён.`, confirmLabel: 'Удалить' })) return;
        const index = settings.scenarios.indexOf(scenario);
        settings.scenarios = settings.scenarios.filter(item => item.id !== scenario.id);
        expanded.delete(scenario.id);
        save(settings.scenarios.find(item => item.id === settings.activeScenarioId) ?? settings.scenarios[index] ?? settings.scenarios[index - 1]);
      })(); });
      header.append(title, rename, actions);
      const body = document.createElement('div');
      body.className = 'scenario-card-body';
      renderBody(body, scenario);
      card.append(header, error, body);
      const nextCard = settings.scenarios.slice(settings.scenarios.indexOf(scenario) + 1)
        .map(item => retainedCards.get(item.id)).find(Boolean);
      root.insertBefore(card, nextCard ?? null);
      if (!rename.hidden) queueMicrotask(() => { rename.focus(); rename.select(); });
    }
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'btn secondary scenario-add-scenario';
    add.textContent = '+'; add.title = 'Добавить сценарий'; add.setAttribute('aria-label', 'Добавить сценарий');
    add.addEventListener('click', () => {
      let name = 'Новый сценарий'; let suffix = 2;
      while (settings.scenarios.some(item => item.name === name)) name = `Новый сценарий ${suffix++}`;
      const scenario: Scenario = { id: crypto.randomUUID(), name, enabled: false, steps: [createStep('startRecording', '')] };
      settings.scenarios.push(scenario); expanded.add(scenario.id); renameId = scenario.id; save(scenario);
    });
    root.append(add);
    updateScenarioTriggerWarnings(root, settings);
    const measureHeaders = () => {
      if (!root.isConnected) return;
      const measurements = [...root.querySelectorAll<HTMLElement>('.scenario-card-header')].map(header => {
        // Measure headers alone: expanded settings and the tree never affect their columns.
        const measure = header.cloneNode(true) as HTMLElement;
        measure.setAttribute('aria-hidden', 'true');
        measure.style.cssText = 'position:fixed;left:-10000px;visibility:hidden;width:max-content;max-width:none;pointer-events:none';
        measure.querySelector<HTMLElement>('.scenario-card-name')!.hidden = false;
        measure.querySelector<HTMLInputElement>('input[type="text"]')!.hidden = true;
        measure.querySelector('.scenario-trigger-error')?.remove();
        return measure;
      });
      root.append(...measurements);
      const width = Math.max(0, ...measurements.map(measure => measure.getBoundingClientRect().width));
      measurements.forEach(measure => measure.remove());
      root.style.setProperty('--scenario-header-width', `${Math.ceil(width)}px`);
    };
    queueMicrotask(measureHeaders);
    // A measurement taken before the web font loads is too narrow, and the widest
    // header then wraps; measure again once fonts are ready.
    void document.fonts?.ready.then(measureHeaders);
  };
}

export function updateScenarioTriggerWarnings(root: HTMLElement, settings: AppSettings): void {
  root.querySelectorAll<HTMLElement>('.scenario-card').forEach(card => {
    const scenario = settings.scenarios.find(item => item.id === card.dataset.scenarioId);
    const header = card.querySelector<HTMLElement>('.scenario-card-header');
    if (!scenario || !header) return;
    const problem = isAndroid ? null : scenarioTriggerProblem(settings.scenarios, scenario, settings.hotkeyCancel);
    let warning = header.querySelector<HTMLElement>('.scenario-trigger-error');
    if (problem) {
      if (!warning) { warning = document.createElement('span'); warning.className = 'scenario-trigger-error'; warning.setAttribute('role', 'alert'); header.append(warning); }
      warning.textContent = problem;
    } else warning?.remove();
    header.classList.toggle('scenario-card-header--error', !!problem);
    header.title = problem || '';
  });
}

export function updateScenarioResetButtons(root: HTMLElement, scenarios: Scenario[]): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-reset-scenario-id]').forEach(button => {
    const scenario = scenarios.find(item => item.id === button.dataset.resetScenarioId);
    button.disabled = !scenario || !canResetScenarioToTemplate(scenario);
  });
}

function scenarioActionIcon(name: 'copy' | 'delete' | 'reset'): string {
  const paths = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    delete: '<path d="M3 6h18M8 6V4h8v2m2 0-.8 14H6.8L6 6m4 4v7m4-7v7"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

