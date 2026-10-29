// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from './config';
import { createStep, scenarioCancelHotkey } from './scenario';
import { mountScenarioEditor } from './scenario-editor';
import { hasStepSettings } from './step-settings-block';

vi.mock('./microphones', () => ({
  listMicrophones: vi.fn(async () => [{ id: '', name: 'Системный микрофон', error: null }]),
  checkMicrophone: vi.fn(async () => { }),
}));
vi.mock('./scenario-column-layout', () => ({ alignScenarioColumns: vi.fn(), disposeScenarioColumns: vi.fn() }));
vi.mock('./speech-settings-editor', () => ({ mountSpeechProvider: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('Option', function (text = '', value = text) {
    const option = document.createElement('option');
    option.textContent = text;
    option.value = value;
    return option;
  });
  document.body.innerHTML = `
    <section class="cp-card"><span id="stt-provider-status" class="status-pill--ready">Готов</span>
      <label>Провайдер речи<select id="provider-select"><option value="groq">Groq</option></select></label>
      <input id="api-key" value="test-key"></section>
    <section class="cp-card"><span id="postprocess-provider-status">Готов</span>
      <select id="post-process-provider"><option value="gemini">Gemini</option></select></section>
    <div id="scenario-editor"></div>`;
});
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function mount(settings = defaultSettings()) {
  const root = document.getElementById('scenario-editor')!;
  mountScenarioEditor(root, settings, vi.fn());
  // Microphone discovery causes the same startup redraw as the installed app.
  await vi.waitFor(() => expect(root.textContent).not.toContain('Проверяется'));
  return root;
}

function detailsFor(root: HTMLElement, stepId: string) {
  return root.querySelector<HTMLDetailsElement>(`details[data-scenario-step-id="${stepId}"]`)!;
}

it('keeps start and cancel in the scenario header, and stop in the recording step', async () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios.find(item => item.id === 'claude-code-test')!;
  const root = await mount(settings);
  const body = () => detailsFor(root, scenario.steps[0].id).closest<HTMLElement>('.scenario-card-body')!;
  const field = (label: string) => body().querySelector<HTMLInputElement>(`.scenario-hotkeys [aria-label="${label}"]`)!;
  expect(field('Старт').value).toBe('Ctrl+Shift+D');
  expect(field('Старт').closest('.scenario-step')).toBeNull();
  expect(detailsFor(root, scenario.steps[0].id).querySelector('[aria-label="Старт"]')).toBeNull();
  field('Старт').dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true }));
  expect(scenario.steps[0].hotkey).toBe('F8');

  // Cancel is per scenario, Escape by default.
  expect(field('Отмена').value).toBe('Escape');
  field('Отмена').dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', code: 'F9', bubbles: true }));
  expect(scenario.hotkeyCancel).toBe('F9');
  expect(scenarioCancelHotkey(settings.scenarios.find(item => item.id === 'default-scenario'))).toBe('Escape');

  // Stop is a recording setting: in the step, following the start key until an own key is chosen.
  expect(body().querySelector('.scenario-hotkeys [aria-label="Режим стопа"]')).toBeNull();
  const step = () => detailsFor(root, scenario.steps[0].id);
  const mode = step().querySelector<HTMLSelectElement>('select[aria-label="Режим стопа"]')!;
  expect(mode.value).toBe('start');
  mode.value = 'own'; mode.dispatchEvent(new Event('change'));
  step().querySelector<HTMLInputElement>('[aria-label="Клавиша стопа"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', code: 'F10', bubbles: true }));
  expect(scenario.steps[0].hotkeyStop).toBe('F10');
});

it('shows no settings block for a step with nothing to set', async () => {
  const settings = defaultSettings();
  settings.activeScenarioId = 'selected-text-speech-scenario';
  const root = await mount(settings);
  const rowOf = (type: string) => [...root.querySelectorAll<HTMLSelectElement>('select.scenario-step-type')]
    .find(select => select.value === type && select.closest('[data-scenario-id="selected-text-speech-scenario"]'))!
    .closest('.scenario-step')!;
  expect(rowOf('selectedText').querySelector('.scenario-step-details')).toBeNull();
});

it('treats only visible controls or a pending shared panel as step settings', () => {
  const content = (html: string) => Object.assign(document.createElement('div'), { innerHTML: html });
  expect(hasStepSettings(content(''))).toBe(false);
  expect(hasStepSettings(content('<p>Подсказка</p><div></div>'))).toBe(false);
  expect(hasStepSettings(content('<div hidden><input></div>'))).toBe(false);
  expect(hasStepSettings(content('<label>Поле <input></label>'))).toBe(true);
  expect(hasStepSettings(content('<span data-settings-pending></span>'))).toBe(true);
  // The block itself may keep `hidden` from an earlier render.
  const block = content('<select></select>'); block.hidden = true;
  expect(hasStepSettings(block)).toBe(true);
});

it('offers full final recognition disabled by default in transcription settings', async () => {
  const settings = defaultSettings();
  const step = settings.scenarios[0].steps[1];
  const root = await mount(settings);
  const toggle = detailsFor(root, step.id).querySelector<HTMLInputElement>('[aria-label="Повторно распознавать всю запись после стопа"]')!;
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  expect(step.transcription!.retranscribeFullRecording).toBe(true);
});

it('edits the recording stop tail in milliseconds, allowing zero and rejecting invalid values', async () => {
  const settings = defaultSettings();
  const recording = settings.scenarios[0].steps[0];
  const root = await mount(settings);
  const input = detailsFor(root, recording.id).querySelector<HTMLInputElement>('[aria-label="Время после стопа, мс"]')!;
  expect(input.value).toBe('150');
  input.value = '0'; input.dispatchEvent(new Event('change'));
  expect(recording.afterStopMs).toBe(0);
  input.value = '-1'; input.dispatchEvent(new Event('change'));
  expect(input.value).toBe('0');
  expect(recording.afterStopMs).toBe(0);
});

it('toggles the card from empty space beside its header without intercepting controls or the body', async () => {
  const root = await mount();
  const card = root.querySelector<HTMLDetailsElement>('.scenario-card')!;
  const header = card.querySelector<HTMLElement>('.scenario-card-header')!;
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 400, 40));
  const wasOpen = card.open;
  // The header controls end at x=400; the rest of the row belongs to the card.
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 600, clientY: 40 }));
  expect(card.open).toBe(!wasOpen);
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 600, clientY: 40 }));
  expect(card.open).toBe(wasOpen);
  card.querySelector<HTMLElement>('.scenario-card-body')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 40 }));
  expect(card.open).toBe(wasOpen);
  card.querySelector<HTMLElement>('.scenario-card-enabled')!.click();
  expect(card.open).toBe(wasOpen);
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 600, clientY: 100 }));
  expect(card.open).toBe(wasOpen);
});

it('offers a disabled-by-default focus return flag in paste step settings and retains changes', async () => {
  const settings = defaultSettings();
  const paste = settings.scenarios[0].steps.find(step => step.type === 'paste')!;
  const root = await mount(settings);
  const checkbox = detailsFor(root, paste.id).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.closest('label')?.textContent).toContain('Возвращать фокус перед вставкой');
  expect(checkbox.checked).toBe(false);
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change'));
  expect(paste.returnFocusToOriginalWindow).toBe(true);
  expect(detailsFor(root, paste.id).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
});

it('shows provider fields on the first opening after startup, keeping their original listeners', async () => {
  const settings = defaultSettings();
  const provider = document.getElementById('provider-select')!;
  const changed = vi.fn();
  provider.addEventListener('change', changed);
  const root = await mount(settings);
  const details = detailsFor(root, settings.scenarios[0].steps[1].id);
  details.querySelector('summary')!.click();
  expect(details.querySelector('#provider-select')).toBe(provider);
  provider.dispatchEvent(new Event('change'));
  expect(changed).toHaveBeenCalledOnce();
});

it('keeps the first transcription settings populated when the scenario has another transcription', async () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios[0];
  const another = createStep('transcribe');
  another.transcription!.apiKey = 'second-key';
  scenario.steps.push(createStep('speak'), another);
  const root = await mount(settings);
  const first = detailsFor(root, scenario.steps[1].id);
  first.querySelector('summary')!.click();
  expect(first.querySelector('#provider-select')).not.toBeNull();
  const second = detailsFor(root, another.id);
  second.querySelector('summary')!.click();
  expect(second.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('second-key');
  const key = second.querySelector<HTMLInputElement>('input[type="password"]')!;
  key.value = 'updated-second-key';
  key.dispatchEvent(new Event('input'));
  expect(another.transcription!.apiKey).toBe('updated-second-key');
  expect(scenario.steps[1].transcription!.apiKey).not.toBe('updated-second-key');
  expect(first.querySelector('#provider-select')).not.toBeNull();
});

it('keeps independent postprocessing settings for repeated steps', async () => {
  const settings = defaultSettings();
  const scenario = settings.scenarios[0];
  const first = scenario.steps.find(step => step.type === 'postprocess')!;
  first.enabled = true;
  const another = createStep('postprocess');
  another.postprocessing!.prompt = 'Второй промпт';
  scenario.steps.push(another);
  const root = await mount(settings);
  expect(detailsFor(root, first.id).querySelector('#post-process-provider')).not.toBeNull();
  const prompt = detailsFor(root, another.id).querySelector('textarea')!;
  expect(prompt.value).toBe('Второй промпт');
  prompt.value = 'Изменённый второй промпт';
  prompt.dispatchEvent(new Event('input'));
  expect(another.postprocessing!.prompt).toBe('Изменённый второй промпт');
  expect(first.postprocessing!.prompt).not.toBe('Изменённый второй промпт');
});

it('can reopen settings in the previous card after another card was edited', async () => {
  const settings = defaultSettings();
  const firstScenario = settings.scenarios[0];
  const secondScenario = settings.scenarios[1];
  const root = await mount(settings);
  const card = root.querySelector<HTMLElement>(`.scenario-card[data-scenario-id="${secondScenario.id}"]`)!;
  const postprocess = [...card.querySelectorAll<HTMLElement>('.scenario-step')]
    .find(row => row.querySelector<HTMLSelectElement>('.scenario-step-type')?.value === 'postprocess')!;
  postprocess.querySelector<HTMLButtonElement>('button[aria-label="Отключить шаг"]')!.click();
  expect(settings.activeScenarioId).toBe(secondScenario.id);
  detailsFor(root, firstScenario.steps[1].id).querySelector('summary')!.click();
  expect(settings.activeScenarioId).toBe(firstScenario.id);
  expect(detailsFor(root, firstScenario.steps[1].id).querySelector('#provider-select')).not.toBeNull();
});
