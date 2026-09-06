/**
 * the arc automations mark.
 *
 * there was no logo file in this repo — the brand's only consistent mark was
 * the orange asterisk that serves as the favicon and as the star in the nav
 * wordmark. this is that asterisk drawn as geometry, wrapped in the open arc
 * the company is named after, so the two halves of the name are both in it.
 *
 * one file, so replacing it with a real logo is one file. it inherits size
 * from its prop and colour from the tokens, never from a bitmap.
 */
export default function ArcMark({ size = 22, className = '', title }) {
  const r = 8.4;
  const circumference = 2 * Math.PI * r;

  return (
    <svg
      className={`arcmark ${className}`.trim()}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      fill="none"
    >
      {/* the arc: an open ring, broken at the top right where the star sits */}
      <circle
        cx="12"
        cy="12"
        r={r}
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.7} ${circumference}`}
        transform="rotate(-58 12 12)"
      />

      {/* the star, at the break in the arc */}
      <g stroke="var(--accent-lite)" strokeWidth="1.7" strokeLinecap="round">
        <line x1="18.2" y1="2.6" x2="18.2" y2="8.4" />
        <line x1="15.7" y1="4.05" x2="20.7" y2="6.95" />
        <line x1="15.7" y1="6.95" x2="20.7" y2="4.05" />
      </g>
    </svg>
  );
}
