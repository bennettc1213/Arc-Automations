/* display formatting, centralised so a number is written the same way everywhere.
   inconsistent formatting reads as carelessness, and carelessness is what makes a
   reader start doubting the numbers themselves. */

import { DateTime } from 'luxon';

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${String(rem).padStart(2, '0')}s`;
}

/* two decimals: a bare "99%" hides the difference between good and broken. */
export function formatUptime(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

export function formatClock(iso, timezone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm:ss');
}

export function formatDayLabel(iso, timezone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('LLL d');
}

/* used only alongside an absolute timestamp, never instead of one. */
export function formatRelative(iso, timezone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toRelative() ?? '';
}

export function formatDate(iso, timezone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('LLL d');
}

export function formatStamp(iso, timezone) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('LLL d · HH:mm:ss');
}

/* thousands separators from ~1,000 up. a four-digit lead count without one reads as a
   different order of magnitude at a glance, and this page is read at a glance. */
export function formatCount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/* one decimal, always signed. the sign is the information — an unsigned "12.6%" next to an
   arrow makes the reader do the work of combining two symbols to learn one fact. */
export function formatPct(pct, digits = 1) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  return `${pct.toFixed(digits)}%`;
}

export function formatSignedPct(pct, digits = 1) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/* phone numbers arrive from carriers in e.164 and are unreadable in it. anything that is
   not a plain us number is returned untouched rather than mangled into a shape it isn't. */
export function formatPhone(raw) {
  if (!raw) return '—';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

/* a duration in human words, for incident lengths and "last run" gaps where a millisecond
   figure is precise about something nobody is measuring in milliseconds. */
export function formatSpan(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function eventLabel(eventType, payload = {}) {
  switch (eventType) {
    case 'lead_received': {
      const via =
        payload.source === 'missed_call'
          ? 'missed call'
          : payload.source === 'web_form'
            ? 'web form'
            : payload.source === 'gbp_message'
              ? 'google message'
              : 'unknown source';
      return `lead received via ${via}`;
    }
    case 'call_missed':
      return 'call missed';
    case 'sms_sent':
      return 'text sent';
    case 'routed':
      return `routed to ${payload.tech ?? 'on-call tech'}`;
    case 'reply_received':
      return 'customer replied';
    default:
      return eventType.replace(/_/g, ' ');
  }
}
