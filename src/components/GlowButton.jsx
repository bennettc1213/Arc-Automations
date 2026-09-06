import { Link } from 'react-router-dom';
import './GlowButton.css';

/**
 * pill button with a conic-gradient ring rotating behind it.
 *
 * the ring is a single oversized element spinning under an overflow-hidden
 * pill, so the animation is one GPU-composited transform rather than a paint
 * on every frame. the opaque face on top masks the middle, leaving only the
 * 1.5px rim visible — that rim is the whole effect.
 *
 * renders as a router Link, a plain anchor, or a button depending on what it
 * is actually doing. a nav control that scrolls the page is a button; one that
 * changes the route is a link. getting that wrong breaks keyboard and
 * screen-reader users even when it looks identical.
 */
export default function GlowButton({
  to,
  href,
  variant = 'ghost',
  className = '',
  children,
  ...rest
}) {
  const inner = (
    <>
      <span className="glowbtn__ring" aria-hidden="true" />
      <span className="glowbtn__face">{children}</span>
    </>
  );

  const cls = ['glowbtn', `glowbtn--${variant}`, className].filter(Boolean).join(' ');

  if (to) {
    return (
      <Link className={cls} to={to} {...rest}>
        {inner}
      </Link>
    );
  }

  if (href) {
    return (
      <a className={cls} href={href} {...rest}>
        {inner}
      </a>
    );
  }

  return (
    <button className={cls} type="button" {...rest}>
      {inner}
    </button>
  );
}
