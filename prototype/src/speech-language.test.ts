import { expect, it } from 'vitest';
import { pickSpeechLanguage } from './speech-settings';

const installed = ['en-US', 'ru-RU'];

it('picks the voice language by the script that dominates the text', () => {
  expect(pickSpeechLanguage('Привет, это проверка озвучки.', installed)).toBe('ru-RU');
  expect(pickSpeechLanguage('Hello, this is a speech check.', installed)).toBe('en-US');
  // Mostly Russian with English terms is read by the Russian voice, not skipped.
  expect(pickSpeechLanguage('Обновите список голосов Windows → Речь.', installed)).toBe('ru-RU');
});

it('falls back to the system voice when no voice fits the text', () => {
  expect(pickSpeechLanguage('Привет', ['en-US'])).toBe('');
  expect(pickSpeechLanguage('12345 !?', installed)).toBe('');
  expect(pickSpeechLanguage('Привет', ['ru_RU'])).toBe('ru_RU');
});
