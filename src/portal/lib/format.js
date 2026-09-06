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
