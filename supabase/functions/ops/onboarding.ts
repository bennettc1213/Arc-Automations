/**
 * The operator surface of ARC-390: putting one client on a route.
 *
 * Behind the `ops` function's admin check like everything in this directory. The actor is
 * the verified token's user, never a field in the body, and 0028 checks it against
 * `arc_admins` again on every write. Every action takes `tenant_id`, and each answers with
 * the whole of where the client's onboarding now stands.
 *
 *   onboarding-overview          what the business said, the plan, each capability and what it
 *                                is right now (ARC, their system, left out, or blocked — with
 *                                the reason), the steps read off what exists, what a change of
 *                                route or authority would do, and the history
 *
 *   onboarding-save              { expected_revision, answers?, plan? }
 *                                the answers, a plan, or both. A plan is a decision on paper:
 *                                this selects no module, records no route and moves no record.
 *                                409 `stale` when the page was drawn from an older revision.
 *
 *   onboarding-authority-apply   { acknowledged }
 *                                record the plan's route and hand each kind of record to the
 *                                side the plan names. `acknowledged` is the digest
 *                                `onboarding-overview` returned beside what this will change;
 *                                409 `impact_changed` if it is no longer that change.      audited
 *
 *   onboarding-enable            { capability }
 *                                the ARC piece behind a capability the plan gives to ARC: the
 *                                pipeline, a draft form, an appointment type and a draft booking
 *                                page. Never published, never switched on. Asking twice makes
 *                                it once.                                                    audited
 *
 * Everything else onboarding leads to is another surface's own action, unchanged: the
 * business profile and services (`crm-profile-save`, `crm-service-save`), forms and imports
 * (`intake-*`), booking (`crm-booking-*`), a module's selection and its way to live
 * (`module-*`, `activation-overview`), a provider's connection (the `connections` function).
 *
 * 422 with `field_errors` lists every problem with an input at once.
 */

import type { CrmActor } from '../_shared/crm/model.ts';
import * as onboarding from '../_shared/onboarding/service.ts';
import { type OnboardingDeps, onboardingErrorStatus, type OnboardingOutcome } from '../_shared/onboarding/service.ts';

export interface OnboardingActionContext {
  deps: OnboardingDeps;
  body: Record<string, unknown>;
  actorId: string | null;
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

type Handler = (deps: OnboardingDeps, actor: CrmActor, body: Record<string, unknown>) => Promise<OnboardingOutcome<unknown>>;

const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  'onboarding-overview': (d, a, b) => onboarding.getOnboarding(d, a, b.tenant_id),
  'onboarding-save': (d, a, b) => onboarding.saveOnboarding(d, a, b.tenant_id, b),
  'onboarding-authority-apply': (d, a, b) => onboarding.applyAuthority(d, a, b.tenant_id, b),
  'onboarding-enable': (d, a, b) => onboarding.enableCapability(d, a, b.tenant_id, b.capability),
});

export const ONBOARDING_ACTIONS = Object.keys(HANDLERS);

export async function handleOnboardingAction(action: string, context: OnboardingActionContext): Promise<ActionResponse> {
  if (!context.actorId) return { status: 401, body: { error: 'not signed in', code: 'unauthorized' } };
  const run = HANDLERS[action];
  if (!run) return { status: 422, body: { error: `"${action}" is not an onboarding action`, code: 'invalid' } };
  const outcome = await run(context.deps, { kind: 'operator', userId: context.actorId }, context.body);
  if (!outcome.ok) {
    return {
      status: onboardingErrorStatus(outcome.code),
      body: { error: outcome.message, code: outcome.code, ...(outcome.fieldErrors ? { field_errors: outcome.fieldErrors } : {}) },
    };
  }
  return { status: 200, body: { ok: true, onboarding: outcome.result } };
}
