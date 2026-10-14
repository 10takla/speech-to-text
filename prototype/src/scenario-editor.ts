import type { AppSettings } from './config';
import { checkMicrophone, listMicrophones, type Microphone } from './microphones';
import { errorMessage } from './error-message';
import { isAndroid } from './android-runtime';
import {
  canDisableScenarioStep,
  normalizeClipboardHistoryLevel,
  createStep,
  type ScenarioStepSettingsDefaults,
  getScenarioStepContract,
  isScenarioStepType,
  scenarioDataTypeLabel,
  validateScenario,
  type Scenario,
  type ScenarioStepType,
} from './scenario';

const stepChoices: readonly ScenarioStepType[] = ['startRecording', 'transcribe', 'postprocess', 'copy', 'paste'];

export function mountScenarioEditor(
  root: HTMLElement,
  settings: AppSettings,
  onChange: () => void,
): () => void {
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

  let editingScenarioId: string | null = null;
  const openStepSettings = new Set<string>();
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

  const getActiveScenario = (): Scenario =>
    settings.scenarios.find(scenario => scenario.id === settings.activeScenarioId) ?? settings.scenarios[0];

  const render = () => {
    root.querySelectorAll<HTMLDetailsElement>('.scenario-step-details[data-scenario-step-id]').forEach(details => {
      const stepId = details.dataset.scenarioStepId;
      if (!stepId) return;
      if (details.open) openStepSettings.add(stepId);
      else openStepSettings.delete(stepId);
    });
    root.replaceChildren();
    const scenario = getActiveScenario();
    if (!scenario) return;
    const restoreStepDetails = (details: HTMLDetailsElement, stepId: string) => {
      details.dataset.scenarioStepId = stepId;
      details.open = openStepSettings.has(stepId);
    };
    const appendStepSettings = (row: HTMLElement, details: HTMLDetailsElement,
      summary: HTMLElement, content: HTMLElement) => {
      details.hidden = !Array.from(content.children).some(child => !child.hasAttribute('hidden'));
      if (details.hidden) return;
      details.append(summary, content);
      row.append(details);
    };

    const isEditingName = editingScenarioId === scenario.id;

    const toolbar = document.createElement('div');
    toolbar.className = 'scenario-toolbar';

    const pickerWrapper = document.createElement('div');
    pickerWrapper.className = 'scenario-picker-wrapper';

    const picker = document.createElement('select');
    picker.className = 'scenario-picker-select';
    picker.setAttribute('aria-label', 'Активный сценарий');
    for (const item of settings.scenarios) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || 'Без названия';
      option.selected = item.id === settings.activeScenarioId;
      picker.append(option);
    }
    picker.addEventListener('change', () => {
      settings.activeScenarioId = picker.value;
      save();
    });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'scenario-picker-input';
    nameInput.maxLength = 64;
    nameInput.value = scenario.name;
    nameInput.style.display = isEditingName ? 'block' : 'none';
    picker.style.display = isEditingName ? 'none' : '';
    const nameError = document.createElement('span');
    nameError.className = 'scenario-name-error';
    nameError.setAttribute('role', 'alert');
    nameError.textContent = 'Сценарий с таким названием уже существует.';
    nameError.hidden = true;

    nameInput.addEventListener('input', () => {
      nameError.hidden = true;
      nameInput.removeAttribute('aria-invalid');
    });

    const finishRename = () => {
      if (editingScenarioId !== scenario.id) return;
      const trimmed = nameInput.value.trim();
      if (trimmed && hasScenarioName(settings.scenarios, trimmed, scenario.id)) {
        nameError.hidden = false;
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      if (trimmed) scenario.name = trimmed;
      editingScenarioId = null;
      save();
    };

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        editingScenarioId = null;
        render();
      }
    });
    nameInput.addEventListener('blur', finishRename);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-icon scenario-rename-btn';
    editBtn.title = 'Переименовать сценарий';
    editBtn.innerHTML = scenarioIcon('edit');
    if (isEditingName) {
      editBtn.innerHTML = scenarioIcon('check');
      editBtn.title = 'Сохранить название';
    }
    editBtn.addEventListener('click', () => {
      if (!isEditingName) {
        editingScenarioId = scenario.id;
        picker.style.display = 'none';
        nameInput.style.display = 'block';
        nameInput.value = scenario.name;
        nameInput.focus();
        nameInput.select();
        editBtn.innerHTML = scenarioIcon('check');
        editBtn.title = 'Сохранить название';
      } else {
        finishRename();
      }
    });

    pickerWrapper.append(picker, nameInput, editBtn, nameError);
    toolbar.append(pickerWrapper);

    toolbar.append(button('Новый', 'Создать сценарий', () => {
      const created: Scenario = {
        id: crypto.randomUUID(),
        name: getUniqueScenarioName('Новый сценарий', settings.scenarios),
        steps: [],
      };
      settings.scenarios.push(created);
      settings.activeScenarioId = created.id;
      editingScenarioId = created.id;
      save();
    }, false, scenarioIcon('plus')));
    toolbar.append(button('Копировать', 'Создать копию сценария', () => {
      const copy: Scenario = {
        id: crypto.randomUUID(),
        name: getUniqueScenarioName(`${scenario.name} — копия`, settings.scenarios),
        steps: scenario.steps.map(step => ({
          ...step,
          id: crypto.randomUUID(),
          transcription: step.transcription ? { ...step.transcription } : undefined,
          postprocessing: step.postprocessing ? {
            ...step.postprocessing,
            generationConfig: step.postprocessing.generationConfig ? { ...step.postprocessing.generationConfig } : undefined,
          } : undefined,
        })),
      };
      settings.scenarios.push(copy);
      settings.activeScenarioId = copy.id;
      save();
    }, false, scenarioIcon('copy')));
    toolbar.append(button('Удалить', 'Удалить сценарий', () => {
      if (settings.scenarios.length < 2) return;
      if (!window.confirm(`Удалить сценарий «${scenario.name}»?`)) return;
      const deletedIndex = settings.scenarios.findIndex(item => item.id === scenario.id);
      settings.scenarios.splice(deletedIndex, 1);
      const selectedIndex = Math.min(deletedIndex, settings.scenarios.length - 1);
      settings.activeScenarioId = settings.scenarios[selectedIndex].id;
      if (editingScenarioId === scenario.id) editingScenarioId = null;
      save();
    }, settings.scenarios.length < 2, scenarioIcon('delete')));
    root.append(toolbar);
    if (isEditingName) {
      nameInput.focus();
      nameInput.select();
    }

    const scenarioControls = document.createElement('div');
    scenarioControls.className = 'scenario-global-controls';
    const cancelHotkeyLabel = document.createElement('label');
    cancelHotkeyLabel.textContent = 'Отмена сценария';
    const cancelHotkeyInput = document.createElement('input');
    cancelHotkeyInput.type = 'text';
    cancelHotkeyInput.readOnly = true;
    cancelHotkeyInput.value = formatHotkey(settings.hotkeyCancel || 'Escape');
    cancelHotkeyInput.placeholder = 'Нажмите сочетание';
    cancelHotkeyInput.title = 'Остановить весь процесс и закрыть оверлей';
    cancelHotkeyInput.setAttribute('aria-label', 'Горячая клавиша отмены сценария');
    cancelHotkeyInput.addEventListener('focus', () => { cancelHotkeyInput.value = 'Нажмите сочетание…'; });
    cancelHotkeyInput.addEventListener('blur', () => {
      cancelHotkeyInput.value = formatHotkey(settings.hotkeyCancel || 'Escape');
    });
    cancelHotkeyInput.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const parts: string[] = [];
      if (event.ctrlKey) parts.push('Control');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');
      if (event.metaKey) parts.push('Meta');
      parts.push(event.code || event.key);
      settings.hotkeyCancel = parts.join('+');
      save();
    });
    cancelHotkeyLabel.append(cancelHotkeyInput);
    scenarioControls.append(cancelHotkeyLabel);
    root.append(scenarioControls);

    const problem = validateScenario(scenario);
    const status = document.createElement('p');
    status.className = `scenario-validation ${problem ? 'scenario-validation--error' : 'scenario-validation--ready'}`;
    status.setAttribute('role', 'status');
    status.textContent = problem ?? 'Сценарий готов';
    root.append(status);

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
          root.querySelectorAll<HTMLElement>('.scenario-paste-sound-options').forEach(option => {
            option.hidden = !soundEnabledInput.checked;
          });
          onChange();
        });
        soundEnabledLabel.append(soundEnabledInput, document.createTextNode('Звук сигналов'));

        const triggerOptions = document.createElement('div');
        triggerOptions.className = 'scenario-trigger-options';
        const hotkeyLabel = document.createElement('label');
        hotkeyLabel.textContent = 'Старт записи';
        const hotkeyInput = document.createElement('input');
        hotkeyInput.type = 'text';
        hotkeyInput.readOnly = true;
        hotkeyInput.value = formatHotkey(step.hotkey ?? 'Control+Digit1');
        hotkeyInput.placeholder = 'Нажмите сочетание';
        hotkeyInput.title = 'Нажмите, затем введите сочетание клавиш';
        hotkeyInput.addEventListener('focus', () => { hotkeyInput.value = 'Нажмите сочетание…'; });
        hotkeyInput.addEventListener('blur', () => { hotkeyInput.value = formatHotkey(step.hotkey ?? 'Control+Digit1'); });
        hotkeyInput.addEventListener('keydown', event => {
          event.preventDefault();
          event.stopPropagation();
          if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
          const parts: string[] = [];
          if (event.ctrlKey) parts.push('Control');
          if (event.altKey) parts.push('Alt');
          if (event.shiftKey) parts.push('Shift');
          parts.push(event.code || event.key);
          step.hotkey = parts.join('+');
          save();
        });
        hotkeyLabel.append(hotkeyInput);

        const pauseHotkeyLabel = document.createElement('label');
        pauseHotkeyLabel.textContent = 'Пауза';
        const pauseHotkeyInput = document.createElement('input');
        pauseHotkeyInput.type = 'text';
        pauseHotkeyInput.readOnly = true;
        pauseHotkeyInput.value = formatHotkey(step.hotkeyPause ?? settings.hotkeyPause);
        pauseHotkeyInput.placeholder = 'Нажмите сочетание';
        pauseHotkeyInput.title = 'Нажмите, затем введите сочетание клавиш для паузы';
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
        triggerOptions.append(hotkeyLabel, pauseHotkeyLabel);
        soundOptions.append(soundLabel, profileLabel);
        content.append(triggerOptions, soundEnabledLabel, soundOptions);
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
        appendStepSettings(row, details, summary, content);
      } else if (step.type === 'transcribe' || step.type === 'postprocess') {
        const panel = step.type === 'transcribe' ? transcriptionPanel : postprocessingPanel;
        if (panel) {
          const details = document.createElement('details');
          details.className = 'scenario-step-details';
          restoreStepDetails(details, step.id);
          const summary = document.createElement('summary');
          summary.append(document.createTextNode('Настройки'));
          const readiness = document.createElement('span');
          readiness.className = 'scenario-step-readiness';
          readiness.dataset.stepType = step.type;
          readiness.setAttribute('role', 'status');
          summary.append(readiness);
          const content = document.createElement('div');
          content.className = 'scenario-step-settings';
          content.append(panel);
          appendStepSettings(row, details, summary, content);
        }
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

    updateReadinessIndicators();
  };

  function moveStep(scenario: Scenario, from: number, to: number): void {
    if (to < 0 || to >= scenario.steps.length) return;
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
      apiKey: settings.groqApiKey,
      model: settings.groqModel,
      prompt: settings.groqPrompt,
      temperature: settings.groqTemperature,
      language: settings.groqLanguage,
      responseFormat: settings.groqResponseFormat,
      liveTranscriptionEnabled: settings.liveTranscriptionEnabled,
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

function normalizeScenarioName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

function hasScenarioName(scenarios: Scenario[], name: string, excludeId?: string): boolean {
  const normalized = normalizeScenarioName(name);
  return scenarios.some(scenario =>
    scenario.id !== excludeId && normalizeScenarioName(scenario.name) === normalized,
  );
}

function getUniqueScenarioName(baseName: string, scenarios: Scenario[]): string {
  if (!hasScenarioName(scenarios, baseName)) return baseName;
  for (let number = 2; ; number += 1) {
    const candidate = `${baseName} ${number}`;
    if (!hasScenarioName(scenarios, candidate)) return candidate;
  }
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

function scenarioIcon(name: 'edit' | 'check' | 'plus' | 'copy' | 'delete'): string {
  const paths: Record<typeof name, string> = {
    edit: '<path d="m16 5 3 3M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    delete: '<path d="M3 6h18M8 6V4h8v2m2 0-.8 14H6.8L6 6m4 4v7m4-7v7"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
