/**
 * An owner previews and publishes their own campaign (decided 2026-10-13; 0034).
 *
 * Two actions on the `crm` function, both for the tenant's owner and nobody else. The
 * function has already read who is asking from their sign-in and their role from
 * `tenant_members`; a body names a campaign and the revision of it the owner was looking at,
 * and nothing more. The words that are published are read from the saved row, never from
 * the request, so what goes live is what was saved and reviewed.
 *
 *   campaign-preview   what publishing this campaign would change, what it would not, the
 *                      texts as a customer would receive them, and whether the account is
 *                      one ARC is answering for yet. A read.
 *
 *   campaign-publish   { campaign_id, expected_revision, expected_version }
 *                      the wording becomes the next Lead Recovery version through
 *                      `publishOwnerWording`, and the campaign is marked as the one live for
 *                      its kind. Asking again with nothing changed publishes nothing.
 *
 * Publishing never switches an account on. Where ARC is not yet answering for the business,
 * the words are published and wait; the answer says so in plain terms.
 */

import type { ConfigStore } from '../config/store.ts';
import type { ConfigActor } from '../config/model.ts';
import { moduleScope } from '../config/model.ts';
import { publishOwnerWording, resolveEffectiveConfig } from '../config/engine.ts';
import { applyOwnerWording, OWNER_WORDING_MODULE } from '../config/owner-wording.ts';
import { render, withOptOut } from '../engine/templates.ts';
import { DEFAULT_TEMPLATES, type LeadRecoveryConfig } from '../lead-recovery-config.ts';
import { CAMPAIGN_FIRST_TEXT, type PlanLine, publishPlan } from './model.ts';

export const CAMPAIGN_ACTIONS = ['campaign-preview', 'campaign-publish'];

export interface CampaignRow {
  id: string;
  tenantId: string;
  kind: string;
  revision: number;
  config: Record<string, unknown>;
  publishedRevision: number | null;
  publishedVersion: number | null;
}

export interface CampaignStore {
  getCampaign(tenantId: string, campaignId: string): Promise<CampaignRow | null>;
  markPublished(args: { tenantId: string; campaignId: string; revision: number; version: number; actorId: string }): Promise<void>;
  /** the lifecycle's own state for Lead Recovery, or null where the module was never selected. */
  moduleState(tenantId: string): Promise<{ state: string; pending: string[]; ownerPaused?: boolean } | null>;
}

export interface CampaignDeps { config: ConfigStore; campaigns: CampaignStore }

export interface CampaignResult { status: number; body: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): CampaignResult =>
  ({ status, body: { error, code, ...extra } });

/** Where the account stands, in the one distinction an owner needs: is ARC texting for them. */
function sendingWords(module: { state: string; pending: string[]; ownerPaused?: boolean } | null): { live: boolean; text: string } {
  if (module?.ownerPaused) {
    return { live: false, text: 'You have paused your texts, so nothing is being sent. These are the words ARC will use when you resume.' };
  }
  if (!module || module.state === 'unselected' || module.state === 'configuring' || module.state === 'testing' || module.state === 'shadow') {
    return { live: false, text: 'ARC is not switched on for your business yet. Your words are saved as the ones it will use, and nothing is sent until ARC switches your account on.' };
  }
  if (module.state === 'paused') {
    return { live: false, text: 'Your account is paused, so nothing is being sent. Your words are the ones ARC will use when it is switched back on.' };
  }
  if (module.pending.length > 0) {
    return { live: false, text: 'ARC is checking another change on your account. New inquiries are kept, and your words are used as soon as that check passes.' };
  }
  return { live: true, text: 'ARC is switched on for your business, so the next inquiry gets these words.' };
}

/** The texts as a customer would receive them, rendered by the engine's own renderer. */
function samples(config: LeadRecoveryConfig, kind: string, followup: boolean): { id: string; label: string; text: string }[] {
  const key = CAMPAIGN_FIRST_TEXT[kind];
  const out = [{
    id: 'message',
    label: 'First text',
    text: withOptOut(render(config.templates[key] ?? DEFAULT_TEMPLATES.first_response, { config, customerName: 'Alex Morgan' }), config),
  }];
  if (followup) {
    out.push({
      id: 'followup',
      label: 'Check-in text',
      text: withOptOut(render(config.templates.followup ?? DEFAULT_TEMPLATES.followup, { config, customerName: 'Alex Morgan' }), config),
    });
  }
  return out;
}

interface Prepared {
  campaign: CampaignRow;
  plan: Extract<ReturnType<typeof publishPlan>, { ok: true }>;
  headVersion: number;
  proposed: LeadRecoveryConfig;
}

async function prepare(deps: CampaignDeps, tenantId: string, body: Record<string, unknown>): Promise<Prepared | CampaignResult> {
  if (typeof body.campaign_id !== 'string' || !UUID.test(body.campaign_id)) return fail(422, 'invalid', 'campaign_id is required');
  const campaign = await deps.campaigns.getCampaign(tenantId, body.campaign_id);
  if (!campaign) return fail(404, 'not_found', 'campaign not found');

  const plan = publishPlan({ ...campaign.config, kind: campaign.kind });
  if (!plan.ok) return fail(422, 'not_publishable', 'this campaign cannot be switched on as it is', { problems: plan.problems });

  const head = await deps.config.getConfigHead(tenantId, moduleScope(OWNER_WORDING_MODULE));
  if (!head) {
    return fail(409, 'not_configured', 'ARC has not finished setting up your account yet, so a campaign cannot be switched on. Your draft is saved.');
  }
  /* the whole effective configuration with the owner's words in it, validated the way a
     send would read it. an account whose published settings no longer validate is not one
     to publish onto. */
  const effective = await resolveEffectiveConfig(deps.config, tenantId, OWNER_WORDING_MODULE);
  if (!effective.ok) return fail(409, 'not_configured', 'ARC needs to check your account settings before a campaign can be switched on.');
  const proposed = applyOwnerWording(effective.config, plan.wording) as unknown as LeadRecoveryConfig;
  return { campaign, plan, headVersion: head.version, proposed };
}

const isResult = (value: Prepared | CampaignResult): value is CampaignResult => 'status' in value;

export async function handleCampaignAction(
  action: string,
  deps: CampaignDeps,
  context: { tenantId: string; actor: ConfigActor; body: Record<string, unknown> },
): Promise<CampaignResult> {
  const { tenantId, actor, body } = context;
  if (actor.kind !== 'client' || actor.tenantId !== tenantId) return fail(403, 'forbidden', 'owner access required');

  const prepared = await prepare(deps, tenantId, body);
  if (isResult(prepared)) return prepared;
  const { campaign, plan, headVersion, proposed } = prepared;
  const sending = sendingWords(await deps.campaigns.moduleState(tenantId));
  const preview = {
    campaign_id: campaign.id,
    revision: campaign.revision,
    version: headVersion,
    applied: plan.applied as PlanLine[],
    not_applied: plan.notApplied as PlanLine[],
    samples: samples(proposed, campaign.kind, plan.wording.followup?.enabled === true),
    sending,
    already_live: campaign.publishedRevision === campaign.revision,
  };

  if (action === 'campaign-preview') return { status: 200, body: { ok: true, preview } };
  if (action !== 'campaign-publish') return fail(400, 'unknown_action', 'unknown action');

  if (!Number.isInteger(body.expected_revision) || body.expected_revision !== campaign.revision) {
    return fail(409, 'stale', 'this campaign was changed since you reviewed it — look at it again before switching it on', { preview });
  }
  if (!Number.isInteger(body.expected_version) || body.expected_version !== headVersion) {
    return fail(409, 'stale', 'your account settings changed since you reviewed this — look at it again before switching it on', { preview });
  }

  const published = await publishOwnerWording(deps.config, {
    tenantId, wording: plan.wording, expectedVersion: headVersion, actor,
    note: `owner campaign ${campaign.id} revision ${campaign.revision}`,
  });
  let version = headVersion;
  if (published.ok) version = published.version.version;
  else if (published.code !== 'no_change') {
    const status = published.code === 'publication_conflict' || published.code === 'draft_conflict' ? 409
      : published.code === 'validation_failed' ? 422
        : published.code === 'forbidden' || published.code === 'edit_permission_denied' ? 403 : 500;
    return fail(status, published.code, published.code === 'validation_failed'
      ? 'ARC could not accept this wording'
      : published.message, published.fieldErrors ? { field_errors: published.fieldErrors } : {});
  }

  /* marking is its own step and repeats safely: where the wording was already what ARC
     sends, the campaign is still recorded as the one it came from. */
  await deps.campaigns.markPublished({
    tenantId, campaignId: campaign.id, revision: campaign.revision, version, actorId: actor.userId,
  });
  const after = sendingWords(await deps.campaigns.moduleState(tenantId));
  return {
    status: 200,
    body: {
      ok: true,
      published: { campaign_id: campaign.id, revision: campaign.revision, version, changed: published.ok },
      preview: { ...preview, version, sending: after, already_live: true },
    },
  };
}
