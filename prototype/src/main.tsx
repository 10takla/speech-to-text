import { createRoot } from 'react-dom/client';
import ControlPanelApp from './ControlPanelApp';
import { isAndroid } from './android-runtime';
import { defaultSettings, saveSettings, SETTINGS_STORAGE_KEY } from './config';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Не найден корневой элемент панели управления.');

const root = createRoot(rootElement);
if (isAndroid) {
  if (!localStorage.getItem(SETTINGS_STORAGE_KEY)) {
    const settings = defaultSettings();
    for (const scenario of settings.scenarios) {
      for (const step of scenario.steps) {
        if (step.type === 'copy') step.clipboardHistoryLevel = 0;
      }
    }
    saveSettings(settings);
  }
  void import('./AndroidApp').then(({ default: AndroidApp }) => root.render(<AndroidApp />));
}
else root.render(<ControlPanelApp />);
