/* ARC-380 — scheduling, availability and booking, with no database.
 *
 *   - `booking/model.ts` as plain functions: which times can be offered (opening hours in the
 *     business's own timezone, across a clock change; notice; buffers; capacity), what a
 *     booking page and a booking may hold, whose calendar it is, and what may happen to an
 *     appointment afterwards;
 *   - the real screens rendered to static markup (esbuild, as tests/crm-workspace.test.js does)
 *     over known rows: what a person in the workspace and a member of the public are shown,
 *     what is offered, and what is never printed.
 *
 * The same rules through real SQL are tests/booking-db.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addDays, agendaDays, APPOINTMENT_ACTIONS, APPOINTMENT_STATUSES, APPOINTMENT_TRANSITIONS, appointmentAuthority, availableSlots, bookingEmbedSnippet,
  BOOKING_KEY, BOOKING_LIMITS, bookingMode, bookingUrl, customerChangeDecision, DEFAULT_SETTINGS, defaultPageDefinition, HELD_STATUSES, isOffered,
  localDate, MANAGE_TOKEN, manageUrl, nextActions, overlapCount, parseAppointmentTypeInput, parseChange, parseExternalReport, parseInstant,
  parsePageDefinition, parsePageInput, parseSettingsInput, parseStaffBooking, parseSubmission, serviceAreaDecision, spamVerdict, unavailableReason,
  weekdayOf,
} from '../supabase/functions/_shared/booking/model.ts';
import { effectivePolicy, POLICY_FIELDS, writeDecision } from '../supabase/functions/_shared/crm/model.ts';
import { inboxStates } from '../supabase/functions/_shared/crm/inbox.ts';
import { CRM_ERROR_STATUS } from '../supabase/functions/_shared/crm/service.ts';
import { instantFor } from '../supabase/functions/_shared/engine/hours.ts';
import { glossFor } from '../src/portal/lib/glossary.js';
import { NAV_ITEMS } from '../src/portal/lib/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const TZ = 'America/Denver';
const NINE_TO_FIVE = [{ open: '09:00', close: '17:00' }];
const WEEK = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, NINE_TO_FIVE]));
const ARC = { authority: 'arc', connector_key: null, time_owner: 'arc', status_owner: 'arc' };
const THEIRS = { authority: 'external', connector_key: 'google_calendar', time_owner: 'external', status_owner: 'external' };
const rules = (extra = {}) => ({ timezone: TZ, hours: WEEK, ...DEFAULT_SETTINGS, closed_dates: [], authority: ARC, ...extra });
const VISIT = { duration_minutes: 60, buffer_before_minutes: null, buffer_after_minutes: null };
/* a Monday morning in Denver, well before opening. */
const NOW = new Date('2026-10-05T12:00:00Z'); // 06:00 MDT
const at = (date, time) => instantFor(date, time, TZ).toISOString();
const held = (date, from, to, before = 0, after = 0, id = 'h1') => ({
  id, starts_at: at(date, from), ends_at: at(date, to),
  busy_from: new Date(Date.parse(at(date, from)) - before * 60_000).toISOString(), busy_until: new Date(Date.parse(at(date, to)) + after * 60_000).toISOString(),
});
const slotsOn = (date, extra = {}) => availableSlots({ rules: rules(), type: VISIT, held: [], now: NOW, from: date, days: 1, ...extra });
const times = (slots) => slots.map((s) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(s.starts_at)));

/* ── availability ───────────────────────────────────────── */

describe('the times that can be offered', () => {
  test('inside an open period of an open day, on the grid, and long enough to fit before closing', () => {
    const tuesday = slotsOn('2026-10-06');
    assert.deepEqual(times(tuesday), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00']);
    assert.equal(tuesday[0].starts_at, '2026-10-06T15:00:00.000Z', '09:00 in Denver, in daylight time');
    assert.equal(tuesday.at(-1).ends_at, '2026-10-06T23:00:00.000Z', 'the last one ends at closing, not after it');
    assert.deepEqual(slotsOn('2026-10-10'), [], 'a Saturday with no hours is closed');
    assert.equal(weekdayOf('2026-10-10'), 'sat');
    assert.deepEqual(times(slotsOn('2026-10-06', { rules: rules({ slot_step_minutes: 60 }) })).slice(0, 3), ['09:00', '10:00', '11:00']);
    assert.deepEqual(times(slotsOn('2026-10-06', { type: { ...VISIT, duration_minutes: 480 } })), ['09:00'], 'an all-day job fits once');
    assert.deepEqual(slotsOn('2026-10-06', { type: { ...VISIT, duration_minutes: 481 } }), []);
    /* two periods: nothing is offered across the gap. */
    const split = { ...WEEK, tue: [{ open: '08:00', close: '10:00' }, { open: '13:00', close: '15:00' }] };
    assert.deepEqual(times(slotsOn('2026-10-06', { rules: rules({ hours: split }) })), ['08:00', '08:30', '09:00', '13:00', '13:30', '14:00']);
  });

  test('a booking needs notice, the calendar is only open so far ahead, and a closed day offers nothing', () => {
    /* 06:00 on Monday, two hours' notice: the day's first slot is 09:00 regardless. at 08:30 it is 10:30. */
    assert.equal(times(slotsOn('2026-10-05'))[0], '09:00');
    const later = new Date('2026-10-05T14:30:00Z'); // 08:30 MDT
    assert.equal(times(slotsOn('2026-10-05', { now: later }))[0], '10:30');
    assert.equal(times(slotsOn('2026-10-05', { now: later, rules: rules({ min_lead_minutes: 0 }) }))[0], '09:00');
    assert.deepEqual(slotsOn('2026-10-05', { now: new Date('2026-10-05T23:30:00Z') }), [], 'after closing, today has nothing left');
    assert.deepEqual(slotsOn('2026-10-06', { rules: rules({ closed_dates: ['2026-10-06'] }) }), []);
    assert.ok(slotsOn('2026-11-03').length > 0, '29 days out is open');
    assert.deepEqual(slotsOn('2026-11-05'), [], '31 days out is not');
    assert.equal(slotsOn('2026-10-06', { rules: rules({ max_days_ahead: 1 }) }).length, 0);
    /* one read covers at most a fortnight, whatever is asked. */
    const many = availableSlots({ rules: rules({ max_days_ahead: 365 }), type: VISIT, held: [], now: NOW, from: '2026-10-05', days: 90 });
    assert.equal(new Set(many.map((s) => localDate(new Date(s.starts_at), TZ))).size, 10, 'ten weekdays in fourteen days');
    assert.equal(BOOKING_LIMITS.daysPerRead, 14);
  });

  test('nine is nine on both sides of a clock change; an hour that does not exist is not offered, and one that happens twice is offered once', () => {
    /* spring forward in Denver: 2027-03-14, 02:00 → 03:00. */
    const open = rules({ max_days_ahead: 365, hours: { ...WEEK, sat: NINE_TO_FIVE, sun: [{ open: '01:00', close: '04:00' }], mon: NINE_TO_FIVE } });
    const before = availableSlots({ rules: open, type: VISIT, held: [], now: NOW, from: '2027-03-13', days: 1 });
    const after = availableSlots({ rules: open, type: VISIT, held: [], now: NOW, from: '2027-03-15', days: 1 });
    assert.equal(before[0].starts_at, '2027-03-13T16:00:00.000Z', '09:00 standard time');
    assert.equal(after[0].starts_at, '2027-03-15T15:00:00.000Z', '09:00 daylight time');
    const half = { duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0 };
    const skipped = availableSlots({ rules: open, type: half, held: [], now: NOW, from: '2027-03-14', days: 1 });
    assert.deepEqual(times(skipped), ['01:00', '01:30', '03:00', '03:30'], '02:00 and 02:30 never happen that night');
    /* fall back: 2026-11-01, 01:00–02:00 happens twice. */
    const night = rules({ hours: { sun: [{ open: '00:00', close: '03:00' }] } });
    const twice = availableSlots({ rules: night, type: half, held: [], now: NOW, from: '2026-11-01', days: 1 });
    assert.deepEqual(times(twice), ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30']);
    assert.equal(new Set(twice.map((s) => s.starts_at)).size, 6, 'six different instants');
  });

  test('a time somebody holds is not offered; a buffer is the larger of the two, not their sum; capacity is how many may overlap', () => {
    const taken = [held('2026-10-06', '10:00', '11:00')];
    assert.deepEqual(times(slotsOn('2026-10-06', { held: taken })).slice(0, 4), ['09:00', '11:00', '11:30', '12:00']);
    /* the held one keeps 30 minutes free either side. */
    const buffered = [held('2026-10-06', '11:00', '12:00', 30, 30)];
    const around = times(slotsOn('2026-10-06', { held: buffered }));
    assert.ok(around.includes('09:30') && around.includes('12:30'));
    assert.ok(!around.includes('10:00') && !around.includes('12:00'));
    /* a new one that also wants 30 minutes either side: still 30 apart, not 60. */
    const both = times(slotsOn('2026-10-06', { held: buffered, type: { ...VISIT, buffer_before_minutes: 30, buffer_after_minutes: 30 } }));
    assert.ok(both.includes('09:30') && both.includes('12:30'));
    assert.ok(!both.includes('10:00') && !both.includes('12:00'));
    /* a type's own buffer wins over the client's; null means the client's. */
    const own = { rules: rules({ buffer_after_minutes: 60 }), held: [held('2026-10-06', '13:00', '14:00')] };
    assert.ok(!times(slotsOn('2026-10-06', own)).includes('11:30'), 'the client asks for an hour after each');
    assert.ok(times(slotsOn('2026-10-06', { ...own, type: { ...VISIT, buffer_after_minutes: 0 } })).includes('12:00'));
    /* two crews. */
    assert.ok(times(slotsOn('2026-10-06', { held: taken, rules: rules({ capacity: 2 }) })).includes('10:00'));
    const two = [held('2026-10-06', '10:00', '11:00', 0, 0, 'a'), held('2026-10-06', '10:30', '11:30', 0, 0, 'b')];
    assert.ok(!times(slotsOn('2026-10-06', { held: two, rules: rules({ capacity: 2 }) })).includes('10:30'));
    /* an appointment being moved does not block its own new time. */
    assert.ok(times(slotsOn('2026-10-06', { held: taken, excludeId: 'h1' })).includes('10:30'));
    assert.equal(overlapCount(taken, Date.parse(at('2026-10-06', '11:00')), Date.parse(at('2026-10-06', '12:00')), 0, 0), 0, 'back to back is not an overlap');
    assert.equal(overlapCount(taken, Date.parse(at('2026-10-06', '10:59')), Date.parse(at('2026-10-06', '11:59')), 0, 0), 1);
    /* a row's time is the same instant whether the driver hands back a string or a Date. */
    const asDates = taken.map((h) => ({ ...h, starts_at: new Date(h.starts_at), ends_at: new Date(h.ends_at), busy_from: new Date(h.busy_from), busy_until: new Date(h.busy_until) }));
    assert.deepEqual(slotsOn('2026-10-06', { held: asDates }), slotsOn('2026-10-06', { held: taken }));
  });

  test('"is this exact time offered" is the same calculation, so a start off the grid or in a gap is not', () => {
    const input = { rules: rules(), type: VISIT, held: [held('2026-10-06', '10:00', '11:00')], now: NOW };
    assert.equal(isOffered(input, at('2026-10-06', '09:00')), true);
    assert.equal(isOffered(input, at('2026-10-06', '10:30')), false, 'held');
    assert.equal(isOffered(input, at('2026-10-06', '09:10')), false, 'off the grid');
    assert.equal(isOffered(input, at('2026-10-06', '16:30')), false, 'would run past closing');
    assert.equal(isOffered(input, at('2026-10-10', '10:00')), false, 'closed that day');
    assert.equal(isOffered(input, '2026-10-04T15:00:00.000Z'), false, 'yesterday');
  });

  test('when nothing can be offered at all, the reason is one a person can act on', () => {
    assert.equal(unavailableReason(rules(), [VISIT]), null);
    assert.equal(unavailableReason(rules({ hours: {} }), [VISIT]), 'no_hours');
    assert.equal(unavailableReason(rules(), []), 'no_types');
    assert.equal(unavailableReason(rules({ authority: THEIRS }), [VISIT]), 'their_calendar', 'whose calendar it is comes first');
  });
});

/* ── whose calendar it is ───────────────────────────────── */

describe('whose calendar it is', () => {
  test('no policy is ARC; an external or hybrid policy hands over exactly the fields it names', () => {
    assert.deepEqual(appointmentAuthority(null), ARC);
    const external = effectivePolicy({ authority: 'external', connector_key: 'google_calendar', field_owners: {} }, 'appointment');
    assert.deepEqual(appointmentAuthority(external), THEIRS);
    const timeTheirs = effectivePolicy({ authority: 'hybrid', connector_key: 'google_calendar', field_owners: { starts_at: 'external', ends_at: 'external' } }, 'appointment');
    assert.deepEqual(appointmentAuthority(timeTheirs), { authority: 'hybrid', connector_key: 'google_calendar', time_owner: 'external', status_owner: 'arc' });
    assert.equal(bookingMode(ARC), 'slots');
    assert.equal(bookingMode(THEIRS), 'request');
    assert.equal(bookingMode(appointmentAuthority(timeTheirs)), 'request', 'ARC does not offer times it does not own');
  });

  test('an appointment is a kind of record ARC-340\'s policy covers, and who has it in ARC is never handed over', () => {
    for (const field of ['starts_at', 'ends_at', 'status']) assert.ok(POLICY_FIELDS.appointment.includes(field), field);
    for (const field of ['assigned_user_id', 'sync_state', 'lead_id', 'contact_id']) assert.ok(!POLICY_FIELDS.appointment.includes(field), field);
    const external = effectivePolicy({ authority: 'external', connector_key: 'google_calendar', field_owners: {} }, 'appointment');
    const person = { kind: 'client_user', userId: 'u', tenantId: 't', role: 'owner' };
    assert.equal(writeDecision(external, person, 'create', ['starts_at', 'ends_at', 'status']).code, 'external_authority');
    assert.equal(writeDecision(external, person, 'update', ['status']).code, 'external_authority');
    assert.equal(writeDecision(external, person, 'update', []).ok, true, 'handing it to somebody is ARC\'s to say');
    assert.equal(writeDecision(external, { kind: 'system' }, 'create', ['starts_at']).ok, true, 'a request from the booking page is ARC\'s own arrival');
    assert.equal(writeDecision(external, { kind: 'external', connectorKey: 'google_calendar' }, 'update', ['starts_at']).ok, true);
    assert.equal(writeDecision(external, { kind: 'external', connectorKey: 'jobber' }, 'update', ['starts_at']).code, 'arc_authority');
  });
});

/* ── what may be saved ──────────────────────────────────── */

describe('rules, types and pages', () => {
  test('a change to the rules is only what was sent, and every problem is named at once', () => {
    assert.deepEqual(parseSettingsInput({ capacity: 2, closed_dates: ['2026-12-25', '2026-12-25', '2026-11-26'] }).value, { capacity: 2, closed_dates: ['2026-11-26', '2026-12-25'] });
    const custom = parseSettingsInput({ hours_source: 'custom', custom_hours: { mon: [{ open: '08:00', close: '12:00' }] } });
    assert.deepEqual(custom.value, { hours_source: 'custom', custom_hours: { mon: [{ open: '08:00', close: '12:00' }] } });
    const bad = parseSettingsInput({ slot_step_minutes: 20, capacity: 0, max_days_ahead: 400, closed_dates: ['2026-02-30'], custom_hours: { mon: [{ open: '12:00', close: '08:00' }] }, customer_may_cancel: 'yes', extra: 1 });
    assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['capacity', 'closed_dates', 'custom_hours.mon', 'customer_may_cancel', 'extra', 'max_days_ahead', 'slot_step_minutes']);
    assert.equal(parseSettingsInput({}).ok, false, 'nothing to change is said, not saved');
  });

  test('a type needs a key, a name and a length; its key never changes; a blank buffer means the client\'s own', () => {
    const made = parseAppointmentTypeInput({ key: 'site_visit', name: ' Site visit ', duration_minutes: 60, buffer_after_minutes: null });
    assert.deepEqual(made.value, { key: 'site_visit', name: 'Site visit', duration_minutes: 60, buffer_after_minutes: null });
    assert.deepEqual(parseAppointmentTypeInput({ name: 'X' }).errors.map((e) => e.field).sort(), ['duration_minutes', 'key']);
    assert.equal(parseAppointmentTypeInput({ key: 'Site Visit', name: 'X', duration_minutes: 60 }).ok, false);
    assert.equal(parseAppointmentTypeInput({ key: 'other' }, { partial: true }).errors[0].field, 'key');
    assert.ok(parseAppointmentTypeInput({ archived: true }, { partial: true }).value.archived_at);
    assert.equal(parseAppointmentTypeInput({ archived: false }, { partial: true }).value.archived_at, null);
    assert.equal(parseAppointmentTypeInput({ duration_minutes: 2 }, { partial: true }).ok, false);
    const secret = ['api', '_key=sk_', 'live_abcdefgh12345678'].join('');
    assert.equal(parseAppointmentTypeInput({ key: 'visit', name: secret, duration_minutes: 30 }).ok, false);
  });

  test('a booking page is data, not a program: a closed list of keys, plain wording, no credential', () => {
    const page = defaultPageDefinition('Book a visit');
    assert.deepEqual(parsePageDefinition(page), { ok: true, value: page });
    assert.equal(page.consent.sms.mode, 'optional', 'never required by default, and never ticked for anybody');
    for (const bad of [
      { ...page, script: 'alert(1)' },
      { ...page, title: '' },
      { ...page, address: 'sometimes' },
      { ...page, type_keys: [] },
      { ...page, type_keys: ['Not A Key'] },
      { ...page, consent: { sms: { mode: 'assumed', text: 'x' } } },
      { ...page, consent: { fax: { mode: 'optional', text: 'x' } } },
      { ...page, intro: ['pass', 'word: hunter2hunter2'].join('') },
      'a string',
    ]) assert.equal(parsePageDefinition(bad).ok, false, JSON.stringify(bad));
    assert.deepEqual(parsePageDefinition({ title: 'T', type_keys: ['visit', 'visit'] }).value.type_keys, ['visit']);
    assert.deepEqual(parsePageInput({ name: 'Website', definition: page, hourly_cap: 10 }).value, { name: 'Website', definition: page, hourly_cap: 10 });
    assert.deepEqual(parsePageInput({ hourly_cap: 0, definition: { title: '' } }, { partial: true }).errors.map((e) => e.field).sort(), ['definition.title', 'hourly_cap']);
  });

  test('the link is the whole of what is shared: no script in the embed, and a customer\'s token only in the fragment', () => {
    const key = `arcb_${'k'.repeat(32)}`;
    const token = `arcm_${'t'.repeat(40)}`;
    assert.match(key, BOOKING_KEY);
    assert.match(token, MANAGE_TOKEN);
    assert.equal(bookingUrl('https://arcautomation.site/', key), `https://arcautomation.site/book/${key}`);
    const embed = bookingEmbedSnippet('https://arcautomation.site', key, 'Book "now" <b>');
    assert.match(embed, /^<iframe src="https:\/\/arcautomation\.site\/book\/arcb_k{32}\?embed=1" title="Book now b"/);
    assert.doesNotMatch(embed, /<script|javascript:|onload/i);
    const link = new URL(manageUrl('https://arcautomation.site', key, token));
    assert.equal(link.hash, `#${token}`);
    assert.equal(link.search, '', 'a fragment is not sent to a server or put in a referrer; a query string is');
    assert.ok(!link.pathname.includes(token));
  });
});

/* ── a booking ──────────────────────────────────────────── */

describe('a booking', () => {
  const types = [
    { id: 't1', key: 'visit', name: 'Site visit', description: null, duration_minutes: 60, buffer_before_minutes: null, buffer_after_minutes: null, requires_approval: true },
    { id: 't2', key: 'tune_up', name: 'Tune-up', description: null, duration_minutes: 30, buffer_before_minutes: null, buffer_after_minutes: null, requires_approval: false },
  ];
  const page = defaultPageDefinition('Book a visit');
  const good = { type: 'visit', starts_at: '2026-10-06T15:00:00.000Z', name: ' Dana  Reyes ', phone: '(614) 555-0137', email: 'Dana@Example.com', address: '12 Elm St', postal_code: '80202', note: 'Gate code 4411', consent_sms: true };

  test('what a stranger sent, checked against the page: one spelling of each address, and only what the page asks for', () => {
    const parsed = parseSubmission(page, { ...good, lead_id: 'x', status: 'confirmed', extra: 'ignored' }, { types });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const { type, startsAt, contact, address, note, consent } = parsed.value;
    assert.deepEqual([type.key, startsAt], ['visit', '2026-10-06T15:00:00.000Z']);
    assert.deepEqual(contact, { display_name: 'Dana Reyes', phone: '+16145550137', email: 'dana@example.com', address_line1: '12 Elm St', postal_code: '80202' });
    assert.deepEqual(address, { address_line1: '12 Elm St', city: null, region: null, postal_code: '80202' });
    assert.equal(note, 'Gate code 4411');
    assert.deepEqual(consent, [{ channel: 'sms', address: '+16145550137', granted: true, disclosure: page.consent.sms.text }]);
    assert.ok(!JSON.stringify(parsed.value).includes('ignored'), 'a key the page does not have is not stored');
  });

  test('every problem comes back by field: no time, nobody to reach, a number that cannot be dialled', () => {
    const errors = (values, definition = page) => parseSubmission(definition, values, { types }).errors.map((e) => e.field).sort();
    assert.deepEqual(errors({}), ['name', 'phone', 'starts_at', 'type']);
    assert.deepEqual(errors({ ...good, phone: '12', email: 'nope' }), ['email', 'phone']);
    assert.deepEqual(errors({ ...good, starts_at: '2026-10-06T09:00' }), ['starts_at'], 'a time with no offset is refused: whose 9am?');
    assert.deepEqual(errors({ ...good, type: 'nothing' }), ['type']);
    assert.deepEqual(errors({ ...good, address: undefined, postal_code: undefined }, { ...page, address: 'required' }), ['address', 'postal_code']);
    assert.deepEqual(errors({ ...good, consent_sms: false }, { ...page, consent: { sms: { mode: 'required', text: 'T' } } }), ['consent_sms']);
    assert.equal(parseSubmission(page, { ...good, phone: undefined }, { types }).ok, true, 'an email alone is enough to reach somebody');
    /* one type on the page: it does not have to be chosen. */
    assert.equal(parseSubmission(page, { ...good, type: undefined }, { types: [types[0]] }).value.type.key, 'visit');
  });

  test('consent is what was ticked, for an address that was given — never assumed; a page that asks nothing records nothing', () => {
    const consent = (values, definition = page) => parseSubmission(definition, { ...good, ...values }, { types }).value.consent;
    assert.equal(consent({ consent_sms: undefined })[0].granted, false);
    assert.equal(consent({ consent_sms: 'true' })[0].granted, false, 'only the boolean a tick box sends');
    assert.deepEqual(consent({ phone: undefined }), [], 'no phone, no permission to text recorded');
    assert.deepEqual(consent({}, { ...page, consent: {} }), []);
    const off = parseSubmission({ ...page, address: 'off', note: false }, good, { types }).value;
    assert.deepEqual([off.address.address_line1, off.note, off.contact.address_line1], [null, null, undefined], 'what the page does not ask is not kept');
  });

  test('a pasted password does not cost the customer the booking, and is not kept; a caught script is told nothing', () => {
    const secret = ['pass', 'word: hunter2hunter2'].join('');
    const parsed = parseSubmission(page, { ...good, note: secret }, { types });
    assert.equal(parsed.ok, true);
    assert.match(parsed.value.note, /removed/);
    assert.doesNotMatch(JSON.stringify(parsed.value), /hunter2/);
    assert.equal(spamVerdict({ company_website: 'https://x.example' }, Date.now()), 'honeypot');
    assert.equal(spamVerdict({ rendered_at: Date.now() - 200 }, Date.now()), 'dwell');
    assert.equal(spamVerdict({ rendered_at: Date.now() - 5000 }, Date.now()), null);
    assert.equal(spamVerdict({}, Date.now()), null);
  });

  test('a person\'s booking names who it is for; a change names what it does; their calendar\'s report names a time', () => {
    const id = '11111111-0000-4000-8000-000000000001';
    const lead = '22222222-0000-4000-8000-000000000002';
    assert.equal(parseStaffBooking({ appointment_type_id: id, starts_at: good.starts_at, lead_id: lead }).value.outside_rules, false);
    assert.deepEqual(parseStaffBooking({ appointment_type_id: id, starts_at: good.starts_at }).errors.map((e) => e.field), ['contact_id']);
    assert.deepEqual(parseStaffBooking({ starts_at: 'tomorrow', lead_id: 'x', status: 'confirmed' }).errors.map((e) => e.field).sort(), ['appointment_type_id', 'lead_id', 'starts_at', 'status']);
    assert.equal(parseInstant('2026-10-06T09:00:00-06:00'), '2026-10-06T15:00:00.000Z');
    assert.equal(parseInstant('2026-10-06T09:00:00'), null);
    assert.equal(parseInstant(1759762800000), null);

    assert.deepEqual(parseChange({ action: 'reschedule', starts_at: good.starts_at }).value, { action: 'reschedule', starts_at: good.starts_at, reason: null, assigned_user_id: null, outside_rules: false });
    assert.equal(parseChange({ action: 'reschedule' }).errors[0].field, 'starts_at');
    assert.equal(parseChange({ action: 'delete' }).errors[0].field, 'action');
    assert.equal(parseChange({ action: 'cancel', reason: ' moved away ' }).value.reason, 'moved away');
    assert.equal(parseChange({ action: 'assign', assigned_user_id: id }).value.assigned_user_id, id);
    assert.equal(parseChange({ action: 'confirm', status: 'completed' }).ok, false, 'a status is never typed');

    const report = { external_id: 'evt-1', status: 'confirmed', starts_at: '2026-10-06T15:00:00Z', ends_at: '2026-10-06T16:00:00Z' };
    assert.equal(parseExternalReport(report).ok, true);
    assert.equal(parseExternalReport({ ...report, connector_key: 'google_calendar' }).ok, false, 'which system it is comes from the connection, never the payload');
    assert.equal(parseExternalReport({ ...report, ends_at: report.starts_at }).ok, false);
    assert.equal(parseExternalReport({ ...report, status: 'tentative' }).ok, false);
    assert.equal(parseExternalReport({ ...report, ends_at: '2026-10-08T16:00:00Z' }).ok, false, 'an appointment is within a day');
  });

  test('an address is turned away only on a match that can be checked — never on a guess', () => {
    const zips = [{ kind: 'postal_code', value: '80202' }, { kind: 'postal_code', value: '80203', archived_at: '2026-01-01' }, { kind: 'city', value: 'Aurora' }];
    assert.equal(serviceAreaDecision(zips, { postal_code: '80202-1234' }), 'inside');
    assert.equal(serviceAreaDecision(zips, { postal_code: '80203' }), 'outside', 'a retired area no longer covers anybody');
    assert.equal(serviceAreaDecision(zips, { postal_code: '99999', city: 'aurora' }), 'inside');
    assert.equal(serviceAreaDecision(zips, { postal_code: '99999' }), 'outside');
    assert.equal(serviceAreaDecision(zips, {}), 'unknown', 'no address given');
    assert.equal(serviceAreaDecision([], { postal_code: '99999' }), 'unknown', 'no areas on file');
    assert.equal(serviceAreaDecision([...zips, { kind: 'radius_miles', value: '25' }], { postal_code: '99999' }), 'unknown', 'a radius cannot be checked from text');
    assert.equal(serviceAreaDecision([{ kind: 'region', value: 'CO' }], { region: 'co' }), 'inside');
  });
});

/* ── what may happen to an appointment ──────────────────── */

describe('what may happen to an appointment', () => {
  const soon = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
  const tomorrow = new Date(NOW.getTime() + 30 * 3_600_000).toISOString();
  const yesterday = new Date(NOW.getTime() - 20 * 3_600_000).toISOString();

  test('every status and every action has a place, and the two that hold a time are the two that can still change', () => {
    assert.deepEqual([...HELD_STATUSES], ['requested', 'confirmed']);
    for (const [from, to] of APPOINTMENT_TRANSITIONS) {
      assert.ok(APPOINTMENT_STATUSES.includes(from) && APPOINTMENT_STATUSES.includes(to));
      assert.ok(HELD_STATUSES.includes(from), `${from} → ${to}: nothing leaves a closed status`);
    }
    for (const code of ['slot_taken', 'slot_unavailable', 'invalid_transition', 'needs_reconciliation', 'too_late', 'outside_service_area']) {
      assert.ok(CRM_ERROR_STATUS[code] >= 400, `${code} has a status`);
    }
  });

  test('the buttons on an appointment are its legal next steps, by the clock and by whose calendar it is', () => {
    assert.deepEqual(nextActions({ status: 'requested', starts_at: tomorrow }, ARC, NOW), ['confirm', 'decline', 'cancel', 'reschedule', 'assign']);
    assert.deepEqual(nextActions({ status: 'confirmed', starts_at: tomorrow }, ARC, NOW), ['cancel', 'reschedule', 'assign'], 'not yet started: it cannot be closed');
    assert.deepEqual(nextActions({ status: 'confirmed', starts_at: yesterday }, ARC, NOW), ['complete', 'no_show', 'cancel', 'reschedule', 'assign']);
    for (const status of ['declined', 'cancelled', 'completed', 'no_show']) assert.deepEqual(nextActions({ status, starts_at: yesterday }, ARC, NOW), [], status);
    assert.deepEqual(nextActions({ status: 'requested', starts_at: tomorrow }, THEIRS, NOW), ['assign'], 'their calendar: only who has it');
    assert.deepEqual(nextActions({ status: 'confirmed', starts_at: tomorrow }, { ...ARC, authority: 'hybrid', time_owner: 'external' }, NOW), ['cancel', 'assign']);
    assert.deepEqual(nextActions({ status: 'confirmed', starts_at: tomorrow, sync_state: 'conflict' }, ARC, NOW), ['assign'], 'frozen until it is settled');
    for (const action of nextActions({ status: 'confirmed', starts_at: yesterday }, ARC, NOW)) assert.ok(APPOINTMENT_ACTIONS.includes(action));
  });

  test('a customer\'s link moves or cancels only what still holds its time, only as early as the client says, and never their calendar\'s', () => {
    const r = rules();
    assert.equal(customerChangeDecision(r, { status: 'confirmed', starts_at: tomorrow }, 'cancel', NOW).ok, true);
    assert.equal(customerChangeDecision(r, { status: 'requested', starts_at: tomorrow }, 'reschedule', NOW).ok, true);
    assert.equal(customerChangeDecision(r, { status: 'confirmed', starts_at: soon }, 'cancel', NOW).code, 'too_late', 'inside the four-hour cutoff');
    assert.equal(customerChangeDecision({ ...r, customer_change_cutoff_minutes: 60 }, { status: 'confirmed', starts_at: soon }, 'cancel', NOW).ok, true);
    assert.equal(customerChangeDecision({ ...r, customer_may_cancel: false }, { status: 'confirmed', starts_at: tomorrow }, 'cancel', NOW).code, 'too_late');
    assert.equal(customerChangeDecision({ ...r, customer_may_cancel: false }, { status: 'confirmed', starts_at: tomorrow }, 'reschedule', NOW).ok, true);
    assert.equal(customerChangeDecision(r, { status: 'cancelled', starts_at: tomorrow }, 'cancel', NOW).code, 'conflict');
    assert.equal(customerChangeDecision({ ...r, authority: THEIRS }, { status: 'requested', starts_at: tomorrow }, 'cancel', NOW).code, 'too_late');
    assert.equal(customerChangeDecision(r, { status: 'confirmed', starts_at: tomorrow, sync_state: 'conflict' }, 'reschedule', NOW).code, 'too_late');
    assert.match(customerChangeDecision(r, { status: 'confirmed', starts_at: soon }, 'cancel', NOW).message, /please call/);
  });

  test('the calendar is days in the business\'s own timezone, not UTC\'s', () => {
    const late = { id: 'a', starts_at: '2026-10-07T03:30:00.000Z' }; // 21:30 on the 6th in Denver
    const early = { id: 'b', starts_at: '2026-10-06T15:00:00.000Z' };
    const next = { id: 'c', starts_at: '2026-10-07T15:00:00.000Z' };
    assert.deepEqual(agendaDays([next, late, early], TZ).map((d) => [d.date, d.appointments.map((a) => a.id)]), [['2026-10-06', ['b', 'a']], ['2026-10-07', ['c']]]);
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2027-03-14', 1), '2027-03-15', 'a 23-hour day is still one day');
    assert.equal(localDate(new Date('2026-10-06T05:00:00Z'), TZ), '2026-10-05');
  });

  test('the inbox reads a booked time as a lead\'s next step, and a request as something to answer', () => {
    const stage = (key, position, kind = 'open') => ({ id: `s-${key}`, pipeline_id: 'p1', key, name: key, position, kind, waits_on: 'us', archived_at: null });
    const lead = (id) => ({ id, contact_id: `c-${id}`, pipeline_id: 'p1', stage_id: 's-contacted', status: 'open', owner_user_id: 'u', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
    const input = {
      pipelines: [{ id: 'p1', stages: [stage('new', 10), stage('contacted', 20)] }],
      contacts: [], tasks: [],
      leads: [lead('booked'), lead('asked'), lead('bare'), lead('past')],
      appointments: [
        { id: 'a1', lead_id: 'booked', status: 'confirmed', starts_at: tomorrow },
        { id: 'a2', lead_id: 'asked', status: 'requested', starts_at: tomorrow },
        { id: 'a3', lead_id: 'past', status: 'confirmed', starts_at: yesterday },
        { id: 'a4', lead_id: 'bare', status: 'cancelled', starts_at: tomorrow },
      ],
    };
    const by = Object.fromEntries(inboxStates(input, NOW).map((s) => [s.lead.id, s]));
    assert.deepEqual([by.booked.next_appointment.id, by.booked.attention, by.booked.reasons], ['a1', false, []]);
    assert.deepEqual([by.asked.booking_request, by.asked.attention], [true, true]);
    assert.ok(by.asked.reasons.includes('a booking request is waiting for an answer'));
    assert.deepEqual([by.bare.next_appointment, by.bare.attention], [null, true], 'a cancelled appointment is not a next step');
    assert.ok(by.bare.reasons.includes('no next step'));
    assert.deepEqual([by.past.next_appointment, by.past.attention], [null, true], 'one that is over is not either');
    /* a workspace read before 0027 has no appointments at all, and reads as it always did. */
    const without = inboxStates({ ...input, appointments: undefined }, NOW);
    assert.ok(without.every((s) => s.next_appointment === null && s.booking_request === false && s.attention));
  });
});

/* ── the screens ────────────────────────────────────────── */

async function loadComponents() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: {
      contents: [
        "import { createElement as h } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { Bookings, BookingError, RecordBooking } from './src/portal/components/CrmBooking.jsx';",
        "import { BookingFlow, Booked, ManageFlow } from './src/portal/pages/PublicBooking.jsx';",
        "import CrmWorkspace from './src/portal/components/CrmWorkspace.jsx';",
        "import { demoCrmApi } from './src/portal/demo/crm-demo.js';",
        'const C = { Bookings, BookingError, RecordBooking, BookingFlow, Booked, ManageFlow, CrmWorkspace };',
        'export const render = (name, props) => renderToStaticMarkup(h(C[name], props));',
        'export { demoCrmApi };',
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.js': 'jsx', '.svg': 'empty' },
    define: { 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '""', 'import.meta.env.BASE_URL': '"/"' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'crm-booking-'));
  const file = path.join(dir, 'components.cjs');
  writeFileSync(file, out.outputFiles[0].text);
  try {
    return createRequire(import.meta.url)(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const ME = 'bbbbbbbb-0000-4000-8000-000000000001';
const hoursFromNow = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const appointment = (n, status, startsIn, extra = {}) => ({
  id: `ap-${n}`, tenant_id: T, contact_id: `c${n}`, lead_id: `l${n}`, title: 'Site visit', status,
  starts_at: hoursFromNow(startsIn), ends_at: hoursFromNow(startsIn + 1), busy_from: hoursFromNow(startsIn), busy_until: hoursFromNow(startsIn + 1),
  timezone: TZ, address_line1: null, city: null, customer_note: null, cancel_reason: null, assigned_user_id: null, reschedule_count: 0,
  sync_state: 'local', sync_detail: {}, source: 'booking_page', requires_approval: true, ...extra,
});
function overview(extra = {}) {
  return {
    tenant: { id: T, name: 'Acme Heating', timezone: TZ },
    rules: rules(),
    mode: 'slots',
    unavailable: null,
    types: [{ id: 'ty1', key: 'visit', name: 'Site visit', duration_minutes: 60, requires_approval: true, is_public: true, archived_at: null }],
    pages: [{ id: 'pg1', name: 'Website booking', status: 'published', version: 2, public_key: `arcb_${'k'.repeat(32)}`, definition: defaultPageDefinition('Book a visit') }],
    appointments: [
      appointment(1, 'requested', 26, { customer_note: 'Gate code is on the fence' }),
      appointment(2, 'confirmed', 2, { assigned_user_id: ME }),
      appointment(3, 'confirmed', -20),
      appointment(4, 'cancelled', 30, { cancel_reason: 'Sold the house' }),
    ],
    contacts: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, display_name: `Person ${n}`, phone: `+1614555010${n}`, email: null })),
    people: [{ user_id: ME, label: 'owner@acme.example — you', role: 'owner', assignable: true }],
    services: [],
    viewer: { kind: 'client_user', user_id: ME, may: { book: true, setup: true, reconcile: true } },
    truncated: false,
    read_at: new Date().toISOString(),
    ...extra,
  };
}

describe('the bookings screen', async () => {
  const ui = await loadComponents();
  const api = { door: 'crm', readOnly: false };
  const draw = (data, props = {}) => ui.render('Bookings', { api, initial: data, ...props });

  test('loading, and the two ways a read can fail, each say what is happening', () => {
    assert.match(ui.render('Bookings', { api }), /reading the calendar…/);
    const missing = Object.assign(new Error('x'), { status: 501 });
    const client = ui.render('BookingError', { error: missing, door: 'crm' });
    assert.match(client, /not switched on here yet/);
    assert.doesNotMatch(client, /0027|migration|function/, 'a client is not shown deploy steps');
    assert.match(ui.render('BookingError', { error: missing, door: 'ops' }), /0027_crm_booking\.sql/);
    const failed = ui.render('BookingError', { error: new Error('the network dropped'), door: 'crm' });
    assert.match(failed, /the calendar could not be read/);
    assert.match(failed, /the network dropped/);
  });

  test('what is waiting for an answer comes first, with the buttons that are its legal next steps', () => {
    const html = draw(overview());
    assert.match(html, /waiting for an answer/);
    assert.match(html, /1 waiting for an answer/);
    assert.match(html, /Person 1/);
    assert.match(html, /Gate code is on the fence/);
    assert.match(html, />confirm</);
    assert.match(html, />decline</);
    assert.match(html, /it happened/, 'the one that is over can be closed');
    assert.match(html, /they did not show/);
    assert.match(html, /reason given: Sold the house/);
    assert.match(html, new RegExp(`times in ${TZ}`));
    /* every state word carries its meaning. */
    assert.ok((html.match(/class="ws-term"/g) ?? []).length >= 4);
    for (const status of APPOINTMENT_STATUSES) assert.ok(glossFor(`appt_${status}`), `appt_${status} is in the glossary`);
    for (const key of ['their_calendar', 'sync_pending', 'sync_conflict', 'appt_approval', 'booking_capacity']) assert.ok(glossFor(key), key);
  });

  test('every button that changes the calendar says, before it is pressed, that the customer is told nothing', () => {
    const html = draw(overview());
    const consequences = html.match(/class="ops-action__why"[^>]*>[^<]*/g) ?? [];
    assert.ok(consequences.length >= 4);
    assert.ok(consequences.filter((c) => /nothing is sent to the customer from here/.test(c)).length >= 3);
    assert.match(html, /it sends the customer nothing/);
    assert.match(html, /not counted as a proven result anywhere/);
  });

  test('an empty calendar says so, and what nothing can be offered for is said in the words of whoever can fix it', () => {
    const empty = draw(overview({ appointments: [], contacts: [] }));
    assert.match(empty, /nothing in the calendar yet/);
    assert.match(empty, /0 ahead · 0 waiting for an answer/);
    const noHours = draw(overview({ unavailable: 'no_hours' }));
    assert.match(noHours, /no opening hours to book inside/);
    assert.match(noHours, /under &quot;rules&quot; below/);
    const staff = { kind: 'client_user', user_id: ME, may: { book: true, setup: false, reconcile: false } };
    assert.match(draw(overview({ unavailable: 'no_hours', viewer: staff })), /the account owner sets the hours/);
    assert.match(draw(overview({ unavailable: 'no_types' })), /nothing can be booked yet/);
  });

  test('their own calendar: the page says where appointments live, offers no confirm or move, and still lets somebody take it', () => {
    const theirs = overview({
      mode: 'request', unavailable: 'their_calendar', rules: rules({ authority: THEIRS }),
      appointments: [appointment(1, 'requested', 26, { sync_state: 'pending' })],
    });
    const html = draw(theirs);
    assert.match(html, /appointments are booked in google_calendar/);
    assert.match(html, /waiting on their calendar/);
    assert.doesNotMatch(html, />confirm<|>decline<|>cancel<| move<\/button>/);
    assert.match(html, /aria-label="who has the Site visit/);
  });

  test('a disagreement with their calendar is shown side by side, frozen, and settled only by somebody who may', () => {
    const reported = { starts_at: hoursFromNow(50), ends_at: hoursFromNow(51), status: 'confirmed' };
    const clash = overview({ appointments: [appointment(1, 'confirmed', 26, { sync_state: 'conflict', sync_detail: { reason: 'time', reported } })] });
    const html = draw(clash);
    assert.match(html, /needs settling/);
    assert.match(html, /their calendar and this one disagree/);
    assert.match(html, /their calendar says/);
    assert.match(html, />keep ours</);
    assert.match(html, />use theirs</);
    assert.doesNotMatch(html, />cancel<| move<\/button>/, 'frozen until it is settled');
    const staff = { kind: 'client_user', user_id: ME, may: { book: true, setup: false, reconcile: false } };
    const asStaff = draw({ ...clash, viewer: staff });
    assert.doesNotMatch(asStaff, />keep ours</);
    assert.match(asStaff, /the account owner settles this/);
  });

  test('staff see no setup; a read-only calendar offers no writes at all; the setup names each page\'s link and never a key of ARC\'s', () => {
    const data = overview();
    const owner = draw(data);
    assert.match(owner, />setup</);
    assert.match(owner, /make a booking page/);
    assert.match(owner, /a frame around the hosted page — no script/);
    assert.match(owner, /book\/arcb_k{32}/);
    const staff = draw({ ...data, viewer: { ...data.viewer, may: { book: true, setup: false, reconcile: false } } });
    assert.doesNotMatch(staff, />setup<|make a booking page|save the rules/);
    assert.match(staff, />confirm</, 'staff still work the calendar');
    const readOnly = draw(data, { readOnly: true });
    assert.doesNotMatch(readOnly, />confirm<|>decline<|>cancel<|>setup<|it happened/);
    assert.doesNotMatch(readOnly, /<select|type="checkbox"/);
    const noBook = draw({ ...data, viewer: { ...data.viewer, may: { book: false, setup: false, reconcile: false } } });
    assert.doesNotMatch(noBook, />confirm<|>decline</);
  });

  test('one lead\'s appointments: each with its history and who did it, and a way to book another', () => {
    const a = appointment(1, 'confirmed', 26, { reschedule_count: 1 });
    const events = [
      { id: 'e1', appointment_id: a.id, event_type: 'requested', actor_type: 'system', actor_id: null, detail: { via: 'booking_page' }, occurred_at: hoursFromNow(-30) },
      { id: 'e2', appointment_id: a.id, event_type: 'confirmed', actor_type: 'client_user', actor_id: ME, detail: { via: 'workspace' }, occurred_at: hoursFromNow(-29) },
      { id: 'e3', appointment_id: a.id, event_type: 'rescheduled', actor_type: 'system', actor_id: null, detail: { via: 'manage_link', from: hoursFromNow(10), to: a.starts_at }, occurred_at: hoursFromNow(-2) },
    ];
    const data = overview();
    const record = { rules: data.rules, mode: 'slots', unavailable: null, types: data.types, appointments: [a], events, people: data.people, viewer: data.viewer, read_at: data.read_at };
    const html = ui.render('RecordBooking', { api, by: { lead_id: 'l1' }, timezone: TZ, initial: record });
    assert.match(html, /the customer, on the booking page/);
    assert.match(html, /owner@acme\.example — you, here/);
    assert.match(html, /<b>moved<\/b> — from /);
    assert.match(html, /moved once/);
    assert.match(html, /book a time/);
    assert.doesNotMatch(ui.render('RecordBooking', { api, by: { lead_id: 'l1' }, timezone: TZ, initial: record, readOnly: true }), /book a time|>cancel</);
    const empty = ui.render('RecordBooking', { api, by: { lead_id: 'l1' }, timezone: TZ, initial: { ...record, appointments: [], events: [] } });
    assert.match(empty, /no appointments\./);
    const theirs = ui.render('RecordBooking', { api, by: { lead_id: 'l1' }, timezone: TZ, initial: { ...record, appointments: [], events: [], unavailable: 'their_calendar', rules: rules({ authority: THEIRS }) } });
    assert.match(theirs, /appointments are booked in google_calendar/);
    assert.doesNotMatch(theirs, /book a time/);
  });

  test('the workspace has a bookings view, the inbox says when a lead has a time booked or a request to answer, and the demo is the same screen', async () => {
    const demo = ui.demoCrmApi();
    const ws = await demo.workspace();
    const html = ui.render('CrmWorkspace', { api: demo, initial: ws });
    assert.match(html, />bookings</);
    assert.match(html, /booking to answer/);
    assert.match(html, /asked for /);
    const data = await demo.booking();
    assert.ok(data.appointments.length >= 5);
    assert.ok(data.appointments.every((a) => data.contacts.some((c) => c.id === a.contact_id)));
    const calendar = ui.render('Bookings', { api: demo, initial: data, readOnly: true });
    assert.match(calendar, /waiting for an answer/);
    assert.doesNotMatch(calendar, />confirm<|>setup</, 'the demo is read-only');
    await assert.rejects(demo.changeAppointment('x', { action: 'confirm' }), /this is the demo/);
    await assert.rejects(demo.bookAppointment({}), /this is the demo/);
    /* the times the demo offers are the real calculation over its own appointments. */
    const taken = data.appointments.find((a) => a.status === 'confirmed' && Date.parse(a.starts_at) > Date.now() + 3 * 3_600_000);
    const day = localDate(new Date(taken.starts_at), data.rules.timezone);
    const availability = await demo.bookingSlots({ appointment_type_id: data.types[0].id, from: day, days: 1 });
    assert.ok(availability.slots.length > 0);
    assert.ok(!availability.slots.some((s) => s.starts_at === taken.starts_at), 'a held time is not offered');
    const record = await demo.bookingRecord({ lead_id: taken.lead_id });
    assert.deepEqual(record.appointments.map((a) => a.id), [taken.id]);
    assert.ok(record.events.length >= 1);
  });

  test('nothing secret-shaped can be printed: the screens have no field for one, and no page was added to or taken from either rail', () => {
    for (const file of ['src/portal/components/CrmBooking.jsx', 'src/portal/pages/PublicBooking.jsx']) {
      assert.doesNotMatch(read(file), /token_hash|service_role|api[_-]?key|password|client_secret|SUPABASE_ANON/i, file);
    }
    assert.doesNotMatch(read('src/portal/components/CrmBooking.jsx'), /manage_token|arcm_/, 'the workspace never holds a customer\'s link');
    /* bookings is a view of the lead inbox, not a page of its own: the rail is as it was. */
    assert.ok(!NAV_ITEMS.some((item) => /book/.test(item.to)));
    assert.match(read('src/portal/components/CrmWorkspace.jsx'), /\['bookings', 'bookings'\]/);
    assert.match(read('src/App.jsx'), /<Route path="\/book\/:key" element=\{<PublicBooking \/>\} \/>/);
    assert.match(read('src/App.jsx'), /<Route path="\/book\/:key\/manage" element=\{<PublicBooking manage \/>\} \/>/);
    assert.match(read('src/App.jsx'), /pathname\.startsWith\('\/book\/'\)\) return null/, 'ARC\'s own cursor is not drawn on a business\'s booking page');
  });
});

describe('the hosted booking page', async () => {
  const ui = await loadComponents();
  const key = `arcb_${'k'.repeat(32)}`;
  const today = localDate(new Date(), TZ);
  const page = (extra = {}) => ({
    version: 1, business: 'Acme Heating', timezone: TZ, title: 'Book a visit', intro: 'Pick a time that suits you.', success_message: 'Thanks — your booking has been received.',
    address: 'optional', note: true, consent: defaultPageDefinition('x').consent, mode: 'slots', today, last_day: addDays(today, 30),
    types: [
      { key: 'visit', name: 'Site visit', description: 'We come to you.', duration_minutes: 60, requires_approval: true },
      { key: 'tune_up', name: 'Tune-up', description: null, duration_minutes: 30, requires_approval: false },
    ],
    ...extra,
  });
  const tomorrow = addDays(today, 1);
  const slot = (time) => ({ starts_at: instantFor(tomorrow, time, TZ).toISOString(), ends_at: instantFor(tomorrow, time, TZ).toISOString() });
  const draw = (initial, props = {}) => ui.render('BookingFlow', { pageKey: key, initial, ...props });

  test('a stranger sees the business, what can be booked, and nothing of ARC\'s but its name', () => {
    assert.match(ui.render('BookingFlow', { pageKey: 'not-a-page' }), /Loading…/);
    const html = draw({ page: page() });
    assert.match(html, /Acme Heating/);
    assert.match(html, /Book a visit/);
    assert.match(html, /What is it for\?/);
    assert.match(html, /Site visit/);
    assert.match(html, /about 60 minutes/);
    assert.match(html, /We come to you\./);
    assert.doesNotMatch(html, /When\?|Your details/, 'one step at a time: a time is asked for once there is something to book');
    assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-|tenant|lead|n8n|supabase/i);
    assert.match(draw({ page: page({ types: [] }) }), /Online booking is not open right now/);
  });

  test('one thing to book: the times are offered straight away, in the business\'s own time, and say so', () => {
    const one = page({ types: [page().types[0]] });
    const html = draw({ page: one, availability: { slots: [slot('09:00'), slot('13:30')] } });
    assert.doesNotMatch(html, /What is it for\?/);
    assert.match(html, /Site visit, about 60 minutes\./);
    assert.match(html, /aria-label="Choose a day"/);
    assert.match(html, />9:00 AM</);
    assert.match(html, />1:30 PM</);
    assert.match(html, /business’s local time \(America\/Denver\)/);
    assert.match(html, /aria-pressed="true"/, 'the first day with a free time is the one shown');
    assert.match(html, /no times free"[^>]*disabled=""|disabled=""[^>]*no times free"/, 'a day with nothing free cannot be chosen');
    assert.match(draw({ page: one, availability: { slots: [] } }), /No times are free this week\. Try a later one\./);
  });

  test('where the business keeps its own calendar, the page asks for a preferred time and says it is a request', () => {
    const html = draw({ page: page({ mode: 'request', types: [page().types[1]] }) });
    assert.match(html, /When would suit you\?/);
    assert.match(html, /type="date"/);
    assert.match(html, /This is a request, not a booking yet\. Acme Heating keeps its own calendar/);
    assert.doesNotMatch(html, /Choose a day/, 'no times are offered as free');
  });

  test('once it is made the customer is told the time, where it stands, and their own link — with the token in the fragment', () => {
    const token = `arcm_${'t'.repeat(40)}`;
    const booking = { status: 'requested', title: 'Site visit', starts_at: slot('09:00').starts_at, ends_at: slot('10:00').starts_at, timezone: TZ, manage_token: token };
    const html = ui.render('Booked', { page: page(), booking, pageKey: key });
    assert.match(html, /Your request is in/);
    assert.match(html, /Acme Heating will confirm this time with you\. It is held for you until they do\./);
    assert.match(html, /9:00 AM M[DS]T/);
    assert.match(html, new RegExp(`href="/book/${key}/manage#${token}"`));
    assert.match(html, /Keep that link/);
    assert.match(ui.render('Booked', { page: page(), booking: { ...booking, status: 'confirmed' }, pageKey: key }), /You are booked/);
  });

  test('a customer\'s own link: the booking, what it can still do, and the reason when it cannot', () => {
    assert.match(ui.render('ManageFlow', { pageKey: key, token: 'nonsense' }), /Loading…/);
    const view = (extra = {}) => ({
      business: 'Acme Heating', timezone: TZ, mode: 'slots',
      appointment: { status: 'confirmed', title: 'Site visit', starts_at: slot('09:00').starts_at, ends_at: slot('10:00').starts_at, address_line1: '12 Elm St', city: 'Denver', requires_approval: true },
      can: { cancel: { ok: true }, reschedule: { ok: true } },
      ...extra,
    });
    const html = ui.render('ManageFlow', { pageKey: key, token: 'x', initial: view() });
    assert.match(html, /Your booking/);
    assert.match(html, /Confirmed/);
    assert.match(html, /12 Elm St, Denver/);
    assert.match(html, /Move it to another time/);
    assert.match(html, /Cancel this booking/);
    const late = ui.render('ManageFlow', { pageKey: key, token: 'x', initial: view({ can: { cancel: { ok: false, code: 'too_late', message: 'it is too close to the appointment to change it online — please call us' }, reschedule: { ok: true } } }) });
    assert.match(late, /Cancelling it: it is too close to the appointment to change it online — please call us\./);
    assert.match(late, /<button[^>]*disabled=""[^>]*>Cancel this booking/);
    const over = ui.render('ManageFlow', { pageKey: key, token: 'x', initial: view({ appointment: { ...view().appointment, status: 'cancelled' }, can: { cancel: { ok: false, message: 'x' }, reschedule: { ok: false, message: 'x' } } }) });
    assert.match(over, /Cancelled/);
    assert.match(over, /Nothing more can be changed here/);
    assert.doesNotMatch(over, /Move it to another time/);
    for (const out of [html, late, over]) assert.doesNotMatch(out, /[0-9a-f]{8}-[0-9a-f]{4}-|phone|email/i, 'no ids and no contact details');
  });

  test('the page is the hosted form\'s kind of page: no supabase client, no script on anybody\'s site, and the token never in a query string', () => {
    const source = read('src/portal/pages/PublicBooking.jsx');
    assert.doesNotMatch(source, /lib\/supabase|getSupabase|@supabase/);
    assert.match(source, /parseSubmission\(page, answers, \{ types: page\.types \}\)/, 'checked here with the function\'s own parser');
    assert.match(source, /window\.location\.hash/);
    assert.doesNotMatch(source, /[?&]token=|params\.get\('token'\)/);
    assert.match(source, /send\('\/manage', \{ key: pageKey, token \}\)/, 'the token travels in a request body');
    assert.match(read('scripts/smoke.mjs'), /\['hosted-booking', '\/book\/not-a-page'\]/);
  });
});
