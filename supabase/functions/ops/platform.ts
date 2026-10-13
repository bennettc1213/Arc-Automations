/**
 * The operator's view of the product as a whole (ARC SaaS foundation, 0031 and 0033).
 *
 * Behind the `ops` function's admin check like everything in this directory. The actor is
 * the verified token's user, never a field in the body, and 0033 checks it against
 * `arc_admins` again on the one write here.
 *
 *   platform-sending-status   whether every real send is stopped, why, since when, by whom
 *
 *   platform-sending-stop     { stopped: boolean, reason }
 *                             stop or resume every real send, for every business. A stop needs
 *                             a reason. Calls, forms and replies are still recorded while it
 *                             is on; a text refused by it is cancelled and its lead handed to a
 *                             person, so resuming flushes nothing.                    audited
 *
 *   platform-self-service     every self-signup business: what it has set up, where its module
 *                             stands, its subscription as Stripe last reported it, and what it
 *                             has used this period against its cap. A read. No credential, no
 *                             customer's number and no message text is in it.
 */

export const PLATFORM_ACTIONS = ['platform-sending-status', 'platform-sending-stop', 'platform-self-service'];

// deno-lint-ignore no-explicit-any
type Db = any;

export interface PlatformContext {
  db: Db;
  body: Record<string, unknown>;
  actorId: string;
}

export interface PlatformResult { status: number; body: Record<string, unknown> }

const ok = (body: Record<string, unknown>): PlatformResult => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string, code: string): PlatformResult => ({ status, body: { error, code } });

/** Usage at or above this share of the cap is flagged for the operator before it runs out. */
export const USAGE_WARNING_SHARE = 0.8;

export function usageFlag(used: number | null, cap: number | null): 'none' | 'near_cap' | 'at_cap' {
  if (used === null || cap === null || cap <= 0) return 'none';
  if (used >= cap) return 'at_cap';
  return used >= Math.ceil(cap * USAGE_WARNING_SHARE) ? 'near_cap' : 'none';
}

async function sendingStatus(db: Db): Promise<Record<string, unknown>> {
  const { data, error } = await db.from('platform_controls').select('sending_stopped,reason,changed_by,changed_at').maybeSingle();
  if (error) throw new Error(error.message);
  return {
    sending_stopped: data?.sending_stopped === true,
    reason: data?.reason ?? null,
    changed_by: data?.changed_by ?? null,
    changed_at: data?.changed_at ?? null,
  };
}

async function selfService(db: Db): Promise<Record<string, unknown>[]> {
  const accounts = await db.from('self_service_accounts').select('tenant_id,created_at').order('created_at', { ascending: false }).limit(500);
  if (accounts.error) throw new Error(accounts.error.message);
  const ids: string[] = (accounts.data ?? []).map((row: { tenant_id: string }) => row.tenant_id);
  if (!ids.length) return [];

  const [tenants, setup, drafts, modules, billing, usage, forms] = await Promise.all([
    db.from('tenants').select('id,name,status,timezone').in('id', ids),
    db.from('tenant_setup_answers').select('tenant_id,business_type,services,service_area,step,updated_at').in('tenant_id', ids),
    db.from('customer_campaign_drafts').select('tenant_id,kind,updated_at').in('tenant_id', ids),
    db.from('tenant_modules').select('tenant_id,state,pending_requirements,health_status').eq('module_key', 'lead_recovery').in('tenant_id', ids),
    db.from('saas_billing_accounts').select('tenant_id,status,period_start,period_end,cancel_at_period_end,action_cap,provider_observed_at').in('tenant_id', ids),
    db.from('saas_usage_actions').select('tenant_id,period_start').in('tenant_id', ids),
    db.from('intake_keys').select('tenant_id,last_used_at,revoked_at').in('tenant_id', ids),
  ]);
  for (const result of [tenants, setup, drafts, modules, billing, usage, forms]) {
    if (result.error) throw new Error(result.error.message);
  }
  const by = <T extends { tenant_id: string }>(rows: T[] | null) => {
    const map = new Map<string, T[]>();
    for (const row of rows ?? []) map.set(row.tenant_id, [...(map.get(row.tenant_id) ?? []), row]);
    return map;
  };
  const tenantById = new Map((tenants.data ?? []).map((t: { id: string }) => [t.id, t]));
  const setups = by(setup.data); const draftsBy = by(drafts.data); const modulesBy = by(modules.data);
  const billingBy = by(billing.data); const usageBy = by(usage.data); const formsBy = by(forms.data);
  const sameInstant = (a: unknown, b: unknown) => a != null && b != null && new Date(String(a)).getTime() === new Date(String(b)).getTime();

  return (accounts.data ?? []).map((account: { tenant_id: string; created_at: string }) => {
    // deno-lint-ignore no-explicit-any
    const tenant = tenantById.get(account.tenant_id) as any;
    // deno-lint-ignore no-explicit-any
    const answers = setups.get(account.tenant_id)?.[0] as any;
    // deno-lint-ignore no-explicit-any
    const module = modulesBy.get(account.tenant_id)?.[0] as any;
    // deno-lint-ignore no-explicit-any
    const bill = billingBy.get(account.tenant_id)?.[0] as any;
    // deno-lint-ignore no-explicit-any
    const form = (formsBy.get(account.tenant_id) ?? []).find((key: any) => !key.revoked_at) as any;
    const used = bill?.period_start
      // deno-lint-ignore no-explicit-any
      ? (usageBy.get(account.tenant_id) ?? []).filter((row: any) => sameInstant(row.period_start, bill.period_start)).length
      : null;
    const cap = bill?.period_start ? Number(bill.action_cap) : null;
    return {
      tenant_id: account.tenant_id,
      name: tenant?.name ?? null,
      tenant_status: tenant?.status ?? null,
      signed_up_at: account.created_at,
      setup: {
        step: answers?.step ?? 0,
        details_complete: Boolean(answers && String(answers.business_type ?? '').trim() && answers.services?.length && answers.service_area?.length),
        updated_at: answers?.updated_at ?? null,
      },
      // deno-lint-ignore no-explicit-any
      campaign_drafts: (draftsBy.get(account.tenant_id) ?? []).map((draft: any) => ({ kind: draft.kind, updated_at: draft.updated_at })),
      form: { exists: Boolean(form), last_used_at: form?.last_used_at ?? null },
      module: {
        state: module?.state ?? 'unselected',
        pending_requirements: module?.pending_requirements ?? [],
        health: module?.health_status ?? 'unverified',
      },
      subscription: {
        status: bill?.status ?? 'none',
        period_end: bill?.period_end ?? null,
        cancel_at_period_end: bill?.cancel_at_period_end === true,
        observed_at: bill?.provider_observed_at ?? null,
      },
      usage: { used, cap, flag: usageFlag(used, cap) },
    };
  });
}

export async function handlePlatformAction(action: string, context: PlatformContext): Promise<PlatformResult> {
  const { db, body, actorId } = context;

  if (action === 'platform-sending-status') return ok({ sending: await sendingStatus(db) });

  if (action === 'platform-sending-stop') {
    if (typeof body.stopped !== 'boolean') return fail(422, 'say whether sending is stopped', 'invalid');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (body.stopped && reason.length < 3) return fail(422, 'say why sending is being stopped', 'invalid');
    if (reason.length > 300) return fail(422, 'the reason is too long', 'invalid');
    const { data, error } = await db.rpc('set_platform_sending_stop', {
      p_actor: actorId, p_stopped: body.stopped, p_reason: reason || null,
    });
    if (error) {
      const message = String(error.message ?? '');
      if (/arc_platform:forbidden/.test(message)) return fail(403, 'stopping or resuming sending is an operator action', 'forbidden');
      if (/arc_platform:invalid/.test(message)) return fail(422, message.replace(/^.*arc_platform:invalid:\s*/, ''), 'invalid');
      throw new Error(message);
    }
    return ok({ sending: data });
  }

  if (action === 'platform-self-service') return ok({ businesses: await selfService(db) });

  return fail(400, 'unknown action', 'unknown_action');
}
