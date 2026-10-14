import { createRoot } from 'react-dom/client';
import OverlayApp from './OverlayApp';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Не найден корневой элемент оверлея.');

createRoot(rootElement).render(<OverlayApp />);
