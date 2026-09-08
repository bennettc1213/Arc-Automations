/* csv export for the leads table.
 *
 * a client's own lead history is theirs, and a portal that will not give it back is a
 * hostage situation with a nice chart on it. this runs entirely in the browser against data
 * already loaded, so there is no endpoint to secure and nothing new to get wrong.
 */

import { DateTime } from 'luxon';
import { formatPhone } from './format';

/* excel and sheets both treat a leading =, +, - or @ in a cell as the start of a formula.
   a loss type that begins with a dash is enough to turn an export into a spreadsheet that
   executes something, so those cells are prefixed with a quote. */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  }
  /* crlf: the line ending excel expects, and the one the csv rfc specifies. */
  return lines.join('\r\n');
}

export function threadsToCsv(threads, timezone) {
  return toCsv(
    [
      {
        label: 'received',
        value: (t) =>
          DateTime.fromISO(t.startedAt, { zone: 'utc' }).setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss'),
      },
      { label: 'name', value: (t) => t.name },
      { label: 'phone', value: (t) => formatPhone(t.phone) },
      { label: 'source', value: (t) => t.sourceLabel },
      { label: 'loss type', value: (t) => t.lossType },
      {
        label: 'response seconds',
        value: (t) => (t.latencyMs === null ? '' : (t.latencyMs / 1000).toFixed(1)),
      },
      { label: 'routed to', value: (t) => t.tech },
      { label: 'customer replied', value: (t) => (t.replied ? 'yes' : 'no') },
      { label: 'outcome', value: (t) => t.state },
      { label: 'failure', value: (t) => t.failureReason },
    ],
    threads,
  );
}

export function downloadCsv(filename, csv) {
  /* the bom is what makes excel open a utf-8 csv as utf-8. without it the em dashes in
     "water — burst supply line" arrive as mojibake, which reads as a broken export. */
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  /* revoked on the next tick rather than immediately: firefox cancels an in-flight
     download when the object url disappears in the same frame as the click. */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
