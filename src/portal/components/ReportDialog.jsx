import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import Icon from './Icon';
import { Pill } from './ui';
import { connectionLiveness } from '../lib/ops';
import {
  MAX_REPORT_DAYS,
  REPORT_AUDIENCES,
  REPORT_PERIODS,
  REPORT_SECTIONS,
  buildReport,
  defaultSections,
  reportFilename,
  resolvePeriod,
} from '../lib/report';
import { fetchReportWindow } from '../lib/report-data';
import { formatCount, formatDuration, formatUptime } from '../lib/format';
import './ReportDialog.css';

/**
 * the report builder: pick a window, pick who it is for, pick what goes in it,
 * watch the pdf redraw, download it.
 *
 * three things happen underneath, in order, and each is cached so a change only
 * redoes what it has to. the events for the window are read from supabase — once,
 * and reused for any shorter window inside the same span. the report is derived
 * from them by report.js, the same chain as the dashboard. and the pdf is drawn
 * from the report, debounced so typing a note does not redraw on every keystroke.
 *
 * jspdf and the fonts are four hundred kilobytes the rest of the console never
 * needs, so they load when this opens rather than with the page.
 */

let pdfKit = null;

function loadPdfKit() {
  if (!pdfKit) {
    pdfKit = Promise.all([import('../lib/report-pdf'), import('../lib/report-fonts')])
      .then(async ([pdf, fonts]) => ({
        render: pdf.renderReportPdf,
        /* a font request that fails still produces a report, set in helvetica. */
        fonts: await fonts.loadReportFonts().catch(() => null),
      }))
      .catch((error) => {
        pdfKit = null;
        throw error;
      });
  }
  return pdfKit;
}

const REDRAW_MS = 420;
const FETCH_DEBOUNCE_MS = 380;
const FINDING_TONE = { alert: 'fail', watch: 'warn', good: 'ok', info: 'neutral' };

function kilobytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} kb`
    : `${(bytes / 1024 / 1024).toFixed(1)} mb`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  /* revoked a beat later: firefox cancels a download whose url disappears in the
     same frame as the click. */
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function ReportDialog({ client, onClose }) {
  const { tenant } = client;
  const zone = tenant.timezone;
  const titleId = useId();

  /* one `now` for the life of the dialog, so "last 30 days" is the same thirty
     days on the preview and on the download, however long the note takes to write. */
  const [now] = useState(() => DateTime.now());
  const today = now.setZone(zone).toISODate();

  const [periodKey, setPeriodKey] = useState('30d');
  const [customFrom, setCustomFrom] = useState(() => now.setZone(zone).minus({ days: 29 }).toISODate());
  const [customTo, setCustomTo] = useState(today);
  const [audience, setAudience] = useState('client');
  const [sections, setSections] = useState(defaultSections);
  const [compare, setCompare] = useState(true);
  const [preparedFor, setPreparedFor] = useState(tenant.contactName ?? '');
  const [note, setNote] = useState('');

  const period = useMemo(
    () => resolvePeriod({ key: periodKey, from: customFrom, to: customTo }, zone, now),
    [periodKey, customFrom, customTo, zone, now],
  );

  /* ── the read ─────────────────────────────────────────── */

  const cache = useRef(null);
  const [source, setSource] = useState({ kind: 'loading' });
  const sinceMs = period.error ? null : period.fetchSince.toMillis();
  const untilMs = period.error ? null : period.fetchUntil.toMillis();

  useEffect(() => {
    if (sinceMs === null) return undefined;

    const cached = cache.current;
    if (cached && cached.since.toMillis() <= sinceMs && cached.until.toMillis() >= untilMs) {
      setSource({ kind: 'ready', data: cached });
      return undefined;
    }

    let live = true;
    const since = DateTime.fromMillis(cached ? Math.min(cached.since.toMillis(), sinceMs) : sinceMs);
    const until = DateTime.fromMillis(cached ? Math.max(cached.until.toMillis(), untilMs) : untilMs);
    setSource((prev) => ({ ...prev, kind: 'loading' }));

    const timer = setTimeout(
      () => {
        fetchReportWindow(tenant.id, since, until)
          .then((data) => {
            if (!live) return;
            cache.current = data;
            setSource({ kind: 'ready', data });
          })
          .catch((error) => live && setSource({ kind: 'error', message: error.message }));
      },
      periodKey === 'custom' ? FETCH_DEBOUNCE_MS : 0,
    );

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sinceMs, untilMs, periodKey, tenant.id]);

  /* ── the report ───────────────────────────────────────── */

  const connections = useMemo(
    () =>
      client.connections.map((connection) => ({
        ...connection,
        liveness: connectionLiveness(connection, client.workflowActivity, now),
      })),
    [client.connections, client.workflowActivity, now],
  );

  const report = useMemo(() => {
    if (source.kind !== 'ready' || period.error) return null;
    /* trimmed to exactly this period's read, so a report does not depend on which
       window happened to be fetched first. the same choices give the same pdf. */
    const since = period.fetchSince.toMillis();
    const until = period.fetchUntil.toMillis();
    const events = source.data.events.filter((event) => {
      const at = Date.parse(event.occurredAt);
      return at >= since && at < until;
    });
    return buildReport({
      tenant,
      events,
      alerts: source.data.alerts,
      connections,
      period,
      audience,
      now,
    });
  }, [source, period, tenant, connections, audience, now]);

  /* ── the pdf ──────────────────────────────────────────── */

  const options = useMemo(
    () => ({ sections, note, preparedFor, compare }),
    [sections, note, preparedFor, compare],
  );
  const [pdf, setPdf] = useState({ url: null, pages: 0, size: 0, busy: true, error: null, plain: false });
  const urlRef = useRef(null);

  useEffect(() => {
    if (!report) return undefined;
    let live = true;
    setPdf((prev) => ({ ...prev, busy: true }));

    const timer = setTimeout(async () => {
      try {
        const kit = await loadPdfKit();
        if (!live) return;
        const doc = kit.render(report, { ...options, fonts: kit.fonts });
        const blob = doc.output('blob');
        if (!live) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPdf({
          url,
          pages: doc.getNumberOfPages(),
          size: blob.size,
          busy: false,
          error: null,
          plain: !kit.fonts,
        });
      } catch (error) {
        if (live) setPdf((prev) => ({ ...prev, busy: false, error: error.message }));
      }
    }, REDRAW_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [report, options]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  /* downloads draw fresh from the current choices rather than handing over the
     preview, which can be a redraw behind a note typed a moment ago. */
  const [saving, setSaving] = useState(null);
  async function produce(mode) {
    if (!report) return;
    setSaving(mode);
    try {
      const kit = await loadPdfKit();
      const blob = kit.render(report, { ...options, fonts: kit.fonts }).output('blob');
      if (mode === 'download') {
        saveBlob(blob, reportFilename(report));
      } else {
        /* no `noopener` in the features string: with it, window.open returns null
           even on success, and a blocked popup could not be told from an open one.
           the opener is cut by hand instead. */
        const url = URL.createObjectURL(blob);
        const tab = window.open(url, '_blank');
        if (tab) tab.opener = null;
        else saveBlob(blob, reportFilename(report));
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (error) {
      setPdf((prev) => ({ ...prev, error: error.message }));
    } finally {
      setSaving(null);
    }
  }

  /* ── the frame ────────────────────────────────────────── */

  const boxRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* mount-only: a parent passing a fresh arrow each render must not re-run this,
     or focus would jump back to the dialog frame mid-typing. */
  useEffect(() => {
    const opener = document.activeElement;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    boxRef.current?.focus();

    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const toggleSection = (key) =>
    setSections((prev) =>
      prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key],
    );

  const status =
    period.error
      ? { tone: 'fail', text: period.error }
      : source.kind === 'error'
        ? { tone: 'fail', text: source.message }
        : source.kind === 'loading'
          ? { tone: 'neutral', text: 'reading the event log…' }
          : pdf.error
            ? { tone: 'fail', text: `could not draw the pdf: ${pdf.error}` }
            : pdf.busy || !pdf.url
              ? { tone: 'neutral', text: 'drawing…' }
              : {
                  tone: 'ok',
                  text: `${pdf.pages} ${pdf.pages === 1 ? 'page' : 'pages'} · ${kilobytes(pdf.size)} · ${formatCount(report?.eventsRead ?? 0)} events read`,
                };

  const previousRange =
    !period.error && period.previousFrom
      ? `${period.previousFrom.setZone(zone).toFormat('LLL d').toLowerCase()} – ${period.previousTo
          .minus({ milliseconds: 1 })
          .setZone(zone)
          .toFormat('LLL d')
          .toLowerCase()}`
      : null;

  return (
    <div className="rpt" role="presentation">
      <button type="button" className="rpt__scrim" aria-label="close" tabIndex={-1} onClick={onClose} />

      <div
        className="rpt__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={boxRef}
      >
        <header className="rpt__head">
          <div className="rpt__title">
            <span className="pt-eyebrow">generate report</span>
            <h2 id={titleId}>{tenant.name}</h2>
          </div>
          <span className="rpt__id mono">{tenant.clientId ?? tenant.slug ?? ''}</span>
          <button type="button" className="rpt__close" onClick={onClose} aria-label="close">
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="rpt__body">
          {/* ── choices ─────────────────────────────── */}
          <div className="rpt__form">
            <fieldset className="rpt__group">
              <legend className="rpt__legend">period</legend>
              <div className="ws-chips" role="radiogroup" aria-label="report period">
                {REPORT_PERIODS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={periodKey === option.key}
                    className={`ws-chip${periodKey === option.key ? ' is-on' : ''}`}
                    onClick={() => setPeriodKey(option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {periodKey === 'custom' && (
                <div className="rpt__dates">
                  <label className="ops-field">
                    <span className="ops-field__label">from</span>
                    <input
                      type="date"
                      className="ops-input ops-input--mono"
                      value={customFrom}
                      max={today}
                      onChange={(event) => setCustomFrom(event.target.value)}
                    />
                  </label>
                  <label className="ops-field">
                    <span className="ops-field__label">through</span>
                    <input
                      type="date"
                      className="ops-input ops-input--mono"
                      value={customTo}
                      min={customFrom}
                      max={today}
                      onChange={(event) => setCustomTo(event.target.value)}
                    />
                  </label>
                </div>
              )}

              <p className={`rpt__resolved${period.error ? ' is-error' : ''}`}>
                {period.error ? (
                  period.error
                ) : (
                  <>
                    <b>{period.range}</b>
                    <span>
                      {period.title} · compared with {previousRange}
                    </span>
                  </>
                )}
              </p>
              {periodKey === 'custom' && !period.error && (
                <p className="rpt__hint">up to {MAX_REPORT_DAYS} days, in {zone.toLowerCase()}.</p>
              )}
            </fieldset>

            <fieldset className="rpt__group">
              <legend className="rpt__legend">who it is for</legend>
              <div className="rpt__options" role="radiogroup" aria-label="audience">
                {REPORT_AUDIENCES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={audience === option.key}
                    className={`rpt__option${audience === option.key ? ' is-on' : ''}`}
                    onClick={() => setAudience(option.key)}
                  >
                    <span className="rpt__radio" aria-hidden="true" />
                    <span className="rpt__option-text">
                      <b>{option.label}</b>
                      <em>{option.hint}</em>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="rpt__group">
              <legend className="rpt__legend">
                what goes in it
                <span>cover, headline figures and summary are always included</span>
              </legend>
              <ul className="rpt__checks">
                {REPORT_SECTIONS.map((section) => {
                  const on = sections.includes(section.key);
                  return (
                    <li key={section.key}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        className={`rpt__check${on ? ' is-on' : ''}`}
                        onClick={() => toggleSection(section.key)}
                      >
                        <span className="rpt__box-mark" aria-hidden="true">
                          {on && <Icon name="check" size={10} />}
                        </span>
                        <span className="rpt__check-label">{section.label}</span>
                        <span className="rpt__check-hint">{section.hint}</span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={compare}
                    className={`rpt__check${compare ? ' is-on' : ''}`}
                    onClick={() => setCompare((value) => !value)}
                  >
                    <span className="rpt__box-mark" aria-hidden="true">
                      {compare && <Icon name="check" size={10} />}
                    </span>
                    <span className="rpt__check-label">changes vs the period before</span>
                    <span className="rpt__check-hint">only printed when that period is fully covered</span>
                  </button>
                </li>
              </ul>
            </fieldset>

            <fieldset className="rpt__group">
              <legend className="rpt__legend">on the cover</legend>
              <label className="ops-field">
                <span className="ops-field__label">prepared for</span>
                <input
                  className="ops-input"
                  value={preparedFor}
                  onChange={(event) => setPreparedFor(event.target.value)}
                  placeholder="optional — a name on the cover"
                  maxLength={80}
                />
              </label>
              <label className="ops-field">
                <span className="ops-field__label">a note from arc</span>
                <textarea
                  className="ops-input ops-input--area"
                  rows={4}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="optional — printed under the summary. what changed, what we fixed, what is next."
                  maxLength={1200}
                />
              </label>
            </fieldset>
          </div>

          {/* ── preview ─────────────────────────────── */}
          <div className="rpt__preview">
            <div className="rpt__preview-bar">
              <Pill tone={status.tone}>{status.text}</Pill>
              {pdf.plain && !pdf.busy && (
                <span className="rpt__hint">brand fonts did not load — set in helvetica</span>
              )}
            </div>

            <div className={`rpt__frame${pdf.busy || source.kind === 'loading' ? ' is-busy' : ''}`}>
              {pdf.url && !period.error && source.kind !== 'error' ? (
                <iframe title={`report preview for ${tenant.name}`} src={`${pdf.url}#view=FitH`} />
              ) : (
                <div className="rpt__frame-empty">
                  {period.error || source.kind === 'error' ? status.text : 'the preview appears here'}
                </div>
              )}
            </div>

            {/* small screens cannot show a pdf inline, so they get the summary the
                pdf opens with instead. */}
            {report && (
              <div className="rpt__glance">
                <dl>
                  <div>
                    <dt>leads</dt>
                    <dd>{formatCount(report.totals.leads)}</dd>
                  </div>
                  <div>
                    <dt>median reply</dt>
                    <dd>{formatDuration(report.totals.medianResponseMs)}</dd>
                  </div>
                  <div>
                    <dt>checks passed</dt>
                    <dd>{formatUptime(report.totals.uptimePct)}</dd>
                  </div>
                </dl>
                <ul>
                  {report.findings.map((finding) => (
                    <li key={finding.text}>
                      <Pill tone={FINDING_TONE[finding.tone] ?? 'neutral'}>{finding.tone}</Pill>
                      <span>{finding.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <footer className="rpt__foot">
          <span className="rpt__file mono">{report ? reportFilename(report) : ' '}</span>
          <div className="rpt__actions">
            <button type="button" className="ws-btn" onClick={onClose}>
              cancel
            </button>
            <button
              type="button"
              className="ws-btn"
              onClick={() => produce('open')}
              disabled={!report || Boolean(saving)}
              title="opens the pdf in a new tab, where it can be printed"
            >
              <Icon name="external" size={13} />
              {saving === 'open' ? 'opening…' : 'open to print'}
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={() => produce('download')}
              disabled={!report || Boolean(saving)}
            >
              <Icon name="download" size={13} />
              {saving === 'download' ? 'drawing…' : 'download pdf'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
