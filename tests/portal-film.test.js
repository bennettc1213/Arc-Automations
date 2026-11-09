/* The hero film is a picture of the owner portal, so it may say only what the portal says.
 *
 * `src/components/portal-film-data.js` holds the film's words as plain text (the real workspace
 * is too heavy to ship in the marketing bundle). This file reads the same words back off the
 * code `/demo` renders — `buildProofLedger`, `ownerMonth`, `ownerNeeds` and the ledger's own
 * rule — and fails when they differ, so the film can never promise a figure, a status or a
 * button the page behind its caption does not show.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FILM_ANSWERS,
  FILM_COMPANY,
  FILM_DONE,
  FILM_FIGURES,
  FILM_HANDOFF,
  FILM_JOBS,
  FILM_NAV,
  FILM_NEED,
  FILM_PAGES,
  FILM_PROVEN,
} from '../src/components/portal-film-data.js';
import { PROOF_LEDGER_COMPANY, PROOF_LEDGER_LEADS, buildProofLedger, ledgerVerdict } from '../src/portal/demo/proof-ledger.js';
import { OWNER_NAV_GROUPS } from '../src/portal/lib/nav.js';
import { ownerMonth, ownerNeeds } from '../src/portal/lib/owner.js';
import { OWNER_ANSWERS } from '../supabase/functions/_shared/ledger/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const data = { proofLedger: buildProofLedger() };
const month = ownerMonth(data);
const needs = ownerNeeds(data);
const ownerItems = OWNER_NAV_GROUPS.flatMap((group) => group.items);

describe('the film is the owner portal, not the whole workspace', () => {
  test('its rail is the four screens a launch client gets, in order', () => {
    assert.deepEqual(
      FILM_NAV.map((item) => item.label),
      ownerItems.map((item) => item.label),
    );
    assert.equal(FILM_NAV.length, 4);
  });

  test('each page it draws carries the portal’s own title and blurb', () => {
    for (const page of Object.values(FILM_PAGES)) {
      const item = ownerItems.find((entry) => entry.title === page.title);
      assert.ok(item, page.title);
      assert.equal(page.blurb, item.blurb);
    }
  });

  test('it names the demo company', () => {
    assert.equal(FILM_COMPANY, PROOF_LEDGER_COMPANY);
  });

  test('it no longer draws the workspace’s modules, tables or lifecycle', () => {
    const source = `${read('src/components/PortalFilm.jsx')}\n${read('src/components/portal-film-data.js')}`;
    assert.doesNotMatch(source, /estimate|membership|install & warranty|lifecycle|median response|uptime/i);
  });
});

describe('every figure is what /demo derives', () => {
  test('this month’s three figures', () => {
    assert.equal(FILM_FIGURES.length, month.figures.length);
    month.figures.forEach((figure, n) => {
      const shown = FILM_FIGURES[n];
      assert.equal(shown.label, figure.label);
      assert.equal(shown.value, figure.available ? String(figure.value) : null, figure.label);
      assert.equal(shown.note, figure.note, figure.label);
    });
  });

  test('a figure that cannot be shown is null in the film too, never a zero', () => {
    const fee = FILM_FIGURES.find((figure) => figure.key === 'fee');
    assert.equal(fee.value, null);
    assert.ok(fee.note.length > 0);
  });

  test('what happened', () => {
    assert.deepEqual(
      FILM_PROVEN,
      month.proven.map((row) => ({ label: row.label, value: String(row.value) })),
    );
  });
});

describe('the question and the answer', () => {
  const [outcome, handoff] = needs.groups;

  test('the first thing waiting is the outcome question, worded as the portal words it', () => {
    assert.equal(outcome.key, 'outcome');
    assert.equal(FILM_NEED.kind, outcome.label);
    assert.equal(FILM_NEED.title, outcome.items[0].title);
    assert.equal(FILM_NEED.detail, outcome.items[0].detail);
    assert.equal(FILM_NEED.reason, outcome.items[0].reason);
  });

  test('the second is the handoff', () => {
    assert.equal(handoff.key, 'handoff');
    assert.equal(FILM_HANDOFF.kind, handoff.label);
    assert.equal(FILM_HANDOFF.title, handoff.items[0].title);
    assert.equal(FILM_HANDOFF.detail, handoff.items[0].detail);
    assert.equal(needs.total, FILM_FIGURES.find((figure) => figure.key === 'waiting').value * 1);
  });

  test('the six answers are the ledger’s own six', () => {
    assert.deepEqual(FILM_ANSWERS, OWNER_ANSWERS.map((answer) => answer.label));
  });

  test('the answer the film taps is one that counts', () => {
    assert.equal(OWNER_ANSWERS[0].label, FILM_ANSWERS[0]);
    assert.equal(OWNER_ANSWERS[0].counts, true);
    assert.equal(FILM_DONE, 'recorded. this job counts.');
  });
});

describe('the jobs the film shows', () => {
  test('are three of the ledger’s seven, with the statuses its rule reads', () => {
    for (const job of FILM_JOBS) {
      const lead = data.proofLedger.leads.find((entry) => entry.key === job.key);
      assert.ok(lead, job.key);
      assert.equal(job.title, lead.title);
      assert.equal(job.arrived, lead.arrived);
      assert.equal(job.label, lead.verdict.label);
      assert.equal(job.tone, lead.verdict.tone);
      assert.equal(job.reason, lead.verdict.reason);
    }
  });

  test('the one the owner answers reads exactly what the rule reads once they have', () => {
    const answered = FILM_JOBS.find((job) => job.then);
    const lead = PROOF_LEDGER_LEADS.find((entry) => entry.key === answered.key);
    assert.equal(lead.owner, null, 'it is the lead nobody has answered about');
    const after = ledgerVerdict({ ...lead, owner: 'happened' });
    assert.equal(answered.then.label, after.label);
    assert.equal(answered.then.tone, after.tone);
    assert.equal(answered.then.reason, after.reason);
    assert.equal(after.billed, true);
  });

  test('the question the film answers is that lead’s', () => {
    const answered = FILM_JOBS.find((job) => job.then);
    const lead = data.proofLedger.leads.find((entry) => entry.key === answered.key);
    assert.match(FILM_NEED.title, new RegExp(lead.booking.when.replace(/[·]/g, '.')));
  });
});
