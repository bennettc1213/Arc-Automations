/**
 * What actually gets sent to a customer.
 *
 * One rule, and it is the reason this file exists rather than a prompt: **the model never
 * writes the message.** It may classify, it may summarise for the contractor's eyes, and
 * it may ask for a person. It does not compose outbound SMS. A model that writes customer-
 * facing text under the contractor's brand and phone number is one prompt injection away
 * from writing whatever the last stranger asked it to, and there is no review step between
 * it and a carrier.
 *
 * So every outbound message is a reviewed template with a closed set of placeholders
 * filled in from validated config, and the opt-out sentence is appended here rather than
 * being part of any template — so it cannot be edited out of one.
 */

import type { LeadRecoveryConfig } from '../lead-recovery-config.ts';
import { DEFAULT_OPT_OUT_LANGUAGE, DEFAULT_TEMPLATES } from '../lead-recovery-config.ts';
import { isOpenAt, nextOpenAt } from './hours.ts';

export interface RenderInput {
  config: LeadRecoveryConfig;
  customerName?: string | null;
}

/**
 * Fill a template.
 *
 * `{{customer_name}}` renders as a leading ", Dana" or as nothing at all — the comma lives
 * with the name rather than in the template, because "Hi , this is …" is how every
 * personalisation bug announces itself. Anything not on the placeholder list was rejected
 * by the config validator and cannot reach here; if one somehow does it is left as written
 * rather than blanked, so the mistake is visible in the outbox instead of silently
 * swallowed.
 */
export function render(template: string, input: RenderInput): string {
  const { config } = input;
  const name = (input.customerName ?? '').trim();

  const values: Record<string, string> = {
    company: config.company_name,
    customer_name: name ? `, ${name.split(/\s+/)[0]}` : '',
    booking_url: config.booking_url ?? '',
    callback_window: config.after_hours.callback_window ?? 'shortly',
  };

  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole,
    )
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The opt-out line, appended to every outbound message.
 *
 * Appended rather than templated, and skipped only when the rendered body already carries
 * the word STOP as its own instruction — so a template that legitimately says "reply STOP
 * to opt out" mid-sentence does not produce it twice.
 */
export function withOptOut(body: string, config: LeadRecoveryConfig): string {
  const optOut = config.compliance.opt_out_language?.trim() || DEFAULT_OPT_OUT_LANGUAGE;
  if (/\bstop\b/i.test(body)) return body;
  return `${body} ${optOut}`.trim();
}

export type OutboundDecision =
  | { send: true; body: string; templateKey: string; sendAt: Date; reason: string }
  | { send: false; reason: string; retryAt: Date | null };

/**
 * The first response: whether to send one, which words, and when.
 *
 * This is where `after_hours.behaviour` is actually honoured. It is a decision rather than
 * a template choice because one of the four options is "not now, at opening time", and a
 * function that only picked wording would have no way to say that.
 *
 * `compliance.status` is checked here, first, ahead of everything else. A tenant whose
 * campaign is not approved does not send — not a different message, not a queued one.
 * Nothing.
 */
export function decideFirstResponse(
  config: LeadRecoveryConfig,
  now: Date,
  customerName?: string | null,
): OutboundDecision {
  if (config.compliance.status !== 'approved') {
    return {
      send: false,
      reason: `messaging compliance is "${config.compliance.status}" — nothing is sent until the campaign is approved`,
      retryAt: null,
    };
  }

  const open = isOpenAt(now, config);
  const behaviour = config.after_hours.behaviour;

  if (open.open || behaviour === 'same_response') {
    return {
      send: true,
      templateKey: 'first_response',
      body: withOptOut(render(config.templates.first_response ?? DEFAULT_TEMPLATES.first_response, { config, customerName }), config),
      sendAt: now,
      reason: open.open ? 'inside business hours' : 'configured to answer at any hour',
    };
  }

  if (behaviour === 'after_hours_response') {
    return {
      send: true,
      templateKey: 'after_hours_response',
      body: withOptOut(
        render(config.templates.after_hours_response ?? DEFAULT_TEMPLATES.after_hours_response, { config, customerName }),
        config,
      ),
      sendAt: now,
      reason: `${open.reason.replace(/_/g, ' ')} — sending the out-of-hours wording`,
    };
  }

  if (behaviour === 'queue_until_open') {
    const opening = nextOpenAt(now, config);
    if (!opening) {
      return {
        send: false,
        reason: 'configured to wait for opening hours, but the next fourteen days have none — check business_hours',
        retryAt: null,
      };
    }
    return {
      send: true,
      templateKey: 'first_response',
      body: withOptOut(render(config.templates.first_response ?? DEFAULT_TEMPLATES.first_response, { config, customerName }), config),
      sendAt: opening,
      reason: `${open.reason.replace(/_/g, ' ')} — held until the shop opens`,
    };
  }

  return { send: false, reason: `${open.reason.replace(/_/g, ' ')} — this company sends nothing out of hours`, retryAt: nextOpenAt(now, config) };
}

/** The one follow-up. Same compliance gate, same opt-out line, no personalisation beyond the company name. */
export function renderFollowup(config: LeadRecoveryConfig, customerName?: string | null): string {
  return withOptOut(render(config.templates.followup ?? DEFAULT_TEMPLATES.followup, { config, customerName }), config);
}

/** Sent once, when a person takes over, so the customer is not left on a dead thread. */
export function renderHandoffAck(config: LeadRecoveryConfig, customerName?: string | null): string {
  return withOptOut(render(config.templates.handoff_ack ?? DEFAULT_TEMPLATES.handoff_ack, { config, customerName }), config);
}

/**
 * The internal alert to the contractor's own staff.
 *
 * Not a template in `config.templates`, because it is not customer-facing and a client
 * editing it would be editing Arc's own operational notification. It names the lead, what
 * they asked for, and where to look — and never carries the customer's full number, which
 * is on the lead row for the people entitled to see it.
 */
export function renderStaffAlert(input: {
  config: LeadRecoveryConfig;
  customerName?: string | null;
  maskedPhone?: string | null;
  summary?: string | null;
  urgency?: string | null;
  safetyFlags?: string[];
  portalUrl?: string | null;
}): string {
  const bits = [`${input.config.company_name}: new lead needs you`];
  if (input.customerName) bits.push(input.customerName);
  if (input.maskedPhone) bits.push(input.maskedPhone);
  if (input.safetyFlags?.length) bits.push(`SAFETY: ${input.safetyFlags.join(', ')}`);
  else if (input.urgency && input.urgency !== 'unknown') bits.push(input.urgency.replace(/_/g, ' '));
  if (input.summary) bits.push(input.summary);
  if (input.portalUrl) bits.push(input.portalUrl);
  return bits.join(' · ').slice(0, 480);
}
