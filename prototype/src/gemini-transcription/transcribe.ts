import { decodeAudio } from '../audio-decoding';
import { cutAudio } from '../recording-editor';
import { base64 } from '../binary-base64';
import type { TimedTranscript, TranscriptSegment } from '../groq';
import { fetchGeminiTranscriptionCatalog } from './catalog';
import { geminiTranscriptionConfigurationError, geminiTranscriptionConfig, normalizeGeminiTranscriptionSettings, type GeminiTranscriptionSettings } from './settings';

export async function transcribeWithGemini(audio: Blob, options?: Partial<GeminiTranscriptionSettings>, signal?: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<TimedTranscript> {
  signal?.throwIfAborted();
  const s = normalizeGeminiTranscriptionSettings(options);
  const error = geminiTranscriptionConfigurationError(s);
  if (error) throw new Error(error);
  const models = await fetchGeminiTranscriptionCatalog(s.apiKey, signal, fetcher);
  if (!models.some(m => m.id === s.model)) throw new Error('Модель Gemini Transcribe недоступна для этого ключа. Обновите список моделей.');
  const buffer = await decodeAudio(await audio.arrayBuffer());
  signal?.throwIfAborted();
  // Keep inline audio comfortably below the 20 MB request limit (including base64).
  // https://ai.google.dev/api/interactions-api#content — inline AudioContent
  // https://ai.google.dev/gemini-api/docs/transcribe#limitations — unary duration limits
  const chunkSeconds = Math.min(240, Math.floor(8_000_000 / (buffer.sampleRate * 2)));
  if (chunkSeconds < 1) throw new Error('Неподдерживаемая частота аудио Gemini Transcribe.');
  const texts: string[] = [], segments: TranscriptSegment[] = [];
  for (let start = 0; start < buffer.duration; start += chunkSeconds) {
    signal?.throwIfAborted();
    const chunk = cutAudio(buffer, [{ start, end: Math.min(buffer.duration, start + chunkSeconds) }]);
    const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', signal, headers: { 'x-goog-api-key': s.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.model, store: false,
        input: [{ type: 'audio', data: base64(new Uint8Array(await chunk.arrayBuffer())), mime_type: 'audio/wav' }],
        generation_config: { transcription_config: geminiTranscriptionConfig(s) },
      }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const detail = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : 'Ошибка распознавания.';
      throw new Error(`Gemini Transcribe (${response.status}): ${detail}`);
    }
    signal?.throwIfAborted();
    const result = parseGeminiTranscript(body, start);
    texts.push(result.text); segments.push(...result.segments);
  }
  return { text: texts.filter(Boolean).join(' '), segments };
}

/** REST output: model_output steps -> text content -> word_info annotations.
 * https://ai.google.dev/gemini-api/docs/transcribe#parsing-transcription-output */
export function parseGeminiTranscript(body: unknown, offset = 0): TimedTranscript {
  if (!isRecord(body)) throw new Error('Gemini Transcribe вернул некорректный ответ.');
  if (typeof body.status === 'string' && body.status !== 'completed') throw new Error(`Gemini Transcribe: распознавание не завершено (${body.status}).`);
  const texts: string[] = [], segments: TranscriptSegment[] = [];
  for (const step of Array.isArray(body.steps) ? body.steps : []) {
    if (!isRecord(step) || step.type !== 'model_output') continue;
    for (const content of Array.isArray(step.content) ? step.content : []) {
      if (!isRecord(content) || content.type !== 'text') continue;
      if (typeof content.text === 'string') texts.push(content.text);
      for (const word of Array.isArray(content.annotations) ? content.annotations : []) {
        if (!isRecord(word) || word.type !== 'word_info' || typeof word.text !== 'string') continue;
        const seconds = (v: unknown) => typeof v === 'string' && /^\d+(?:\.\d+)?s$/.test(v) ? Number(v.slice(0, -1)) : NaN;
        const start = seconds(word.start_offset), end = seconds(word.end_offset);
        if (word.text.trim() && end > start && Number.isFinite(start) && Number.isFinite(end)) {
          segments.push({ start: offset + start, end: offset + end, text: word.text.trim(),
            ...(typeof word.speaker === 'string' ? { speaker: word.speaker } : {}),
          });
        }
      }
    }
  }
  // output_text is available in SDK responses; REST exposes the text in steps.
  const text = texts.length ? texts.join('\n').trim() : typeof body.output_text === 'string' ? body.output_text.trim() : '';
  if (!Array.isArray(body.steps) && typeof body.output_text !== 'string') throw new Error('Gemini Transcribe не вернул результат распознавания.');
  return { text, segments: segments.sort((a, b) => a.start - b.start) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
