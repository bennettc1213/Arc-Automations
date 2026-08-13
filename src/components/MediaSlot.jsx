import { media } from '../lib/media';

/**
 * Renders a real asset if it exists in src/assets/media/, otherwise a
 * designed, honest slot naming the exact file to drop in. No fake media.
 */
export default function MediaSlot({ name, spec, alt = '', className = '', video = false }) {
  const url = media(name);

  if (url) {
    if (video || /\.(mp4|webm)$/i.test(name)) {
      return (
        <video
          className={className}
          src={url}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
        />
      );
    }
    return <img className={className} src={url} alt={alt} loading="lazy" />;
  }

  return (
    <div className={`slot ${className}`}>
      <span className="slot__mark" aria-hidden="true">
        *
      </span>
      <span className="slot__name">assets/media/{name}</span>
      {spec && <span className="slot__spec">{spec}</span>}
    </div>
  );
}
