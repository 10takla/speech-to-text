import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { seekTo, useActiveSpeech, useSpeechLoading, useSpeechMarks, useSpeechTime, type SpeechMark } from './speech-playback-control';
import './speech-text.scss';

interface Span { start: number; end: number; from: number; to: number }

/** Finds the marked words or sentences in the shown text, one after another. */
export function locate(body: string, marks: readonly Pick<SpeechMark, 'kind' | 'text' | 'from' | 'to'>[], kind: SpeechMark['kind']): Span[] {
  const found: Span[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.kind !== kind) continue;
    const start = body.indexOf(mark.text, cursor);
    if (start < 0) continue;
    found.push({ start, end: start + mark.text.length, from: mark.from, to: mark.to });
    cursor = start + mark.text.length;
  }
  return found;
}

/** How much of the sentence has been spoken, in per cent of its text. By the words, not by the sentence's
 * time: the time of a sentence includes the pause after it, so a fill by time would lag the voice. */
export function sentenceFill(sentence: Span, words: readonly Span[], time: number): number {
  if (time >= sentence.to || time === Infinity) return 100;
  if (time <= sentence.from) return 0;
  const inside = words.filter(word => word.start >= sentence.start && word.end <= sentence.end);
  if (!inside.length) return (time - sentence.from) / Math.max(.05, sentence.to - sentence.from) * 100;
  let offset = 0;
  for (const word of inside) {
    if (time >= word.to) { offset = word.end - sentence.start; continue; }
    if (time >= word.from) offset = word.start - sentence.start + (time - word.from) / Math.max(.01, word.to - word.from) * (word.end - word.start);
    break;
  }
  return Math.min(100, offset / Math.max(1, sentence.end - sentence.start) * 100);
}

/** The time that matches a place of the sentence, in per cent of its text: the opposite of sentenceFill. */
export function timeAtFill(sentence: Span, words: readonly Span[], fraction: number): number {
  const inside = words.filter(word => word.start >= sentence.start && word.end <= sentence.end);
  if (!inside.length) return sentence.from + fraction * (sentence.to - sentence.from);
  const offset = sentence.start + fraction * (sentence.end - sentence.start);
  for (const word of inside) {
    if (offset < word.start) return word.from;
    if (offset <= word.end) return word.from + (offset - word.start) / Math.max(1, word.end - word.start) * (word.to - word.from);
  }
  return inside[inside.length - 1].to;
}

interface Line { left: number; top: number; width: number }

// The text is ONE text node that never changes while the speech is shown: nothing is wrapped,
// nothing is re-created. So a selection of the text survives everything that happens during
// the speech (marks arriving, the loading going on). The word being spoken and the word under the
// cursor are marked with the CSS Custom Highlight API, which paints ranges without touching the DOM.
type Registry = { set(name: string, highlight: unknown): void; delete(name: string): void };
const highlights = (): Registry | undefined => (CSS as unknown as { highlights?: Registry }).highlights;
const newHighlight = (...ranges: Range[]) => new (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight(...ranges);

// Several texts may be on the page (the history): a highlight is cleared only by the text that set it.
const owners = new Map<string, object>();
function setHighlight(name: string, range: Range | null, owner: object) {
  const registry = highlights();
  if (!registry) return;
  if (range) { registry.set(name, newHighlight(range)); owners.set(name, owner); }
  else if (owners.get(name) === owner) { registry.delete(name); owners.delete(name); }
}

/** The character of the text under a point of the screen. */
function offsetAt(text: HTMLElement, x: number, y: number): number | undefined {
  const node = text.firstChild;
  if (!node) return undefined;
  const document_ = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  const position = document_.caretPositionFromPoint?.(x, y);
  const found = position ? { node: position.offsetNode, offset: position.offset } : (() => {
    const range = document.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  })();
  return found && found.node === node ? found.offset : undefined;
}

/** The tracks are not the text's background: a selection tints the text's whole line, and
 * a track inside it would be tinted too. They are drawn above, from the measured lines of
 * each sentence (a sentence wraps, so it has a piece per line). */
function useTrackLines(box: React.RefObject<HTMLDivElement | null>, sentences: readonly Span[], rangeOf: (start: number, end: number) => Range | null, version: unknown) {
  const [lines, setLines] = useState<Line[][]>([]);
  const measure = useCallback(() => {
    const frame = box.current?.getBoundingClientRect();
    if (!frame) return;
    const next = sentences.map(sentence => {
      const range = rangeOf(sentence.start, sentence.end);
      return range ? [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ left: rect.left - frame.left, top: rect.bottom - frame.top, width: rect.width })) : [];
    });
    setLines(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [box, sentences, rangeOf]);
  useLayoutEffect(measure, [measure, version]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, measure]);
  return lines;
}

/** The text of a speech step. Under every loaded sentence runs its track, as under the transcription:
 * it wraps with the text, the played part is filled, the playing sentence is brighter, and a
 * light shows where the next track is still to come. The word being spoken is marked, a click
 * on a word (or on a track) moves the speech there. */
export function SpeechTextView({ body, audio, marks, loading = false, done = !audio, onSeek }: {
  body: string; audio?: HTMLAudioElement | null; marks: readonly SpeechMark[]; loading?: boolean;
  // After the speech the whole text is spoken: every track stays, filled.
  done?: boolean; onSeek?(seconds: number): void;
}) {
  const owner = useRef({}).current;
  const playing = useSpeechTime(audio ?? undefined);
  const time = done ? Infinity : playing;
  // Only the text being listened to marks its word (the audio has been started).
  const listening = !!audio && (!audio.paused || playing > 0);
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const words = useMemo(() => locate(body, marks, 'WordBoundary'), [body, marks]);
  const sentences = useMemo(() => locate(body, marks, 'SentenceBoundary'), [body, marks]);
  const rangeOf = useCallback((start: number, end: number) => {
    const node = text.current?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const range = document.createRange();
    range.setStart(node, Math.min(start, (node as Text).length));
    range.setEnd(node, Math.min(end, (node as Text).length));
    return range;
  }, []);
  const lines = useTrackLines(box, sentences, rangeOf, `${body}|${marks.length}|${loading}`);
  let current = -1;
  if (!done && listening) words.forEach((word, index) => { if (word.from <= time) current = index; });

  // The spoken word.
  useEffect(() => {
    const word = current >= 0 ? words[current] : undefined;
    setHighlight('speech-current', word ? rangeOf(word.start, word.end) : null, owner);
    return () => setHighlight('speech-current', null, owner);
  }, [current, words, rangeOf, owner]);
  useEffect(() => () => setHighlight('speech-hover', null, owner), [owner]);

  // A new speech follows the voice again.
  useEffect(() => { if (!marks.length) delete scrollFrame(box.current)?.dataset.userScrolled; }, [marks.length]);
  // Keeps the spoken word in view of the (height-limited) text, unless the user has scrolled it.
  useEffect(() => {
    const word = current >= 0 ? words[current] : undefined;
    const frame = scrollFrame(box.current);
    const rect = word && rangeOf(word.start, word.end)?.getBoundingClientRect();
    if (!rect || !frame || frame.dataset.userScrolled) return;
    const area = frame.getBoundingClientRect();
    const top = rect.top - area.top + frame.scrollTop, bottom = rect.bottom - area.top + frame.scrollTop;
    if (top < frame.scrollTop || bottom > frame.scrollTop + frame.clientHeight) frame.scrollTop = Math.max(0, top - frame.clientHeight / 3);
  }, [current, words, rangeOf]);

  const wordAt = (event: React.MouseEvent<HTMLElement>) => {
    const offset = offsetAt(event.currentTarget, event.clientX, event.clientY);
    return offset === undefined ? undefined : words.find(word => offset >= word.start && offset < word.end);
  };
  const fills = sentences.map(sentence => sentenceFill(sentence, words, time));
  const sentenceAt = sentences.find(sentence => sentence.from <= time && time < sentence.to);
  const last = lines[sentences.length - 1]?.at(-1);
  return <div ref={box} className="speech-text">
    <span ref={text}
      onMouseMove={audio ? event => { const word = wordAt(event); setHighlight('speech-hover', word ? rangeOf(word.start, word.end) : null, owner); } : undefined}
      onMouseLeave={() => setHighlight('speech-hover', null, owner)}
      onClick={audio ? event => { const word = wordAt(event); if (word && window.getSelection()?.isCollapsed !== false) onSeek?.(word.from); } : undefined}>{body}</span>
    <div className="speech-bars" aria-hidden="true">
      {sentences.map((sentence, index) => {
        const pieces = lines[index] ?? [];
        const total = pieces.reduce((sum, piece) => sum + piece.width, 0);
        let before = 0;
        return pieces.map((piece, line) => {
          const start = before;
          before += piece.width;
          const filled = Math.max(0, Math.min(piece.width, (fills[index] ?? 0) / 100 * total - start));
          return <div key={`${index}-${line}`} className={`speech-bar${sentence === sentenceAt ? ' speech-bar--current' : ''}`}
            style={{ left: piece.left, top: piece.top + 1, width: piece.width }}
            onPointerDown={audio ? event => {
              const bar = event.currentTarget.getBoundingClientRect();
              if (total) onSeek?.(timeAtFill(sentence, words, Math.max(0, Math.min(1, (start + event.clientX - bar.left) / total))));
            } : undefined}>
            <div className="speech-bar-fill" style={{ width: filled }} />
          </div>;
        });
      })}
      {loading && last && <div className="speech-bar speech-bar--next" title="Звук ещё загружается: здесь появится следующая полоса"
        style={{ left: Math.min(last.left + last.width + 6, (box.current?.clientWidth ?? Infinity) - 26), top: last.top + 1 }} />}
    </div>
  </div>;
}

/** The overlay's text of a speech step: the speech that plays now and its marks. */
export default function SpeechText({ body }: { body: string }) {
  const audio = useActiveSpeech();
  return <SpeechTextView body={body} audio={audio} marks={useSpeechMarks()} loading={useSpeechLoading()} done={!audio}
    onSeek={seconds => { if (audio) seekTo(audio, seconds); }} />;
}

/** The nearest ancestor that scrolls: the frame the text is kept in view of. */
function scrollFrame(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}
