import { postProcessTextWithGemini, type GeminiPostProcessOptions } from './gemini';
import { transcribeTimedAudioWithGroq, type GroqTranscriptionOptions } from './groq';
import type { TextPostProcessor, TranscriptionProvider } from './ports';

export function createGroqTranscriptionProvider(
  options: () => GroqTranscriptionOptions,
  fetcher: typeof fetch = fetch,
): TranscriptionProvider {
  return {
    transcribe: (audio, signal) => transcribeTimedAudioWithGroq(audio, options(), signal, fetcher),
  };
}

export function createGeminiTextPostProcessor(
  options: () => GeminiPostProcessOptions,
  fetcher: typeof fetch = fetch,
): TextPostProcessor {
  return {
    process: (text, signal) => postProcessTextWithGemini(text, options(), fetcher, signal),
  };
}
