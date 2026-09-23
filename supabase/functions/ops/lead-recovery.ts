/**
 * The operator half of Lead Recovery.
 *
 * Everything the ops console can do to a tenant's module lives here, behind the `ops`
 * function's existing admin check — so there is one definition of "is this an operator"
 * and this file never repeats it.
 *
 * Two rules shape the action list:
 *
 * 1. **Activation fails closed.** `activate` re-validates the configuration, re-checks
 *    compliance, and re-reads the onboarding checklist from the database. There is no
 *    override parameter. The way to switch on a module whose campaign is not registered is
 *    to register the campaign.
 *
 * 2. **Nothing here can reach a customer by accident.** `test-routing` is a pure
 *    computation that returns the TwiML that *would* be produced and places no call.
 *    `canary` runs a synthetic lead through the whole engine with a sender that records
 *    instead of sending. Neither one is capable of dialling or texting a real number, and
 *    that is a property of which objects they are given rather than a flag they check.
 *
 * There is deliberately no action that provisions Twilio resources. Buying a number is a
 * billable, externally visible act, and it is done by a person in the Twilio console who
 * then records the reference here.
 */

import {
  canActivate,
  defaultConfig,
  ONBOARDING_STEPS,
  REQUIRED_STEPS,
  validateLeadRecoveryConfig,
} from '../_shared/lead-recovery-config.ts';
import { supabaseStore } from '../_shared/supabase-store.ts';
import {
  intakeLead,
  markBooked,
  resolveHandoffFor,
  runDueActions,
  suppressContact,
  takeOverLead,
  type EngineDeps,
} from '../_shared/engine/runtime.ts';
import { classifierFor, FakeClassifier } from '../_shared/classifier.ts';
import { dialTwiml, RecordingSender, TwilioRestSender } from '../_shared/twilio.ts';
import { normalisePhone } from '../_shared/phone.ts';

export const LEAD_RECOVERY_ACTIONS = [
  'lead-recovery-get',
  'lead-recovery-validate-config',
  'lead-recovery-save-config',
  'lead-recovery-set-step',
  'lead-recovery-activate',
  'lead-recovery-pause',
  'lead-recovery-test-routing',
  'lead-recovery-canary',
  'lead-recovery-retry-action',
  'lead-recovery-take-over',
  'lead-recovery-resolve-handoff',
  'lead-recovery-book',
  'lead-recovery-suppress',
  'lead-recovery-issue-intake-key',
];

const MODULE_KEY = 'lead_recovery';

/**
 * Twilio's own magic number for "a valid mobile that must never be charged or dialled".
 *
 * Used as the canary's customer so that even a catastrophic misconfiguration — the live
 * sender handed to a synthetic run — could not reach a member of the public. The recording
 * sender is the actual guarantee; this is the second one.
 */
export const CANARY_PHONE = '+15005550006';

export interface LeadRecoveryContext {
  // deno-lint-ignore no-explicit-any
  db: any;
  body: Record<string, unknown>;
  actorId: string | null;
  audit(verb: string, targetType: string | null, targetId: string | null, metadata?: Record<string, unknown>): Promise<boolean>;
  env: {
    twilioAccountSid: string;
    twilioAuthToken: string;
    anthropicKey: string;
    publicFunctionsBase: string;
    siteUrl: string;
  };
}

export interface ActionResponse {
  body: Record<string, unknown>;
  status: number;
}

const ok = (body: Record<string, unknown>): ActionResponse => ({ body: { ok: true, ...body }, status: 200 });
const bad = (error: string, status = 400): ActionResponse => ({ body: { error }, status });

/** A postgres error that means migration 0010 has not been applied yet. */
function missingTable(message: string): boolean {
  return /relation .*(module_configs|leads|scheduled_actions|handoffs|suppressions|module_onboarding|intake_keys).* does not exist/i.test(
    message,
  );
}

function needs0010(message: string): ActionResponse {
  return {
    body: { error: 'lead recovery needs supabase/migrations/0010_lead_recovery.sql applied first', detail: message },
    status: 501,
  };
}

function depsFor(context: LeadRecoveryContext, options: { synthetic?: boolean } = {}): EngineDeps {
  const { env } = context;
  return {
    store: supabaseStore(context.db),
    now: () => new Date(),
    /* a synthetic run is given a recording sender in BOTH slots. the engine would already
       pick the canary one off `lead.isCanary`, and this makes it impossible for a bug in
       that branch to produce a live send from an operator's test button. */
    liveSender: options.synthetic
      ? new RecordingSender()
      : new TwilioRestSender(env.twilioAccountSid, env.twilioAuthToken),
    canarySender: new RecordingSender(),
    classifierFor: (config) =>
      options.synthetic ? new FakeClassifier() : classifierFor(config, { anthropicKey: env.anthropicKey || null }),
    urls: {
      statusCallback: `${env.publicFunctionsBase}/twilio/message-status`,
      leadInConsole: (tenantId) => (env.siteUrl ? `${env.siteUrl}/ops/console/clients/${tenantId}` : null),
    },
    uuid: () => crypto.randomUUID(),
    worker: 'ops-console',
  };
}

/** An opaque, rotatable public key for a website form. */
function newIntakeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  /* 36 does not divide 256, so the modulo is very slightly biased. Said out loud and
     accepted: this is an identifier printed in public HTML, not a credential, and its
     security property is "unguessable enough to not be enumerated", which 28 characters of
     base36 provides with room to spare. */
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `arcw_${out}${Date.now().toString(36)}`;
}

export async function handleLeadRecoveryAction(
  action: string,
  context: LeadRecoveryContext,
): Promise<ActionResponse> {
  const { db, body } = context;
  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
  if (!tenantId) return bad('tenant_id is required');

  try {
    switch (action) {
      // ── everything the console needs to draw the panel, in one round trip ──
      case 'lead-recovery-get': {
        const [configRead, stepsRead, keyRead, runsRead, failedRead, handoffRead, leadRead] = await Promise.all([
          db.from('module_configs').select('*').eq('tenant_id', tenantId).eq('module_key', MODULE_KEY).maybeSingle(),
          db.from('module_onboarding').select('*').eq('tenant_id', tenantId).eq('module_key', MODULE_KEY),
          db.from('intake_keys').select('id, public_key, label, allowed_origins, created_at, last_used_at, revoked_at').eq('tenant_id', tenantId).is('revoked_at', null),
          db.from('automation_runs').select('state').eq('tenant_id', tenantId).eq('module_key', MODULE_KEY),
          db.from('scheduled_actions').select('*').eq('tenant_id', tenantId).eq('status', 'failed').order('completed_at', { ascending: false }).limit(25),
          db.from('handoffs').select('*').eq('tenant_id', tenantId).eq('status', 'open').order('opened_at', { ascending: false }).limit(25),
          db.from('leads').select('id, correlation_id, customer_name, phone, source, status, urgency, safety_flags, ai_summary, booking_outcome, is_canary, created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(25),
        ]);

        for (const read of [configRead, stepsRead, keyRead, runsRead, failedRead, handoffRead, leadRead]) {
          if (read.error && missingTable(read.error.message)) return needs0010(read.error.message);
          if (read.error) return bad(`read failed: ${read.error.message}`, 500);
        }

        const config = configRead.data?.config ?? null;
        const validation = config ? validateLeadRecoveryConfig(config) : null;

        const done = (stepsRead.data ?? []).filter((s: { done_at: string | null }) => s.done_at).map((s: { step_key: string }) => s.step_key);
        const activation = config ? canActivate(config, done) : { ok: false, blockers: ['no configuration yet'], missingSteps: REQUIRED_STEPS };

        /* run states, counted rather than listed: the panel shows "how many are waiting on
           a person" not a table of uuids. */
        const byState: Record<string, number> = {};
        for (const row of runsRead.data ?? []) byState[row.state] = (byState[row.state] ?? 0) + 1;

        return ok({
          configured: Boolean(configRead.data),
          enabled: configRead.data?.enabled ?? false,
          schema_version: configRead.data?.schema_version ?? null,
          config_version: configRead.data?.config_version ?? null,
          updated_at: configRead.data?.updated_at ?? null,
          config: config ?? defaultConfig(),
          valid: validation ? validation.ok : false,
          errors: validation && !validation.ok ? validation.errors : [],
          warnings: validation?.warnings ?? [],
          compliance: validation?.ok ? validation.config.compliance.status : (config as { compliance?: { status?: string } })?.compliance?.status ?? 'not_started',
          steps: ONBOARDING_STEPS.map((step) => {
            const row = (stepsRead.data ?? []).find((s: { step_key: string }) => s.step_key === step.key);
            return { ...step, done_at: row?.done_at ?? null, note: row?.note ?? null };
          }),
          activation,
          intake_keys: keyRead.data ?? [],
          runs_by_state: byState,
          failed_actions: failedRead.data ?? [],
          open_handoffs: handoffRead.data ?? [],
          recent_leads: leadRead.data ?? [],
        });
      }

      // ── validate without writing. the console calls this as the operator types ──
      case 'lead-recovery-validate-config': {
        const result = validateLeadRecoveryConfig(body.config);
        return ok({
          valid: result.ok,
          errors: result.ok ? [] : result.errors,
          warnings: result.warnings,
          /* the normalised object, so the console can show what would actually be stored
             rather than what was typed. */
          config: result.ok ? result.config : null,
        });
      }

      case 'lead-recovery-save-config': {
        const result = validateLeadRecoveryConfig(body.config);
        if (!result.ok) {
          return { body: { error: 'the configuration is not valid', errors: result.errors, warnings: result.warnings }, status: 422 };
        }

        /* the validated, normalised object is what is stored — never the raw body. a key
           the schema dropped must not survive into the database by the back door. */
        const { data, error } = await db
          .from('module_configs')
          .upsert(
            { tenant_id: tenantId, module_key: MODULE_KEY, config: result.config, schema_version: 1 },
            { onConflict: 'tenant_id,module_key' },
          )
          .select('*')
          .single();

        if (error) {
          if (missingTable(error.message)) return needs0010(error.message);
          return bad(`save failed: ${error.message}`, 500);
        }

        /* saving valid business rules is what step 2 means, so it ticks itself. an
           operator ticking a box to say the thing they just did was done is theatre. */
        await db
          .from('module_onboarding')
          .upsert(
            { tenant_id: tenantId, module_key: MODULE_KEY, step_key: 'business_rules', done_at: new Date().toISOString() },
            { onConflict: 'tenant_id,module_key,step_key' },
          );

        const logged = await context.audit('lead_recovery.config_saved', 'tenant', tenantId, {
          config_version: data.config_version,
          compliance: result.config.compliance.status,
          warnings: result.warnings.length,
        });

        return ok({ config_version: data.config_version, warnings: result.warnings, logged });
      }

      case 'lead-recovery-set-step': {
        const stepKey = typeof body.step_key === 'string' ? body.step_key : '';
        if (!ONBOARDING_STEPS.some((s) => s.key === stepKey)) return bad(`"${stepKey}" is not a step in this checklist`);
        const done = body.done !== false;

        const { error } = await db.from('module_onboarding').upsert(
          {
            tenant_id: tenantId,
            module_key: MODULE_KEY,
            step_key: stepKey,
            /* the browser sends a boolean. the timestamp and the operator's id are the
               database's, via the trigger 0008 introduced and 0010 reuses. */
            done_at: done ? new Date().toISOString() : null,
            note: typeof body.note === 'string' ? body.note.slice(0, 300) : null,
          },
          { onConflict: 'tenant_id,module_key,step_key' },
        );

        if (error) {
          if (missingTable(error.message)) return needs0010(error.message);
          return bad(`step update failed: ${error.message}`, 500);
        }

        const logged = await context.audit(done ? 'lead_recovery.step_completed' : 'lead_recovery.step_reopened', 'tenant', tenantId, { step: stepKey });
        return ok({ step: stepKey, done, logged });
      }

      // ── the gate ──
      case 'lead-recovery-activate': {
        const [configRead, stepsRead] = await Promise.all([
          db.from('module_configs').select('*').eq('tenant_id', tenantId).eq('module_key', MODULE_KEY).maybeSingle(),
          db.from('module_onboarding').select('step_key, done_at').eq('tenant_id', tenantId).eq('module_key', MODULE_KEY),
        ]);
        if (configRead.error && missingTable(configRead.error.message)) return needs0010(configRead.error.message);
        if (!configRead.data) return bad('this tenant has no lead recovery configuration to activate', 409);

        const done = (stepsRead.data ?? []).filter((s: { done_at: string | null }) => s.done_at).map((s: { step_key: string }) => s.step_key);
        const check = canActivate(configRead.data.config, done);

        /* fail closed, and say everything that is wrong rather than the first thing. */
        if (!check.ok) {
          return {
            body: {
              error: 'this module cannot be activated yet',
              blockers: check.blockers,
              missing_steps: check.missingSteps,
            },
            status: 409,
          };
        }

        const { error } = await db
          .from('module_configs')
          .update({ enabled: true })
          .eq('tenant_id', tenantId)
          .eq('module_key', MODULE_KEY);
        if (error) return bad(`activation failed: ${error.message}`, 500);

        await db.from('module_onboarding').upsert(
          { tenant_id: tenantId, module_key: MODULE_KEY, step_key: 'module_activated', done_at: new Date().toISOString() },
          { onConflict: 'tenant_id,module_key,step_key' },
        );

        const logged = await context.audit('lead_recovery.activated', 'tenant', tenantId, {
          config_version: configRead.data.config_version,
        });
        return ok({ enabled: true, logged });
      }

      case 'lead-recovery-pause': {
        const { error } = await db
          .from('module_configs')
          .update({ enabled: false })
          .eq('tenant_id', tenantId)
          .eq('module_key', MODULE_KEY);
        if (error) {
          if (missingTable(error.message)) return needs0010(error.message);
          return bad(`pause failed: ${error.message}`, 500);
        }

        /* pausing stops new sequences. anything already queued is cancelled too, because
           "paused" that still texts four people over the next hour is not paused. */
        const { data: cancelled } = await db
          .from('scheduled_actions')
          .update({ status: 'cancelled', last_error: 'the module was paused', completed_at: new Date().toISOString() })
          .eq('tenant_id', tenantId)
          .eq('status', 'pending')
          .select('id');

        const logged = await context.audit('lead_recovery.paused', 'tenant', tenantId, {
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
          cancelled: cancelled?.length ?? 0,
        });
        return ok({ enabled: false, cancelled_actions: cancelled?.length ?? 0, logged });
      }

      // ── a dry run of the voice webhook. no call is placed ──
      case 'lead-recovery-test-routing': {
        const { data, error } = await db
          .from('module_configs')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('module_key', MODULE_KEY)
          .maybeSingle();
        if (error && missingTable(error.message)) return needs0010(error.message);
        if (!data) return bad('this tenant has no lead recovery configuration', 404);

        const result = validateLeadRecoveryConfig(data.config);
        if (!result.ok) return { body: { error: 'the configuration is not valid', errors: result.errors }, status: 422 };

        const config = result.config;
        if (!config.twilio.phone_number) {
          return { body: { error: 'no Twilio number is recorded, so no webhook would ever reach this tenant' }, status: 409 };
        }

        /* the same function the live webhook calls, on the same config. nothing is dialled
           and nothing is written — this is a computation whose output is XML. */
        const xml = dialTwiml({
          destination: config.forwarding.destination,
          timeoutSeconds: config.forwarding.timeout_seconds,
          actionUrl: `${context.env.publicFunctionsBase}/twilio/dial-status`,
          callerId: null,
        });

        /* the routing question asked the other way round: does the number this tenant
           claims actually resolve back to them, and only to them? */
        const { data: claimants } = await db
          .from('module_configs')
          .select('tenant_id')
          .eq('module_key', MODULE_KEY)
          .contains('config', { twilio: { phone_number: config.twilio.phone_number } });

        const conflicts = (claimants ?? []).map((row: { tenant_id: string }) => row.tenant_id).filter((id: string) => id !== tenantId);

        return ok({
          dry_run: true,
          number: config.twilio.phone_number,
          forwards_to: config.forwarding.destination,
          timeout_seconds: config.forwarding.timeout_seconds,
          twiml: xml,
          webhooks: {
            voice: `${context.env.publicFunctionsBase}/twilio/voice`,
            dial_status: `${context.env.publicFunctionsBase}/twilio/dial-status`,
            sms: `${context.env.publicFunctionsBase}/twilio/sms`,
            message_status: `${context.env.publicFunctionsBase}/twilio/message-status`,
          },
          conflicts,
          resolves: conflicts.length === 0,
        });
      }

      // ── a synthetic lead, end to end, that cannot reach anybody ──
      case 'lead-recovery-canary': {
        const deps = depsFor(context, { synthetic: true });
        const stamp = new Date().toISOString();

        const intake = await intakeLead(deps, {
          tenantId,
          source: 'web_form',
          externalRef: `canary:${stamp}`,
          phone: CANARY_PHONE,
          customerName: 'Arc canary',
          serviceRequest: typeof body.scenario === 'string' && body.scenario.trim()
            ? body.scenario.slice(0, 300)
            : 'no heat upstairs, thermostat is blank',
          zip: null,
          intakeRef: 'arc-canary',
          consentSms: true,
          consentSource: 'operator',
          isCanary: true,
        });

        /* run the canary's own work, and nothing else.
 
           This call used to be `runDueActions(deps, { limit: 10 })` over a claim
           function that took no tenant — so pressing "run canary" for one client
           claimed whatever was due for *every* client and pushed it through a
           recording sender. Those customers' texts were never delivered, the actions
           were marked done, and a successful `sms_sent` was written against their
           dashboards (audit S-C1).
 
           Both guards are needed. `tenantId` keeps the claim inside this client, and
           `canaryOnly` keeps it to synthetic leads, so even this tenant's own real
           queue is untouched by a test. */
        const dispatched = await runDueActions(deps, {
          limit: 10,
          worker: 'ops-canary',
          tenantId,
          canaryOnly: true,
        });

        const run = intake.run ? await deps.store.getRun(tenantId, intake.run.id) : null;
        const actions = intake.run ? await deps.store.listActionsForRun(tenantId, intake.run.id) : [];

        const passed = Boolean(intake.lead) && (run?.state === 'awaiting_reply' || run?.state === 'handoff_required');
        if (passed) {
          await db.from('module_onboarding').upsert(
            { tenant_id: tenantId, module_key: MODULE_KEY, step_key: 'canary_passed', done_at: new Date().toISOString() },
            { onConflict: 'tenant_id,module_key,step_key' },
          );
        }

        const logged = await context.audit('lead_recovery.canary_run', 'tenant', tenantId, {
          passed,
          state: run?.state ?? null,
          outcome: intake.outcome,
        });

        return ok({
          passed,
          outcome: intake.outcome,
          state: run?.state ?? null,
          lead_id: intake.lead?.id ?? null,
          correlation_id: intake.lead?.correlationId ?? null,
          actions: actions.map((a) => ({ type: a.actionType, status: a.status, error: a.lastError })),
          dispatched,
          /* said plainly on the response so nobody has to take it on trust. */
          note: 'nothing was sent — a synthetic run is given a recording sender and Twilio\'s reserved test number',
          logged,
        });
      }

      // ── failures an operator can do something about ──
      case 'lead-recovery-retry-action': {
        const actionId = typeof body.action_id === 'string' ? body.action_id : '';
        if (!actionId) return bad('action_id is required');

        const store = supabaseStore(db);
        const retried = await store.retryAction(tenantId, actionId, new Date().toISOString());
        if (!retried) {
          return bad(
            'that action is not a failed action for this client, or it was queued before configuration pinning and can never run — resolve its lead by hand instead',
            409,
          );
        }

        const logged = await context.audit('lead_recovery.action_retried', 'tenant', tenantId, {
          action_id: actionId,
          action_type: retried.actionType,
        });
        return ok({ action: { id: retried.id, type: retried.actionType, run_at: retried.runAt }, logged });
      }

      case 'lead-recovery-take-over': {
        const leadId = typeof body.lead_id === 'string' ? body.lead_id : '';
        if (!leadId) return bad('lead_id is required');
        const deps = depsFor(context);
        const result = await takeOverLead(deps, {
          tenantId,
          leadId,
          actor: typeof body.actor === 'string' ? body.actor.slice(0, 80) : null,
          note: typeof body.note === 'string' ? body.note.slice(0, 300) : null,
        });
        if (!result.ok) return bad(result.outcome, 404);
        const logged = await context.audit('lead_recovery.lead_taken_over', 'lead', leadId, { tenant_id: tenantId });
        return ok({ outcome: result.outcome, logged });
      }

      case 'lead-recovery-resolve-handoff': {
        const handoffId = typeof body.handoff_id === 'string' ? body.handoff_id : '';
        if (!handoffId) return bad('handoff_id is required');
        const deps = depsFor(context);
        const result = await resolveHandoffFor(deps, {
          tenantId,
          handoffId,
          resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution : 'resolved',
          actorId: context.actorId,
        });
        if (!result.ok) return bad(result.outcome, 404);
        const logged = await context.audit('lead_recovery.handoff_resolved', 'handoff', handoffId, { tenant_id: tenantId });
        return ok({ outcome: result.outcome, logged });
      }

      case 'lead-recovery-book': {
        const leadId = typeof body.lead_id === 'string' ? body.lead_id : '';
        if (!leadId) return bad('lead_id is required');
        const deps = depsFor(context);
        const outcomes = ['booked', 'declined', 'no_response', 'not_a_fit', 'duplicate'];
        const outcome = typeof body.outcome === 'string' && outcomes.includes(body.outcome) ? body.outcome : 'booked';
        const result = await markBooked(deps, {
          tenantId,
          leadId,
          outcome: outcome as 'booked',
          valueCents: typeof body.value_cents === 'number' ? body.value_cents : null,
          actor: typeof body.actor === 'string' ? body.actor.slice(0, 80) : null,
        });
        if (!result.ok) return bad(result.outcome, 404);
        const logged = await context.audit('lead_recovery.outcome_recorded', 'lead', leadId, { tenant_id: tenantId, outcome });
        return ok({ outcome: result.outcome, logged });
      }

      case 'lead-recovery-suppress': {
        const channel = body.channel === 'email' ? 'email' : 'sms';
        const address = typeof body.address === 'string' ? body.address : '';
        const reasons = ['opt_out', 'wrong_contact', 'compliance', 'staff_suppressed', 'bounced', 'other'];
        const reason = typeof body.reason === 'string' && reasons.includes(body.reason) ? body.reason : 'staff_suppressed';

        const deps = depsFor(context);
        const result = await suppressContact(deps, { tenantId, channel, address, reason });
        if (!result.ok) return bad(result.outcome);

        const logged = await context.audit('lead_recovery.contact_suppressed', 'tenant', tenantId, {
          channel,
          /* the last four only. a suppression log that prints the whole number is a list of
             customers in a table operators browse. */
          address: channel === 'sms' ? `•••${(normalisePhone(address) ?? '').slice(-4)}` : address.replace(/^(.).*(@.*)$/, '$1•••$2'),
          reason,
        });
        return ok({ outcome: result.outcome, logged });
      }

      // ── the website form's public key ──
      case 'lead-recovery-issue-intake-key': {
        const origins = Array.isArray(body.allowed_origins)
          ? body.allowed_origins
              .filter((o): o is string => typeof o === 'string')
              .map((o) => o.trim())
              .filter(Boolean)
              .slice(0, 10)
          : [];

        /* an origin is a scheme and a host, nothing else. a path or a wildcard here would
           be silently ignored by the browser check and give an operator a false sense of
           what they had configured. */
        for (const origin of origins) {
          let parsed: URL;
          try {
            parsed = new URL(origin);
          } catch {
            return bad(`"${origin}" is not an origin — it should look like https://example.com`);
          }
          if (parsed.origin !== origin.replace(/\/+$/, '')) {
            return bad(`"${origin}" should be just the scheme and host, for example ${parsed.origin}`);
          }
          if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
            return bad(`"${origin}" must be https`);
          }
        }

        /* rotation is "revoke the old, issue the new" rather than an update, so a key that
           was ever published stays revoked and a request carrying it is refused rather
           than silently belonging to somebody else's form. */
        if (body.rotate === true) {
          await db.from('intake_keys').update({ revoked_at: new Date().toISOString() }).eq('tenant_id', tenantId).is('revoked_at', null);
        }

        const publicKey = newIntakeKey();
        const { data, error } = await db
          .from('intake_keys')
          .insert({
            tenant_id: tenantId,
            public_key: publicKey,
            label: typeof body.label === 'string' ? body.label.slice(0, 80) : 'website form',
            allowed_origins: origins,
          })
          .select('id, public_key, allowed_origins, created_at')
          .single();

        if (error) {
          if (missingTable(error.message)) return needs0010(error.message);
          return bad(`could not issue a key: ${error.message}`, 500);
        }

        if (origins.length > 0) {
          await db.from('module_onboarding').upsert(
            { tenant_id: tenantId, module_key: MODULE_KEY, step_key: 'website_origin', done_at: new Date().toISOString() },
            { onConflict: 'tenant_id,module_key,step_key' },
          );
        }

        const logged = await context.audit('lead_recovery.intake_key_issued', 'tenant', tenantId, {
          rotated: body.rotate === true,
          origins,
        });

        return ok({
          key: data,
          snippet: `<div data-arc-lead-form></div>\n<script defer src="${context.env.publicFunctionsBase}/lead-intake/embed.js?key=${publicKey}"></script>`,
          logged,
        });
      }

      default:
        return bad(`"${action}" is not a lead recovery action`, 400);
    }
  } catch (error) {
    const message = (error as Error)?.message ?? 'the action failed';
    if (missingTable(message)) return needs0010(message);
    console.error(`lead recovery action ${action} failed`, error);
    return bad(message, 500);
  }
}
