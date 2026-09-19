-- ARC Lead Recovery: the first execution layer.
--
-- Every module before this one *observed*. An adapter watched somebody else's
-- system — a CRM, a billing provider, an n8n workflow — and posted evidence of
-- what it saw to /ingest, and the portal folded that evidence back into records.
-- Nothing in this repository has ever decided what happens next.
--
-- Lead Recovery does. A call rings out, Arc sends the text, waits for the reply,
-- classifies it, and either routes it to the contractor or stops and fetches a
-- person. That is a state machine with money and a customer's phone on the other
-- end of it, and a state machine needs somewhere to keep its state.
--
-- ---------------------------------------------------------------------------
-- Why this is new tables rather than more events
-- ---------------------------------------------------------------------------
--
-- 0009 deliberately added no tables, because the client's CRM was the system of
-- record for estimates and a synced copy of it would be stale between syncs.
-- That reasoning does not transfer. Arc *is* the system of record for its own
-- automation: nobody else knows that a follow-up is due at 14:20, that two
-- workers must not both send it, or that this run stopped because the customer
-- texted STOP. Deriving "what must happen next" from an append-only log on every
-- render would mean scanning the log to decide whether to send a text, and a
-- missed row there is a message sent to somebody who opted out.
--
-- So the split is explicit, and it is the rule for everything below:
--
--   operational tables (here)   current state, and what must happen next.
--                               mutable, locked, claimed, reconciled.
--   public.events (0001-0009)   append-only evidence of what happened.
--                               never read to make a decision, only to report.
--
-- Both are written by the engine, and the portal keeps deriving every *figure*
-- from `events` exactly as it always has. No number on any page reads these
-- tables. That invariant is why the console and a client's dashboard cannot
-- disagree, and this migration does not touch it.
--
-- ---------------------------------------------------------------------------
-- Why one shared schema and no per-customer anything
-- ---------------------------------------------------------------------------
--
-- There is one `lead_recovery` module, one engine, one set of templates and one
-- prompt. What differs between an HVAC shop in Columbus and a plumber in Boise
-- is *configuration*, and configuration lives in `module_configs.config` as
-- validated JSON — no expressions, no callbacks, no per-tenant SQL, nothing
-- executable. A tenant that needs behaviour the config cannot express is a
-- feature request against the shared engine, not a branch.
--
-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
--
-- Every row carries `tenant_id`, and every relationship between two of these
-- tables is a COMPOSITE foreign key through `(id, tenant_id)` — the trick 0008
-- used for service steps. It makes a cross-tenant link structurally impossible
-- rather than merely prohibited: you cannot attach tenant A's conversation to
-- tenant B's lead even with the service role and a bug, because there is no such
-- row to point at.
--
-- RLS is enabled on every table. Clients get SELECT on their own rows and
-- nothing else; there is no client write path anywhere in this schema and this
-- migration does not open one. Operators get SELECT everywhere through
-- is_arc_admin(). Every mutation goes through an edge function under the service
-- role, which is where validation, idempotency and signature checks live.
--
-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
--
--   drop function if exists public.claim_scheduled_actions(integer, text, integer);
--   drop function if exists public.touch_module_config();
--   drop table if exists public.scheduled_actions, public.handoffs,
--     public.messages, public.conversations, public.automation_runs,
--     public.suppressions, public.leads, public.module_onboarding,
--     public.intake_keys, public.module_configs cascade;
--
-- Nothing in 0001-0009 is altered, so dropping all of the above returns the
-- database to its 0009 state exactly. The events these tables produced stay —
-- they are evidence of things that really happened.

-- ---------------------------------------------------------------------------
-- 1. module_configs — the only place a tenant differs
-- ---------------------------------------------------------------------------

create table if not exists public.module_configs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  module_key     text not null check (module_key in ('lead_recovery')),

  -- the shape of `config`, so an engine reading a record written by an older
  -- release knows whether it can. bumped by a deploy, never by an operator.
  schema_version integer not null default 1 check (schema_version > 0),

  -- the master switch. false is the default and activation is fail-closed: the
  -- ops function refuses to set it true until every required onboarding step is
  -- ticked. a module that can be switched on by accident is a module that texts
  -- somebody's customers by accident.
  enabled        boolean not null default false,

  -- validated by supabase/functions/_shared/lead-recovery-config.ts before it is
  -- ever written. json rather than forty columns because the shape belongs to
  -- the module, and a new field on one module should not be a migration on a
  -- table three other modules share. no key in here may hold a credential, a
  -- token or an api key — the check constraint below is a blunt instrument
  -- aimed at exactly that mistake.
  config         jsonb not null default '{}'::jsonb,

  -- increments on every content change (trigger below). an automation_run pins
  -- the version it started under, so a config edited mid-sequence cannot
  -- retroactively change what a running sequence was allowed to do.
  config_version integer not null default 1,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (tenant_id, module_key),
  -- lets anything that must belong to one tenant's config prove it.
  unique (id, tenant_id),

  -- belt and braces against a secret being pasted into configuration. the real
  -- defence is the validator, which whitelists keys; this catches the case where
  -- something bypasses it.
  constraint module_configs_no_secrets check (
    config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  )
);

create index if not exists module_configs_tenant_idx
  on public.module_configs (tenant_id, module_key);

-- updated_at and config_version are the database's to set. a caller that could
-- write its own version number could pin a run to a config that never existed.
create or replace function public.touch_module_config()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.config is distinct from old.config then
      new.config_version := old.config_version + 1;
    else
      new.config_version := old.config_version;
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists module_configs_touch on public.module_configs;
create trigger module_configs_touch
  before insert or update on public.module_configs
  for each row execute function public.touch_module_config();

-- ---------------------------------------------------------------------------
-- 2. intake_keys — the website form's public identifier
-- ---------------------------------------------------------------------------

-- A form on the client's website has to name which tenant it belongs to, and
-- that name is readable by anyone who views source. Putting the tenant UUID
-- there hands out a primary key that appears in every other table; putting an
-- opaque per-tenant string there hands out a string that means nothing anywhere
-- else and can be rotated in one update.
--
-- Stored in the clear, unlike ingest_tokens. This is deliberate and is the
-- opposite decision to that one, for a reason: an ingest token is a bearer
-- credential that must never be recoverable, whereas an intake key is published
-- in HTML on a public website. Hashing a value that is printed on the internet
-- buys nothing and costs the operator the ability to read their own snippet back.
-- What actually protects this endpoint is the origin allowlist, the rate limit,
-- the honeypot, and the fact that the only thing it can do is create a lead.
create table if not exists public.intake_keys (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  public_key      text not null unique check (public_key ~ '^arcw_[a-z0-9]{24,48}$'),
  label           text,
  -- origins the browser form may post from. empty means "not yet configured",
  -- which the endpoint treats as refuse, not as allow-all.
  allowed_origins text[] not null default '{}',
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

create index if not exists intake_keys_tenant_idx on public.intake_keys (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. leads — the narrow operational record
-- ---------------------------------------------------------------------------

-- Narrow on purpose. This is not a CRM, and the out-of-scope list says so: it
-- holds what the engine needs in order to decide what to do next, and what the
-- portal needs in order to name the row. Everything else about the customer
-- lives in the contractor's own system.
create table if not exists public.leads (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,

  -- the thread id every event for this lead carries. one correlation_id per
  -- lead lifecycle is the rule the whole event contract rests on, so it is
  -- unique per tenant here rather than merely indexed.
  correlation_id   uuid not null,

  source           text not null check (source in ('missed_call', 'web_form', 'inbound_sms', 'manual')),
  -- what the caller dialled, or which number the form was wired to. kept so an
  -- operator can tell two routing numbers apart without joining config.
  intake_ref       text,

  customer_name    text,
  -- E.164. normalised at the boundary, never as typed, because a suppression
  -- list holding "(614) 555-0137" does not match "+16145550137".
  phone            text check (phone is null or phone ~ '^\+[1-9][0-9]{7,15}$'),
  email            text,

  service_request  text,
  location_zip     text,
  location_text    text,
  urgency          text check (urgency is null or urgency in ('emergency', 'same_day', 'this_week', 'scheduling', 'unknown')),
  safety_flags     text[] not null default '{}',
  -- the classifier's one-line summary. a summary, never an instruction: nothing
  -- downstream branches on this text.
  ai_summary       text,

  status           text not null default 'new' check (status in (
    'new', 'contacted', 'awaiting_reply', 'qualifying', 'qualified',
    'handoff_required', 'handed_off', 'booked', 'closed', 'suppressed'
  )),

  -- consent, recorded rather than assumed. a missed call is implied consent to
  -- reply to the number that just dialled you; a web form is an explicit tick.
  -- both are written down, with where they came from.
  consent_sms      boolean not null default false,
  consent_source   text check (consent_source is null or consent_source in ('inbound_call', 'web_form', 'inbound_sms', 'operator')),
  consent_at       timestamptz,

  assigned_to      text,
  assigned_user_id uuid references auth.users(id) on delete set null,

  booking_outcome  text check (booking_outcome is null or booking_outcome in ('booked', 'declined', 'no_response', 'not_a_fit', 'duplicate')),
  booked_at        timestamptz,

  -- a synthetic lead. it traverses the entire engine and is excluded from every
  -- client-facing count, exactly as events.is_canary is — and the dispatcher
  -- refuses to let one reach a real phone.
  is_canary        boolean not null default false,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (tenant_id, correlation_id),
  unique (id, tenant_id)
);

create index if not exists leads_tenant_created_idx on public.leads (tenant_id, created_at desc);
create index if not exists leads_tenant_status_idx on public.leads (tenant_id, status, created_at desc);
create index if not exists leads_tenant_phone_idx on public.leads (tenant_id, phone) where phone is not null;

-- ---------------------------------------------------------------------------
-- 4. conversations and messages
-- ---------------------------------------------------------------------------

create table if not exists public.conversations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  lead_id        uuid not null,
  channel        text not null default 'sms' check (channel in ('sms')),
  provider       text not null default 'twilio' check (provider in ('twilio')),
  -- the provider's own handle for the thread, when it has one.
  provider_ref   text,
  status         text not null default 'open' check (status in ('open', 'closed', 'suppressed')),
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- one thread per lead per channel. a second one would split a conversation in
  -- half and let a stop-on-reply check pass while the customer is mid-sentence
  -- in the other half.
  unique (tenant_id, lead_id, channel),
  unique (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.leads (id, tenant_id) on delete cascade
);

create index if not exists conversations_tenant_idx on public.conversations (tenant_id, updated_at desc);

create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  conversation_id     uuid not null,
  direction           text not null check (direction in ('inbound', 'outbound')),

  -- Twilio's SID. the unique index below is what makes a redelivered webhook a
  -- no-op instead of a second row, and a second row here is a second "message
  -- delivered" on somebody's dashboard.
  provider_message_id text,

  body                text,
  status              text not null default 'queued' check (status in (
    'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received', 'blocked'
  )),
  -- the same eight-value vocabulary events.error_class uses, so a failure reads
  -- as the same word in the run log and in the message row behind it.
  error_class         text check (error_class is null or error_class in (
    'auth', 'delivery', 'schema', 'rate_limit', 'timeout', 'upstream', 'config', 'unknown'
  )),
  error_detail        text,

  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  foreign key (conversation_id, tenant_id)
    references public.conversations (id, tenant_id) on delete cascade
);

-- idempotency for provider callbacks. partial, because an outbound row exists
-- for a moment before the provider has given it a sid.
create unique index if not exists messages_provider_id_uniq
  on public.messages (tenant_id, provider_message_id)
  where provider_message_id is not null;

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, occurred_at desc);
create index if not exists messages_tenant_failed_idx
  on public.messages (tenant_id, occurred_at desc)
  where status in ('failed', 'undelivered', 'blocked');

-- ---------------------------------------------------------------------------
-- 5. automation_runs — one state machine instance per lead
-- ---------------------------------------------------------------------------

create table if not exists public.automation_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  lead_id        uuid not null,
  module_key     text not null default 'lead_recovery' check (module_key in ('lead_recovery')),

  -- the states in supabase/functions/_shared/engine/state-machine.ts. the check
  -- constraint is a copy of that list and is meant to be: an engine that invents
  -- a state must fail loudly at the write rather than quietly store it.
  state          text not null default 'new' check (state in (
    'new', 'response_queued', 'awaiting_reply', 'qualifying', 'qualified',
    'handoff_required', 'handed_off', 'booked', 'closed', 'suppressed', 'failed'
  )),

  -- which module_configs.config_version this run started under.
  config_version integer not null default 1,

  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- stopped: the sequence will send nothing more. completed: it reached a
  -- terminal state cleanly. a run can be stopped without being completed — an
  -- opt-out is a stop, not a success.
  stopped_at     timestamptz,
  completed_at   timestamptz,
  stop_reason    text check (stop_reason is null or stop_reason in (
    'opted_out', 'human_takeover', 'safety', 'booked', 'closed', 'failed', 'replaced', 'not_permitted'
  )),
  last_error     text,

  -- one run per lead per module. the engine is not allowed to start a second
  -- sequence against a customer who is already in one.
  unique (tenant_id, lead_id, module_key),
  unique (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.leads (id, tenant_id) on delete cascade
);

create index if not exists automation_runs_tenant_state_idx
  on public.automation_runs (tenant_id, state, updated_at desc);

-- ---------------------------------------------------------------------------
-- 6. scheduled_actions — the durable queue
-- ---------------------------------------------------------------------------

-- Everything the engine will do in the future is a row here. Not a setTimeout,
-- not an n8n Wait node, not a cron that re-derives intent from the log: a row,
-- with a time, an idempotency key and an attempt count, that exactly one worker
-- may claim.
create table if not exists public.scheduled_actions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  run_id          uuid not null,

  action_type     text not null check (action_type in (
    'send_first_response', 'send_followup', 'classify_reply', 'route_to_contractor',
    'open_handoff', 'close_run', 'notify_staff'
  )),
  run_at          timestamptz not null,

  status          text not null default 'pending' check (status in (
    'pending', 'claimed', 'done', 'cancelled', 'failed'
  )),

  -- stable across retries and across duplicate webhooks. "the first response for
  -- run X" has exactly one key, so a Twilio callback delivered three times
  -- queues one message.
  idempotency_key text not null,

  attempts        integer not null default 0 check (attempts >= 0),
  max_attempts    integer not null default 5 check (max_attempts > 0),

  -- set together by claim_scheduled_actions(). locked_at doubles as the lease
  -- clock: a worker that dies mid-action leaves a claimed row whose lease
  -- expires and which the next sweep may take.
  locked_at       timestamptz,
  locked_by       text,

  last_error      text,
  -- carried on the action rather than looked up, so a retry sends the same thing
  -- it was queued to send even if something else moved on.
  payload         jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  completed_at    timestamptz,

  unique (tenant_id, idempotency_key),
  foreign key (run_id, tenant_id)
    references public.automation_runs (id, tenant_id) on delete cascade
);

-- the dispatcher's own query: due, not yet taken, oldest first.
create index if not exists scheduled_actions_due_idx
  on public.scheduled_actions (run_at)
  where status = 'pending';
create index if not exists scheduled_actions_lease_idx
  on public.scheduled_actions (locked_at)
  where status = 'claimed';
create index if not exists scheduled_actions_run_idx
  on public.scheduled_actions (run_id, status);
create index if not exists scheduled_actions_tenant_failed_idx
  on public.scheduled_actions (tenant_id, completed_at desc)
  where status = 'failed';

-- ---------------------------------------------------------------------------
-- 7. handoffs — where a person takes over
-- ---------------------------------------------------------------------------

create table if not exists public.handoffs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  lead_id      uuid not null,
  run_id       uuid,

  reason       text not null,
  -- the machine-readable half, so "how often does this happen" is a group-by
  -- rather than a text search.
  reason_code  text not null check (reason_code in (
    'safety', 'low_confidence', 'ambiguous_scope', 'out_of_area', 'no_capacity',
    'customer_asked', 'classifier_unavailable', 'delivery_failed', 'staff_request', 'other'
  )),
  -- computed from deterministic rules, never from the classifier's opinion.
  is_safety    boolean not null default false,

  assigned_to  text,
  status       text not null default 'open' check (status in ('open', 'resolved')),
  resolution   text,

  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references auth.users(id) on delete set null,

  foreign key (lead_id, tenant_id) references public.leads (id, tenant_id) on delete cascade,
  foreign key (run_id, tenant_id) references public.automation_runs (id, tenant_id) on delete set null
);

create index if not exists handoffs_tenant_open_idx
  on public.handoffs (tenant_id, opened_at desc)
  where status = 'open';
create index if not exists handoffs_lead_idx on public.handoffs (lead_id);

-- ---------------------------------------------------------------------------
-- 8. suppressions — who must not be messaged
-- ---------------------------------------------------------------------------

-- Checked twice: once when an action is queued, and again, from the database,
-- immediately before the send. The second check is the one that matters — the
-- gap between queueing a follow-up for tomorrow morning and sending it is
-- exactly where a STOP arrives.
create table if not exists public.suppressions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  channel    text not null check (channel in ('sms', 'email')),
  -- E.164, or a lowercased address. normalised by the caller, constrained here.
  address    text not null check (char_length(trim(address)) > 0),
  reason     text not null check (reason in (
    'opt_out', 'wrong_contact', 'compliance', 'staff_suppressed', 'bounced', 'other'
  )),
  source     text check (source is null or source in ('customer', 'operator', 'provider', 'system')),
  note       text,
  created_at timestamptz not null default now(),
  -- null means forever, which is what an opt-out is.
  expires_at timestamptz,

  -- scoped to the tenant: opting out of one contractor's texts is not opting out
  -- of another's, and a global list would be one contractor's customer data
  -- silently shaping another's.
  unique (tenant_id, channel, address)
);

create index if not exists suppressions_lookup_idx on public.suppressions (tenant_id, channel, address);

-- ---------------------------------------------------------------------------
-- 9. module_onboarding — the checklist activation is gated on
-- ---------------------------------------------------------------------------

create table if not exists public.module_onboarding (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  module_key text not null check (module_key in ('lead_recovery')),
  step_key   text not null,
  done_at    timestamptz,
  done_by    uuid references auth.users(id) on delete set null,
  note       text,
  created_at timestamptz not null default now(),

  unique (tenant_id, module_key, step_key)
);

create index if not exists module_onboarding_tenant_idx
  on public.module_onboarding (tenant_id, module_key);

-- stamped by the database, like client_service_steps in 0008 and for the same
-- reason: a compliance checklist whose dates the browser can set is not evidence.
drop trigger if exists module_onboarding_stamp on public.module_onboarding;
create trigger module_onboarding_stamp
  before insert or update of done_at on public.module_onboarding
  for each row execute function public.stamp_client_service_step();

-- ---------------------------------------------------------------------------
-- 10. claim_scheduled_actions — why two workers cannot send the same text
-- ---------------------------------------------------------------------------

-- `for update skip locked` is the whole mechanism. Two dispatchers running in
-- the same second select disjoint sets of rows: the first takes the lock, the
-- second skips past it rather than blocking and then acting on a row that has
-- since been claimed. The status flip happens in the same statement, so there is
-- no window between "I read it" and "I own it".
--
-- A lease rather than a permanent claim, because a worker can die between
-- claiming and completing. Claims older than `p_lease_seconds` are re-offered;
-- the action's own idempotency key is what stops the re-offer from sending twice.
create or replace function public.claim_scheduled_actions(
  p_limit         integer default 25,
  p_worker        text default 'dispatcher',
  p_lease_seconds integer default 120
)
returns setof public.scheduled_actions
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  with due as (
    select a.id
      from public.scheduled_actions a
     where (a.status = 'pending' and a.run_at <= now())
        or (a.status = 'claimed'
            and a.locked_at is not null
            and a.locked_at < now() - make_interval(secs => greatest(p_lease_seconds, 30)))
     order by a.run_at
     limit greatest(p_limit, 1)
     for update skip locked
  )
  update public.scheduled_actions a
     set status    = 'claimed',
         locked_at = now(),
         locked_by = coalesce(nullif(trim(p_worker), ''), 'dispatcher'),
         attempts  = a.attempts + 1
    from due
   where a.id = due.id
  returning a.*;
end;
$fn$;

-- only the service role, which means only an edge function. a browser holding an
-- anon key must never be able to claim work.
revoke all on function public.claim_scheduled_actions(integer, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. RLS
-- ---------------------------------------------------------------------------

-- The pattern, on every table: clients may SELECT their own rows, operators may
-- SELECT everything, and nobody holding a browser key may write anything. Write
-- access belongs to the service role alone, which means it belongs to an edge
-- function that checked a signature or a JWT first.
--
-- Four tables get no client policy at all: module_configs (staff phone numbers,
-- alert recipients, provider references — operator material, and self-service
-- client configuration is explicitly out of scope), intake_keys, module_onboarding
-- and scheduled_actions (internal machinery; the client's view of what the engine
-- did is the run log, built from events, not the queue).

alter table public.module_configs     enable row level security;
alter table public.intake_keys        enable row level security;
alter table public.leads              enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.automation_runs    enable row level security;
alter table public.scheduled_actions  enable row level security;
alter table public.handoffs           enable row level security;
alter table public.suppressions       enable row level security;
alter table public.module_onboarding  enable row level security;

-- operator-only, read-only from a browser.
drop policy if exists module_configs_admin_read on public.module_configs;
create policy module_configs_admin_read on public.module_configs
  for select to authenticated using (public.is_arc_admin());

drop policy if exists intake_keys_admin_read on public.intake_keys;
create policy intake_keys_admin_read on public.intake_keys
  for select to authenticated using (public.is_arc_admin());

drop policy if exists scheduled_actions_admin_read on public.scheduled_actions;
create policy scheduled_actions_admin_read on public.scheduled_actions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists module_onboarding_admin_read on public.module_onboarding;
create policy module_onboarding_admin_read on public.module_onboarding
  for select to authenticated using (public.is_arc_admin());

-- the client-visible half. is_tenant_member() first and untouched, exactly as
-- 0003 established: a bug in the admin branch can only ever widen what an
-- operator sees, never what a client does.
drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists automation_runs_read on public.automation_runs;
create policy automation_runs_read on public.automation_runs
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists handoffs_read on public.handoffs;
create policy handoffs_read on public.handoffs
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

drop policy if exists suppressions_read on public.suppressions;
create policy suppressions_read on public.suppressions
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());

-- No insert, update or delete policy is created on any table in this migration,
-- for any role. That absence *is* the write protection — the same way
-- admin_actions has been append-only since 0004 by having no policy rather than
-- by having a trigger.

-- ---------------------------------------------------------------------------
-- 12. realtime
-- ---------------------------------------------------------------------------

-- The ops console watches a lead move through the engine while it is happening.
-- RLS still applies to subscribers, so a client's socket sees a client's rows.
do $$
begin
  alter publication supabase_realtime add table public.automation_runs;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
