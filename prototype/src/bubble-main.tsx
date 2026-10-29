import { createRoot } from 'react-dom/client';
import { SETTINGS_STORAGE_KEY } from './config';
import { isAndroidBubble } from './android-runtime';

if (isAndroidBubble) {
  const configuration = window.AndroidBubble!.configuration();
  if (configuration) localStorage.setItem(SETTINGS_STORAGE_KEY, configuration);
  document.documentElement.style.setProperty('--bubble-max-height', `${window.AndroidBubble!.maxHeight()}px`);
}
window.addEventListener('android-configuration', event => {
  const text = (event as CustomEvent<string>).detail;
  if (!text) return;
  localStorage.setItem(SETTINGS_STORAGE_KEY, text);
  window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_STORAGE_KEY, newValue: text }));
});
void import('./BubbleApp').then(({ default: BubbleApp }) => {
  createRoot(document.getElementById('root')!).render(<BubbleApp />);
});
