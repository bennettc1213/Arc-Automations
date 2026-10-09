/**
 * The `ledger` function's actions, apart from Deno.serve so node can test them (index.ts
 * imports supabase-js from jsr:, which node cannot load) — ARC-GO-320.
 *
 * The portal's first client write, so what the door trusts is written down in one place:
 *
 *   - **who** is `door.userId`: whoever the bearer token verified as, asked of Supabase Auth
 *     by index.ts. Nothing in a body is read for it.
 *   - **which client** is a question the body may ask (`tenant_id`) and `tenant_members`
 *     answers. A user who is not a member is refused before anything else is read — the
 *     same answer whether or not the client exists — and `door.deps()`, which builds the
 *     engine's writers, is never called for them.
 *
 * Everything after that is `_shared/ledger/service.ts`.
 */

import { clientActor } from '../_shared/crm/actions.ts';
import { answerOutcome, LEDGER_ERROR_STATUS, markAsked, recordVisit, type LedgerDeps } from '../_shared/ledger/service.ts';

export const LEDGER_ACTIONS = ['outcome-answer', 'outcome-asked', 'visit-booked'] as const;

export const MAX_BODY_BYTES = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LedgerDoor {
  /** the verified sign-in, or null when the token verified as nobody. */
  userId: string | null;
  /** this user's row in `tenant_members` for that client, or null. throws when it cannot be read. */
  membership(tenantId: string, userId: string): Promise<{ role?: string } | null>;
  /** the engine's writers and the ledger's two reads. called only for a member. */
  deps(): LedgerDeps;
}

export interface LedgerAnswer {
  status: number;
  body: Record<string, unknown>;
}

const answer = (body: Record<string, unknown>, status: number): LedgerAnswer => ({ status, body });

export async function handleLedgerAction(door: LedgerDoor, text: string): Promise<LedgerAnswer> {
  const userId = door.userId;
  if (!userId) return answer({ error: 'not signed in', code: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    if (text.length > MAX_BODY_BYTES) return answer({ error: 'the request is too large' }, 413);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return answer({ error: 'body is not a JSON object' }, 400);
  }

  const action = String(body.action ?? '');
  if (action === 'capabilities') return answer({ ok: true, actions: LEDGER_ACTIONS }, 200);
  if (!(LEDGER_ACTIONS as readonly string[]).includes(action)) return answer({ error: 'unknown action' }, 400);
  if (typeof body.tenant_id !== 'string' || !UUID.test(body.tenant_id)) {
    return answer({ error: 'tenant_id is required', code: 'invalid' }, 422);
  }

  let membership: { role?: string } | null;
  try {
    membership = await door.membership(body.tenant_id, userId);
  } catch {
    return answer({ error: 'could not check membership' }, 500);
  }
  /* not a member: the same answer whether or not the tenant exists. */
  const actor = clientActor(userId, body.tenant_id, membership);
  if (!actor) return answer({ error: 'this account does not belong to that client', code: 'forbidden' }, 403);

  try {
    const deps = door.deps();
    const outcome =
      action === 'outcome-answer'
        ? await answerOutcome(deps, actor, { tenantId: body.tenant_id, lead: body.lead, input: body })
        : action === 'visit-booked'
          ? await recordVisit(deps, actor, { tenantId: body.tenant_id, lead: body.lead, appointmentAt: body.appointment_at })
          : await markAsked(deps, actor, { tenantId: body.tenant_id, leads: body.leads });
    if (!outcome.ok) return answer({ error: outcome.message, code: outcome.code }, LEDGER_ERROR_STATUS[outcome.code] ?? 409);
    return answer({ ok: true, ...outcome.result }, 200);
  } catch (failure) {
    console.error(`ledger action ${action} failed`, failure);
    return answer({ error: 'that could not be recorded' }, 500);
  }
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

/** The membership read, from `tenant_members` and nowhere else. */
export function membershipFrom(db: Db): LedgerDoor['membership'] {
  return async (tenantId, userId) => {
    const { data: membership, error } = await db
      .from('tenant_members')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error('could not check membership');
    return membership ?? null;
  };
}
