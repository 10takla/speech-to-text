import { DEFAULT_GEMINI_API_KEY, DEFAULT_GEMINI_MODEL } from './defaults';
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

  const apiKey = (options.apiKey || DEFAULT_GEMINI_API_KEY).trim();
  const model = options.model || DEFAULT_GEMINI_MODEL;
  const instruction = (options.instructionPrompt || '').trim();

  if (!instruction) throw new Error('Для постобработки укажите промпт преобразования.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${instruction}\n\nВходной текст:\n${trimmed}`,
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
    return trimmed;
  }

  return candidate.trim();
}

function getCandidateText(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return undefined;
  const first = payload.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return undefined;
  const firstPart = first.content.parts[0];
  return isRecord(firstPart) && typeof firstPart.text === 'string' ? firstPart.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
