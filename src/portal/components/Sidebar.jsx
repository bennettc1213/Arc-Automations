import { Link, NavLink } from 'react-router-dom';
import ArcMark from '../../components/ArcMark';
import Icon from './Icon';
import { NAV_GROUPS } from '../lib/nav';

/**
 * the workspace rail.
 *
 * it carries three things and nothing else: who this data belongs to, where you can go,
 * and whether the pipeline is up. the status dot lives down here rather than only on the
 * overview because the one question a client opens this product to ask should be answered
 * on every page, not just the first one.
 *
 * collapsing is a real state rather than a decoration: a leads table with fourteen columns
 * wants the horizontal space back, and the choice persists so it does not have to be made
 * again every visit.
 *
 * the ops console renders this same rail over a different `groups`. the alternative was a
 * second rail that looked the same today — and the day it stopped looking the same, one of
 * the two would be the wrong one and nobody would know which.
 */

const STATUS_GLYPH = { operational: '■', degraded: '▲', failed: '●' };
const STATUS_WORD = { operational: 'operational', degraded: 'degraded', failed: 'action required' };
const STATUS_MOD = { operational: 'ok', degraded: 'degraded', failed: 'failed' };

export default function Sidebar({
  base,
  tenantName,
  status,
  collapsed,
  onToggleCollapse,
  onNavigate,
  counts = {},
  groups = NAV_GROUPS,
  mark = 'portal',
  home = '/portal',
  tenantSub = 'client portal',
}) {
  const state = status?.status ?? 'operational';

  return (
    <nav className="ws-rail" aria-label="portal sections">
      <div className="ws-rail__brand">
        <Link to={home} className="ws-rail__mark" title="arc automations">
          <ArcMark size={18} title="arc automations" />
          {!collapsed && (
            <span>
              arc<b>.</b>
              {mark}
            </span>
          )}
        </Link>
      </div>

      {!collapsed && tenantName && (
        <div className="ws-rail__tenant">
          <span className="ws-rail__tenant-name">{tenantName}</span>
          <span className="ws-rail__tenant-sub">{tenantSub}</span>
        </div>
      )}

      <div className="ws-rail__scroll">
        {groups.map((group) => (
          <div className="ws-nav" key={group.label}>
            {!collapsed && <p className="ws-nav__label">{group.label}</p>}

            <ul>
              {group.items.map((item) => (
                <li key={item.label}>
                  <NavLink
                    to={item.to ? `${base}/${item.to}` : base}
                    end={item.end}
                    className={({ isActive }) => `ws-nav__item${isActive ? ' is-active' : ''}`}
                    onClick={onNavigate}
                    /* the tooltip is the label when the label is hidden. a collapsed rail
                       that is a column of unexplained glyphs is a puzzle, not a nav. */
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon name={item.icon} />
                    {!collapsed && <span className="ws-nav__text">{item.label}</span>}
                    {!collapsed && counts[item.to] !== undefined && counts[item.to] !== null && (
                      <span className="ws-nav__count">{counts[item.to]}</span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="ws-rail__foot">
        <div className={`ws-rail__status ws-rail__status--${STATUS_MOD[state]}`}>
          <span aria-hidden="true">{STATUS_GLYPH[state]}</span>
          {!collapsed && <span>{STATUS_WORD[state]}</span>}
        </div>

        <button
          type="button"
          className="ws-rail__collapse"
          onClick={onToggleCollapse}
          aria-pressed={collapsed}
          title={collapsed ? 'expand sidebar' : 'collapse sidebar'}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
          {!collapsed && <span>collapse</span>}
        </button>
      </div>
    </nav>
  );
}
