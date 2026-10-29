import type { WheelEvent } from 'react';
import { useEffect, useState } from 'react';
import './speech-controls.scss';
import { receivedEnd, seekBy, setSpeechRate, SPEECH_RATES, togglePause, useActiveSpeech, useSpeechLoading } from './speech-playback-control';

const time = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** Pause, ±5 s, speed and time of the streamed speech. */
export default function SpeechControls() {
  return <SpeechControlsView audio={useActiveSpeech()} loading={useSpeechLoading()} />;
}

/** The controls of a player element; without one (nothing has arrived yet) they wait disabled. */
export function SpeechControlsView({ audio, loading = false }: { audio?: HTMLAudioElement | null; loading?: boolean }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!audio) return;
    const update = () => refresh(value => value + 1);
    const events = ['timeupdate', 'progress', 'play', 'pause', 'ratechange', 'durationchange', 'ended'];
    events.forEach(event => audio.addEventListener(event, update));
    return () => events.forEach(event => audio.removeEventListener(event, update));
  }, [audio]);
  // The panel is there before the first piece of audio: it waits disabled, so the text below does not jump.
  const received = audio ? receivedEnd(audio) : 0;
  // The total is known only once the stream has ended.
  const total = audio && Number.isFinite(audio.duration) ? audio.duration : received;

  const currentRate = audio?.playbackRate || 1;
  const rateIndex = SPEECH_RATES.findIndex(rate => Math.abs(rate - currentRate) < 0.01);
  const currentIndex = rateIndex >= 0 ? rateIndex : SPEECH_RATES.indexOf(1);

  const stepUp = () => {
    if (audio && currentIndex < SPEECH_RATES.length - 1) {
      setSpeechRate(audio, SPEECH_RATES[currentIndex + 1]);
    }
  };

  const stepDown = () => {
    if (audio && currentIndex > 0) {
      setSpeechRate(audio, SPEECH_RATES[currentIndex - 1]);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.deltaY < 0) stepUp();
    else if (event.deltaY > 0) stepDown();
  };

  return (
    <div className="speech-controls" role="group" aria-label="Управление озвучкой">
      <button type="button" className="btn secondary compact-btn" title="Назад на 5 секунд" aria-label="Назад на 5 секунд"
        disabled={!audio} onClick={() => audio && seekBy(audio, -5)}>−5</button>
      <button type="button" className="btn secondary compact-btn" title={audio?.paused ? 'Продолжить' : 'Пауза'}
        aria-label={audio?.paused ? 'Продолжить' : 'Пауза'} disabled={!audio} onClick={() => audio && togglePause(audio)}>{audio?.paused ? '▶' : '⏸'}</button>
      <button type="button" className="btn secondary compact-btn" title="Вперёд на 5 секунд (в пределах загруженного)"
        aria-label="Вперёд на 5 секунд" disabled={!audio} onClick={() => audio && seekBy(audio, 5)}>+5</button>
      <div className="speech-rate-stepper" role="group" aria-label="Скорость озвучки"
        title="Скорость озвучки" onWheel={handleWheel}>
        <span className="speech-rate-value">×{String(SPEECH_RATES[currentIndex] ?? currentRate).replace('.', ',')}</span>
        <div className="speech-rate-buttons">
          <button type="button" className="speech-rate-btn speech-rate-btn--up"
            title="Увеличить скорость" aria-label="Увеличить скорость"
            disabled={!audio || currentIndex >= SPEECH_RATES.length - 1}
            onClick={stepUp}>
            <svg width="6" height="4" viewBox="0 0 6 4" fill="currentColor" aria-hidden="true">
              <path d="M3 0.5L5.5 3.5H0.5Z" />
            </svg>
          </button>
          <button type="button" className="speech-rate-btn speech-rate-btn--down"
            title="Уменьшить скорость" aria-label="Уменьшить скорость"
            disabled={!audio || currentIndex <= 0}
            onClick={stepDown}>
            <svg width="6" height="4" viewBox="0 0 6 4" fill="currentColor" aria-hidden="true">
              <path d="M3 3.5L0.5 0.5H5.5Z" />
            </svg>
          </button>
        </div>
      </div>
      <span className="speech-time">{time(audio?.currentTime ?? 0)} / {time(total)}{loading ? '+' : ''}</span>
    </div>
  );
}
