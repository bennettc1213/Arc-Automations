import { NavLink } from 'react-router-dom';
import Icon from './Icon';

/**
 * ARC-MK-200 — the owner portal's tab bar, on a phone.
 *
 * the same four screens the rail lists, pinned to the bottom of the screen where a thumb
 * already is. it reads the nav declaration it is handed and keeps no list of its own, so it
 * cannot offer a screen the rail does not. drawn only below the width at which the rail goes
 * off-canvas (Owner.css).
 */
export default function OwnerTabs({ base, items, counts = {} }) {
  return (
    <nav className="ow-tabs" aria-label="your four screens">
      {items.map((item) => (
        <NavLink
          key={item.label}
          to={item.to ? `${base}/${item.to}` : base}
          end={item.end}
          className={({ isActive }) => (isActive ? 'is-active' : undefined)}
        >
          <Icon name={item.icon} size={18} />
          <span>{item.short ?? item.label}</span>
          {counts[item.to] ? (
            <span className="ow-tabs__count">
              {counts[item.to]}
              <span className="ws-sr"> waiting</span>
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
