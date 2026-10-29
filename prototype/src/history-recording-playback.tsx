import { useLayoutEffect, useRef, useState, type MouseEventHandler } from 'react';
import { claimPlayback, ownsPlayback, releasePlayback } from './playback-coordinator';

/** The whole-recording track remains usable when recognition returned no segments. */
export function HistoryRecordingPlayback({ audio, onContextMenu }: {
  audio: Blob;
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const owner = useRef({});
  const attempt = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const element = player.current!;
    const playbackOwner = owner.current;
    const url = URL.createObjectURL(audio);
    setPlaying(false); setError(''); element.src = url;
    return () => {
      attempt.current++;
      releasePlayback(playbackOwner);
      element.pause(); element.removeAttribute('src'); element.load();
      URL.revokeObjectURL(url);
    };
  }, [audio]);

  function stopped() {
    attempt.current++;
    setPlaying(false);
    releasePlayback(owner.current);
  }

  async function togglePlayback() {
    const element = player.current;
    if (!element) return;
    if (!element.paused || ownsPlayback(owner.current)) { element.pause(); stopped(); return; }
    const token = ++attempt.current;
    setError('');
    claimPlayback(owner.current, () => { element.pause(); stopped(); });
    try {
      element.currentTime = 0;
      await element.play();
      if (token === attempt.current && !ownsPlayback(owner.current)) element.pause();
    } catch {
      if (token !== attempt.current) return;
      stopped(); setError('Не удалось воспроизвести аудиозапись.');
    }
  }

  const label = playing ? 'Остановить воспроизведение всей записи' : 'Воспроизвести всю запись';
  return <div className="history-recording-playback">
    <audio ref={player} preload="metadata" aria-label="Сохранённая аудиозапись"
      onPlay={event => {
        if (ownsPlayback(owner.current)) setPlaying(true);
        else event.currentTarget.pause();
      }}
      onPause={stopped} onEnded={stopped}
      onError={() => { stopped(); setError('Не удалось загрузить аудиозапись.'); }} />
    <button type="button" className={`all-fragments-playback-bar history-all-fragments-playback-bar${playing ? ' playing' : ''}`}
      data-level="all" aria-label={label} title={label} aria-pressed={playing} aria-haspopup="menu"
      onClick={() => void togglePlayback()} onContextMenu={onContextMenu} />
    {error && <div className="history-action-message history-action-message--error" role="status">{error}</div>}
  </div>;
}
