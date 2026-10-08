import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Panel, Pill } from '../../components/ui';
import { site } from '../../../data/site';
import { crmApi } from '../../lib/crm';
import { downloadCsv, toCsv } from '../../lib/csv';
import { formatCount, formatDate } from '../../lib/format';
import { OWNER_DETAIL_ITEMS } from '../../lib/nav';
import { jobsTable, ownerJobs } from '../../lib/owner';
import {
  AFTER_HOURS_WORDS,
  STOP_REASON_WORDS,
  hoursLines,
} from '../../../../supabase/functions/_shared/account/model.ts';
import './Owner.css';

/**
 * ARC-MK-200 — account: what is arc allowed to do?
 *
 * the owner's hours, service area, what happens outside hours, who is told when a lead
 * needs a person, and who must never be texted — then their data, a person to reach, and
 * the rest of the workspace under "details".
 *
 * the settings are read, never edited here. a signed-in client's come from the `crm`
 * function's `account-settings` read: the published versions actually in force, with every
 * address reduced to a hint before it leaves the server. the demo is handed a written
 * example in the same shape. when they cannot be read the page prints a dash and why —
 * it never falls back to a default that looks like somebody's real hours.
 */

function useSettings(data, live) {
  const [state, setState] = useState(() =>
    data.accountSettings
      ? { kind: 'ready', settings: data.accountSettings }
      : live
        ? { kind: 'loading' }
        : { kind: 'unavailable', reason: 'settings are only shown for a signed-in account.' },
  );

  useEffect(() => {
    if (data.accountSettings || !live || !data.tenant?.id) return undefined;
    let cancelled = false;
    crmApi('crm', data.tenant.id)
      .accountSettings()
      .then((settings) => {
        if (cancelled) return;
        setState(
          settings?.available
            ? { kind: 'ready', settings }
            : { kind: 'unavailable', reason: settings?.reason ?? 'your settings could not be read.' },
        );
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: 'unavailable', reason: 'your settings could not be read just now. nothing about them has changed.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [data.accountSettings, data.tenant?.id, live]);

  return state;
}

function Unavailable({ state }) {
  if (state.kind === 'loading') return <p className="ow-sub">reading your settings…</p>;
  return (
    <p className="ow-sub">
      <span aria-hidden="true">— </span>
      <span className="ws-sr">not available. </span>
      {state.reason}
    </p>
  );
}

export default function OwnerAccount({ data, base, live }) {
  const state = useSettings(data, live);
  const settings = state.kind === 'ready' ? state.settings : null;
  const { tenant } = data;
  const { jobs, example } = ownerJobs(data);

  const changeSubject = encodeURIComponent(`change request — ${tenant.name}`);
  const changeBody = encodeURIComponent(`account: ${tenant.name} (${tenant.slug ?? tenant.id})\n\nwhat should change:\n\n`);

  const exportJobs = () => {
    const { columns, rows } = jobsTable(jobs);
    downloadCsv(`${tenant.slug ?? 'arc'}-jobs-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(columns, rows));
  };

  return (
    <div className="ow">
      {data.accountSettings && example && (
        <p className="ow-example">example settings for a made-up company.</p>
      )}

      <Panel title="when arc works for you" note={settings?.timezone ?? tenant.timezone}>
        {settings ? (
          <>
            <dl className="ow-hours">
              {hoursLines(settings).map((line) => (
                <div key={line.day} className={line.open ? undefined : 'is-closed'}>
                  <dt>{line.day}</dt>
                  <dd>{line.words}</dd>
                </div>
              ))}
            </dl>
            <p className="ow-rule">
              <b>outside those hours:</b>{' '}
              {AFTER_HOURS_WORDS[settings.after_hours.behaviour] ?? settings.after_hours.behaviour}
              {settings.after_hours.callback_window && ` it says you will call ${settings.after_hours.callback_window}.`}
            </p>
          </>
        ) : (
          <Unavailable state={state} />
        )}
      </Panel>

      <Panel title="where you work">
        {settings ? (
          <>
            {settings.service_area.cities.length > 0 && <p className="ow-chips">{settings.service_area.cities.join(' · ')}</p>}
            {settings.service_area.zips.length > 0 && (
              <p className="ow-chips mono">{settings.service_area.zips.join(' · ')}</p>
            )}
            {settings.service_area.note && <p className="ow-sub">{settings.service_area.note}</p>}
            <p className="ow-sub">a customer outside this area is told so, and is never booked.</p>
          </>
        ) : (
          <Unavailable state={state} />
        )}
      </Panel>

      <Panel title="who arc tells" note="when a lead needs a person">
        {settings ? (
          settings.alerts.length === 0 ? (
            <p className="ow-sub">
              nobody yet. a lead that needs a person would wait here with no one told — ask us
              to add somebody.
            </p>
          ) : (
            <ul className="ow-rows">
              {settings.alerts.map((alert, index) => (
                <li key={`${alert.address_hint}-${index}`}>
                  <span>{alert.name ?? 'unnamed'}</span>
                  <span className="mono">
                    {alert.channel === 'email' ? 'email' : 'text'} · {alert.address_hint}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <Unavailable state={state} />
        )}
      </Panel>

      <Panel title="stop list" note={settings ? `${formatCount(settings.stop_list.total)} never texted` : null}>
        {settings ? (
          <>
            <p className="ow-sub">
              arc never texts anyone on this list. a customer who replies stop is added the
              moment they do, and nothing takes them off it but a person.
            </p>
            {settings.stop_list.entries.length > 0 && (
              <ul className="ow-rows">
                {settings.stop_list.entries.map((entry, index) => (
                  <li key={`${entry.address_hint}-${index}`}>
                    <span className="mono">{entry.address_hint}</span>
                    <span>
                      {STOP_REASON_WORDS[entry.reason] ?? entry.reason}
                      {entry.added_at && ` · ${formatDate(entry.added_at, settings.timezone ?? tenant.timezone)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {settings.stop_list.total > settings.stop_list.entries.length && (
              <p className="ow-sub">
                showing the newest {formatCount(settings.stop_list.entries.length)} of{' '}
                {formatCount(settings.stop_list.total)}.
              </p>
            )}
          </>
        ) : (
          <Unavailable state={state} />
        )}
      </Panel>

      <Panel title="change any of this">
        <p className="ow-sub">
          none of this is a switch on this page, on purpose: these rules decide who gets
          texted and when, so we change them with you and check them before they take effect.
        </p>
        <a className="ws-btn ws-btn--primary ow-tap" href={`mailto:${site.email}?subject=${changeSubject}&body=${changeBody}`}>
          request a change
        </a>
      </Panel>

      <Panel title="your data">
        <p className="ow-sub">
          every lead on the jobs screen, step by step, as a spreadsheet file. it is yours — take
          it whenever you like.
        </p>
        <button type="button" className="ws-btn ow-tap" onClick={exportJobs} disabled={jobs.length === 0}>
          <Icon name="download" size={13} />
          export my data
        </button>
        {jobs.length === 0 && <p className="ow-sub">there are no leads to export yet.</p>}
      </Panel>

      <Panel title="reach a person">
        <dl className="ow-hours">
          <div>
            <dt>account</dt>
            <dd>{tenant.name}</dd>
          </div>
          <div>
            <dt>account id</dt>
            <dd className="mono">{tenant.slug ?? tenant.id}</dd>
          </div>
          <div>
            <dt>status</dt>
            <dd>
              <Pill tone={tenant.status === 'active' ? 'ok' : 'warn'}>{tenant.status}</Pill>
            </dd>
          </div>
        </dl>
        <a className="ws-btn ow-tap" href={`mailto:${site.email}`}>
          {site.email}
        </a>
      </Panel>

      <Panel title="details" note="the rest of the record">
        <ul className="ow-details">
          {OWNER_DETAIL_ITEMS.map((item) => (
            <li key={item.to}>
              <Link to={`${base}/${item.to}`} className="ow-tap">
                <span>{item.title}</span>
                <small>{item.blurb}</small>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
