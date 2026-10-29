import type { HistoryItem } from './history-db';
import type { TimedTranscript } from './groq';
import type { ClipboardHistoryLevel } from './scenario';

export interface TranscriptionProvider {
  transcribe(audio: Blob, signal?: AbortSignal): Promise<TimedTranscript>;
}

export interface TextPostProcessor {
  process(text: string, signal?: AbortSignal): Promise<string>;
}

export interface HistoryRepository {
  add(data: Parameters<typeof import('./history-db').addHistoryRecord>[0], maxItems: number): Promise<HistoryItem>;
  update(id: string, updates: Parameters<typeof import('./history-db').updateHistoryRecord>[1]): Promise<HistoryItem | null>;
  list(limit: number): Promise<HistoryItem[]>;
}

export interface AudioCapturePort {
  start(microphoneId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  snapshot(): Promise<ArrayBuffer>;
  stop(requestedAtMs?: number, afterStopMs?: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  cancel(): Promise<void>;
  inputLevel(): Promise<number>;
}

export interface TextOutputPort {
  copy(text: string, historyLevel?: ClipboardHistoryLevel): Promise<void>;
  paste(text: string, returnFocusToOriginalWindow?: boolean): Promise<void>;
}
