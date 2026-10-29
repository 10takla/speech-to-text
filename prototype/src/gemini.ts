import { DEFAULT_GEMINI_MODEL } from './defaults';
import type { GeminiGenerationSettings } from './provider-models';

// Модуль пост-процессинга текста (Text-to-Text) через Google Gemini API
// Описание приложения.md:87, 114-118

export { DEFAULT_GEMINI_API_KEY } from './defaults';

export interface GeminiPostProcessOptions {
  apiKey?: string;
  model?: string;
  instructionPrompt?: string;
  generationConfig?: GeminiGenerationSettings;
}

export async function postProcessTextWithGemini(
  text: string,
  options: GeminiPostProcessOptions = {},
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const apiKey = (options.apiKey ?? '').trim();
  if (!apiKey) throw new Error('API-ключ Gemini не указан.');
  const model = options.model || DEFAULT_GEMINI_MODEL;
  if (!model.trim()) throw new Error('Модель Gemini не выбрана. Загрузите список моделей из API.');
  const instruction = (options.instructionPrompt || '').trim();

  if (!instruction) throw new Error('Для постобработки укажите промпт преобразования.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: trimmed,
          },
        ],
      },
    ],
    generationConfig: {
      ...(options.generationConfig ?? { temperature: 0.2 }),
    },
  };

  const response = await fetcher(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Gemini API (${response.status}): ${errorText}`);
  }

  const payload: unknown = await response.json();
  const candidate = getCandidateText(payload);
  if (typeof candidate !== 'string' || !candidate.trim()) {
    const first = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
    const feedback = isRecord(payload) && isRecord(payload.promptFeedback) ? payload.promptFeedback : undefined;
    const reason = feedback?.blockReason ?? (isRecord(first) ? first.finishReason : undefined);
    throw new Error(`Gemini не вернул текст ответа${typeof reason === 'string' ? ` (${reason})` : ''}.`);
  }

  return candidate.trim();
}

function getCandidateText(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return undefined;
  const first = payload.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return undefined;
  return first.content.parts
    .filter(part => isRecord(part) && part.thought !== true && typeof part.text === 'string')
    .map(part => (part as Record<string, unknown>).text as string)
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
