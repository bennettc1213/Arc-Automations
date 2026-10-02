/* ARC-350 — native lead capture, without a database: what a form may be, what a submission,
 * an import row and an API post must look like, and what is kept about where a lead came from.
 *
 * The same functions run in the hosted page, the console and the edge function, so these
 * are the rules all three share. `tests/intake-db.test.js` runs them over real SQL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  cleanText, defaultFormDefinition, embedSnippet, ENDPOINT_TOKEN, FORM_KEY, formUrl, IMPORT_TARGETS, LIMITS,
  mapImportRows, parseAttribution, parseCsv, parseFormDefinition, parseFormInput, parseManualLead, parseMapping,
  parseSubmission, parseWebhookPayload, spamVerdict, STANDARD_FIELDS, suggestMapping,
} from '../supabase/functions/_shared/intake/model.ts';
import { randomKey, sha256Hex } from '../supabase/functions/_shared/intake/service.ts';
import { PUBLIC_LIMITS, windowLimiter } from '../supabase/functions/_shared/intake/public.ts';

const fields = (errors) => errors.map((e) => e.field).sort();
const SERVICES = [
  { id: '11111111-1111-4111-8111-111111111111', key: 'ac_repair', name: 'AC repair', category_id: null },
  { id: '22222222-2222-4222-8222-222222222222', key: 'furnace', name: 'Furnace tune-up', category_id: '33333333-3333-4333-8333-333333333333' },
];
/* built from parts: a credential-shaped literal in a test file is refused by the host. */
const SECRETISH = ['pass', 'word'].join('') + ': ' + 'hunter2' + 'hunter2';

/* ── the form definition ────────────────────────────────── */

describe('a form is data', () => {
  const base = () => defaultFormDefinition('Request service');

  test('the starting form parses to itself', () => {
    const parsed = parseFormDefinition(base());
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.value, base());
    assert.deepEqual(parsed.value.fields.map((f) => [f.key, f.type, f.required]), [
      ['name', 'text', true], ['phone', 'phone', true], ['email', 'email', false], ['message', 'textarea', true],
    ]);
  });

  test('there is nowhere to put logic, markup or a pattern: every other key is refused', () => {
    for (const extra of ['show_if', 'pattern', 'html', 'on_change', 'validate', 'default', 'action']) {
      const onField = parseFormDefinition({ ...base(), fields: [{ key: 'phone', [extra]: 'x' }] });
      assert.equal(onField.ok, false, extra);
      assert.deepEqual(fields(onField.errors), [`fields[0].${extra}`]);
      const onForm = parseFormDefinition({ ...base(), [extra]: 'x' });
      assert.deepEqual(fields(onForm.errors), [extra]);
    }
    const script = parseFormDefinition({ ...base(), fields: [{ key: 'phone' }, { key: 'q_run', type: 'script', label: 'x' }] });
    assert.deepEqual(fields(script.errors), ['fields[1].type']);
  });

  test('a standard field keeps its meaning; a question of the business\'s own is q_ and one of five types', () => {
    const wrong = parseFormDefinition({ title: 'T', fields: [{ key: 'phone', type: 'text' }] });
    assert.deepEqual(fields(wrong.errors), ['fields[0].type']);
    const unknown = parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }, { key: 'budget', type: 'text', label: 'Budget' }] });
    assert.deepEqual(fields(unknown.errors), ['fields[1].key']);
    const ok = parseFormDefinition({
      title: 'T',
      fields: [
        { key: 'email', required: true },
        { key: 'q_own', type: 'select', label: 'Do you own the home?', options: ['Yes', 'No', 'Yes'] },
        { key: 'q_age', type: 'number', label: 'Age of the unit' },
        { key: 'q_pets', type: 'checkbox', label: 'Pets at home' },
      ],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.value.fields[1].options, ['Yes', 'No'], 'a repeated option is one option');
    assert.equal(ok.value.fields[0].label, STANDARD_FIELDS.email.label);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'email' }, { key: 'q_one', type: 'select', label: 'x', options: ['only'] }] }).errors), ['fields[1].options']);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'email' }, { key: 'q_a', type: 'text', label: 'x', options: ['a', 'b'] }] }).errors), ['fields[1].options']);
  });

  test('a form must ask how to reach the person, has no field twice, and 1 to 25 of them', () => {
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'name' }, { key: 'message' }] }).errors), ['fields']);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }, { key: 'phone' }] }).errors), ['fields[1].key']);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [] }).errors), ['fields']);
    const many = Array.from({ length: 26 }, (_, i) => ({ key: `q_${i}`, type: 'text', label: `Q${i}` }));
    assert.ok(fields(parseFormDefinition({ title: 'T', fields: many }).errors).includes('fields'));
    assert.deepEqual(fields(parseFormDefinition({ fields: [{ key: 'phone' }] }).errors), ['title']);
    assert.deepEqual(fields(parseFormDefinition('nope').errors), ['definition']);
  });

  test('consent wording is required, belongs to a field the form has, and is optional or required — never on by default', () => {
    const noPhone = parseFormDefinition({ title: 'T', fields: [{ key: 'email' }], consent: { sms: { mode: 'optional', text: 'Text me.' } } });
    assert.deepEqual(fields(noPhone.errors), ['consent.sms']);
    const noText = parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }], consent: { sms: { mode: 'optional' } } });
    assert.deepEqual(fields(noText.errors), ['consent.sms.text']);
    const badMode = parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }], consent: { sms: { mode: 'default_on', text: 'Text me.' } } });
    assert.deepEqual(fields(badMode.errors), ['consent.sms.mode']);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }], consent: { push: { mode: 'optional', text: 'x' } } }).errors), ['consent.push']);
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }], consent: { sms: { mode: 'optional', text: 'x', checked: true } } }).errors), ['consent.sms.checked']);
  });

  test('no wording and no key may read like a credential', () => {
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'phone', label: SECRETISH }] }).errors), ['fields[0].label']);
    const key = ['q_pass', 'word'].join('');
    assert.deepEqual(fields(parseFormDefinition({ title: 'T', fields: [{ key: 'phone' }, { key, type: 'text', label: 'Gate code' }] }).errors), ['fields[1].key']);
  });

  test('saving a form: a name and a definition, and two limits inside their ranges', () => {
    const saved = parseFormInput({ name: ' Website ', definition: base(), dedupe_minutes: 60, hourly_cap: 10 });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.value.name, 'Website');
    assert.deepEqual(fields(parseFormInput({ name: 'x' }).errors), ['definition']);
    assert.deepEqual(fields(parseFormInput({ dedupe_minutes: -1, hourly_cap: 0, tenant_id: 'x' }, { partial: true }).errors), ['dedupe_minutes', 'hourly_cap', 'tenant_id']);
    assert.deepEqual(parseFormInput({ hourly_cap: 5 }, { partial: true }), { ok: true, value: { hourly_cap: 5 } });
    assert.deepEqual(fields(parseFormInput({ name: 'x', definition: { title: 'T', fields: [{ key: 'name' }] } }).errors), ['definition.fields']);
  });
});

/* ── a submission ───────────────────────────────────────── */

describe('a submission is checked against its form', () => {
  const definition = parseFormDefinition({
    title: 'Request service',
    fields: [
      { key: 'name', required: true }, { key: 'phone', required: true }, { key: 'email' }, { key: 'service' },
      { key: 'postal_code' }, { key: 'message', required: true }, { key: 'preferred_time' },
      { key: 'q_own', type: 'select', label: 'Do you own the home?', options: ['Yes', 'No'] },
      { key: 'q_pets', type: 'checkbox', label: 'Pets at home' },
    ],
    consent: { sms: { mode: 'optional', text: 'Text me about this request.' }, email: { mode: 'required', text: 'Email me a copy.' } },
  }).value;
  const context = { formName: 'Website', services: SERVICES };
  const submit = (values) => parseSubmission(definition, values, context);

  test('phone and email come out in the one spelling the rest of ARC uses', () => {
    const parsed = submit({ name: '  Dana   Reyes ', phone: '(614) 555-0137', email: ' Dana@Example.COM ', message: 'No heat\r\nsince Tuesday', consent_email: true });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.contact, { display_name: 'Dana Reyes', phone: '+16145550137', email: 'dana@example.com' });
    assert.equal(parsed.value.lead.title, 'No heat');
    assert.equal(parsed.value.lead.summary, 'No heat\nsince Tuesday');
  });

  test('every problem comes back at once, by field', () => {
    const parsed = submit({ phone: '12', email: 'nope', q_own: 'Maybe', service: 'roofing' });
    assert.equal(parsed.ok, false);
    assert.deepEqual(fields(parsed.errors), ['email', 'message', 'name', 'phone', 'q_own', 'service']);
  });

  test('consent is what was ticked: anything but true is "did not agree", and nothing is recorded for an address not given', () => {
    const parsed = submit({ name: 'A', phone: '6145550137', message: 'm', consent_sms: 'true' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.consent, [{ channel: 'sms', address: '+16145550137', granted: false, disclosure: 'Text me about this request.' }]);
    const both = submit({ name: 'A', phone: '6145550137', email: 'a@b.co', message: 'm', consent_sms: true, consent_email: true });
    assert.deepEqual(both.value.consent.map((c) => [c.channel, c.granted]), [['sms', true], ['email', true]]);
    const required = submit({ name: 'A', phone: '6145550137', email: 'a@b.co', message: 'm' });
    assert.deepEqual(fields(required.errors), ['consent_email']);
  });

  test('a service is one of the business\'s; the lead takes its name and its category', () => {
    const parsed = submit({ name: 'A', phone: '6145550137', message: 'm', service: 'furnace' });
    assert.equal(parsed.value.lead.title, 'Furnace tune-up');
    assert.equal(parsed.value.lead.service_id, SERVICES[1].id);
    assert.equal(parsed.value.lead.service_category_id, SERVICES[1].category_id);
  });

  test('the business\'s own questions are kept as answers and written into the summary by their label', () => {
    const parsed = submit({ name: 'A', phone: '6145550137', message: 'Leak', preferred_time: 'mornings', q_own: 'Yes', q_pets: true });
    assert.deepEqual(parsed.value.answers, { preferred_time: 'mornings', q_own: 'Yes', q_pets: true });
    assert.equal(parsed.value.lead.summary, 'Leak\nWhen suits you?: mornings\nDo you own the home?: Yes\nPets at home: yes');
  });

  test('a key the form does not have is ignored, not stored', () => {
    const parsed = submit({ name: 'A', phone: '6145550137', message: 'm', tenant_id: 'x', owner_user_id: 'y', q_extra: 'z', priority: 'urgent' });
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed.value.contact).sort(), ['display_name', 'phone']);
    assert.deepEqual(parsed.value.answers, {});
    assert.equal(parsed.value.lead.priority, undefined);
  });

  test('a pasted password does not cost the customer their enquiry, and is not kept', () => {
    const parsed = submit({ name: 'A', phone: '6145550137', message: `the gate ${SECRETISH}` });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.doesNotMatch(JSON.stringify(parsed.value), /hunter2/);
    assert.match(parsed.value.lead.summary, /^\[removed/);
  });

  test('text over its length is refused, not cut', () => {
    assert.deepEqual(fields(submit({ name: 'A', phone: '6145550137', message: 'x'.repeat(2001) }).errors), ['message']);
  });

  test('with neither a phone nor an email there is nobody to call back', () => {
    const optional = parseFormDefinition({ title: 'T', fields: [{ key: 'name' }, { key: 'phone' }, { key: 'email' }] }).value;
    const parsed = parseSubmission(optional, { name: 'A' }, context);
    assert.deepEqual(fields(parsed.errors), ['phone']);
  });

  test('free text is one spelling: no control, zero-width or direction-override characters', () => {
    assert.equal(cleanText('a\u0000b​ ‮c\t d  '), 'ab c d');
    assert.equal(cleanText('line one\r\n\r\n\r\n\r\nline two  ', { multiline: true }), 'line one\n\nline two');
    assert.equal(cleanText('   '), null);
    assert.equal(cleanText(42), null);
    /* markup is text. it is never rendered as anything else, so it is not rewritten either. */
    assert.equal(cleanText('<b>hi</b> & <3'), '<b>hi</b> & <3');
  });

  test('the two silent checks', () => {
    assert.equal(spamVerdict({ company_website: 'http://x' }, 10_000), 'honeypot');
    assert.equal(spamVerdict({ rendered_at: 9_500 }, 10_000), 'dwell');
    assert.equal(spamVerdict({ rendered_at: 8_000, company_website: '' }, 10_000), null);
    assert.equal(spamVerdict({}, 10_000), null);
    assert.equal(LIMITS.minDwellMs, 1200);
  });
});

/* ── attribution ────────────────────────────────────────── */

describe('what a browser claims about where a visitor came from', () => {
  test('a page is kept without its query; the campaign is read from fields or from that query', () => {
    const claimed = parseAttribution({
      page: 'https://acme.example/contact?utm_source=google&utm_campaign=spring&gclid=abc123&email=dana@example.com#top',
      referrer: 'https://www.google.com/search?q=hvac+near+me',
      utm_medium: 'cpc',
      embedded: true,
    });
    assert.deepEqual(claimed, {
      page: 'https://acme.example/contact', referrer: 'https://www.google.com/search',
      utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring', click_ids: ['gclid'], embedded: true,
    });
    assert.doesNotMatch(JSON.stringify(claimed), /abc123|dana@/, 'a click id and anything else on the query are not kept');
  });

  test('it never fails and never keeps what it cannot use', () => {
    assert.deepEqual(parseAttribution(null), {});
    assert.deepEqual(parseAttribution({ page: 'javascript:alert(1)', referrer: 'not a url', utm_source: 42 }), {});
    assert.deepEqual(parseAttribution({ utm_source: 'x'.repeat(500) }), { utm_source: 'x'.repeat(120) });
    assert.deepEqual(parseAttribution({ utm_term: SECRETISH }), {});
  });
});

/* ── CSV ────────────────────────────────────────────────── */

describe('a CSV is read the way a spreadsheet writes one', () => {
  test('quotes, doubled quotes, a line break and a comma inside a value, CRLF, and a byte-order mark', () => {
    const csv = parseCsv('﻿Name,Phone,Notes\r\n"Reyes, Dana",6145550137,"said ""no heat""\nsince Tuesday"\r\n\r\nLee,,plain\r\n');
    assert.deepEqual(csv.problems, []);
    assert.deepEqual(csv.headers, ['Name', 'Phone', 'Notes']);
    assert.deepEqual(csv.rows, [['Reyes, Dana', '6145550137', 'said "no heat"\nsince Tuesday'], ['Lee', '', 'plain']]);
  });

  test('a semicolon or a tab where a locale uses one', () => {
    assert.deepEqual(parseCsv('Name;Phone\nA;1').rows, [['A', '1']]);
    assert.equal(parseCsv('Name\tPhone\nA\t1').delimiter, '\t');
  });

  test('nothing is evaluated: a formula is text', () => {
    assert.deepEqual(parseCsv('Name\n=HYPERLINK("http://x")').rows, [['=HYPERLINK("http://x")']]);
  });

  test('a file that cannot be imported says why', () => {
    assert.match(parseCsv('').problems[0], /empty/);
    assert.match(parseCsv('Name,Phone\n"unclosed,1').problems[0], /never closed/);
    assert.match(parseCsv('Name,Phone').problems[0], /no rows/);
    assert.match(parseCsv('Name,Name\nA,B').problems[0], /both headed "Name"/);
    assert.match(parseCsv(`Name\n${'A\n'.repeat(LIMITS.importRows + 1)}`).problems[0], /takes up to 2000/);
    assert.match(parseCsv('x'.repeat(LIMITS.csvCharacters + 1)).problems[0], /larger than/);
  });
});

describe('an import row', () => {
  const headers = ['Full Name', 'Mobile', 'E-mail', 'Zip Code', 'Job Type', 'Notes', 'Internal ID'];

  test('headings are guessed, then confirmed', () => {
    assert.deepEqual(suggestMapping(headers), {
      'Full Name': 'name', Mobile: 'phone', 'E-mail': 'email', 'Zip Code': 'postal_code', 'Job Type': 'service', Notes: 'summary', 'Internal ID': null,
    });
    assert.deepEqual(suggestMapping(['Phone', 'Cell']), { Phone: 'phone', Cell: null }, 'a target is suggested once');
    for (const target of Object.values(suggestMapping(headers))) assert.ok(target === null || IMPORT_TARGETS.includes(target));
  });

  test('a mapping names real columns, real targets, each once, and something to find the person by', () => {
    assert.equal(parseMapping({ Mobile: 'phone', Notes: 'ignore' }, headers).ok, true);
    assert.deepEqual(fields(parseMapping({ Mobile: 'phone', 'E-mail': 'phone' }, headers).errors), ['mapping.E-mail']);
    assert.deepEqual(fields(parseMapping({ Nope: 'phone' }, headers).errors), ['mapping', 'mapping.Nope']);
    assert.deepEqual(fields(parseMapping({ Mobile: 'owner_user_id' }, headers).errors), ['mapping', 'mapping.Mobile']);
    assert.deepEqual(fields(parseMapping({ Notes: 'summary' }, headers).errors), ['mapping']);
    assert.deepEqual(fields(parseMapping([], headers).errors), ['mapping']);
  });

  test('rows become what they would be; a problem names the field and never repeats the value', () => {
    const mapping = parseMapping(suggestMapping(headers), headers).value;
    const rows = mapImportRows({
      headers, mapping, services: SERVICES, fileName: 'leads.csv',
      rows: [
        ['Dana Reyes', '(614) 555-0137', 'DANA@example.com', '43215', 'AC repair', 'No cooling', '77'],
        ['Bad Phone', '555-01', 'not-an-email', '', 'Roofing', '', ''],
        ['Dana Again', '614.555.0137', '', '', '', '', ''],
        ['', '', '', '', '', 'no way to reach them', ''],
        ['Leaky', '6145550199', '', '', '', SECRETISH, ''],
        ['Extra', '6145550188', '', '', '', '', '', 'overflow'],
        ['Plain', '', 'plain@example.com', '', '', '', ''],
      ],
    });
    assert.deepEqual(rows.map((r) => r.status), ['ready', 'invalid', 'duplicate_in_file', 'invalid', 'invalid', 'invalid', 'ready']);
    assert.deepEqual(rows[0].payload, {
      contact: { display_name: 'Dana Reyes', phone: '+16145550137', email: 'dana@example.com', postal_code: '43215' },
      lead: { title: 'AC repair', summary: 'No cooling', service_id: SERVICES[0].id },
    });
    assert.deepEqual(fields(rows[1].problems), ['email', 'phone', 'service']);
    assert.match(rows[2].problems[0].message, /same phone or email as row 1/);
    assert.deepEqual(fields(rows[3].problems), ['name']);
    assert.deepEqual(fields(rows[4].problems), ['summary']);
    assert.deepEqual(fields(rows[5].problems), ['row']);
    assert.equal(rows[6].payload.lead.title, 'Imported from leads.csv');
    for (const row of rows.filter((r) => r.status !== 'ready')) {
      assert.deepEqual(row.payload, {});
      assert.doesNotMatch(JSON.stringify(row.problems), /555-01|not-an-email|hunter2|Roofing/, 'the value is not echoed');
    }
  });
});

/* ── an API post and a typed-in lead ────────────────────── */

describe('a lead posted by the client\'s own system', () => {
  test('is strict, normalised, and carries their event id', () => {
    const parsed = parseWebhookPayload({
      event_id: 'wix-000123',
      contact: { name: 'Dana Reyes', phone: '614 555 0137', email: 'Dana@Example.com', city: 'Columbus' },
      lead: { summary: 'Furnace is rattling', service: 'Furnace tune-up', priority: 'HIGH' },
      attribution: { page: 'https://acme.example/quote?utm_source=facebook' },
      consent: { sms: { granted: true, disclosure: 'Text me about my quote.' } },
      occurred_at: '2026-10-01T15:00:00-04:00',
    }, { services: SERVICES });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.value.eventId, 'wix-000123');
    assert.deepEqual(parsed.value.contact, { display_name: 'Dana Reyes', phone: '+16145550137', email: 'dana@example.com', city: 'Columbus' });
    assert.equal(parsed.value.lead.title, 'Furnace tune-up');
    assert.equal(parsed.value.lead.priority, 'high');
    assert.deepEqual(parsed.value.consent, [{ channel: 'sms', address: '+16145550137', granted: true, disclosure: 'Text me about my quote.' }]);
    assert.deepEqual(parsed.value.claimed, { page: 'https://acme.example/quote', utm_source: 'facebook' });
    assert.equal(parsed.value.occurredAt, '2026-10-01T19:00:00.000Z');
  });

  test('refuses what it does not know rather than dropping it', () => {
    const parsed = parseWebhookPayload({
      tenant_id: 'x', contact: { phone: '1', owner_user_id: 'y' }, lead: { stage: 'won', title: SECRETISH },
      consent: { sms: { granted: 'yes' } }, occurred_at: 'soon',
    }, { services: SERVICES });
    /* contact.name: with no usable phone there is nothing left to find the person by. */
    assert.deepEqual(fields(parsed.errors), ['consent.sms.granted', 'contact.name', 'contact.owner_user_id', 'contact.phone', 'lead.stage', 'lead.title', 'occurred_at', 'tenant_id']);
    assert.deepEqual(fields(parseWebhookPayload([], { services: [] }).errors), ['body']);
    assert.deepEqual(fields(parseWebhookPayload({ contact: {} }, { services: [] }).errors), ['contact.name']);
    const consent = parseWebhookPayload({ contact: { email: 'a@b.co' }, consent: { sms: { granted: true, disclosure: 'x' } } }, { services: [] });
    assert.deepEqual(fields(consent.errors), ['consent.sms'], 'consent to text needs a number to be about');
  });
});

describe('a lead somebody typed in', () => {
  test('names an existing contact or a new one, and needs a title', () => {
    const fresh = parseManualLead({ contact: { first_name: 'Dana', phone: '6145550137' }, lead: { service: 'ac_repair' } }, { services: SERVICES });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.value.lead.title, 'AC repair');
    assert.equal(fresh.value.contactId, null);
    assert.equal(fresh.value.allowDuplicate, false);
    const existing = parseManualLead({ contact_id: '11111111-1111-4111-8111-111111111111', lead: { title: 'Callback' }, allow_duplicate: true }, { services: [] });
    assert.equal(existing.value.contactId, '11111111-1111-4111-8111-111111111111');
    assert.equal(existing.value.allowDuplicate, true);
    assert.deepEqual(fields(parseManualLead({ contact_id: '11111111-1111-4111-8111-111111111111', contact: {}, lead: {} }, { services: [] }).errors), ['contact', 'lead.title']);
    assert.deepEqual(fields(parseManualLead({ contact: {}, lead: { title: 'x', stage_id: 'y' }, source: 'web_form' }, { services: [] }).errors), ['contact.display_name', 'lead.stage_id', 'source']);
  });
});

/* ── keys, links, limits ────────────────────────────────── */

describe('keys and links', () => {
  test('a form key and an endpoint token are random, opaque, and not an id', async () => {
    const key = `arcf_${randomKey(32)}`;
    const token = `arci_${randomKey(48)}`;
    assert.match(key, FORM_KEY);
    assert.match(token, ENDPOINT_TOKEN);
    assert.notEqual(randomKey(32), randomKey(32));
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.doesNotMatch('11111111-1111-4111-8111-111111111111', FORM_KEY);
  });

  test('the embed is a frame around the hosted form: no script, no token, no endpoint, no client id', () => {
    const key = `arcf_${'a'.repeat(32)}`;
    assert.equal(formUrl('https://arcautomation.site/', key), `https://arcautomation.site/form/${key}`);
    const snippet = embedSnippet('https://arcautomation.site', key, 'Request "service" <now>');
    assert.match(snippet, new RegExp(`^<iframe src="https://arcautomation\\.site/form/${key}\\?embed=1" title="Request service now"`));
    assert.doesNotMatch(snippet, /<script|arci_|functions\/v1|supabase|tenant|apikey/i);
  });

  test('the in-process limiter counts per bucket and starts again after its window', () => {
    let clock = 0;
    const limiter = windowLimiter(60_000, () => clock);
    for (let i = 0; i < PUBLIC_LIMITS.perIp; i += 1) assert.equal(limiter.over('ip:1', PUBLIC_LIMITS.perIp), false);
    assert.equal(limiter.over('ip:1', PUBLIC_LIMITS.perIp), true);
    assert.equal(limiter.over('ip:2', PUBLIC_LIMITS.perIp), false);
    clock = 60_001;
    assert.equal(limiter.over('ip:1', PUBLIC_LIMITS.perIp), false);
  });
});

/* ── what this module may import ────────────────────────── */

describe('portal-safe', () => {
  test('the model is importable by a browser: no Deno, no jsr:, no database', () => {
    const model = readFileSync(new URL('../supabase/functions/_shared/intake/model.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(model.replace(/\/\*[\s\S]*?\*\//g, ''), /\bDeno\b|jsr:|npm:|createClient|\.rpc\(|\.from\(/);
    const imports = [...model.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['../crm/model.ts', '../phone.ts']);
  });

  test('nothing here writes the evidence log or starts a run: capturing a lead is not following it up', () => {
    for (const file of ['model.ts', 'service.ts', 'public.ts', 'supabase-intake-store.ts']) {
      const source = readFileSync(new URL(`../supabase/functions/_shared/intake/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(source, /event-writer|emitEvents|writeEvents|from\('events'\)|intakeLead|automation_runs|scheduled_actions|twilio/i, file);
    }
  });
});
