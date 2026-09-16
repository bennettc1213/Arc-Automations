import { jsPDF } from 'jspdf';
import {
  formatCount,
  formatDuration,
  formatPct,
  formatPhone,
  formatSignedPct,
  formatSpan,
  formatUptime,
} from './format.js';
import { formatMoney } from './integrations.js';

/* a report, drawn as a pdf.
 *
 * vector throughout — text is text and bars are rectangles — so it prints sharp,
 * stays a few hundred kilobytes, and a figure can be selected and pasted out of it.
 * a screenshot of the dashboard would be none of those.
 *
 * the look is the portal's, turned to paper: the dark band and orange rule of the
 * workspace on the cover, then white pages, because this gets printed and ink on a
 * black page is a toner cartridge. the same two rules carry over. orange is the
 * client's own number and nothing else. status is never colour alone — every tone
 * is a shape (square, triangle, circle) next to a word, so a greyscale printout
 * still says which rows need looking at.
 *
 * this module only draws. every figure arrives already derived in the report
 * object from report.js, and nothing here computes a number the dashboard does not.
 */

const W = 612;
const H = 792;
const M = 46;
const CW = W - M * 2;
const TOP = 64;
const BOTTOM = 58;

const C = {
  ink: '#141416',
  body: '#3a3a40',
  muted: '#6b6b73',
  faint: '#9a9aa1',
  line: '#e6e4df',
  lineStrong: '#cfccc5',
  panel: '#f6f5f2',
  track: '#eeece7',
  dark: '#0a0a0b',
  accent: '#ff4d00',
  accentSoft: '#ffb793',
  /* the screen's status colours are tuned for a black background and wash out on
     white paper. same hues, darkened until they hold up in print. */
  ok: '#16915a',
  warn: '#c48600',
  fail: '#d32a55',
  idle: '#b9b7b1',
};

export const REPORT_FONT_FILES = [
  { file: 'ArcReportSans-Regular.ttf', role: 'sans' },
  { file: 'ArcReportSans-Medium.ttf', role: 'sansMedium' },
  { file: 'ArcReportSans-Bold.ttf', role: 'sansBold' },
  { file: 'ArcReportMono-Regular.ttf', role: 'mono' },
  { file: 'ArcReportMono-Medium.ttf', role: 'monoMedium' },
];

const FALLBACK_FONTS = {
  sans: ['helvetica', 'normal'],
  sansMedium: ['helvetica', 'bold'],
  sansBold: ['helvetica', 'bold'],
  mono: ['courier', 'normal'],
  monoMedium: ['courier', 'bold'],
};

const STYLES = {
  eyebrow: { font: 'monoMedium', size: 7, color: C.faint, space: 0.7 },
  label: { font: 'mono', size: 6.8, color: C.faint },
  mono: { font: 'mono', size: 7.6, color: C.muted },
  body: { font: 'sans', size: 9.8, color: C.body, leading: 14.2 },
  small: { font: 'sans', size: 8.2, color: C.muted, leading: 11.8 },
  lead: { font: 'sansMedium', size: 14.5, color: C.ink, leading: 19.5 },
  h2: { font: 'sansBold', size: 13, color: C.ink },
  kpi: { font: 'sansBold', size: 20, color: C.ink },
  stat: { font: 'sansBold', size: 15, color: C.ink },
  cell: { font: 'sans', size: 8.6, color: C.body, leading: 11.4 },
  cellStrong: { font: 'sansMedium', size: 8.6, color: C.ink, leading: 11.4 },
  cellMono: { font: 'mono', size: 7.6, color: C.body, leading: 11.4 },
};

/* the built-in pdf fonts only cover the windows-1252 set. used only when the brand
   fonts failed to load, so a report still comes out rather than an error. */
const ASCII_SWAPS = [
  [/[–—−]/g, '-'],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, '...'],
  [/→/g, '->'],
  [/✓/g, 'v'],
];

const TONE_OF = {
  good: 'ok',
  ok: 'ok',
  alert: 'fail',
  fail: 'fail',
  watch: 'warn',
  warn: 'warn',
  idle: 'idle',
  info: 'neutral',
  neutral: 'neutral',
};

const DECLARED_TONE = { connected: 'ok', planned: 'neutral', paused: 'warn', retired: 'idle' };
const LIVENESS_TONE = { live: 'ok', flaky: 'warn', stale: 'fail', silent: 'idle', unmatched: 'neutral' };
const THREAD_TONE = {
  'send failed': 'fail',
  replied: 'ok',
  routed: 'neutral',
  answered: 'neutral',
  received: 'idle',
};

const LEAD_LOG_LIMIT = 1000;

/* ── the drawing surface ─────────────────────────────────── */

function createWriter(doc, fonts) {
  const unicode = Boolean(fonts);
  const faces = {};

  if (unicode) {
    for (const entry of REPORT_FONT_FILES) {
      doc.addFileToVFS(entry.file, fonts[entry.file]);
      doc.addFont(entry.file, entry.role, 'normal');
      faces[entry.role] = [entry.role, 'normal'];
    }
  } else {
    Object.assign(faces, FALLBACK_FONTS);
  }

  const clean = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return unicode ? text : ASCII_SWAPS.reduce((out, [from, to]) => out.replace(from, to), text);
  };

  const w = {
    doc,
    y: TOP,

    use(styleName, overrides = {}) {
      const style = { ...STYLES[styleName], ...overrides };
      const [family, variant] = faces[style.font];
      doc.setFont(family, variant);
      doc.setFontSize(style.size);
      doc.setTextColor(style.color);
      doc.setCharSpace(style.space ?? 0);
      return style;
    },

    text(value, x, y, options = {}) {
      doc.text(clean(value), x, y, { baseline: 'top', ...options });
    },

    width(value) {
      return doc.getTextWidth(clean(value));
    },

    wrap(value, width, styleName, overrides) {
      w.use(styleName, overrides);
      return String(value ?? '')
        .split('\n')
        .flatMap((paragraph) => doc.splitTextToSize(clean(paragraph), width));
    },

    fill(color, x, y, width, height) {
      doc.setFillColor(color);
      doc.rect(x, y, width, height, 'F');
    },

    rule(y, color = C.line, from = M, to = W - M, weight = 0.6) {
      doc.setDrawColor(color);
      doc.setLineWidth(weight);
      doc.line(from, y, to, y);
    },

    /* a tone as a shape. `x, y` is the top-left of a `size` box, so a glyph lines
       up with the cap height of the text set beside it. */
    glyph(tone, x, y, size = 6) {
      const kind = TONE_OF[tone] ?? 'neutral';
      if (kind === 'ok') {
        w.fill(C.ok, x, y, size, size);
      } else if (kind === 'warn') {
        doc.setFillColor(C.warn);
        doc.triangle(x, y + size, x + size / 2, y - 0.4, x + size, y + size, 'F');
      } else if (kind === 'fail') {
        doc.setFillColor(C.fail);
        doc.circle(x + size / 2, y + size / 2, size / 2, 'F');
      } else if (kind === 'idle') {
        doc.setDrawColor(C.idle);
        doc.setLineWidth(0.9);
        doc.rect(x + 0.45, y + 0.45, size - 0.9, size - 0.9, 'S');
      } else {
        w.fill(C.faint, x + size * 0.3, y + size * 0.3, size * 0.4, size * 0.4);
      }
    },

    ensure(height) {
      if (w.y + height > H - BOTTOM) w.page();
    },

    page() {
      doc.addPage();
      w.y = TOP;
    },
  };

  return w;
}

/* round numbers for a chart's top gridline, with an integer halfway line. */
function niceCeil(value) {
  if (value <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value && Number.isInteger(candidate / 2)) return candidate;
  }
  return 10 * magnitude;
}

/* ── building blocks ─────────────────────────────────────── */

function paragraph(w, value, styleName = 'body', { x = M, width = CW, after = 0, color } = {}) {
  const lines = w.wrap(value, width, styleName, color ? { color } : undefined);
  const style = STYLES[styleName];
  for (const line of lines) {
    w.ensure(style.leading);
    w.use(styleName, color ? { color } : undefined);
    w.text(line, x, w.y);
    w.y += style.leading;
  }
  w.y += after;
}

function sectionHead(w, index, title, note, keepWith = 60) {
  w.ensure(46 + keepWith);
  w.y += 14;
  w.rule(w.y, C.lineStrong);
  w.y += 12;

  w.use('eyebrow', { color: C.accent });
  w.text(String(index).padStart(2, '0'), M, w.y + 3);

  w.use('h2');
  w.text(title, M + 22, w.y);

  if (note) {
    w.use('mono', { color: C.faint });
    w.text(note, W - M, w.y + 3, { align: 'right' });
  }
  w.y += 26;
}

function caption(w, value, after = 4) {
  paragraph(w, value, 'small', { after });
}

/**
 * horizontal bars: a label, a track, a value. used for sources, routing and the
 * response buckets — three readouts that are all "how the total split up".
 */
function hbars(w, rows, { x = M, width = CW, labelWidth = 120, valueWidth = 84, color = C.accent, labelStyle = 'cell' } = {}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const trackX = x + labelWidth;
  const trackW = width - labelWidth - valueWidth - 10;
  const rowH = 17;

  for (const row of rows) {
    w.ensure(rowH);
    w.use(labelStyle);
    const [label] = w.wrap(row.label, labelWidth - 8, labelStyle);
    w.use(labelStyle);
    w.text(label, x, w.y + 3);

    w.fill(C.track, trackX, w.y + 5.5, trackW, 6);
    if (row.value > 0) w.fill(color, trackX, w.y + 5.5, Math.max(1.5, (trackW * row.value) / max), 6);

    w.use('mono');
    w.text(row.text, x + width, w.y + 4, { align: 'right' });
    w.y += rowH;
  }
}

/**
 * a table that breaks across pages and repeats its header when it does.
 *
 * one column may leave its width unset and takes whatever is left. a cell can carry
 * a tone, drawn as a glyph before its text, so a status column reads the same way
 * a pill does on screen. cells wrap rather than truncate: a truncated failure
 * reason is a failure reason nobody can act on.
 */
function table(w, columns, rows, { empty } = {}) {
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const flex = columns.filter((column) => !column.width).length || 1;
  const widths = columns.map((column) => column.width ?? (CW - fixed) / flex);
  const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((sum, v) => sum + v, 0));
  const PAD = 6;

  const header = () => {
    w.use('label');
    columns.forEach((column, i) => {
      const right = column.align === 'right';
      const x = right ? xs[i] + widths[i] - (i === columns.length - 1 ? 0 : PAD) : xs[i] + (i === 0 ? 0 : PAD);
      w.text(column.label, x, w.y, right ? { align: 'right' } : undefined);
    });
    w.y += 13;
    w.rule(w.y, C.lineStrong);
  };

  w.ensure(64);
  header();

  if (rows.length === 0) {
    w.y += 8;
    paragraph(w, empty ?? 'nothing in this period.', 'small', { after: 2 });
    return;
  }

  for (const row of rows) {
    const cells = columns.map((column, i) => {
      const styleName = typeof column.style === 'function' ? column.style(row) : (column.style ?? 'cell');
      const tone = column.tone ? column.tone(row) : null;
      const inner = widths[i] - (i === 0 ? PAD : PAD * 2) - (tone ? 11 : 0);
      const lines = w.wrap(column.value(row), Math.max(20, inner), styleName);
      return { styleName, tone, lines };
    });

    const leading = STYLES.cell.leading;
    const height = Math.max(...cells.map((cell) => cell.lines.length)) * leading + 10;

    if (w.y + height > H - BOTTOM) {
      w.page();
      header();
    }

    cells.forEach((cell, i) => {
      const column = columns[i];
      const right = column.align === 'right';
      let x = right ? xs[i] + widths[i] - (i === columns.length - 1 ? 0 : PAD) : xs[i] + (i === 0 ? 0 : PAD);

      if (cell.tone) {
        w.glyph(cell.tone, x, w.y + 6.6, 5.4);
        x += 11;
      }
      cell.lines.forEach((line, lineIndex) => {
        w.use(cell.styleName);
        w.text(line, x, w.y + 5 + lineIndex * leading, right ? { align: 'right' } : undefined);
      });
    });

    w.y += height;
    w.rule(w.y);
  }
}

/* ── the cover ───────────────────────────────────────────── */

function cover(w, report, { preparedFor }) {
  const { doc } = w;
  const internal = report.audience === 'internal';
  const bandH = 212;

  w.fill(C.dark, 0, 0, W, bandH);
  w.fill(C.accent, 0, bandH, W, 3);

  w.fill(C.accent, M, 42, 6, 6);
  w.use('eyebrow', { color: '#ededef', space: 1.1, size: 7.6 });
  w.text('arc automations', M + 13, 41);

  w.use('mono', { color: internal ? C.accent : '#8d8d95' });
  w.text(internal ? 'internal report — arc only' : 'performance report', W - M, 41.5, { align: 'right' });

  /* long names step down rather than run off the band. */
  let nameSize = 28;
  let nameLines = w.wrap(report.tenant.name, CW, 'kpi', { size: nameSize });
  if (nameLines.length > 1) {
    nameSize = 21;
    nameLines = w.wrap(report.tenant.name, CW, 'kpi', { size: nameSize }).slice(0, 2);
  }
  let y = nameLines.length > 1 ? 78 : 92;
  for (const line of nameLines) {
    w.use('kpi', { size: nameSize, color: '#f4f4f5' });
    w.text(line, M, y);
    y += nameSize * 1.12;
  }

  w.use('body', { size: 12, color: '#c9c9cf' });
  w.text(`${report.period.title}  ·  ${report.period.range}`, M, y + 8);

  const meta = [
    report.tenant.clientId,
    preparedFor ? `prepared for ${preparedFor}` : null,
    `prepared ${report.generatedLabel}`,
    report.tenant.timezone.toLowerCase(),
  ].filter(Boolean);
  w.use('mono', { color: '#7c7c84', size: 7.2 });
  w.text(meta.join('   ·   '), M, 184);

  doc.setCharSpace(0);
  w.y = bandH + 30;
}

function headlineBlock(w, report) {
  paragraph(w, report.headline, 'lead', { after: 14 });
}

function tiles(w, report, { compare }) {
  const { totals, deltas, failures } = report;
  const gap = 10;
  const tileW = (CW - gap * 2) / 3;
  const tileH = 80;

  const items = [
    { label: 'leads', value: formatCount(totals.leads), delta: deltas.leads },
    {
      label: 'median first reply',
      value: formatDuration(totals.medianResponseMs),
      delta: deltas.medianResponseMs,
      sub:
        totals.p90ResponseMs === null
          ? 'no texts sent'
          : `9 in 10 within ${formatDuration(totals.p90ResponseMs)}`,
    },
    {
      label: 'missed calls answered',
      value: formatCount(totals.missedCallsAnswered),
      delta: deltas.missedCallsAnswered,
    },
    {
      label: 'texts sent',
      value: formatCount(totals.sends),
      delta: deltas.sends,
      sub: failures.count > 0 ? `${formatCount(failures.count)} failed to send` : null,
    },
    {
      label: 'customers wrote back',
      value: formatCount(totals.replied),
      sub: totals.leadThreads > 0 ? `of ${formatCount(totals.leadThreads)} leads` : null,
    },
    {
      label: 'end-to-end checks passed',
      value: formatUptime(totals.uptimePct),
      sub:
        totals.checks > 0
          ? `${formatCount(totals.checks - totals.checksFailed)} of ${formatCount(totals.checks)}`
          : 'none recorded',
    },
  ];

  w.ensure(tileH * 2 + gap + 30);
  const top = w.y;

  items.forEach((item, i) => {
    const x = M + (i % 3) * (tileW + gap);
    const y = top + Math.floor(i / 3) * (tileH + gap);
    w.fill(C.panel, x, y, tileW, tileH);
    if (i === 0) w.fill(C.accent, x, y, 2, tileH);

    w.use('label');
    w.text(item.label, x + 12, y + 11);

    w.use('kpi', i === 0 ? { color: C.accent } : undefined);
    w.text(item.value, x + 12, y + 25);

    let lineY = y + 53;
    /* when nothing is comparable the caption under the grid says so once, rather
       than six tiles saying it six times. */
    if (compare && report.comparable && item.delta) {
      const { pct, good, direction } = item.delta;
      if (pct === null) {
        w.use('label');
        w.text('no earlier figure', x + 12, lineY);
      } else {
        const color = good === null ? C.faint : good ? C.ok : C.fail;
        w.doc.setFillColor(color);
        if (direction === 'up') {
          w.doc.triangle(x + 12, lineY + 6.4, x + 15.2, lineY + 0.6, x + 18.4, lineY + 6.4, 'F');
        } else if (direction === 'down') {
          w.doc.triangle(x + 12, lineY + 0.6, x + 15.2, lineY + 6.4, x + 18.4, lineY + 0.6, 'F');
        } else {
          w.fill(color, x + 12, lineY + 3, 6.4, 1);
        }
        w.use('mono', { color });
        w.text(formatSignedPct(pct), x + 23, lineY);
      }
      lineY += 12;
    }
    if (item.sub) {
      w.use('label', { color: C.muted });
      w.text(item.sub, x + 12, lineY);
    }
  });

  w.y = top + tileH * 2 + gap + 10;

  if (compare) {
    caption(
      w,
      report.comparable
        ? `changes are measured ${report.period.compareLabel}. arrows are green where the change is an improvement — a faster reply is an arrow down.`
        : 'no changes are shown: the data does not cover a complete earlier period of the same length, and a percentage against a half-empty window would be invented.',
      6,
    );
  }
}

function summary(w, report) {
  w.ensure(60);
  w.y += 8;
  w.use('eyebrow');
  w.text('summary', M, w.y);
  w.y += 16;

  for (const finding of report.findings) {
    const lines = w.wrap(finding.text, CW - 18, 'body');
    w.ensure(lines.length * STYLES.body.leading + 4);
    w.glyph(finding.tone, M, w.y + 3.6, 6);
    lines.forEach((line, i) => {
      w.use('body');
      w.text(line, M + 18, w.y + i * STYLES.body.leading);
    });
    w.y += lines.length * STYLES.body.leading + 5;
  }
}

function noteBlock(w, note) {
  const lines = w.wrap(note, CW - 30, 'body');
  const height = lines.length * STYLES.body.leading + 38;
  w.ensure(Math.min(height, 200));
  w.y += 10;

  /* a note long enough to cross a page is drawn without its panel rather than as
     a box split in two. */
  const boxed = w.y + height <= H - BOTTOM;
  if (boxed) {
    w.fill(C.panel, M, w.y, CW, height);
    w.fill(C.accent, M, w.y, 2, height);
  }

  w.use('eyebrow');
  w.text('a note from arc', M + 15, w.y + 12);
  w.y += 28;
  for (const line of lines) {
    w.ensure(STYLES.body.leading);
    w.use('body', { color: C.ink });
    w.text(line, M + 15, w.y);
    w.y += STYLES.body.leading;
  }
  w.y += 12;
}

/* ── sections ────────────────────────────────────────────── */

function volumeSection(w, report, index) {
  const { rows, bucket } = report.volume;
  const total = report.totals.leads;
  sectionHead(
    w,
    index,
    'lead volume',
    `${formatCount(total)} ${total === 1 ? 'lead' : 'leads'} · per ${bucket}`,
    150,
  );

  const chartH = 118;
  const axisW = 26;
  const x0 = M + axisW;
  const chartW = CW - axisW;
  const peak = Math.max(0, ...rows.map((row) => row.leads));
  const max = niceCeil(Math.max(1, peak));
  const top = w.y;

  for (const value of [0, max / 2, max]) {
    const gy = top + chartH - (value / max) * chartH;
    w.rule(gy, value === 0 ? C.lineStrong : C.line, x0, W - M, 0.5);
    w.use('label');
    w.text(formatCount(value), x0 - 6, gy - 3.4, { align: 'right' });
  }

  const slot = chartW / rows.length;
  const barW = Math.max(0.8, Math.min(slot * 0.66, 20));
  rows.forEach((row, i) => {
    if (row.leads === 0) return;
    const h = (row.leads / max) * chartH;
    w.fill(row.partial ? C.accentSoft : C.accent, x0 + i * slot + (slot - barW) / 2, top + chartH - h, barW, h);
  });

  w.y = top + chartH + 6;
  w.use('label');
  const prefix = bucket === 'week' ? 'week of ' : '';
  w.text(`${prefix}${rows[0].label}`, x0, w.y);
  if (rows.length > 1) w.text(`${prefix}${rows[rows.length - 1].label}`, W - M, w.y, { align: 'right' });
  if (rows.length > 4) {
    const mid = rows[Math.floor(rows.length / 2)];
    w.text(`${prefix}${mid.label}`, x0 + Math.floor(rows.length / 2) * slot + slot / 2, w.y, { align: 'center' });
  }
  w.y += 18;

  if (total === 0) {
    caption(w, 'no leads came through in this period.');
    return;
  }

  const busiest = rows.reduce((best, row) => (row.leads > best.leads ? row : best), rows[0]);
  const partial = rows.some((row) => row.partial);
  caption(
    w,
    `busiest ${bucket}: ${prefix}${busiest.label}, with ${formatCount(busiest.leads)} ${busiest.leads === 1 ? 'lead' : 'leads'}.` +
      (partial
        ? ` lighter bars are ${bucket === 'week' ? 'weeks' : 'days'} the period only partly covers, so they are short by design.`
        : ''),
  );
}

function speedSection(w, report, index) {
  const { totals, responseBuckets } = report;
  sectionHead(w, index, 'response speed', `${formatCount(totals.sends)} texts`, 90);

  if (totals.sends === 0) {
    caption(w, 'no texts went out in this period, so there is no response time to report.');
    return;
  }

  const top = w.y;
  const leftW = 318;
  hbars(
    w,
    responseBuckets.map((bucket) => ({
      label: bucket.label,
      value: bucket.count,
      text: `${formatCount(bucket.count)} · ${formatPct((bucket.count / totals.sends) * 100, 0)}`,
    })),
    { width: leftW, labelWidth: 54, valueWidth: 70, labelStyle: 'cellMono' },
  );
  const leftEnd = w.y;

  const statX = M + leftW + 34;
  let y = top;
  for (const [label, value] of [
    ['median first reply', formatDuration(totals.medianResponseMs)],
    ['9 in 10 within', formatDuration(totals.p90ResponseMs)],
  ]) {
    w.use('label');
    w.text(label, statX, y);
    w.use('stat');
    w.text(value, statX, y + 10);
    y += 36;
  }

  w.y = Math.max(leftEnd, y) + 4;
  caption(
    w,
    'time from the lead arriving to the first text leaving, for every text that went out successfully. a failed send is not counted as a fast one.',
  );
}

function sourcesSection(w, report, index) {
  const { sources } = report;
  const total = sources.reduce((sum, row) => sum + row.count, 0);
  sectionHead(w, index, 'where leads came from', `${formatCount(total)} leads`, 60);

  if (sources.length === 0) {
    caption(w, 'no leads came in, so there is nothing to split by source.');
    return;
  }

  hbars(
    w,
    sources.map((row) => ({
      label: row.label,
      value: row.count,
      text: `${formatCount(row.count)} · ${formatPct(row.pct, 0)}`,
    })),
  );
}

function timingSection(w, report, index) {
  const { hourly } = report;
  sectionHead(w, index, 'when leads arrived', 'hour of day', 120);

  if (hourly.total === 0) {
    caption(w, 'no leads came in, so there is no time of day to show.');
    return;
  }

  const chartH = 84;
  const axisW = 26;
  const x0 = M + axisW;
  const chartW = CW - axisW;
  const max = niceCeil(Math.max(1, ...hourly.hours.map((hour) => hour.count)));
  const top = w.y;

  for (const value of [0, max / 2, max]) {
    const gy = top + chartH - (value / max) * chartH;
    w.rule(gy, value === 0 ? C.lineStrong : C.line, x0, W - M, 0.5);
    w.use('label');
    w.text(formatCount(value), x0 - 6, gy - 3.4, { align: 'right' });
  }

  const slot = chartW / 24;
  const barW = slot * 0.62;
  for (const { hour, count } of hourly.hours) {
    const afterHours = hour < 7 || hour >= 18;
    if (count > 0) {
      const h = (count / max) * chartH;
      w.fill(afterHours ? C.accent : C.lineStrong, x0 + hour * slot + (slot - barW) / 2, top + chartH - h, barW, h);
    }
    if (hour % 6 === 0 || hour === 23) {
      w.use('label');
      w.text(String(hour).padStart(2, '0'), x0 + hour * slot + slot / 2, top + chartH + 6, { align: 'center' });
    }
  }

  w.y = top + chartH + 22;
  caption(
    w,
    hourly.afterHours > 0
      ? `${formatCount(hourly.afterHours)} of ${formatCount(hourly.total)} leads (${formatPct(hourly.afterHoursPct, 0)}) arrived between 18:00 and 07:00, drawn in orange — the hours nobody is at a desk. hours are ${report.tenant.timezone.toLowerCase()}.`
      : `every lead arrived between 07:00 and 18:00. hours are ${report.tenant.timezone.toLowerCase()}.`,
  );
}

function routingSection(w, report, index) {
  const { routing } = report;
  sectionHead(w, index, 'who the work went to', `${formatCount(report.totals.routed)} routed`, 60);

  if (routing.length === 0) {
    caption(w, 'no lead was routed to a tech in this period.');
    return;
  }

  hbars(
    w,
    routing.map((row) => ({
      label: row.tech,
      value: row.count,
      text: `${formatCount(row.count)} · ${formatPct(row.pct, 0)}`,
    })),
    { color: C.ink },
  );
  w.y += 2;
  caption(w, 'counted from the routing step: who each lead was sent to, not who ended up doing the job.');
}

function automationsSection(w, report, index) {
  const internal = report.audience === 'internal';
  sectionHead(w, index, 'automations', `${formatCount(report.automations.length)} ran`, 60);

  table(
    w,
    [
      {
        label: 'automation',
        style: 'cellStrong',
        value: (row) => (row.kind === 'monitoring' ? `${row.name}  (monitoring)` : row.name),
      },
      { label: 'runs', width: 50, align: 'right', style: 'cellMono', value: (row) => formatCount(row.runs) },
      {
        label: 'failed',
        width: 50,
        align: 'right',
        style: 'cellMono',
        value: (row) => formatCount(row.failures),
      },
      {
        label: 'succeeded',
        width: 62,
        align: 'right',
        style: 'cellMono',
        value: (row) => formatPct(row.successPct),
      },
      {
        label: 'median step',
        width: 66,
        align: 'right',
        style: 'cellMono',
        value: (row) => formatDuration(row.medianLatencyMs),
      },
      {
        label: 'last run',
        width: 92,
        align: 'right',
        style: 'cellMono',
        value: (row) =>
          row.lastRunAt
            ? new Date(row.lastRunAt)
                .toLocaleString('en-US', {
                  timeZone: report.tenant.timezone,
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                })
                .toLowerCase()
            : '—',
      },
    ],
    report.automations,
    { empty: 'no automation ran in this period.' },
  );

  w.y += 6;
  caption(
    w,
    internal
      ? 'a run is one execution, however many rows it wrote. monitoring rows are the canary that tests the pipeline; the client report leaves them out.'
      : 'a run is one execution of the workflow, however many steps it took.',
  );
}

function reliabilitySection(w, report, index) {
  const { totals, incidents, volume } = report;
  const days = volume.bucket === 'day' ? volume.daily : volume.rows;
  const unit = volume.bucket;

  sectionHead(
    w,
    index,
    'reliability & incidents',
    totals.checks > 0 ? `${formatUptime(totals.uptimePct)} passed` : 'no checks recorded',
    90,
  );

  const gap = days.length > 60 ? 1 : 1.6;
  const cell = (CW - gap * (days.length - 1)) / days.length;
  const top = w.y;
  days.forEach((day, i) => {
    const color = day.failures > 0 ? C.fail : day.checks > 0 ? C.ok : C.track;
    w.fill(color, M + i * (cell + gap), top, cell, 12);
  });
  w.y = top + 18;

  w.use('label');
  w.text(`${unit === 'week' ? 'week of ' : ''}${days[0].label}`, M, w.y);
  if (days.length > 1) {
    const stripEnd = M + days.length * (cell + gap) - gap;
    w.text(days[days.length - 1].label, stripEnd, w.y, { align: 'right' });
  }
  w.y += 14;

  /* the legend is what keeps the strip from being colour alone. */
  let x = M;
  for (const [tone, label] of [
    ['ok', `every check passed that ${unit}`],
    ['fail', 'a check failed'],
    ['idle', 'no checks'],
  ]) {
    w.glyph(tone, x, w.y + 1, 5.6);
    w.use('label', { color: C.muted });
    w.text(label, x + 9, w.y);
    x += w.width(label) + 24;
  }
  w.y += 16;

  if (totals.checks > 0) {
    const failedDays = days.filter((day) => day.failures > 0);
    const list = failedDays
      .slice(0, 12)
      .map((day) => `${day.label} (${formatCount(day.failures)})`)
      .join(', ');
    paragraph(
      w,
      `the end-to-end check ran ${formatCount(totals.checks)} times and passed ${formatCount(totals.checks - totals.checksFailed)}.` +
        (failedDays.length > 0
          ? ` failed checks on ${list}${failedDays.length > 12 ? `, and ${failedDays.length - 12} more ${unit}s` : ''}.`
          : ' none failed.'),
      'body',
      { after: 6 },
    );
  } else {
    paragraph(w, 'no end-to-end checks were recorded in this period, so no pass rate is stated.', 'body', {
      after: 6,
    });
  }

  if (incidents.length === 0) {
    caption(w, 'no incidents were raised in this period.');
    return;
  }

  w.y += 4;
  table(
    w,
    [
      {
        label: 'detected',
        width: 86,
        style: 'cellMono',
        value: (row) =>
          new Date(row.firedAt)
            .toLocaleString('en-US', {
              timeZone: report.tenant.timezone,
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })
            .toLowerCase(),
      },
      { label: 'check', width: 96, style: 'cell', value: (row) => row.checkType.replace(/_/g, ' ') },
      { label: 'what happened', value: (row) => row.message ?? '—' },
      { label: 'lasted', width: 62, align: 'right', style: 'cellMono', value: (row) => formatSpan(row.durationMs) },
      {
        label: 'status',
        width: 70,
        tone: (row) => (row.open ? 'fail' : 'ok'),
        value: (row) => (row.open ? 'open' : 'resolved'),
      },
    ],
    incidents,
  );
  w.y += 6;
  caption(
    w,
    'incidents stay on the record once resolved. a failure that was caught, raised and fixed is the monitoring doing its job.',
  );
}

function servicesSection(w, report, index) {
  const internal = report.audience === 'internal';
  const { services } = report;

  sectionHead(
    w,
    index,
    'services & subscriptions',
    services.tracked > 0
      ? `${formatMoney(services.monthlyCents)}/mo${services.estimated ? ' est' : ''}${internal ? '' : ' paid by you'}`
      : `${formatCount(services.rows.length)} recorded`,
    70,
  );

  const columns = [
    {
      label: 'service',
      style: 'cellStrong',
      value: (row) =>
        [row.service, row.label !== row.service ? row.label : null, row.account]
          .filter(Boolean)
          .join('\n'),
    },
    {
      label: 'status',
      width: 70,
      tone: (row) => DECLARED_TONE[row.declared] ?? 'neutral',
      value: (row) => row.declared,
    },
  ];

  if (internal) {
    columns.push({
      label: 'sending',
      width: 84,
      tone: (row) => (row.liveness ? (LIVENESS_TONE[row.liveness.state] ?? 'neutral') : null),
      value: (row) => row.liveness?.label ?? '—',
    });
  }

  columns.push(
    {
      label: 'subscription',
      width: internal ? 112 : 150,
      tone: (row) => row.billing.tone,
      value: (row) => row.billing.label,
    },
    {
      label: 'paid by',
      width: 50,
      value: (row) => (row.paidBy === 'arc' ? 'arc' : row.paidBy === 'client' ? internal ? 'client' : 'you' : '—'),
    },
    { label: 'cost', width: 62, align: 'right', style: 'cellMono', value: (row) => row.cost },
  );

  table(w, columns, services.rows, {
    empty: 'no services are recorded for this client yet.',
  });

  w.y += 6;
  if (services.tracked > 0) {
    paragraph(
      w,
      internal
        ? `tracked subscriptions come to ${formatMoney(services.monthlyCents)} a month${services.estimated ? ', usage-based plans estimated' : ''}: arc pays ${formatMoney(services.arcCents)} and the client pays ${formatMoney(services.clientCents)}. annual plans are spread across twelve months.`
        : `the services you pay for directly come to about ${formatMoney(services.clientCents)} a month${services.estimated ? ', with usage-based plans estimated' : ''}. anything marked covered is included in your arc plan.`,
      'body',
      { after: 4 },
    );
  }

  const renewing = services.rows.filter((row) => row.renews);
  if (renewing.length > 0) {
    paragraph(
      w,
      `next renewals: ${renewing.map((row) => `${row.service} ${row.renews}`).join('; ')}.`,
      'small',
      { after: 4 },
    );
  }

  caption(
    w,
    'subscription details are recorded by arc rather than read from each provider. a renewal date that has passed means the charge should be confirmed, not that the service stopped.',
  );
}

function leadLogSection(w, report, index) {
  const rows = report.leadLog;
  sectionHead(w, index, 'lead log', `${formatCount(rows.length)} leads · oldest first`, 60);

  table(
    w,
    [
      { label: 'received', width: 70, style: 'cellMono', value: (row) => row.at },
      { label: 'customer', style: 'cellStrong', value: (row) => row.name ?? '—' },
      { label: 'phone', width: 86, style: 'cellMono', value: (row) => formatPhone(row.phone) },
      { label: 'source', width: 86, value: (row) => row.source },
      {
        label: 'reply',
        width: 44,
        align: 'right',
        style: 'cellMono',
        value: (row) => formatDuration(row.latencyMs),
      },
      {
        label: 'outcome',
        width: 78,
        tone: (row) => THREAD_TONE[row.state] ?? 'neutral',
        value: (row) => row.state,
      },
    ],
    rows.slice(0, LEAD_LOG_LIMIT),
    { empty: 'no leads came in during this period.' },
  );

  if (rows.length > LEAD_LOG_LIMIT) {
    w.y += 6;
    caption(
      w,
      `the first ${formatCount(LEAD_LOG_LIMIT)} of ${formatCount(rows.length)} leads are listed. the full log exports as a csv from the portal.`,
    );
  }
}

function methodSection(w, report, index) {
  sectionHead(w, index, 'how to read this report', null, 60);
  const notes = [...report.method, `all dates and times are ${report.tenant.timezone.toLowerCase()}.`];
  for (const note of notes) {
    const lines = w.wrap(note, CW - 14, 'small');
    w.ensure(lines.length * STYLES.small.leading + 4);
    w.fill(C.faint, M + 1, w.y + 4.4, 3, 3);
    lines.forEach((line, i) => {
      w.use('small');
      w.text(line, M + 14, w.y + i * STYLES.small.leading);
    });
    w.y += lines.length * STYLES.small.leading + 5;
  }
}

const SECTION_RENDERERS = {
  volume: volumeSection,
  speed: speedSection,
  sources: sourcesSection,
  timing: timingSection,
  routing: routingSection,
  automations: automationsSection,
  reliability: reliabilitySection,
  services: servicesSection,
  leads: leadLogSection,
  method: methodSection,
};

/* ── page furniture, drawn once the page count is known ──── */

function furniture(w, report) {
  const { doc } = w;
  const total = doc.getNumberOfPages();
  const internal = report.audience === 'internal';

  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);

    if (page > 1) {
      w.use('label');
      w.text(`${report.tenant.name} — ${report.period.range}`, M, 30);
      w.text(internal ? 'internal report' : 'performance report', W - M, 30, { align: 'right' });
      w.rule(43, C.line);
    }

    w.rule(H - 38, C.line);
    const suffix = internal ? '  ·  internal — not for the client' : '';
    const pageLabel = `${page} / ${total}`;
    w.use('label');
    const room = CW - w.width(pageLabel) - w.width(suffix) - 18;
    let name = report.tenant.name;
    const leftFor = (value) => `arc automations  ·  ${value}  ·  ${report.period.title}`;
    while (name.length > 4 && w.width(leftFor(name)) > room) name = `${name.slice(0, -2).trimEnd()}…`;
    const left = leftFor(name);
    w.text(left, M, H - 30);
    if (internal) {
      w.use('label', { color: C.accent });
      w.text(suffix, M + w.width(left), H - 30);
    }
    w.use('label');
    w.text(pageLabel, W - M, H - 30, { align: 'right' });
  }
}

/**
 * draws the report and returns the jsPDF document.
 *
 * `fonts` maps each file in REPORT_FONT_FILES to its base64 contents. leave it out
 * and the pdf is set in the built-in helvetica and courier instead — plainer, but
 * a report that will not generate because a font request failed is a worse report.
 */
export function renderReportPdf(report, { sections = [], note = '', preparedFor = '', compare = true, fonts = null } = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  const complete = fonts && REPORT_FONT_FILES.every((entry) => fonts[entry.file]);
  const w = createWriter(doc, complete ? fonts : null);

  const internal = report.audience === 'internal';
  doc.setProperties({
    title: `${report.tenant.name} — ${internal ? 'internal report' : 'performance report'}, ${report.period.range}`,
    subject: `${report.period.title} · ${report.period.range}`,
    author: 'arc automations',
    creator: 'arc ops console',
    keywords: [report.tenant.clientId, report.period.key, report.audience].filter(Boolean).join(', '),
  });

  cover(w, report, { preparedFor: preparedFor.trim() });
  headlineBlock(w, report);
  tiles(w, report, { compare });
  summary(w, report);
  if (note.trim()) noteBlock(w, note.trim());

  let index = 1;
  for (const key of Object.keys(SECTION_RENDERERS)) {
    if (!sections.includes(key)) continue;
    SECTION_RENDERERS[key](w, report, index);
    index += 1;
  }

  furniture(w, report);
  return doc;
}
