/* ARC-310 — turning a configuration document into form inputs and back.
 *
 * pure, and deliberately dumb about rules: nothing here decides whether a value is allowed.
 * the server validates every draft with the registry's own validator and says what is wrong,
 * by path; this file only converts between what an input holds (a string, a boolean) and the
 * document's own shape, and files the server's errors under the field they belong to.
 *
 * how a field is drawn comes from the server too — `config-scope` sends each field's registry
 * metadata and its layout (`registry/layouts.ts`). a field with no layout is a JSON box.
 */

/* ── one part ─────────────────────────────────────────────── */

/** a day's opening hours as typed: "08:00-12:00, 13:00-17:00". */
export function rangesToText(value) {
  if (!Array.isArray(value)) return '';
  return value.map((r) => `${r?.open ?? ''}-${r?.close ?? ''}`).join(', ');
}

/* anything that does not look like "HH:MM-HH:MM" is passed through as written, so the
   server's validator refuses it with its own words instead of this silently dropping it. */
export function textToRanges(text) {
  return String(text ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((piece) => {
      const match = /^(\S+?)\s*[-–]\s*(\S+)$/.exec(piece);
      return match ? { open: match[1], close: match[2] } : { open: piece, close: '' };
    });
}

export function linesToText(value) {
  return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : '';
}

export function textToLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** what an input shows for a value. */
export function inputFor(control, value) {
  switch (control) {
    case 'toggle':
      return value === true;
    case 'ranges':
      return rangesToText(value);
    case 'lines':
      return linesToText(value);
    case 'number':
      return value === null || value === undefined ? '' : String(value);
    case 'json':
      return value === undefined ? '' : JSON.stringify(value, null, 2);
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/**
 * what a value becomes when an input holds `input`. `original` is the value before editing:
 * an emptied text part goes back to null only if it was null (or absent) — a field the
 * validator keeps as a string stays one.
 *
 * returns `{ value }`, or `{ error }` for input that is not the shape at all (unparseable
 * JSON, a number that is not one). whether the value is allowed is the server's call.
 */
export function valueFrom(control, input, original) {
  switch (control) {
    case 'toggle':
      return { value: input === true };
    case 'ranges':
      return { value: textToRanges(input) };
    case 'lines':
      return { value: textToLines(input) };
    case 'number': {
      const text = String(input ?? '').trim();
      if (text === '') return { value: null };
      const n = Number(text);
      return Number.isFinite(n) ? { value: n } : { error: `"${text}" is not a number` };
    }
    case 'json': {
      try {
        return { value: JSON.parse(String(input ?? '')) };
      } catch {
        return { error: 'not valid JSON' };
      }
    }
    default: {
      const text = String(input ?? '');
      if (text.trim() === '' && (original === null || original === undefined)) return { value: null };
      return { value: text };
    }
  }
}

/* ── a whole field ────────────────────────────────────────── */

/** how a top-level field is drawn: 'parts', 'lines', 'records', a simple control, or 'json'. */
export function fieldKind(field) {
  const layout = field.layout;
  if (layout?.parts) return 'parts';
  if (layout?.items === 'text') return 'lines';
  if (layout?.items?.columns) return 'records';
  if (['text', 'textarea', 'number', 'toggle', 'select'].includes(field.control)) return field.control;
  return 'json';
}

const partControl = (part) => (part.control === 'select' ? 'text' : part.control);

/** the form's state for a document: per field, what its inputs hold. */
export function inputsFor(fields, doc) {
  const out = {};
  for (const field of fields) {
    const value = doc?.[field.key];
    switch (fieldKind(field)) {
      case 'parts':
        out[field.key] = Object.fromEntries(field.layout.parts.map((part) => [part.key, inputFor(partControl(part), value?.[part.key])]));
        break;
      case 'lines':
        out[field.key] = linesToText(value);
        break;
      case 'records':
        out[field.key] = (Array.isArray(value) ? value : []).map((row) =>
          Object.fromEntries(field.layout.items.columns.map((c) => [c.key, row?.[c.key] ?? ''])),
        );
        break;
      case 'select':
      case 'text':
      case 'textarea':
        out[field.key] = inputFor('text', value);
        break;
      case 'number':
      case 'toggle':
        out[field.key] = inputFor(field.control, value);
        break;
      default:
        out[field.key] = inputFor('json', value);
    }
  }
  return out;
}

/** an empty row for a records list: the first option of each closed column, blanks elsewhere. */
export function blankRecord(field) {
  return Object.fromEntries(field.layout.items.columns.map((c) => [c.key, c.options?.[0] ?? '']));
}

/**
 * the document the inputs describe. fields the operator may not edit keep their value from
 * `base`, whatever the inputs say. `errors` lists input that is not even the right shape, by
 * field, so it can be shown before anything is sent.
 */
export function documentFrom(fields, inputs, base) {
  const doc = { ...(base ?? {}) };
  const errors = {};
  const fail = (key, part, message) => (errors[key] ??= []).push({ part, message });
  for (const field of fields) {
    if (!field.editable) continue;
    const raw = inputs[field.key];
    const original = base?.[field.key];
    switch (fieldKind(field)) {
      case 'parts': {
        const next = { ...(original && typeof original === 'object' ? original : {}) };
        for (const part of field.layout.parts) {
          const result = valueFrom(partControl(part), raw?.[part.key], original?.[part.key]);
          if (result.error) fail(field.key, part.key, result.error);
          else next[part.key] = result.value;
        }
        doc[field.key] = next;
        break;
      }
      case 'lines':
        doc[field.key] = textToLines(raw);
        break;
      case 'records':
        /* an empty cell is null, so "name" can be left blank and "address" is refused by the
           server as missing rather than accepted as an empty string. */
        doc[field.key] = (raw ?? []).map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : v])),
        );
        break;
      default: {
        const kind = fieldKind(field);
        const control = kind === 'json' ? 'json' : kind === 'number' || kind === 'toggle' ? kind : 'text';
        const result = valueFrom(control, raw, original);
        if (result.error) fail(field.key, null, result.error);
        else doc[field.key] = result.value;
      }
    }
  }
  return { doc, errors };
}

/** the fields whose value differs from the document the draft was loaded with. */
export function changedFields(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).sort();
}

/** the patch a save sends: only what changed, whole top-level fields. */
export function patchFor(before, after) {
  return Object.fromEntries(changedFields(before, after).map((key) => [key, after[key]]));
}

/* ── the server's errors, filed by field ──────────────────── */

/**
 * `field_errors` from the server, as { field → [{ part, message }] }, plus the ones that name
 * no field (`''`) under `_document`.
 */
export function errorsByField(fieldErrors) {
  const out = {};
  for (const error of fieldErrors ?? []) {
    const path = error?.path ?? '';
    const [field, ...rest] = path.split(/[.[\]]+/).filter(Boolean);
    const key = field || '_document';
    const part = rest.find((segment) => !/^\d+$/.test(segment)) ?? null;
    (out[key] ??= []).push({ part, path, message: error?.message ?? String(error) });
  }
  return out;
}

/* ── words ────────────────────────────────────────────────── */

/** the registry's consequences for a field, as short labels. */
export function consequenceLabels(field) {
  const out = [];
  if (field.requires_reactivation) out.push('pauses a live module');
  else if (field.requires_shadow) out.push('needs shadow review');
  else if (field.requires_retest) out.push('needs a retest');
  return out;
}

/** a value for a comparison table: short, and never an object dump. */
export function describeValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return JSON.stringify(value);
}
