import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import { formatRelative, formatStamp } from '../lib/format';

/**
 * the top bar.
 *
 * the search field is a button, not an input. it opens the command palette, which searches
 * pages, leads and automations at once — a bar that only filtered the current table would
 * be a smaller promise wearing the same clothes, and people type into the box at the top of
 * a dashboard expecting to find things that are not on screen.
 *
 * the window readout is here because every figure in this product is scoped to thirty days
 * in the client's own timezone, and a number whose window is implicit is a number two
 * people can read differently.
 */

function useDismissable(open, onClose) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointer = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };

    /* pointerdown rather than click: a click listener fires after the button that opened
       the menu has already been re-rendered, which makes the toggle feel like it swallowed
       a press. */
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return ref;
}

function initialsFor(source) {
  if (!source) return '··';
  const cleaned = source.split('@')[0].replace(/[^a-z0-9]+/gi, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toLowerCase();
  return (parts[0][0] + parts[1][0]).toLowerCase();
}

export default function Topbar({
  title,
  blurb,
  timezone,
  status,
  incidents = [],
  email,
  tenantName,
  onSignOut,
  onOpenPalette,
  onOpenMenu,
  actions,
  searchLabel = 'search leads, pages, automations',
  /* the window chip says what every figure below it is scoped to. the ops console
     is scoped to the same thirty days but across a different set of things, so it
     says so in its own words rather than printing one client's timezone. */
  windowLabel,
  home = '/portal',
  homeLabel = 'portal home',
}) {
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const alertsRef = useDismissable(alertsOpen, () => setAlertsOpen(false));
  const accountRef = useDismissable(accountOpen, () => setAccountOpen(false));

  const open = incidents.filter((i) => i.open);
  /* the badge counts open incidents only. a bell that counts history is a bell that is
     permanently lit, and a permanently lit bell is furniture. */
  const badge = open.length;

  return (
    <header className="ws-top">
      <button type="button" className="ws-top__menu" onClick={onOpenMenu} title="open navigation">
        <Icon name="menu" />
      </button>

      <div className="ws-top__title">
        <h1>{title}</h1>
        {blurb && <p>{blurb}</p>}
      </div>

      <button type="button" className="ws-top__search" onClick={onOpenPalette}>
        <Icon name="search" />
        <span>{searchLabel}</span>
        <kbd>⌘K</kbd>
      </button>

      <span className="ws-top__window" title="every figure on this page is scoped to this window">
        {windowLabel ?? `30d · ${timezone}`}
      </span>

      {actions}

      <div className="ws-top__pop" ref={alertsRef}>
        <button
          type="button"
          className={`ws-top__icon${badge > 0 ? ' has-badge' : ''}`}
          onClick={() => setAlertsOpen((v) => !v)}
          aria-expanded={alertsOpen}
          title="alerts"
        >
          <Icon name="bell" />
          {badge > 0 && <i className="ws-top__badge">{badge}</i>}
        </button>

        {alertsOpen && (
          <div className="ws-menu ws-menu--wide">
            <p className="ws-menu__label">alerts</p>

            {status?.status !== 'operational' && (
              <div className="ws-menu__row ws-menu__row--warn">
                <span>
                  {status.status === 'failed' ? 'action required' : 'degraded — watching'}
                </span>
                <p>{status.detail}</p>
              </div>
            )}

            {incidents.length === 0 ? (
              <p className="ws-menu__empty">no incidents in this window.</p>
            ) : (
              incidents.slice(0, 5).map((incident) => (
                <div
                  key={incident.id}
                  className={`ws-menu__row${incident.open ? ' ws-menu__row--warn' : ''}`}
                >
                  <span>
                    {incident.checkType} · {incident.open ? 'open' : 'resolved'}
                  </span>
                  <p>{incident.message}</p>
                  <em>{formatStamp(incident.firedAt, timezone)}</em>
                </div>
              ))
            )}

            {status?.lastCheckedAt && (
              <p className="ws-menu__foot">
                last end-to-end check {formatRelative(status.lastCheckedAt, timezone)}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="ws-top__pop" ref={accountRef}>
        <button
          type="button"
          className="ws-top__avatar"
          onClick={() => setAccountOpen((v) => !v)}
          aria-expanded={accountOpen}
          title={email ?? tenantName ?? 'account'}
        >
          {initialsFor(email ?? tenantName)}
        </button>

        {accountOpen && (
          <div className="ws-menu">
            <p className="ws-menu__label">signed in</p>
            <p className="ws-menu__id">{email ?? tenantName ?? 'demo viewer'}</p>

            <Link to={home} className="ws-menu__link" onClick={() => setAccountOpen(false)}>
              <Icon name="external" />
              {homeLabel}
            </Link>
            <Link to="/" className="ws-menu__link" onClick={() => setAccountOpen(false)}>
              <Icon name="external" />
              arc automations
            </Link>

            {onSignOut && (
              <button type="button" className="ws-menu__link" onClick={onSignOut}>
                <Icon name="signout" />
                sign out
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
