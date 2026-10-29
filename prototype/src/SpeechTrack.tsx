import { useEffect, useState } from 'react';
import { receivedEnd, seekTo, useActiveSpeech, useSpeechLoading, useSpeechMarks, useSpeechTime } from './speech-playback-control';

interface Segment { from: number; to: number }

/** One level of segments under the text of a speech step, like the tracks of a transcription:
 * a block per spoken sentence, as wide as it sounds. The played part of the block is filled,
 * the playing block glows, a click or a drag inside a block moves the speech there. While
 * the audio is still arriving, a ghost block waits at the end for the next segment. */
export default function SpeechTrack() {
  const audio = useActiveSpeech();
  const marks = useSpeechMarks();
  const loading = useSpeechLoading();
  const time = useSpeechTime(audio);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!audio) return;
    const update = () => refresh(value => value + 1);
    audio.addEventListener('progress', update);
    audio.addEventListener('durationchange', update);
    return () => { audio.removeEventListener('progress', update); audio.removeEventListener('durationchange', update); };
  }, [audio]);
  if (!audio) return null;
  const sentences: Segment[] = marks.filter(mark => mark.kind === 'SentenceBoundary').map(mark => ({ from: mark.from, to: mark.to }));
  // Without marks (the provider sends none), the loaded audio is one segment.
  const segments = sentences.length ? sentences : receivedEnd(audio) > 0 ? [{ from: 0, to: receivedEnd(audio) }] : [];
  if (!segments.length && !loading) return null;
  const current = segments.findIndex(segment => segment.from <= time && time < segment.to);
  const seek = (event: { clientX: number; currentTarget: HTMLElement }, segment: Segment) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width) seekTo(audio, segment.from + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * (segment.to - segment.from));
  };
  return <div className="speech-track" role="group" aria-label="Сегменты озвучки">
    {segments.map((segment, index) => {
      const length = Math.max(.05, segment.to - segment.from);
      const filled = time >= segment.to ? 100 : time <= segment.from ? 0 : (time - segment.from) / length * 100;
      return <div key={index} role="slider" tabIndex={0} aria-label={`Сегмент ${index + 1}`}
        aria-valuemin={Math.round(segment.from)} aria-valuemax={Math.round(segment.to)} aria-valuenow={Math.round(Math.max(segment.from, Math.min(segment.to, time)))}
        className={`speech-track-segment${index === current ? ' speech-track-segment--current' : ''}`}
        style={{ flexGrow: length }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); seek(event, segment); }}
        onPointerMove={event => { if (event.buttons & 1) seek(event, segment); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seekTo(audio, segment.from); } }}>
        <div className="speech-track-fill" style={{ width: `${filled}%` }} />
      </div>;
    })}
    {loading && <div className="speech-track-segment speech-track-segment--ghost" role="status" aria-label="Загружается следующий сегмент"
      title="Звук ещё загружается: следующий сегмент появится здесь" />}
  </div>;
}
