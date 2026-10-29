import { useEffect, useRef, useState } from 'react';
import { claimPlayback, releasePlayback } from './playback-coordinator';
import { SpeechTextView } from './SpeechText';
import { SpeechControlsView } from './SpeechControls';
import type { SpeechMark } from './speech-playback-control';

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

// Accusative/genitive forms for the labels: synthesized speech or a recording.
const NOUNS = {
  speech: { saved: 'Сохранённая озвучка', what: 'озвучку', of: 'озвучки' },
  recording: { saved: 'Сохранённая запись', what: 'запись', of: 'записи' },
};

export function HistorySpeech({ audio, kind = 'speech', text, marks = [] }: {
  audio: Blob; kind?: keyof typeof NOUNS;
  // The spoken text: shown under the player, with the marks of its words (if they were saved) it is
  // highlighted while it plays and its tracks move the playback, as in the overlay.
  text?: string; marks?: readonly SpeechMark[];
}) {
  const noun = NOUNS[kind];
  const player = useRef<HTMLAudioElement>(null);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const owner = useRef({});
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(audio);
    const element = player.current!;
    const playbackOwner = owner.current;
    setPlaying(false); setDuration(0); setPosition(0); setError('');
    element.src = url;
    return () => {
      releasePlayback(playbackOwner);
      element.pause();
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    };
  }, [audio]);
  async function togglePlayback() {
    const element = player.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    setError('');
    try { await element.play(); }
    catch {
      releasePlayback(owner.current);
      if (player.current === element) setError(`Не удалось воспроизвести ${noun.what}.`);
    }
  }
  function stop() { setPlaying(false); releasePlayback(owner.current); }
  return <div className="history-speech">
    <audio ref={node => { player.current = node; if (node !== element) setElement(node); }} preload="metadata" aria-label={noun.saved}
      onPlay={() => { setPlaying(true); const element = player.current; if (element) claimPlayback(owner.current, () => element.pause()); }} onPause={stop} onEnded={stop}
      onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onError={() => { stop(); setError(`Не удалось загрузить ${noun.what}.`); }} />
    {kind === 'speech' ? <SpeechControlsView audio={element} /> : <>
      <button type="button" className="history-speech-toggle" onClick={() => void togglePlayback()}
        aria-label={`${playing ? 'Приостановить' : 'Воспроизвести'} ${noun.what}`}
        title={`${playing ? 'Приостановить' : 'Воспроизвести'} ${noun.what}`}>
        {playing ? 'Ⅱ' : '▶'}
      </button>
      <input type="range" min="0" max={duration || 1} step="0.01" value={Math.min(position, duration)}
        disabled={!duration} aria-label={`Позиция воспроизведения ${noun.of}`}
        aria-valuetext={`${formatTime(position)} из ${formatTime(duration)}`}
        onChange={event => {
          if (player.current) player.current.currentTime = event.currentTarget.valueAsNumber;
          setPosition(event.currentTarget.valueAsNumber);
        }} />
      <span className="history-speech-time">{formatTime(position)} / {formatTime(duration)}</span>
    </>}
    {error && <span className="history-speech-error" role="status">{error}</span>}
    {text?.trim() && <div className="history-speech-text overlay-step-text--speech">
      <SpeechTextView body={text} audio={element} marks={marks}
        onSeek={seconds => { if (player.current) { player.current.currentTime = seconds; if (player.current.paused) void togglePlayback(); } }} />
    </div>}
  </div>;
}
