import { Link } from 'react-router-dom';
import Icon from './Icon';
import { Empty, Panel, Pill, StatCard } from './ui';
import { formatRelative, formatStamp } from '../lib/format';

/**
 * the pieces every lifecycle module page is built from.
 *
 * they exist because the honest states are the hard part, not the tables. five pages each
 * inventing their own way to say "this is not connected yet" is five chances to say it in a
 * way that reads as zero — and the one thing this product cannot afford is a page of
 * confident-looking dashes that a client takes for a bad month.
 *
 * so there is exactly one component that decides what a module page renders when the module
 * is not live, and every page goes through it.
 */

/* the three-way answer from lib/modules.js, drawn.
 *
 * `unavailable` is a page that should not have been reachable — the nav filters it out —
 * so it says so plainly rather than pretending to be an empty dataset.
 * `awaiting` is a real page for a real client whose integration is mid-build. */
export function ModuleGate({ module, children }) {
  if (!module) return null;
  if (module.state === 'live') return children;

  if (module.state === 'unavailable') {
    return (
      <Panel title={module.label}>
        <Empty title="this is not part of your plan">
          {module.label} is not something we are running for you. if you want it, support can
          tell you what it would involve — there is a link in the rail.
        </Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title={module.label}
      note={<Pill tone="idle">awaiting connection</Pill>}
    >
      <Empty title="not connected yet">
        {module.awaiting}
        <br />
        <br />
        nothing is shown above as zero, because zero would be a claim about a working
        pipeline. this one has not sent anything through yet.
      </Empty>
    </Panel>
  );
}

/**
 * a stat card that knows the difference between none and unknown.
 *
 * `available={false}` prints an em dash and the reason. this is the single most important
 * component in the lifecycle work: every headline figure on the overview goes through it,
 * and the alternative — a zero from a module that was never wired up — is indistinguishable
 * from a real zero until somebody acts on it.
 */
export function ModuleStat({
  label,
  value,
  sub,
  available = true,
  unavailable = 'not connected yet',
  ...rest
}) {
  if (!available) {
    return (
      <StatCard
        label={label}
        value="—"
        compact
        sub={<span className="ws-stat__unavail">{unavailable}</span>}
      />
    );
  }
  return <StatCard label={label} value={value} sub={sub} {...rest} />;
}

/**
 * when the data on screen was last true.
 *
 * printed on every module page rather than only where it is flattering. a dashboard with no
 * freshness stamp is implicitly claiming to be live, and this one is a sixty-one day window
 * fetched on page load.
 */
export function Freshness({ at, timezone, label = 'newest record' }) {
  if (!at) return null;
  return (
    <p className="ws-fresh mono">
      <Icon name="clock" size={11} />
      {label} {formatRelative(at, timezone)} · {formatStamp(at, timezone)}
    </p>
  );
}

/* a value that has a reason for being absent, rather than just being absent. used wherever a
   figure is withheld on purpose — an unattributable recovery, a margin nobody sent us. */
export function Withheld({ children }) {
  return <span className="ws-withheld">{children}</span>;
}

/* the paired counter used across the module pages: "4 of 11", where the denominator is the
   thing that stops the numerator being read as the whole story. */
export function Coverage({ of, total, noun }) {
  if (!total) return null;
  return (
    <span className="ws-coverage mono">
      {of} of {total} {noun}
    </span>
  );
}

/* a compliance line: a rule the product promises, and whether the log shows it held.
   `breaches` of zero is the normal case and is stated positively — a rule that is only
   mentioned when it breaks is a rule nobody knows they are being given. */
export function RuleCheck({ rule, breaches, detail, to, linkLabel = 'see them' }) {
  const ok = !breaches;
  return (
    <li className={`ws-rule${ok ? '' : ' is-breached'}`}>
      <Pill tone={ok ? 'ok' : 'fail'}>{ok ? 'holding' : `${breaches} to look at`}</Pill>
      <span className="ws-rule__text">
        <b>{rule}</b>
        {detail && <em>{detail}</em>}
      </span>
      {!ok && to && (
        <Link to={to} className="ws-rule__link">
          {linkLabel}
        </Link>
      )}
    </li>
  );
}

export function RuleList({ title = 'the rules this runs under', children, note }) {
  return (
    <Panel title={title} note={note}>
      <ul className="ws-rules">{children}</ul>
    </Panel>
  );
}
