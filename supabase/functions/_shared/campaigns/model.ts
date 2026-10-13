/**
 * What an owner's saved campaign becomes when they publish it (decided 2026-10-13).
 *
 * A campaign draft (0029) is the owner's own description of what they want. The engine sends
 * from the published Lead Recovery configuration and nothing else, so publishing is a
 * translation: this file says exactly which parts of a campaign have a place in that
 * configuration, turns those into it, and names every part that has none. Nothing here
 * sends, stores or decides who may publish — that is `config/owner-wording.ts` and 0034.
 *
 * Two rules it holds:
 *
 *   - **What is applied is listed, and so is what is not.** A campaign also carries a delay,
 *     a repeat-contact limit and an out-of-hours choice. The engine has no setting for those
 *     yet, so they are reported as saved and unused, never dropped silently and never
 *     implied to be live. Its questions are applied (0036): which are asked, and their words.
 *   - **The words are the owner's, in the engine's placeholders.** `{{business}}` and
 *     `{{first_name}}` are rewritten to `{{company}}` and `{{customer_name}}`; anything the
 *     engine cannot fill is refused before it could be sent as a gap.
 *
 * Portal-safe: the campaign page shows `publishPlan` before the owner confirms, and the
 * `crm` function runs the same function on the saved row before it publishes.
 */

import {
  MAX_FOLLOWUP_AFTER_MINUTES,
  MAX_TEMPLATE_CHARS,
  MIN_FOLLOWUP_AFTER_MINUTES,
  QUESTION_KEYS,
  type QuestionKey,
  templateProblems,
} from '../lead-recovery-config.ts';
import type { OwnerTemplateKey, OwnerWording } from '../config/owner-wording.ts';

/** Which first text each kind of campaign writes. A kind not here cannot be published. */
export const CAMPAIGN_FIRST_TEXT: Readonly<Record<string, OwnerTemplateKey>> = Object.freeze({
  missed: 'first_response',
  inbound: 'first_response_form',
});

export const CAMPAIGN_KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  missed: 'a missed call',
  inbound: 'a website inquiry',
});

export interface CampaignLike {
  kind?: unknown;
  message?: unknown;
  followup?: unknown;
  followupHours?: unknown;
  maxContacts?: unknown;
  questions?: unknown;
  delay?: unknown;
  cooldown?: unknown;
  afterHours?: unknown;
}

export interface PlanLine { id: string; text: string }

export type PublishPlan =
  | { ok: true; wording: OwnerWording; applied: PlanLine[]; notApplied: PlanLine[] }
  | { ok: false; problems: PlanLine[] };

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * An owner's sentence, in the engine's placeholders.
 *
 * `{{first_name}}` becomes `{{customer_name}}` together with the space before it, because the
 * engine's placeholder renders as ", Dana" or as nothing: "Hi {{first_name}}, this is" has to
 * become "Hi{{customer_name}}, this is" or a lead with no name reads "Hi , this is".
 */
export function toEngineTemplate(value: unknown): { ok: true; template: string } | { ok: false; problems: string[] } {
  const raw = text(value);
  if (!raw) return { ok: false, problems: ['is empty'] };
  const problems: string[] = [];
  const used = [...raw.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
  for (const name of used) {
    if (name !== 'first_name' && name !== 'business') {
      problems.push(name === 'service'
        ? 'uses {{service}}, which ARC cannot fill in a first text yet — say it in your own words'
        : `uses {{${name}}}, which ARC cannot fill`);
    }
  }
  const template = raw
    .replace(/\s*,?\s*\{\{\s*first_name\s*\}\}/g, '{{customer_name}}')
    .replace(/\{\{\s*business\s*\}\}/g, '{{company}}');
  /* the name renders as ", Dana" or as nothing, so it needs a word in front of it. */
  if (template.startsWith('{{customer_name}}')) {
    problems.push("starts with the customer's name — begin with a greeting such as Hi, because not every lead has a name");
  }
  if (problems.length === 0) {
    for (const problem of templateProblems(template)) {
      problems.push(problem.startsWith('is longer than')
        ? `is longer than ${MAX_TEMPLATE_CHARS} characters, the most one text can carry`
        : problem);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, template };
}

const hoursWords = (minutes: number) => {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
};

/**
 * What publishing this campaign would change, in order, or why it cannot be published.
 *
 * The follow-up belongs to the business, not to one campaign: the engine sends one follow-up
 * whichever way the lead arrived. A campaign that allows a second contact sets its words and
 * its wait; one that allows a single contact turns it off. Both are stated in `applied`.
 */
export function publishPlan(campaign: CampaignLike): PublishPlan {
  const kind = text(campaign.kind);
  const first = CAMPAIGN_FIRST_TEXT[kind];
  if (!first) {
    return {
      ok: false,
      problems: [{
        id: 'kind',
        text: kind === 'followup'
          ? 'ARC cannot run a check-in campaign to existing contacts yet. Your draft is saved.'
          : 'This kind of campaign cannot be switched on.',
      }],
    };
  }

  const problems: PlanLine[] = [];
  const message = toEngineTemplate(campaign.message);
  if (!message.ok) problems.push(...message.problems.map((p) => ({ id: 'message', text: `Your first text ${p}.` })));

  const contacts = Number(campaign.maxContacts);
  const wantsFollowup = Number.isInteger(contacts) && contacts > 1;
  let followupTemplate: string | null = null;
  let afterMinutes: number | null = null;
  let capped = false;
  if (wantsFollowup) {
    const followup = toEngineTemplate(campaign.followup);
    if (!followup.ok) problems.push(...followup.problems.map((p) => ({ id: 'followup', text: `Your check-in text ${p}.` })));
    else followupTemplate = followup.template;
    const hours = Number(campaign.followupHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      problems.push({ id: 'followup', text: 'Say how long ARC should wait before the check-in text.' });
    } else {
      const wanted = Math.round(hours * 60);
      afterMinutes = Math.min(MAX_FOLLOWUP_AFTER_MINUTES, Math.max(MIN_FOLLOWUP_AFTER_MINUTES, wanted));
      capped = afterMinutes !== wanted;
    }
  }
  /* the questions: each one of the engine's own (`QUESTION_KEYS`), once, in the owner's words. */
  const asked: { key: QuestionKey; template: string }[] = [];
  for (const raw of Array.isArray(campaign.questions) ? campaign.questions : []) {
    const key = raw && typeof raw === 'object' ? (raw as { key?: unknown }).key : null;
    if (!(QUESTION_KEYS as readonly unknown[]).includes(key)) {
      problems.push({ id: 'questions', text: 'One of your questions is not one ARC can ask. Remove it and pick from the list.' });
      continue;
    }
    if (asked.some((q) => q.key === key)) {
      problems.push({ id: 'questions', text: 'The same question is listed twice. ARC asks each one once.' });
      continue;
    }
    const words = toEngineTemplate((raw as { text?: unknown }).text);
    if (!words.ok) problems.push(...words.problems.map((p) => ({ id: 'questions', text: `One of your questions ${p}.` })));
    else asked.push({ key: key as QuestionKey, template: words.template });
  }

  if (problems.length) return { ok: false, problems };
  if (!message.ok) return { ok: false, problems };

  const source = CAMPAIGN_KIND_WORDS[kind];
  const applied: PlanLine[] = [{ id: 'message', text: `The first text after ${source} becomes your words.` }];
  const wording: OwnerWording = { templates: { [first]: message.template } };
  if (wantsFollowup && followupTemplate && afterMinutes !== null) {
    wording.templates = { ...wording.templates, followup: followupTemplate };
    wording.followup = { enabled: true, after_minutes: afterMinutes };
    applied.push({
      id: 'followup',
      text: `If they do not reply, one check-in text goes out ${hoursWords(afterMinutes)} later, during your opening hours, in your words.`
        + (capped ? ` ARC waits ${hoursWords(MAX_FOLLOWUP_AFTER_MINUTES)} at most, which is shorter than you asked for.` : '')
        + ' This applies to missed calls and website inquiries alike.',
    });
  } else {
    wording.followup = { enabled: false };
    applied.push({ id: 'followup', text: 'No check-in text is sent if they do not reply. This applies to missed calls and website inquiries alike.' });
  }

  /* the questions belong to the business as the follow-up does: the engine asks the same
     ones whichever way the lead arrived. which are asked, in what order and in whose words
     are the owner's; a question whose answer the customer has already given is skipped. */
  wording.questions = { ask: asked.map((q) => q.key) };
  for (const q of asked) wording.templates = { ...wording.templates, [`question_${q.key}`]: q.template };
  applied.push(asked.length
    ? {
        id: 'questions',
        text: `After they reply, ARC asks your ${asked.length === 1 ? 'question' : `${asked.length} questions, one at a time`}, skipping anything they have already told you.`
          + ' If they stop answering, the lead comes to you with what they have said so far. An answer that sounds urgent comes to you at once.'
          + ' This applies to missed calls and website inquiries alike.',
      }
    : { id: 'questions', text: "ARC asks no questions. It reads the customer's reply and passes the lead to you. This applies to missed calls and website inquiries alike." });

  const notApplied: PlanLine[] = [];
  if (Number(campaign.delay) > 0) {
    notApplied.push({ id: 'delay', text: 'The wait before the first text: ARC sends it straight away when you are open.' });
  }
  if (campaign.afterHours !== undefined) {
    notApplied.push({ id: 'afterHours', text: 'What happens outside your hours: ARC keeps using the choice already set on your account.' });
  }
  if (campaign.cooldown !== undefined || (Number.isInteger(contacts) && contacts > 2)) {
    notApplied.push({ id: 'limits', text: 'Your repeat-contact limits: ARC sends one first text and at most one check-in per inquiry.' });
  }
  return { ok: true, wording, applied, notApplied };
}
