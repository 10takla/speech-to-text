import { expect, it, vi } from 'vitest';
import { postProcessTextWithGemini } from './gemini';

const options = { apiKey: 'test-key', model: 'test-model', instructionPrompt: 'Ответь на вопрос' };

it('sends the instruction separately from dictated user content', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: 'Ответ' }] } }] }));
  await postProcessTextWithGemini('Входной запрос', options, fetcher);
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body.systemInstruction.parts).toEqual([{ text: options.instructionPrompt }]);
  expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Входной запрос' }] }]);
});

it('reads all answer parts and excludes thoughts and non-text parts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [
    { thought: true, text: 'Рассуждение' }, { inlineData: {} }, { text: 'Два плюс два' }, { text: ' — четыре.' },
  ] } }] }));
  await expect(postProcessTextWithGemini('Сколько будет 2 плюс 2?', options, fetcher))
    .resolves.toBe('Два плюс два — четыре.');
});

it.each([
  [{ candidates: [] }, 'Gemini не вернул текст ответа.'],
  [{ promptFeedback: { blockReason: 'SAFETY' } }, 'Gemini не вернул текст ответа (SAFETY).'],
  [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: 'Мысли' }] } }] },
    'Gemini не вернул текст ответа (MAX_TOKENS).'],
])('reports a missing answer instead of returning the question: %j', async (payload, message) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
  await expect(postProcessTextWithGemini('Сколько будет 2 плюс 2?', options, fetcher)).rejects.toThrow(message);
});

it('does not send a request without an explicit key', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(postProcessTextWithGemini('Вопрос', { ...options, apiKey: '' }, fetcher))
    .rejects.toThrow('API-ключ Gemini не указан.');
  expect(fetcher).not.toHaveBeenCalled();
});
