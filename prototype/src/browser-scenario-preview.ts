import {
  SCENARIO_STEP_CONTRACTS, getScenarioStepContract, scenarioDataTypeLabel,
  createStep,
  type Scenario, type ScenarioDataType, type ScenarioStepType, type ScenarioStep,
} from './scenario';
import { mountSpeechProvider } from './speech-settings-editor';
import { mountBranchStepSettings } from './scenario-branch-settings';
import { alignScenarioColumns, disposeScenarioColumns } from './scenario-column-layout';
import { prependPipelineStep, removePipelineStep, type PipelineStage } from './scenario-pipeline-edit';
import { scenarioAddPicker } from './scenario-add-picker';

// Shared data rails with independent transformation lanes; edits persist in scenario steps.
interface Branch {
  id: string;
  type: ScenarioStepType;
  enabled: boolean;
  settings?: HTMLElement;
  source?: ScenarioStep;
}
type Stage = PipelineStage<Branch>;

const branch = (type: ScenarioStepType, enabled = true): Branch => ({ id: crypto.randomUUID(), type, enabled });
const stage = (type: ScenarioStepType): Stage => ({ branches: [{ ...branch(type), source: createStep(type) }] });
const outputOf = (item: Branch) => getScenarioStepContract(item.type).outputs[0];
const isAction = (item: Branch) => getScenarioStepContract(item.type).category === 'action';


export function createBrowserScenarioPreview() {
  const models = new Map<string, { first?: Stage; steps: ScenarioStep[] }>();
  const templates = new Map<ScenarioStepType, HTMLElement>();
  const providerDetails = new Map<string, HTMLElement>();

  return (flow: HTMLElement, scenario: Scenario, onSettingChange: () => void, openSettings?: ReadonlySet<string>, saveInline = onSettingChange) => {
    const originalRows = flow.querySelectorAll<HTMLElement>(':scope > .scenario-steps > .scenario-step');
    scenario.steps.forEach((item, index) => {
      const settings = originalRows[index]?.querySelector<HTMLElement>('.scenario-step-details');
      if (settings) providerDetails.set(item.id, settings);
      if (settings?.querySelector('input, select') && !templates.has(item.type)) {
        const template = settings.cloneNode(true) as HTMLElement;
        const originalSelects = settings.querySelectorAll('select');
        template.querySelectorAll('select').forEach((select, index) => {
          const value = originalSelects[index].value;
          Array.from(select.options).forEach(option => { option.defaultSelected = option.value === value; });
        });
        templates.set(item.type, template);
      }
    });

    const initial = (steps: ScenarioStep[] = scenario.steps) => {
      let first: Stage | undefined;
      let previous: Stage | undefined;
      let previousGroup: string | undefined;
      for (const item of steps) {
        if (previous && item.parallelGroup && item.parallelGroup === previousGroup && getScenarioStepContract(item.type).category === 'action') {
          previous.branches.push({ ...branch(item.type, item.enabled), source: item });
          previous.forks = [...(previous.forks ?? []), ...(item.parallelBranches?.map(lane => initial(lane).first!).filter(Boolean) ?? [])];
          continue;
        }
        const current: Stage = { branches: [{ ...branch(item.type, item.enabled), source: item }],
          forks: item.parallelBranches?.map(lane => initial(lane).first!).filter(Boolean) };
        if (previous) previous.next = current;
        else first = current;
        previous = current;
        previousGroup = item.parallelGroup;
      }
      return { first };
    };
    if (models.get(scenario.id)?.steps !== scenario.steps) models.set(scenario.id, { ...initial(), steps: scenario.steps });
    const model = models.get(scenario.id)!;
    flow.classList.add('scenario-visual-preview');

    const button = (label: string, title: string, action: () => void, disabled = false) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'btn secondary scenario-button';
      result.textContent = label;
      result.title = title;
      result.setAttribute('aria-label', title);
      result.disabled = disabled;
      result.addEventListener('click', action);
      return result;
    };
    const choices = (input: ScenarioDataType) => SCENARIO_STEP_CONTRACTS.filter(item => item.input === input);
    const picker = (input: ScenarioDataType, placeholder: string, label: string, select: (type: ScenarioStepType) => void, actionsOnly = false, transformationsOnly = false) => {
      const available = choices(input).filter(item => (!actionsOnly || item.category === 'action')
        && (!transformationsOnly || item.category === 'transformation'));
      const element = document.createElement('select');
      element.setAttribute('aria-label', label);
      element.add(new Option(placeholder, ''));
      available.forEach(item => element.add(new Option(item.title, item.type)));
      element.addEventListener('change', () => {
        const selected = available.find(item => item.type === element.value);
        if (selected) select(selected.type);
      });
      return element;
    };
    const connection = (type: ScenarioDataType, addParallel: ((type: ScenarioStepType) => void) | undefined,
      insertStep: (type: ScenarioStepType) => void, hasBranchInputs: boolean) => {
      const element = document.createElement('div');
      element.className = 'scenario-connection scenario-connection--parallel';
      const badge = document.createElement('span');
      badge.className = 'scenario-connection-type';
      badge.textContent = scenarioDataTypeLabel(type);
      element.append(badge);
      if (choices(type).length) {
        // Only a real fork needs an insertion control above the junction.
        const positions = hasBranchInputs ? ['before'] : ['after'];
        for (const position of positions) {
          const tools = document.createElement('span');
          tools.className = `scenario-sequential-tools scenario-sequential-tools--${position}`;
          tools.append(scenarioAddPicker(picker(type, '', position === 'before'
            ? 'Добавить шаг перед меткой данных' : 'Добавить шаг после метки данных', insertStep)));
          element.append(tools);
        }
        if (addParallel) {
          const tools = document.createElement('span');
          tools.className = 'scenario-connection-tools';
          tools.append(scenarioAddPicker(picker(type, '',
            `Добавить параллельный шаг от данных «${scenarioDataTypeLabel(type)}»`, addParallel)));
          element.append(tools);
        }
      }
      return element;
    };
    const settingsFor = (item: Branch, nested = false) => {
      const settingChanged = onSettingChange;
      if (nested) {
        if (item.settings) return item.settings;
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        details.dataset.scenarioStepId = item.source!.id;
        details.open = openSettings?.has(item.source!.id) ?? false;
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        mountBranchStepSettings(content, item.source!, onSettingChange, saveInline);
        details.append(summary, content);
        item.settings = details;
        return details;
      }
      const liveProvider = item.source && providerDetails.get(item.source.id);
      if (liveProvider) {
        item.settings = liveProvider;
        return liveProvider;
      }
      if (item.settings) return item.settings;
      const template = templates.get(item.type);
      const details = template ? template.cloneNode(true) as HTMLElement : document.createElement('details');
      details.removeAttribute('data-scenario-step-id');
      if (!template) {
        details.className = 'scenario-step-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        const fields: Partial<Record<ScenarioStepType, [string, string, string[]?][]>> = {
          transcribe: [['Провайдер', 'select', ['Groq']], ['Модель', 'select', ['whisper-large-v3-turbo', 'whisper-large-v3']], ['Язык', 'select', ['Авто', 'Русский', 'English']], ['Контекст', 'text']],
          postprocess: [['Провайдер', 'select', ['Google Gemini']], ['Модель', 'text'], ['Промпт преобразования', 'text']],
          copy: [['Уровень в истории', 'number']],
          paste: [['Звук вставки', 'select', ['Аккорд', 'Клик', 'Нет']]],
          startRecording: [['Микрофон', 'select', ['Системный микрофон']], ['Горячая клавиша', 'text']],
          speak: [['Провайдер', 'select', ['Системный движок']]],
        };
        for (const [title, type, options] of fields[item.type] ?? []) {
          const label = document.createElement('label');
          label.className = 'scenario-step-setting-label';
          label.textContent = title;
          const control = options ? document.createElement('select') : document.createElement('input');
          if (control instanceof HTMLSelectElement) options?.forEach(option => control.add(new Option(option)));
          else { control.type = type; if (type === 'number') { control.max = '0'; control.value = '-1'; } }
          label.append(control);
          content.append(label);
        }
        details.append(summary, content);
      }
      if (item.type === 'copy' || item.type === 'paste') {
        let toggle = details.querySelector<HTMLInputElement>('[data-show-text-in-overlay]');
        if (!toggle) {
          const label = document.createElement('label');
          label.className = 'checkbox-label';
          toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.dataset.showTextInOverlay = '';
          label.append(toggle, 'Показывать текст в оверлее');
          details.querySelector('.scenario-step-settings')?.append(label);
        }
        toggle.checked = item.source?.showTextInOverlay === true;
        const checkbox = toggle;
        checkbox.addEventListener('change', () => {
          if (item.source && item.source.type === item.type) {
            item.source.showTextInOverlay = checkbox.checked;
            settingChanged();
          }
        });
      }
      if (item.type === 'postprocess' && item.source?.postprocessing) {
        const prompt = details.querySelector<HTMLInputElement>('[id="gemini-prompt"]');
        if (prompt) {
          prompt.value = item.source.postprocessing.prompt;
          prompt.addEventListener('change', () => {
            if (item.source?.postprocessing) { item.source.postprocessing.prompt = prompt.value; settingChanged(); }
          });
        }
      }
      const bindVisibility = (controlId: string, targets: string[], visible: (control: HTMLInputElement | HTMLSelectElement) => boolean) => {
        const control = details.querySelector<HTMLInputElement | HTMLSelectElement>(`[id="${controlId}"]`);
        if (!control) return;
        const elements = targets.map(id => details.querySelector<HTMLElement>(`[id="${id}"]`));
        const update = () => elements.forEach(element => {
          if (!element) return;
          element.hidden = !visible(control);
          element.style.display = visible(control) ? '' : 'none';
        });
        control.addEventListener('change', update);
        update();
      };
      bindVisibility('provider-select', ['provider-specific-groq', 'groq-api-key-field'], control => control.value === 'groq');
      bindVisibility('post-process-provider', ['gemini-specific-block', 'gemini-api-key-field'], control => control.value === 'gemini');
      bindVisibility('toggle-live-transcription', ['live-transcription-parameters'], control => (control as HTMLInputElement).checked);
      details.querySelectorAll<HTMLElement>('[id]').forEach(element => { element.id = `${item.id}-${element.id}`; });
      details.querySelectorAll<HTMLLabelElement>('label[for]').forEach(element => { element.htmlFor = `${item.id}-${element.htmlFor}`; });
      details.querySelectorAll('[aria-describedby]').forEach(element => element.removeAttribute('aria-describedby'));
      details.querySelectorAll('.scenario-step-readiness, .scenario-microphone-status, .model-load-status').forEach(element => element.remove());
      details.querySelectorAll<HTMLButtonElement>('button').forEach(element => {
        element.disabled = true;
        element.title = 'Предпросмотр: без обращения к устройствам и API';
      });
      if (item.type === 'speak') {
        const source = item.source ?? (item.source = createStep('speak'));
        const content = details.querySelector<HTMLElement>('.scenario-step-settings')!;
        content.replaceChildren();
        mountSpeechProvider(content, source, settingChanged, saveInline);
      }
      details.querySelectorAll<HTMLInputElement>('input[readonly]').forEach(element => {
        element.addEventListener('keydown', event => {
          event.preventDefault();
          if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
          element.value = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Win', event.key].filter(Boolean).join('+');
        });
      });
      item.settings = details;
      return details;
    };

    const swapWithNext = (current: Stage, replace: (next?: Stage) => void) => {
      const next = current.next;
      if (!next) return;
      current.next = next.next;
      next.next = current;
      replace(next);
      render(true);
    };
    const addAtInput = (current: Stage | undefined, replace: (next?: Stage) => void, type: ScenarioStepType) => {
      const added = stage(type);
      if (!current) replace(added);
      else if (isAction(added.branches[0]) && current.branches.every(isAction)) {
        current.branches.push(added.branches[0]);
      } else (current.forks ??= []).push(added);
      render(true);
    };
    const renderPipeline = (parent: HTMLElement, current: Stage | undefined, input: ScenarioDataType, replace: (next?: Stage) => void,
      previous?: { current: Stage; replace: (next?: Stage) => void; input: ScenarioDataType }, nested = false, ownColumn = false) => {
      const changed = () => render(true);
      if (!current) {
        const add = document.createElement('div');
        add.className = 'scenario-add-row';
        add.append(scenarioAddPicker(picker(input, '', 'Следующий шаг сценария', type => {
          replace(stage(type)); changed();
        })));
        parent.append(add);
        return;
      }
      const forks = current.forks;
      if (forks?.length && !ownColumn) {
        const tree = document.createElement('div');
        tree.className = 'scenario-transformation-tree';
        tree.setAttribute('role', 'group');
        tree.setAttribute('aria-label', 'Ветки с отдельными выходами');
        const inputConnection = parent.lastElementChild?.querySelector(':scope > .scenario-connection');
        if (inputConnection) tree.append(inputConnection);
        // Forks at the same input share one junction row, including nested siblings.
        let columnIndex = 0;
        const appendLane = (lane: Stage, replaceLane: (next?: Stage) => void, laneNested: boolean,
          lanePrevious?: typeof previous) => {
          const gridColumn = String(++columnIndex);
          const rail = document.createElement('span');
          rail.className = 'scenario-tree-input-rail';
          rail.style.gridColumn = gridColumn;
          rail.setAttribute('aria-hidden', 'true');
          const column = document.createElement('div');
          column.className = 'scenario-tree-column';
          column.style.gridColumn = gridColumn;
          column.dataset.flowBranch = lane.branches[0].source?.id;
          const insert = document.createElement('div');
          insert.className = 'scenario-add-row scenario-branch-insert';
          insert.append(scenarioAddPicker(picker(input, '',
            `Вставить перед первым шагом ветки ${columnIndex}`, type => {
              replaceLane(prependPipelineStep(lane, stage(type)));
              changed();
            })));
          column.append(insert);
          renderPipeline(column, lane, input, replaceLane, lanePrevious, laneNested, true);
          tree.append(rail, column);
          lane.forks?.forEach((fork, index) => appendLane(fork, next => {
            if (next) lane.forks![index] = next;
            else lane.forks!.splice(index, 1);
          }, true));
        };
        appendLane(current, replace, nested, previous);
        tree.style.gridTemplateColumns = `repeat(${columnIndex}, max-content)`;
        tree.querySelector(':scope > .scenario-tree-input-rail:last-of-type')?.classList.add('scenario-tree-input-rail--last');
        parent.append(tree);
        return;
      }
      const group = document.createElement('div');
      group.className = current.branches.length > 1 ? 'scenario-parallel-preview' : 'scenario-preview-single';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', current.branches.length > 1 ? 'Шаги с общим входом' : 'Шаг сценария');
      const branches = document.createElement('div');
      branches.className = 'scenario-parallel-preview-branches';
      current.branches.forEach((item, index) => {
        const branchContainer = document.createElement('div');
        branchContainer.className = 'scenario-preview-branch';
        const contract = getScenarioStepContract(item.type);
        const row = document.createElement('div');
        row.className = `scenario-step scenario-step--${contract.category}${item.enabled ? '' : ' scenario-step--disabled'}`;
        row.dataset.scenarioId = scenario.id;
        row.dataset.runtimeStepId = item.source?.id ?? '';
        if (contract.category !== 'action') {
          const marker = document.createElement('span');
          marker.className = 'scenario-step-marker';
          marker.textContent = contract.category === 'source' ? '●' : 'Δ';
          row.append(marker);
        }
        const select = picker(input, 'Выберите шаг…', 'Тип шага', type => {
          item.type = type;
          item.settings = undefined;
          item.source = createStep(type);
          changed();
        }, current.branches.length > 1 || (!!current.forks?.length && isAction(item)), !!current.forks?.length && !isAction(item));
        select.className = 'scenario-step-type';
        if (![...select.options].some(option => option.value === item.type)) {
          select.add(new Option(`${contract.title} (несовместимый вход)`, item.type));
        }
        select.value = item.type;
        select.disabled = !item.enabled;
        row.append(select);
        const actions = document.createElement('div');
        actions.className = 'scenario-step-actions';
        if (contract.input === outputOf(item)) actions.append(button(item.enabled ? 'Ⅱ' : '▶', item.enabled ? 'Отключить шаг' : 'Включить шаг', () => { item.enabled = !item.enabled; changed(); }));
        const canMoveUp = current.branches.length === 1 && previous?.current.branches.length === 1
          && previous.input === input && outputOf(previous.current.branches[0]) === outputOf(item);
        const canMoveDown = current.branches.length === 1 && current.next?.branches.length === 1
          && getScenarioStepContract(current.next.branches[0].type).input === input
          && outputOf(current.next.branches[0]) === outputOf(item);
        actions.append(button('↑', 'Переместить шаг вверх', () => {
          if (canMoveUp && previous) { swapWithNext(previous.current, previous.replace); return; }
          [current.branches[index - 1], current.branches[index]] = [item, current.branches[index - 1]]; changed();
        }, index === 0 && !canMoveUp));
        actions.append(button('↓', 'Переместить шаг вниз', () => {
          if (canMoveDown) { swapWithNext(current, replace); return; }
          [current.branches[index + 1], current.branches[index]] = [item, current.branches[index + 1]]; changed();
        }, index === current.branches.length - 1 && !canMoveDown));
        actions.append(button('×', 'Удалить шаг', () => {
          replace(removePipelineStep(current, index));
          changed();
        }));
        row.append(actions, settingsFor(item, nested));
        branchContainer.append(row);
        branches.append(branchContainer);
      });
      group.append(branches);
      const linear = document.createElement('div');
      linear.className = 'scenario-pipeline-stage';
      linear.append(group);
      const output = outputOf(current.branches[0]);
      const outputConnection = connection(output,
        current.next ? type => addAtInput(current.next, next => { current.next = next; }, type) : undefined,
        type => {
          const added = stage(type);
          current.next = current.next ? prependPipelineStep(current.next, added) : added;
          changed();
        }, !!current.next?.forks?.length);
      outputConnection.dataset.inputStepIds = JSON.stringify(current.branches.map(item => item.source?.id).filter(Boolean));
      linear.append(outputConnection);
      parent.append(linear);
      if (current.next) {
        renderPipeline(parent, current.next, output, next => { current.next = next; }, { current, replace, input }, nested);
      }
    };
    const render = (saveChanges = false) => {
      if (saveChanges) {
        const serialize = (first?: Stage): ScenarioStep[] => {
        const steps: ScenarioStep[] = [];
        for (let current = first; current; current = current.next) {
          for (const item of current.branches) {
            const source = item.source?.type === item.type ? item.source : createStep(item.type);
            source.enabled = item.enabled;
            if (current.branches.length > 1) source.parallelGroup = current.branches[0].id;
            else delete source.parallelGroup;
            if (item === current.branches[0] && current.forks?.length) source.parallelBranches = current.forks.map(serialize);
            else delete source.parallelBranches;
            item.source = source;
            steps.push(source);
          }
        }
        return steps;
        };
        scenario.steps = serialize(model.first);
        model.steps = scenario.steps;
        onSettingChange();
        return;
      }
      // Keep the actual settings elements so edits and expanded state survive layout changes.
      disposeScenarioColumns(flow);
      flow.replaceChildren();
      renderPipeline(flow, model.first, 'trigger', next => { model.first = next; });
      flow.querySelectorAll<HTMLElement>(':scope > .scenario-transformation-tree').forEach(alignScenarioColumns);
      flow.querySelectorAll<HTMLElement>('.scenario-step').forEach(row => {
        const indicator = document.createElement('span');
        indicator.className = 'scenario-execution-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        row.append(indicator);
      });
    };
    render();
  };
}
