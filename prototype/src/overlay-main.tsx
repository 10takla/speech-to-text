import { createRoot } from 'react-dom/client';
import OverlayApp from './OverlayApp';
import { isTauri } from '@tauri-apps/api/core';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Не найден корневой элемент оверлея.');

const visualPreview = !isTauri() && new URLSearchParams(location.search).get('preview') === 'parallel';
createRoot(rootElement).render(<OverlayApp visualPreview={visualPreview} />);
