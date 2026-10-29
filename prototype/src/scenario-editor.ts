import type { AppSettings } from './config';
import { mountClaudeCodeSettings } from './claude-code-settings';
import { hasStepSettings } from './step-settings-block';
import { createScenarioList, updateScenarioResetButtons, updateScenarioTriggerWarnings } from './scenario-list';
import { renderDuplicateWarnings } from './scenario-duplicate-warnings';
import { scenarioStopProblem, scenarioTriggerProblem } from './scenario-triggers';
import { createBrowserScenarioPreview } from './browser-scenario-preview';
import { disposeScenarioColumns } from './scenario-column-layout';
import { mountSpeechProvider } from './speech-settings-editor';
import { mountBranchStepSettings, mountFinalTranscriptionSetting } from './scenario-branch-settings';
import { checkMicrophone, listMicrophones, type Microphone } from './microphones';
import { errorMessage } from './error-message';
import { isAndroid } from './android-runtime';
import { normalizeAfterStopMs } from './recording-stop';
import {
  canDisableScenarioStep,
  normalizeClipboardHistoryLevel,
  createStep,
  type ScenarioStepSettingsDefaults,
  getScenarioStepContract,
  isScenarioStepType,
  isTriggerStep,
  scenarioCancelHotkey,
  scenarioDataTypeLabel,
  validateScenario,
  type Scenario,
  type ScenarioStep,
  type ScenarioStepType,
} from './scenario';

const stepChoices: readonly ScenarioStepType[] = ['startRecording', 'claudeCode', 'selectedText', 'transcribe', 'postprocess', 'copy', 'paste', 'speak'];

export function mountScenarioEditor(
  root: HTMLElement,
  settings: AppSettings,
  persistChanges: () => void,
): () => void {
  const onChange = () => {
    if (isAndroid && !settings.scenarios.some(scenario => scenario.id === settings.androidScenarioId)) {
      settings.androidScenarioId = settings.scenarios[0]?.id ?? '';
    }
    persistChanges();
    updateScenarioResetButtons(root, settings.scenarios);
  };
  const transcriptionPanel = document.getElementById('provider-select')?.closest('.cp-card') as HTMLElement | null;
  const postprocessingPanel = document.getElementById('post-process-provider')?.closest('.cp-card') as HTMLElement | null;
  const providerStatuses = {
    transcribe: transcriptionPanel?.querySelector<HTMLElement>('#stt-provider-status'),
    postprocess: postprocessingPanel?.querySelector<HTMLElement>('#postprocess-provider-status'),
  };
  transcriptionPanel?.classList.remove('cp-card');
  transcriptionPanel?.classList.add('scenario-provider-settings');
  postprocessingPanel?.classList.remove('cp-card');
  postprocessingPanel?.classList.add('scenario-provider-settings');
  transcriptionPanel?.remove();
  postprocessingPanel?.remove();

  const renderList = createScenarioList();
  const openStepSettings = new Set<string>();
  const renderedLayouts = new Map<string, string>();
  let renderedActiveScenarioId = settings.activeScenarioId;
  const scenarioLayout = (steps: Scenario['steps']): string => {
    const groups = new Map<string, number>();
    return JSON.stringify(steps.map(step => {
      if (step.parallelGroup && !groups.has(step.parallelGroup)) groups.set(step.parallelGroup, groups.size);
      return [step.id, step.type, step.enabled, step.parallelGroup ? groups.get(step.parallelGroup) : null,
      step.parallelBranches?.map(scenarioLayout)];
    }));
  };
  let scrollRestoreFrame: number | undefined;
  let microphones: Microphone[] = [];
  let microphoneListError = '';
  let microphoneLoading = true;
  let microphoneCheckGeneration = 0;
  let microphoneListGeneration = 0;
  const microphoneChecks = new Map<string, { text: string; ready: boolean }>();

  const refreshMicrophones = async () => {
    const generation = ++microphoneListGeneration;
    microphoneCheckGeneration++;
    microphoneLoading = true;
    microphoneChecks.clear();
    try {
      const devices = await listMicrophones();
      if (generation !== microphoneListGeneration) return;
      microphones = devices;
      microphoneListError = '';
    } catch (error) {
      if (generation !== microphoneListGeneration) return;
      microphoneListError = errorMessage(error);
    }
    microphoneLoading = false;
    render();
  };

  const updateReadinessIndicators = () => {
    root.querySelectorAll<HTMLElement>('.scenario-step-readiness').forEach(indicator => {
      const stepType = indicator.dataset.stepType;
      if (!stepType) return;
      const providerStatus = stepType === 'transcribe' ? providerStatuses.transcribe : providerStatuses.postprocess;
      const isReady = providerStatus?.classList.contains('status-pill--ready') ?? false;
      indicator.textContent = providerStatus?.textContent?.trim() || 'Не готов';
      indicator.title = providerStatus?.title || providerStatus?.textContent?.trim() || 'Провайдер не готов';
      const state = providerStatus?.classList.contains('status-pill--error') ? 'error' : isReady ? 'ready' : 'idle';
      indicator.className = `scenario-step-readiness status-pill status-pill--${state}`;
    });
  };

  const readinessObserver = new MutationObserver(updateReadinessIndicators);
  Object.values(providerStatuses).forEach(status => {
    if (status) readinessObserver.observe(status, { attributes: true, childList: true, characterData: true });
  });

  const save = () => {
    onChange();
    render();
  };

  const updateDuplicateWarnings = (scenarioId?: string) => renderDuplicateWarnings(root, settings.scenarios, stepSettingsFromAppSettings(settings), !isAndroid, scenarioId);
  const scheduleDuplicateWarnings = (event: Event) => {
    const scenarioId = (event.target as Element).closest<HTMLElement>('.scenario-card')?.dataset.scenarioId;
    queueMicrotask(() => updateDuplicateWarnings(scenarioId));
  };
  root.addEventListener('input', scheduleDuplicateWarnings);
  root.addEventListener('change', scheduleDuplicateWarnings);

  const render = (changedScenarioId?: string) => {
    // Shared provider controls move with the active card. Rebuild the previous
    // owner too, so its settings can activate the controls again on opening.
    if (settings.activeScenarioId !== renderedActiveScenarioId) changedScenarioId = undefined;
    renderedActiveScenarioId = settings.activeScenarioId;
    if (scrollRestoreFrame !== undefined) cancelAnimationFrame(scrollRestoreFrame);
    const scrollByScenario = new Map([...root.querySelectorAll<HTMLElement>('.scenario-card')].map(card => {
      const body = card.querySelector<HTMLElement>('.scenario-card-body');
      return [card.dataset.scenarioId, { left: body?.scrollLeft ?? 0, top: body?.scrollTop ?? 0 }] as const;
    }));
    const outerScroll: { element: HTMLElement; left: number; top: number }[] = [];
    for (let element: HTMLElement | null = root; element; element = element.parentElement) {
      outerScroll.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    const restoreScroll = () => {
      root.querySelectorAll<HTMLElement>('.scenario-card').forEach(card => {
        const position = scrollByScenario.get(card.dataset.scenarioId);
        const body = card.querySelector<HTMLElement>('.scenario-card-body');
        if (position && body) { body.scrollLeft = position.left; body.scrollTop = position.top; }
      });
      // A newly created scenario intentionally focuses its name for editing.
      if (root.querySelector('input[aria-label="Название сценария"]:not([hidden])')) return;
      outerScroll.forEach(({ element, left, top }) => { element.scrollLeft = left; element.scrollTop = top; });
    };
    root.querySelectorAll<HTMLDetailsElement>('.scenario-step-details[data-scenario-step-id]').forEach(details => {
      const stepId = details.dataset.scenarioStepId;
      if (!stepId) return;
      if (details.open) openStepSettings.add(stepId);
      else openStepSettings.delete(stepId);
    });
    const retainedCards = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>('.scenario-card').forEach(card => {
      if (changedScenarioId && card.dataset.scenarioId !== changedScenarioId
        && settings.scenarios.some(scenario => scenario.id === card.dataset.scenarioId)) {
        retainedCards.set(card.dataset.scenarioId!, card);
      } else disposeScenarioColumns(card);
    });
    for (const child of [...root.children]) {
      if (!(child instanceof HTMLElement) || retainedCards.get(child.dataset.scenarioId ?? '') !== child) child.remove();
    }
    renderGlobalControls();
    renderList(root, settings, (scenario, inline, restored) => {
      settings.activeScenarioId = scenario?.id ?? '';
      onChange();
      if (settings.activeScenarioId !== renderedActiveScenarioId) render();
      else if (inline) { updateScenarioTriggerWarnings(root, settings); updateDuplicateWarnings(); }
      else if (restored && scenario) refreshRestoredScenario(scenario);
      else render(scenario?.id);
    }, renderScenario, retainedCards);
    updateReadinessIndicators();
    restoreScroll();
    updateDuplicateWarnings(changedScenarioId);
    // Column positions are measured in the same frame after their new DOM is attached.
    scrollRestoreFrame = requestAnimationFrame(() => { scrollRestoreFrame = undefined; restoreScroll(); });
  };

  const refreshRestoredScenario = (scenario: Scenario) => {
    const card = [...root.querySelectorAll<HTMLDetailsElement>('.scenario-card')]
      .find(item => item.dataset.scenarioId === scenario.id);
    const body = card?.querySelector<HTMLElement>('.scenario-card-body');
    if (!body) { render(scenario.id); return; }
    const previousDetails = new Map([...body.querySelectorAll<HTMLDetailsElement>('.scenario-step-details')]
      .map(details => [details.dataset.scenarioStepId, details]));
    previousDetails.forEach((details, id) => {
      if (id) { if (details.open) openStepSettings.add(id); else openStepSettings.delete(id); }
    });
    const settingsOnly = renderedLayouts.get(scenario.id) === scenarioLayout(scenario.steps);
    const replacement = document.createElement('div');
    renderScenario(replacement, scenario);
    replacement.querySelectorAll<HTMLDetailsElement>('.scenario-step-details').forEach(details => {
      const previous = previousDetails.get(details.dataset.scenarioStepId);
      if (!previous) return;
      previous.replaceChildren(...details.childNodes);
      if (!settingsOnly) details.replaceWith(previous);
    });
    if (settingsOnly) {
      body.querySelector('.scenario-validation')?.replaceWith(replacement.querySelector('.scenario-validation')!);
      disposeScenarioColumns(replacement);
    } else {
      disposeScenarioColumns(body);
      body.replaceChildren(...replacement.childNodes);
    }
    card!.open = true;
    updateScenarioTriggerWarnings(root, settings);
    updateReadinessIndicators();
    updateDuplicateWarnings(scenario.id);
  };

  const renderGlobalControls = () => {
    if (isAndroid) {
      const label = document.createElement('label');
      label.className = 'scenario-overlay-selector';
      label.textContent = 'Сценарий';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Сценарий для оверлея');
      for (const scenario of settings.scenarios) {
        select.add(new Option(scenario.name, scenario.id));
      }
      if (!settings.scenarios.length) select.add(new Option('Нет сценариев', ''));
      select.value = settings.androidScenarioId;
      select.disabled = !settings.scenarios.length;
      select.addEventListener('change', () => {
        settings.androidScenarioId = select.value;
        onChange();
      });
      label.append(select);
      root.prepend(label);
    }
  };

  const renderScenario = (root: HTMLElement, scenario: Scenario) => {
    const save = () => {
      settings.activeScenarioId = scenario.id;
      onChange();
      render(scenario.id);
    };
    const restoreStepDetails = (details: HTMLDetailsElement, stepId: string) => {
      details.dataset.scenarioStepId = stepId;
      details.open = openStepSettings.has(stepId);
    };
    const appendStepSettings = (row: HTMLElement, details: HTMLDetailsElement,
      summary: HTMLElement, content: HTMLElement) => {
      details.hidden = !hasStepSettings(content);
      if (details.hidden) return;
      details.append(summary, content);
      row.append(details);
    };

    const problem = validateScenario(scenario);
    const status = document.createElement('p');
    status.className = `scenario-validation ${problem ? 'scenario-validation--error' : 'scenario-validation--ready'}`;
    status.setAttribute('role', 'status');
    status.textContent = problem ?? 'Сценарий готов';
    root.append(status);

    // Start and cancel belong to the whole scenario: they sit between its header
    // and its steps. The start key stays on the source step (`steps[0]`).
    // `visibleTitle: false` keeps the title for screen readers only.
    const hotkeyField = (container: HTMLElement, title: string, read: () => string, write: (value: string) => void, required = false, visibleTitle = true) => {
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = title;
      if (required) {
        label.className = 'form-field--important';
        const marker = document.createElement('span');
        marker.className = 'req-marker'; marker.textContent = '*'; marker.setAttribute('aria-hidden', 'true');
        caption.append(marker);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = formatHotkey(read());
      input.placeholder = 'Нажмите сочетание';
      input.title = 'Нажмите, затем введите сочетание клавиш';
      input.setAttribute('aria-label', title);
      if (required) input.setAttribute('aria-required', 'true');
      input.addEventListener('focus', () => { input.value = 'Нажмите сочетание…'; });
      input.addEventListener('blur', () => { input.value = formatHotkey(read()); });
      input.addEventListener('keydown', event => {
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        const parts: string[] = [];
        if (event.ctrlKey) parts.push('Control');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (event.metaKey) parts.push('Meta');
        parts.push(event.code || event.key);
        write(['Backspace', 'Delete'].includes(event.key) ? '' : parts.join('+'));
        save();
      });
      if (!visibleTitle) {
        // Placed inside the caller's own label, right after its other control.
        container.append(input);
        return { label: container, input };
      }
      label.append(caption, input);
      container.append(label);
      return { label, input };
    };

    // Stop belongs to recording (the Запись and Claude Code steps), not to the
    // scenario: by default the start key also stops, or a separate key stops.
    const mountStop = (container: HTMLElement, step: ScenarioStep) => {
      const stopLabel = document.createElement('label');
      const stopCaption = document.createElement('span');
      stopCaption.textContent = 'Стоп';
      const stopMode = document.createElement('select');
      stopMode.setAttribute('aria-label', 'Режим стопа');
      stopMode.add(new Option('Как старт', 'start'));
      stopMode.add(new Option('Своя клавиша', 'own'));
      const ownStop = step.hotkeyStop !== undefined;
      stopMode.value = ownStop ? 'own' : 'start';
      stopMode.addEventListener('change', () => {
        if (stopMode.value === 'own') step.hotkeyStop = '';
        else delete step.hotkeyStop;
        save();
      });
      stopLabel.append(stopCaption, stopMode);
      container.append(stopLabel);
      if (!ownStop) return;
      const stopProblem = scenarioStopProblem(settings.scenarios, scenario)
        ?? (step.hotkeyStop ? null : 'Назначьте клавишу стопа.');
      // Right after the «Своя клавиша» selector, which already names it.
      const stop = hotkeyField(stopLabel, 'Клавиша стопа', () => step.hotkeyStop ?? '', value => { step.hotkeyStop = value; }, false, false);
      stop.label.classList.toggle('is-invalid', !!stopProblem);
      stop.input.setAttribute('aria-invalid', String(!!stopProblem));
      if (stopProblem) stop.input.title = stopProblem;
    };

    const triggerStep = scenario.steps.find(step => isTriggerStep(step));
    if (!isAndroid && triggerStep) {
      const hotkeys = document.createElement('div');
      hotkeys.className = 'scenario-hotkeys';
      const triggerProblem = scenarioTriggerProblem(settings.scenarios, { ...scenario, enabled: true }, settings.hotkeyCancel);
      const start = hotkeyField(hotkeys, 'Старт', () => triggerStep.hotkey ?? '', value => { triggerStep.hotkey = value; }, true);
      start.label.classList.toggle('is-invalid', !!triggerProblem);
      start.input.setAttribute('aria-invalid', String(!!triggerProblem));
      // Only a problem is worth a pill here: a ready trigger is covered by «Сценарий готов».
      if (triggerProblem) {
        start.input.setAttribute('aria-describedby', `trigger-status-${triggerStep.id}`);
        const triggerStatus = document.createElement('span');
        triggerStatus.id = `trigger-status-${triggerStep.id}`;
        triggerStatus.className = 'scenario-trigger-status status-pill status-pill--error';
        triggerStatus.textContent = triggerStep.hotkey?.trim() ? 'Триггер недоступен' : 'Не задан старт';
        triggerStatus.title = triggerProblem;
        triggerStatus.setAttribute('role', 'status');
        start.label.append(triggerStatus);
      }

      hotkeyField(hotkeys, 'Отмена', () => scenarioCancelHotkey(scenario), value => { scenario.hotkeyCancel = value || undefined; });
      root.append(hotkeys);
    }

    const steps = document.createElement('ol');
    steps.className = 'scenario-steps';
    for (const [index, step] of scenario.steps.entries()) {
      const contract = getScenarioStepContract(step.type);
      const row = document.createElement('li');
      row.className = `scenario-step scenario-step--${contract.category}${step.enabled ? '' : ' scenario-step--disabled'}`;
      const categoryLabel = contract.category === 'source' ? 'Источник'
        : contract.category === 'transformation' ? 'Преобразование' : 'Сквозное действие';
      row.setAttribute('aria-label', `Шаг ${index + 1}: ${contract.title}, ${categoryLabel}`);
      if (contract.category !== 'action') {
        const marker = document.createElement('span');
        marker.className = 'scenario-step-marker';
        marker.textContent = contract.category === 'source' ? '●' : 'Δ';
        marker.title = categoryLabel;
        marker.setAttribute('aria-hidden', 'true');
        row.append(marker);
      }

      const typeSelect = document.createElement('select');
      typeSelect.className = 'scenario-step-type';
      typeSelect.disabled = !step.enabled;
      typeSelect.title = categoryLabel;
      typeSelect.setAttribute('aria-label', `Шаг ${index + 1}`);
      const compatibleTypes = getCompatibleTypes(scenario, index);
      for (const type of compatibleTypes.includes(step.type) ? compatibleTypes : [step.type, ...compatibleTypes]) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = getScenarioStepContract(type).title;
        option.selected = type === step.type;
        typeSelect.append(option);
      }
      typeSelect.addEventListener('change', () => {
        const nextType = typeSelect.value;
        if (!isScenarioStepType(nextType)) return;
        step.type = nextType;
        step.output = getScenarioStepContract(nextType).outputs[0];
        scenario.steps.splice(index + 1);
        save();
      });
      row.append(typeSelect);

      if (step.type === 'claudeCode') {
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        mountClaudeCodeSettings(content, step, save);
        if (!isAndroid) {
          const stopOptions = document.createElement('div');
          stopOptions.className = 'scenario-trigger-options';
          mountStop(stopOptions, step);
          content.prepend(stopOptions);
        }
        appendStepSettings(row, details, summary, content);
      }

      if (step.type === 'startRecording') {
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const microphoneStatus = document.createElement('span');
        const microphoneId = step.microphoneId || '';
        const device = microphones.find(item => item.id === microphoneId);
        const checked = microphoneChecks.get(microphoneId);
        const problem = microphoneListError || (!microphoneLoading && !device ? 'Выбранный микрофон не найден' : device?.error) || (checked && !checked.ready ? checked.text : '');
        microphoneStatus.className = `scenario-microphone-status status-pill ${problem ? 'status-pill--error' : checked?.ready ? 'status-pill--ready' : 'status-pill--idle'}`;
        microphoneStatus.textContent = microphoneLoading ? 'Проверяется' : problem ? 'Не готов' : checked?.text || 'Не проверен';
        microphoneStatus.title = problem || checked?.text || 'Проверьте доступ к выбранному микрофону';
        microphoneStatus.setAttribute('role', 'status');
        summary.append(microphoneStatus);
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        const microphoneOptions = document.createElement('div');
        microphoneOptions.className = 'scenario-trigger-options scenario-microphone-options';
        const microphoneLabel = document.createElement('label');
        microphoneLabel.textContent = 'Микрофон';
        const microphoneSelect = document.createElement('select');
        microphoneSelect.id = `microphone-${step.id}`;
        microphoneLabel.htmlFor = microphoneSelect.id;
        microphoneSelect.setAttribute('aria-label', 'Выбрать микрофон');
        const choices = microphones.length ? [...microphones] : [{ id: '', name: 'Системный микрофон', error: null }];
        if (microphoneId && !choices.some(item => item.id === microphoneId)) {
          choices.push({ id: microphoneId, name: `${microphoneId} (недоступен)`, error: 'Микрофон не найден' });
        }
        for (const device of choices) {
          const option = document.createElement('option');
          option.value = device.id;
          option.textContent = device.name;
          option.selected = device.id === microphoneId;
          microphoneSelect.append(option);
        }
        microphoneSelect.addEventListener('change', () => {
          microphoneCheckGeneration++;
          step.microphoneId = microphoneSelect.value;
          save();
        });
        const check = button('Проверить', 'Проверить доступ к микрофону', async () => {
          const generation = ++microphoneCheckGeneration;
          check.disabled = true;
          microphoneStatus.textContent = 'Проверяется';
          microphoneStatus.className = 'scenario-microphone-status status-pill status-pill--idle';
          try {
            await checkMicrophone(microphoneId);
            if (generation !== microphoneCheckGeneration) return;
            microphoneChecks.set(microphoneId, { text: 'Готов', ready: true });
            const devices = await listMicrophones();
            if (generation !== microphoneCheckGeneration) return;
            microphones = devices;
            microphoneListError = '';
          } catch (error) {
            if (generation !== microphoneCheckGeneration) return;
            microphoneChecks.set(microphoneId, { text: errorMessage(error), ready: false });
          }
          render();
        });
        const microphoneControls = document.createElement('div');
        microphoneControls.className = 'scenario-microphone-controls';
        microphoneControls.append(microphoneSelect, check, button('↻', 'Обновить список микрофонов', () => { void refreshMicrophones(); }));
        microphoneOptions.append(microphoneLabel, microphoneControls);
        content.append(microphoneOptions);
        const afterStopLabel = document.createElement('label');
        afterStopLabel.className = 'scenario-step-setting-label scenario-step-setting-label-inline';
        afterStopLabel.textContent = 'Время после стопа:';
        const afterStopInput = document.createElement('input');
        afterStopInput.type = 'number';
        afterStopInput.min = '0';
        afterStopInput.step = '1';
        afterStopInput.value = String(normalizeAfterStopMs(step.afterStopMs));
        afterStopInput.setAttribute('aria-label', 'Время после стопа, мс');
        afterStopInput.title = 'Продолжать запись после стопа; 0 — до нажатия. На паузу не влияет.';
        afterStopInput.addEventListener('change', () => {
          const value = afterStopInput.valueAsNumber;
          if (!Number.isSafeInteger(value) || value < 0) {
            afterStopInput.value = String(normalizeAfterStopMs(step.afterStopMs));
            return;
          }
          step.afterStopMs = value;
          save();
        });
        afterStopLabel.append(afterStopInput, document.createTextNode(' мс'));
        const soundOptions = document.createElement('div');
        soundOptions.className = 'scenario-trigger-options scenario-trigger-sound-options';
        const soundEnabledLabel = document.createElement('label');
        soundEnabledLabel.className = 'checkbox-label';
        const soundEnabledInput = document.createElement('input');
        soundEnabledInput.type = 'checkbox';
        soundEnabledInput.checked = step.soundEnabled ?? settings.soundEnabled;
        soundOptions.hidden = !soundEnabledInput.checked;
        soundEnabledInput.addEventListener('change', () => {
          step.soundEnabled = soundEnabledInput.checked;
          soundOptions.hidden = !soundEnabledInput.checked;
          content.closest('.scenario-card-body')?.querySelectorAll<HTMLElement>('.scenario-paste-sound-options').forEach(option => {
            option.hidden = !soundEnabledInput.checked;
          });
          onChange();
        });
        soundEnabledLabel.append(soundEnabledInput, document.createTextNode('Звук сигналов'));

        const triggerOptions = document.createElement('div');
        triggerOptions.className = 'scenario-trigger-options';

        const pauseHotkeyLabel = document.createElement('label');
        pauseHotkeyLabel.textContent = 'Пауза/продолжить';
        const pauseHotkeyInput = document.createElement('input');
        pauseHotkeyInput.type = 'text';
        pauseHotkeyInput.readOnly = true;
        pauseHotkeyInput.value = formatHotkey(step.hotkeyPause ?? settings.hotkeyPause);
        pauseHotkeyInput.placeholder = 'Нажмите сочетание';
        pauseHotkeyInput.title = 'Нажмите, затем введите сочетание клавиш для паузы и продолжения записи';
        pauseHotkeyInput.addEventListener('focus', () => { pauseHotkeyInput.value = 'Нажмите сочетание…'; });
        pauseHotkeyInput.addEventListener('blur', () => { pauseHotkeyInput.value = formatHotkey(step.hotkeyPause ?? settings.hotkeyPause); });
        pauseHotkeyInput.addEventListener('keydown', event => {
          event.preventDefault();
          event.stopPropagation();
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
          const parts: string[] = [];
          if (event.ctrlKey) parts.push('Control');
          if (event.altKey) parts.push('Alt');
          if (event.shiftKey) parts.push('Shift');
          parts.push(event.code || event.key);
          step.hotkeyPause = parts.join('+');
          save();
        });
        pauseHotkeyLabel.append(pauseHotkeyInput);

        const soundLabel = document.createElement('label');
        soundLabel.textContent = 'Звук старта';
        const soundSelect = document.createElement('select');
        soundSelect.setAttribute('aria-label', 'Звук старта записи');
        for (const [value, label] of [['chime', 'Колокольчик'], ['beep', 'Бип'], ['none', 'Без звука']] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          option.selected = value === (step.sound ?? 'chime');
          soundSelect.append(option);
        }
        soundSelect.addEventListener('change', () => {
          if (soundSelect.value === 'chime' || soundSelect.value === 'beep' || soundSelect.value === 'none') {
            step.sound = soundSelect.value;
            save();
          }
        });
        soundLabel.append(soundSelect);
        const profileLabel = document.createElement('label');
        profileLabel.textContent = 'Тембр';
        const profileSelect = document.createElement('select');
        profileSelect.setAttribute('aria-label', 'Тембр звука сценария');
        for (const [value, label] of [['default', 'Клик'], ['soft', 'Мягкий']] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          option.selected = value === (step.soundProfile ?? settings.soundProfile);
          profileSelect.append(option);
        }
        profileSelect.addEventListener('change', () => {
          step.soundProfile = profileSelect.value === 'soft' ? 'soft' : 'default';
          save();
        });
        profileLabel.append(profileSelect);
        if (!isAndroid) mountStop(triggerOptions, step);
        triggerOptions.append(pauseHotkeyLabel);
        soundOptions.append(soundLabel, profileLabel);
        const soundRow = document.createElement('div');
        soundRow.className = 'scenario-trigger-sound-row';
        soundRow.append(soundEnabledLabel, soundOptions);
        // Stop and pause/continue first, then how long recording continues after stop.
        content.append(triggerOptions, afterStopLabel, soundRow);
        appendStepSettings(row, details, summary, content);
      } else if (step.type === 'copy' && !isAndroid) {
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        const label = document.createElement('label');
        label.className = 'scenario-step-setting-label';
        label.textContent = 'Уровень в истории';
        const input = document.createElement('input');
        input.type = 'number';
        input.max = '0';
        input.step = '1';
        input.value = String(normalizeClipboardHistoryLevel(step.clipboardHistoryLevel));
        input.setAttribute('aria-label', 'Уровень в истории буфера обмена');
        input.title = '0 — сверху, −1 — на одну позицию ниже, −2 — на две и так далее';
        input.addEventListener('change', () => {
          const level = input.valueAsNumber;
          if (!Number.isSafeInteger(level) || level > 0) {
            input.value = String(normalizeClipboardHistoryLevel(step.clipboardHistoryLevel));
            return;
          }
          step.clipboardHistoryLevel = level;
          save();
        });
        label.append(input);
        content.append(label);
        appendStepSettings(row, details, summary, content);
      } else if (step.type === 'paste') {
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        const soundOptions = document.createElement('div');
        soundOptions.className = 'scenario-paste-sound-options';
        soundOptions.hidden = scenario.steps.find(item => item.type === 'startRecording')?.soundEnabled === false;
        const soundLabel = document.createElement('label');
        soundLabel.className = 'scenario-step-setting-label';
        soundLabel.textContent = 'Звук вставки';
        const soundSelect = document.createElement('select');
        soundSelect.setAttribute('aria-label', 'Звук вставки текста');
        for (const [value, label] of [['chord', 'Аккорд'], ['click', 'Клик'], ['none', 'Нет']] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          option.selected = value === (step.soundSuccess ?? settings.soundSuccess);
          soundSelect.append(option);
        }
        soundSelect.addEventListener('change', () => {
          if (soundSelect.value === 'chord' || soundSelect.value === 'click' || soundSelect.value === 'none') {
            step.soundSuccess = soundSelect.value;
            save();
          }
        });
        soundLabel.append(soundSelect);
        soundOptions.append(soundLabel);
        content.append(soundOptions);
        if (!isAndroid) {
          const label = document.createElement('label');
          label.className = 'checkbox-label';
          const toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.checked = step.returnFocusToOriginalWindow === true;
          toggle.addEventListener('change', () => { step.returnFocusToOriginalWindow = toggle.checked; save(); });
          label.append(toggle, 'Возвращать фокус перед вставкой');
          content.append(label);
        }
        appendStepSettings(row, details, summary, content);
      } else if (step.type === 'speak') {
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.textContent = 'Настройки';
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        mountSpeechProvider(content, step, save, onChange);
        appendStepSettings(row, details, summary, content);
      } else if (step.type === 'transcribe' || step.type === 'postprocess') {
        // Legacy shared controls edit the first step of each provider type.
        // Repeated steps need their own controls instead of stealing that panel.
        const primary = scenario.steps.find(item => item.type === step.type) === step;
        const panel = primary ? (step.type === 'transcribe' ? transcriptionPanel : postprocessingPanel) : null;
        const details = document.createElement('details');
        details.className = 'scenario-step-details';
        restoreStepDetails(details, step.id);
        const summary = document.createElement('summary');
        summary.append(document.createTextNode('Настройки'));
        const readiness = document.createElement('span');
        readiness.className = 'scenario-step-readiness';
        if (panel && settings.activeScenarioId === scenario.id) readiness.dataset.stepType = step.type;
        else readiness.textContent = 'Не проверен';
        readiness.setAttribute('role', 'status');
        summary.append(readiness);
        const content = document.createElement('div');
        content.className = 'scenario-step-settings';
        const focused = settings.activeScenarioId === scenario.id;
        if (!panel) mountBranchStepSettings(content, step, save, onChange);
        else if (focused) content.append(panel);
        else {
          details.open = false;
          const placeholder = document.createElement('span');
          placeholder.dataset.settingsPending = '';
          content.append(placeholder);
          summary.addEventListener('click', event => {
            event.preventDefault();
            for (const sharedPanel of [transcriptionPanel, postprocessingPanel]) {
              const previous = sharedPanel?.closest('details');
              if (previous) previous.open = false;
            }
            details.open = true;
            openStepSettings.add(step.id);
            settings.activeScenarioId = scenario.id;
            onChange();
            render();
          });
        }
        if (panel && step.type === 'transcribe') mountFinalTranscriptionSetting(content, step, save);
        appendStepSettings(row, details, summary, content);
      }

      if (step.type === 'copy' || step.type === 'paste') {
        let details = row.querySelector<HTMLDetailsElement>('.scenario-step-details');
        if (!details) {
          details = document.createElement('details');
          details.className = 'scenario-step-details';
          restoreStepDetails(details, step.id);
          const summary = document.createElement('summary');
          summary.textContent = 'Настройки';
          const content = document.createElement('div');
          content.className = 'scenario-step-settings';
          details.append(summary, content);
          row.append(details);
        }
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.dataset.showTextInOverlay = '';
        toggle.checked = step.showTextInOverlay === true;
        toggle.addEventListener('change', () => { step.showTextInOverlay = toggle.checked; save(); });
        label.append(toggle, 'Показывать текст в оверлее');
        details.querySelector('.scenario-step-settings')!.append(label);
      }
      const actions = document.createElement('div');
      actions.className = 'scenario-step-actions';
      if (canDisableScenarioStep(step)) {
        actions.append(button(
          step.enabled ? 'Ⅱ' : '▶',
          `${step.enabled ? 'Отключить' : 'Включить'} шаг ${index + 1}`,
          () => { step.enabled = !step.enabled; save(); },
        ));
      }
      actions.append(button('↑', `Переместить шаг ${index + 1} вверх`, () => moveStep(scenario, index, index - 1), index === 0));
      actions.append(button('↓', `Переместить шаг ${index + 1} вниз`, () => moveStep(scenario, index, index + 1), index === scenario.steps.length - 1));
      actions.append(button('×', `Удалить шаг ${index + 1}`, () => {
        scenario.steps.splice(index, 1);
        save();
      }));
      row.append(actions);
      if (!step.enabled) {
        const state = document.createElement('span');
        state.className = 'scenario-step-state';
        state.textContent = 'Отключён · нажмите ▶, чтобы включить';
        row.append(state);
      }
      steps.append(row);

      const nextStep = scenario.steps[index + 1];
      if (nextStep) {
        const connection = document.createElement('li');
        connection.className = 'scenario-connection';
        connection.setAttribute('aria-label', `Передача данных от шага ${index + 1} к шагу ${index + 2}`);

        const nextInput = getScenarioStepContract(nextStep.type).input;
        if (contract.outputs.length > 1) {
          const outputSelect = document.createElement('select');
          outputSelect.className = 'scenario-connection-type';
          outputSelect.setAttribute('aria-label', `Тип данных между шагами ${index + 1} и ${index + 2}`);
          for (const output of contract.outputs) {
            const option = document.createElement('option');
            option.value = output;
            option.textContent = scenarioDataTypeLabel(output);
            option.selected = output === step.output;
            outputSelect.append(option);
          }
          outputSelect.addEventListener('change', () => {
            const selected = contract.outputs.find(output => output === outputSelect.value);
            if (!selected) return;
            step.output = selected;
            save();
          });
          connection.append(outputSelect);
        } else {
          const typeBadge = document.createElement('span');
          typeBadge.className = 'scenario-connection-type';
          typeBadge.textContent = scenarioDataTypeLabel(step.output);
          connection.append(typeBadge);
        }

        if (step.output !== nextInput) {
          connection.classList.add('scenario-connection--mismatch');
          connection.title = `Шаг передаёт «${scenarioDataTypeLabel(step.output)}», а следующий ожидает «${scenarioDataTypeLabel(nextInput)}».`;
        }
        steps.append(connection);
      }
    }
    const flow = document.createElement('div');
    flow.className = 'scenario-flow';
    flow.append(steps);
    root.append(flow);

    const lastStep = scenario.steps[scenario.steps.length - 1];
    const previousOutput = lastStep?.output ?? 'audio';
    const compatibleTypes = getCompatibleTypes(scenario, scenario.steps.length);
    if (lastStep) {
      const outputContract = getScenarioStepContract(lastStep.type);
      const connection = document.createElement('div');
      connection.className = 'scenario-connection scenario-connection--pending';
      connection.setAttribute('aria-label', `Тип данных для следующего шага: ${scenarioDataTypeLabel(lastStep.output)}`);

      if (outputContract.outputs.length > 1) {
        const outputSelect = document.createElement('select');
        outputSelect.className = 'scenario-connection-type';
        outputSelect.setAttribute('aria-label', 'Тип данных для следующего шага');
        for (const output of outputContract.outputs) {
          const option = document.createElement('option');
          option.value = output;
          option.textContent = scenarioDataTypeLabel(output);
          option.selected = output === lastStep.output;
          outputSelect.append(option);
        }
        outputSelect.addEventListener('change', () => {
          const selected = outputContract.outputs.find(output => output === outputSelect.value);
          if (!selected) return;
          lastStep.output = selected;
          save();
        });
        connection.append(outputSelect);
      } else {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'scenario-connection-type';
        typeBadge.textContent = scenarioDataTypeLabel(lastStep.output);
        connection.append(typeBadge);
      }

      flow.append(connection);
    }

    if (compatibleTypes.length) {
      const nextRow = document.createElement('div');
      nextRow.className = 'scenario-add-row';
      const nextSelect = document.createElement('select');
      nextSelect.setAttribute('aria-label', 'Следующий шаг сценария');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Выберите следующий шаг…';
      nextSelect.append(placeholder);
      for (const type of compatibleTypes) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = getScenarioStepContract(type).title;
        nextSelect.append(option);
      }
      nextSelect.addEventListener('change', () => {
        if (!isScenarioStepType(nextSelect.value)) return;
        scenario.steps.push(createStep(
          nextSelect.value,
          settings.hotkeyRecord,
          settings.soundStart,
          stepSettingsFromAppSettings(settings),
          { enabled: settings.soundEnabled, profile: settings.soundProfile, insert: settings.soundSuccess },
          settings.hotkeyPause,
        ));
        save();
      });
      nextRow.append(nextSelect);
      flow.append(nextRow);
    } else if (!problem) {
      const end = document.createElement('p');
      end.className = 'scenario-end';
      end.textContent = 'Конец сценария';
      flow.append(end);
    } else if (previousOutput !== 'void' && scenario.steps.length > 0) {
      const hint = document.createElement('p');
      hint.className = 'scenario-step-contract';
      hint.textContent = `Нет шага, принимающего тип «${scenarioDataTypeLabel(previousOutput)}». Выберите другой выход или измените порядок.`;
      flow.append(hint);
    } else if (scenario.steps.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'scenario-step-contract';
      hint.textContent = 'Нет шага, принимающего тип «Аудио».';
      flow.append(hint);
    }

    createBrowserScenarioPreview()(flow, scenario, save, openStepSettings, () => {
      settings.activeScenarioId = scenario.id;
      onChange();
    });
    renderedLayouts.set(scenario.id, scenarioLayout(scenario.steps));
    updateReadinessIndicators();
  };

  function moveStep(scenario: Scenario, from: number, to: number): void {
    if (to < 0 || to >= scenario.steps.length) return;
    settings.activeScenarioId = scenario.id;
    const [step] = scenario.steps.splice(from, 1);
    scenario.steps.splice(to, 0, step);
    save();
  }

  render();
  void refreshMicrophones();
  navigator.mediaDevices?.addEventListener('devicechange', () => { void refreshMicrophones(); });
  return render;
}

function stepSettingsFromAppSettings(settings: AppSettings): ScenarioStepSettingsDefaults {
  return {
    transcription: {
      provider: settings.provider,
      googleCloud: settings.googleCloud,
      geminiTranscription: settings.geminiTranscription,
      apiKey: settings.groqApiKey,
      model: settings.groqModel,
      prompt: settings.groqPrompt,
      temperature: settings.groqTemperature,
      language: settings.groqLanguage,
      responseFormat: settings.groqResponseFormat,
      liveTranscriptionEnabled: settings.liveTranscriptionEnabled,
      retranscribeFullRecording: false,
      liveSilenceDurationMs: settings.liveSilenceDurationMs,
      liveMaxChunkDurationSeconds: settings.liveMaxChunkDurationSeconds,
      liveChunkOverlapSeconds: settings.liveChunkOverlapSeconds,
    },
    postprocessing: {
      provider: settings.postProcessProvider,
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      prompt: settings.geminiPrompt,
    },
  };
}

function getCompatibleTypes(scenario: Scenario, index: number): ScenarioStepType[] {
  const previousOutput = index === 0 ? 'trigger' : scenario.steps[index - 1]?.output;
  if (!previousOutput) return [];
  return stepChoices.filter(type =>
    getScenarioStepContract(type).input === previousOutput
    && !scenario.steps.some((step, stepIndex) => step.type === type && stepIndex !== index),
  );
}

function formatHotkey(value: string): string {
  return value.split('+').map(part => {
    if (part === 'Control') return 'Ctrl';
    if (part === 'Meta') return 'Win';
    if (part.startsWith('Key')) return part.slice(3);
    if (part.startsWith('Digit')) return part.slice(5);
    return part;
  }).join('+');
}

function button(label: string, description: string, onClick: () => void, disabled = false, icon?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'btn secondary scenario-button';
  if (icon) element.innerHTML = icon;
  else element.textContent = label;
  element.title = description;
  element.setAttribute('aria-label', description);
  element.disabled = disabled;
  element.addEventListener('click', onClick);
  return element;
}

