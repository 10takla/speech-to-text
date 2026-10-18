import { useEffect, useRef, useState } from 'react';
import { claimPlayback, releasePlayback } from './playback-coordinator';

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function HistorySpeech({ audio }: { audio: Blob }) {
  const player = useRef<HTMLAudioElement>(null);
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
    claimPlayback(owner.current, () => element.pause());
    try { await element.play(); }
    catch {
      releasePlayback(owner.current);
      if (player.current === element) setError('Не удалось воспроизвести озвучку.');
    }
  }
  function stop() { setPlaying(false); releasePlayback(owner.current); }
  return <div className="history-speech">
    <audio ref={player} preload="metadata" aria-label="Сохранённая озвучка"
      onPlay={() => setPlaying(true)} onPause={stop} onEnded={stop}
      onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onError={() => { stop(); setError('Не удалось загрузить озвучку.'); }} />
    <button type="button" className="history-speech-toggle" onClick={() => void togglePlayback()}
      aria-label={playing ? 'Приостановить озвучку' : 'Воспроизвести озвучку'}
      title={playing ? 'Приостановить озвучку' : 'Воспроизвести озвучку'}>
      {playing ? 'Ⅱ' : '▶'}
    </button>
    <input type="range" min="0" max={duration || 1} step="0.01" value={Math.min(position, duration)}
      disabled={!duration} aria-label="Позиция воспроизведения озвучки"
      aria-valuetext={`${formatTime(position)} из ${formatTime(duration)}`}
      onChange={event => {
        if (player.current) player.current.currentTime = event.currentTarget.valueAsNumber;
        setPosition(event.currentTarget.valueAsNumber);
      }} />
    <span className="history-speech-time">{formatTime(position)} / {formatTime(duration)}</span>
    {error && <span className="history-speech-error" role="status">{error}</span>}
  </div>;
}
