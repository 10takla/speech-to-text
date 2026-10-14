import { Fragment } from 'react';
import type { RecordingPreview } from './recording-transcript';
import './transcript-playback-layout.scss';

export default function RecordingTranscriptPreview({ text, fragments }: RecordingPreview) {
  if (!fragments.length) return <>{text}</>;
  return <div className="fragment-editor-flow transcript-line-layout recording-transcript-flow">
    {fragments.map((fragment, index) => <Fragment key={index}>
      {index > 0 && ' '}
      <span className="fragment-editor transcript-fragment">
        <span className="recording-editor"><span className="editor-segments">
          {fragment.segments.map((segment, segmentIndex) => <Fragment key={segmentIndex}>
            {segmentIndex > 0 && ' '}
            <span className={`editor-segment-pair ${segment.deleted ? 'deleted' : 'selected'}`}>
              <span className="editor-segment">{segment.text}</span>
            </span>
          </Fragment>)}
        </span></span>
      </span>
    </Fragment>)}
  </div>;
}
