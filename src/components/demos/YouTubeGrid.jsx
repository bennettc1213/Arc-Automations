import { useRef, useState } from 'react';
import { media } from '../../lib/media';
import './demos.css';

const CELLS = Array.from({ length: 6 }, (_, i) => ({
  thumb: `youtube-thumb-0${i + 1}.jpg`,
  clip: `youtube-clip-0${i + 1}.mp4`,
}));

function Cell({ thumb, clip }) {
  const [hover, setHover] = useState(false);
  const videoRef = useRef(null);
  const thumbUrl = media(thumb);
  const clipUrl = media(clip);

  return (
    <div
      className="demo-yt__cell"
      onMouseEnter={() => {
        setHover(true);
        videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        setHover(false);
        videoRef.current?.pause();
      }}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt="" loading="lazy" />
      ) : (
        <div className="demo-yt__empty mono">
          <span className="demo-yt__play" aria-hidden="true">
            ▶
          </span>
          {thumb}
        </div>
      )}
      {clipUrl && (
        <video
          ref={videoRef}
          src={clipUrl}
          muted
          loop
          playsInline
          preload="none"
          className={hover ? 'is-on' : ''}
        />
      )}
    </div>
  );
}

export default function YouTubeGrid() {
  return (
    <div className="demo demo-yt">
      <div className="demo__chrome mono">
        <span>the funnel — top</span>
        <span className="demo-yt__live">
          <i aria-hidden="true" /> comedy in, contractors out
        </span>
      </div>
      <div className="demo-yt__grid">
        {CELLS.map((c) => (
          <Cell key={c.thumb} {...c} />
        ))}
      </div>
    </div>
  );
}
