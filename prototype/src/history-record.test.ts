import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { HistoryItem } from './history-db';
import { HistoryRecord } from './history-view-react';

vi.mock('./history-transcript', () => ({ HistoryTranscript: () => null }));

const record: HistoryItem = {
  id: 'answer', timestamp: 1, text: 'Четыре.',
  steps: [
    { id: 'transcribe', type: 'transcribe', title: 'Транскрибация', status: 'success' },
    { id: 'answer', type: 'postprocess', title: 'Постобработка', status: 'success' },
    { id: 'speak', type: 'speak', title: 'Озвучка', status: 'success' },
  ],
};

it('shows the saved final answer under postprocessing in existing history', () => {
  expect(renderToStaticMarkup(createElement(HistoryRecord, { record })))
    .toContain('Четыре.');
});

it('keeps the individual results of repeated postprocessing steps', () => {
  const html = renderToStaticMarkup(createElement(HistoryRecord, { record: {
    ...record, text: 'Итог', steps: [
      { id: 'first', type: 'postprocess', title: 'Постобработка', status: 'success', text: 'Первый ответ' },
      { id: 'second', type: 'postprocess', title: 'Постобработка', status: 'success', text: 'Второй ответ' },
    ],
  } }));
  expect(html).toContain('Первый ответ');
  expect(html).toContain('Второй ответ');
  expect(html).not.toContain('Итог');
});

it('does not show another step output as a failed postprocessing result', () => {
  const html = renderToStaticMarkup(createElement(HistoryRecord, { record: {
    ...record, steps: record.steps!.map(step => step.type === 'postprocess'
      ? { ...step, status: 'error' as const, errorMessage: 'Ошибка API' } : step),
  } }));
  expect(html).toContain('Ошибка API');
  expect(html).not.toContain('Четыре.');
});

it('shows saved speech from each branch even when playback failed', () => {
  const html = renderToStaticMarkup(createElement(HistoryRecord, { record: {
    ...record, steps: [
      { id: 'one', type: 'speak', title: 'Озвучка', status: 'success', audioBlob: new Blob(['one'], { type: 'audio/wav' }) },
      { id: 'two', type: 'speak', title: 'Озвучка', status: 'error', errorMessage: 'Ошибка воспроизведения', audioBlob: new Blob(['two'], { type: 'audio/mpeg' }) },
      { id: 'empty', type: 'speak', title: 'Озвучка', status: 'error' },
    ],
  } }));
  expect(html.match(/<audio /g)).toHaveLength(2);
  expect(html.match(/aria-label="Воспроизвести озвучку"/g)).toHaveLength(2);
  expect(html).not.toContain(' controls');
  expect(html).not.toContain('Скачать');
  expect(html).toContain('Ошибка воспроизведения');
});
