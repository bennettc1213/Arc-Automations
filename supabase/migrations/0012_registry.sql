-- ===========================================================================
-- 0012 — Module, connector and capability registries
-- ===========================================================================
--
-- ARC-100. Global catalog tables giving ARC's product vocabulary relational
-- identity: stable keys, immutable published versions, foreign-key targets for
-- ARC-110/120/130, and compatibility relationships.
--
-- **Authority.** The typed registry under
-- `supabase/functions/_shared/registry/` is authoritative for anything
-- executable — validators, defaults, field permissions, behavioural contracts.
-- These tables are authoritative for *identity and referential integrity*: they
-- are what a tenant-module row will point at in ARC-120, and what a connection
-- row will point at in ARC-130. Neither may drift from the other, and
-- `tests/registry.test.js` fails the build if they do.
--
-- That split is deliberate. Putting validators in the database would mean either
-- loading executable code from a row — which this repository will not do — or
-- keeping a second, weaker copy of the rules. Putting identity only in code
-- would leave ARC-120 and ARC-130 with no foreign key to hang a tenant's
-- selection on.
--
-- **What is not here.** No tenant data, no customer data, no credentials, no
-- secrets, no executable source, no environment-specific workflow IDs. A
-- workflow *key* and a contract version are product facts; the n8n id that key
-- resolves to in staging is a deployment fact and belongs to the later workflow
-- registry (ADR-010 §21).
--
-- Additive. No existing table is altered and no row is deleted. The three
-- `module_key in ('lead_recovery')` check constraints from 0010 are left exactly
-- as they are — see §6 for why that is the correct answer rather than an
-- oversight.

-- ---------------------------------------------------------------------------
-- 1. capabilities
-- ---------------------------------------------------------------------------

-- What ARC's adapter code can actually do with a provider. A capability listed
-- here is a claim that adapter code exists, not that a provider's API offers it.

create table if not exists public.registry_capabilities (
  key          text primary key,
  description  text not null,
  category     text not null check (category in (
    'telephony', 'messaging', 'intake', 'crm', 'calendar', 'ai'
  )),
  direction    text not null check (direction in ('read', 'write', 'receive', 'send')),
  risk         text not null check (risk in ('low', 'medium', 'high')),
  external_side_effect    boolean not null default false,
  consent_relevant        boolean not null default false,
  reconciliation_required boolean not null default false,
  status       text not null default 'available' check (status in (
    'planned', 'internal', 'pilot', 'available', 'deprecated', 'retired'
  )),
  deprecated_by text references public.registry_capabilities(key),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. modules
-- ---------------------------------------------------------------------------

create table if not exists public.registry_modules (
  key           text primary key,
  display_name  text not null,
  description   text not null,
  status        text not null check (status in (
    'planned', 'internal', 'pilot', 'available', 'deprecated', 'retired'
  )),

  -- the value this module's events and `tenants.modules` already use. NOT the
  -- canonical key: `lead_recovery`'s bucket is `lead_capture`, because that is
  -- what four migrations and every historical event row already say. Renaming
  -- stored values to tidy a vocabulary would be rewriting history.
  event_module_key text not null unique,
  portal_route_key text not null unique,
  portal_order     integer not null unique,

  created_at    timestamptz not null default now()
);

-- every accepted spelling, normalised at the compatibility boundary. one row per
-- alias, and an alias may belong to exactly one module.
create table if not exists public.registry_module_aliases (
  alias      text primary key,
  module_key text not null references public.registry_modules(key) on delete restrict,
  -- why this spelling exists, so a future reader knows whether it can ever go
  kind       text not null check (kind in ('canonical', 'event_module', 'portal_route', 'historical')),
  created_at timestamptz not null default now()
);

create index if not exists registry_module_aliases_module_idx
  on public.registry_module_aliases (module_key);

create table if not exists public.registry_module_versions (
  id            uuid primary key default gen_random_uuid(),
  module_key    text not null references public.registry_modules(key) on delete restrict,
  version       integer not null check (version >= 1),
  status        text not null check (status in (
    'planned', 'internal', 'pilot', 'available', 'deprecated', 'retired'
  )),

  config_schema_key     text,
  config_schema_version integer,

  execution_mode text not null check (execution_mode in ('direct', 'n8n', 'hybrid')),
  -- ADR-010 §26: production n8n is blocked behind a licensing gate, so a module
  -- version states its posture rather than leaving it implied.
  n8n_posture    text not null check (n8n_posture in ('prohibited', 'optional', 'required')),
  supports_direct_execution boolean not null default true,

  -- ARC-controlled keys only. the environment-specific n8n id these resolve to
  -- lives in the deployment registry, not in a product definition.
  runner_key                text,
  workflow_key              text,
  workflow_contract_version integer,

  requires_consent          boolean not null default false,
  requires_human_handoff    boolean not null default false,
  requires_shadow_mode      boolean not null default false,

  deprecated_by uuid references public.registry_module_versions(id),
  created_at    timestamptz not null default now(),

  unique (module_key, version),
  -- lets capability requirements carry a composite FK, so a requirement can
  -- never point at a version of a different module.
  unique (id, module_key),

  -- a version that can neither run directly nor use n8n cannot run at all.
  constraint registry_module_versions_executable
    check (supports_direct_execution or n8n_posture <> 'prohibited'),

  -- a selectable version must name the schema it validates against.
  constraint registry_module_versions_selectable_has_schema
    check (status not in ('pilot', 'available') or config_schema_key is not null)
);

create index if not exists registry_module_versions_module_idx
  on public.registry_module_versions (module_key, version desc);

-- ---------------------------------------------------------------------------
-- 3. connectors
-- ---------------------------------------------------------------------------

-- A supported provider *adapter type*. Not a tenant's connected account — that is
-- ARC-130 — and not a statement that any connection is healthy, which is ARC-120.

create table if not exists public.registry_connectors (
  key          text primary key,
  display_name text not null,
  category     text not null check (category in (
    'telephony', 'messaging', 'intake', 'crm', 'fsm', 'calendar', 'accounting', 'ai'
  )),
  status       text not null check (status in (
    'planned', 'internal', 'pilot', 'available', 'deprecated', 'retired'
  )),
  description  text not null,
  created_at   timestamptz not null default now()
);

create table if not exists public.registry_connector_versions (
  id            uuid primary key default gen_random_uuid(),
  connector_key text not null references public.registry_connectors(key) on delete restrict,
  version       integer not null check (version >= 1),
  status        text not null check (status in (
    'planned', 'internal', 'pilot', 'available', 'deprecated', 'retired'
  )),

  -- how the connection authenticates. NEVER the credential itself: no token, key,
  -- secret or environment URL is stored in this schema, and the check constraint
  -- below refuses anything secret-shaped that might be smuggled into a text field.
  auth_type     text not null check (auth_type in (
    'arc_managed', 'oauth2', 'api_key', 'signed_webhook', 'none'
  )),
  connection_owner text not null check (connection_owner in ('arc', 'tenant')),
  supports_reauthorization boolean not null default false,
  expects_refresh_token    boolean not null default false,

  webhook_signature text not null check (webhook_signature in (
    'hmac_sha1_twilio', 'shared_key', 'none'
  )),
  health_check      text not null check (health_check in ('provider_api', 'inbound_only', 'none')),
  token_refresh     text not null check (token_refresh in ('not_applicable', 'automatic', 'manual')),
  rate_limit        text,
  supports_reconciliation   boolean not null default false,
  supports_idempotency_key  boolean not null default false,
  limitation    text,

  deprecated_by uuid references public.registry_connector_versions(id),
  created_at    timestamptz not null default now(),

  unique (connector_key, version),
  unique (id, connector_key)
);

alter table public.registry_connector_versions
  drop constraint if exists registry_connector_versions_no_secrets;
alter table public.registry_connector_versions
  add constraint registry_connector_versions_no_secrets
  check (
    coalesce(rate_limit, '') || ' ' || coalesce(limitation, '')
      !~* '(auth_token|api_key|secret|password|private_key|bearer)\s*[:=]\s*\S{8,}'
  );

-- what an adapter version implements and verifies.
create table if not exists public.registry_connector_capabilities (
  connector_version_id uuid not null references public.registry_connector_versions(id) on delete cascade,
  capability_key       text not null references public.registry_capabilities(key) on delete restrict,
  primary key (connector_version_id, capability_key)
);

-- ---------------------------------------------------------------------------
-- 4. module capability requirements
-- ---------------------------------------------------------------------------

-- Modules depend on capabilities, never on provider brands. A requirement group
-- is the unit: `any_of` is how Lead Recovery says "some way of taking a lead in"
-- without naming Twilio.

create table if not exists public.registry_module_requirements (
  id                uuid primary key default gen_random_uuid(),
  module_version_id uuid not null references public.registry_module_versions(id) on delete cascade,
  module_key        text not null,
  requirement_key   text not null,
  kind              text not null check (kind in ('all_of', 'any_of', 'optional', 'conditional')),
  description       text not null,
  -- for `conditional`: the config field whose truthiness makes the group binding.
  when_config_field text,

  unique (module_version_id, requirement_key),
  foreign key (module_version_id, module_key)
    references public.registry_module_versions (id, module_key) on delete cascade,

  constraint registry_module_requirements_conditional_has_field
    check (kind <> 'conditional' or when_config_field is not null)
);

create table if not exists public.registry_module_requirement_capabilities (
  requirement_id uuid not null references public.registry_module_requirements(id) on delete cascade,
  capability_key text not null references public.registry_capabilities(key) on delete restrict,
  primary key (requirement_id, capability_key)
);

-- ---------------------------------------------------------------------------
-- 5. published-version immutability
-- ---------------------------------------------------------------------------

-- A published version's contract is frozen: behavioural change means a new
-- version, not an edit. Only `status` and `deprecated_by` may move, and only
-- along a lifecycle that never returns a retired version to service.
--
-- Enforced by trigger rather than by convention, so the service role is bound by
-- it too — the same reasoning as 0011's snapshot immutability.

create or replace function public.registry_version_is_immutable()
returns trigger
language plpgsql
as $fn$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if tg_op = 'DELETE' then
    raise exception 'registry versions are not deleted — deprecate or retire them instead'
      using errcode = 'P0001';
  end if;

  -- everything except the two mutable columns must be identical.
  if (v_old - 'status' - 'deprecated_by') is distinct from (v_new - 'status' - 'deprecated_by') then
    raise exception 'a published registry version is immutable; publish a new version instead'
      using errcode = 'P0001';
  end if;

  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'a retired version cannot be brought back into service'
      using errcode = 'P0001';
  end if;

  return new;
end;
$fn$;

drop trigger if exists registry_module_versions_immutable on public.registry_module_versions;
create trigger registry_module_versions_immutable
  before update or delete on public.registry_module_versions
  for each row execute function public.registry_version_is_immutable();

drop trigger if exists registry_connector_versions_immutable on public.registry_connector_versions;
create trigger registry_connector_versions_immutable
  before update or delete on public.registry_connector_versions
  for each row execute function public.registry_version_is_immutable();

-- a version's capability contract cannot change silently either.
create or replace function public.registry_capability_links_are_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'capability links are fixed at publication (attempted %)', tg_op
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists registry_connector_capabilities_immutable
  on public.registry_connector_capabilities;
create trigger registry_connector_capabilities_immutable
  before update or delete on public.registry_connector_capabilities
  for each row execute function public.registry_capability_links_are_immutable();

drop trigger if exists registry_requirement_capabilities_immutable
  on public.registry_module_requirement_capabilities;
create trigger registry_requirement_capabilities_immutable
  before update or delete on public.registry_module_requirement_capabilities
  for each row execute function public.registry_capability_links_are_immutable();

-- ---------------------------------------------------------------------------
-- 6. existing module_key constraints: reviewed, retained
-- ---------------------------------------------------------------------------

-- 0010 put `check (module_key in ('lead_recovery'))` on three tables, and 0011
-- added a fourth. Each was reviewed against the question "is this table's shape
-- Lead Recovery-specific, or is it generic and merely restricted?"
--
--   module_configs        (0010:88)   RETAINED. `config` is validated by the
--                                     Lead Recovery validator specifically.
--                                     ARC-110 generalises this table with
--                                     schema-per-module validation; widening the
--                                     constraint now, before that validator
--                                     dispatch exists, would allow a row nothing
--                                     can validate.
--   automation_runs       (0010:336)  RETAINED. Its state machine is Lead
--                                     Recovery's (`state-machine.ts`), and the
--                                     state check constraint alongside it is that
--                                     module's vocabulary.
--   module_onboarding     (0010:509)  RETAINED. Its `step_key` values are the
--                                     eleven-step Lead Recovery gate. ARC-120
--                                     replaces this table with a general
--                                     lifecycle.
--   lead_recovery_config_snapshots
--                         (0011:82)   RETAINED. Named for the module; ARC-110
--                                     supersedes it.
--
-- So: nothing is widened here, and nothing is weakened. The registry adds the
-- vocabulary those constraints will eventually reference; the prompts that own
-- those tables do the widening, each with the validator dispatch that makes a
-- wider constraint safe. Removing a constraint now without its replacement
-- protection would be the opposite of what ARC-100 is for.

-- ---------------------------------------------------------------------------
-- 7. seed
-- ---------------------------------------------------------------------------

-- Mirrors the typed registry exactly. `tests/registry.test.js` parses this file
-- and fails if the two disagree, so this is a projection of the code rather than
-- a second source of truth.
--
-- Idempotent: re-running changes nothing. `on conflict do nothing` rather than
-- `do update`, because an update would fight the immutability trigger.

insert into public.registry_capabilities
  (key, description, category, direction, risk, external_side_effect, consent_relevant, reconciliation_required, status)
values
  ('receive_calls', 'Accept an inbound voice webhook and answer it with call-routing instructions.', 'telephony', 'receive', 'medium', true, false, false, 'available'),
  ('receive_call_status', 'Accept the dial-result callback that says whether a forwarded call was answered.', 'telephony', 'receive', 'low', false, false, false, 'available'),
  ('send_sms', 'Send an SMS to a member of the public and report whether the provider accepted it.', 'messaging', 'send', 'high', true, true, true, 'available'),
  ('receive_sms', 'Accept an inbound SMS webhook, including STOP and other opt-out keywords.', 'messaging', 'receive', 'low', false, true, false, 'available'),
  ('receive_delivery_status', 'Accept the delivery callback that settles whether a sent message arrived.', 'messaging', 'receive', 'low', false, false, false, 'available'),
  ('receive_web_leads', 'Accept a lead submitted from a form on the client''s own website.', 'intake', 'receive', 'medium', false, true, false, 'available'),
  ('classify_text', 'Classify free text with a model, within ARC''s deterministic safety fence.', 'ai', 'read', 'medium', false, false, false, 'available')
on conflict (key) do nothing;

insert into public.registry_modules
  (key, display_name, description, status, event_module_key, portal_route_key, portal_order)
values
  ('lead_recovery', 'Lead Recovery', 'A missed call or a website form becomes a lead, a text back, and either a routed job or a person.', 'available', 'lead_capture', 'leads', 1),
  ('estimate_recovery', 'Estimate Recovery', 'Unsold estimates chased to a decision.', 'planned', 'estimates', 'estimates', 2),
  ('review_recovery', 'Reviews & Service Recovery', 'Review requests after a completed job, and the unhappy ones caught first.', 'planned', 'reviews', 'reviews', 3),
  ('membership_retention', 'Membership Retention', 'Maintenance plans renewed before they lapse.', 'planned', 'memberships', 'memberships', 4),
  ('install_warranty', 'Install & Warranty', 'New equipment registered for warranty before the window closes.', 'planned', 'installs', 'installs', 5)
on conflict (key) do nothing;

insert into public.registry_module_aliases (alias, module_key, kind) values
  ('lead_recovery', 'lead_recovery', 'canonical'),
  ('lead_capture',  'lead_recovery', 'event_module'),
  ('leads',         'lead_recovery', 'portal_route'),
  ('estimate_recovery', 'estimate_recovery', 'canonical'),
  ('estimates',         'estimate_recovery', 'event_module'),
  ('review_recovery', 'review_recovery', 'canonical'),
  ('reviews',         'review_recovery', 'event_module'),
  ('membership_retention', 'membership_retention', 'canonical'),
  ('memberships',          'membership_retention', 'event_module'),
  ('install_warranty', 'install_warranty', 'canonical'),
  ('installs',         'install_warranty', 'event_module')
on conflict (alias) do nothing;

-- Lead Recovery v1 — the only published module version. ADR-010 §11 puts it in
-- `direct` mode with n8n in none of its operations, so `n8n_posture` is
-- `prohibited` and no licensing gate can block this module.
insert into public.registry_module_versions (
  module_key, version, status,
  config_schema_key, config_schema_version,
  execution_mode, n8n_posture, supports_direct_execution,
  runner_key, workflow_key, workflow_contract_version,
  requires_consent, requires_human_handoff, requires_shadow_mode
)
select 'lead_recovery', 1, 'available',
       'lead_recovery_config', 1,
       'direct', 'prohibited', true,
       'arc-direct-worker', null, null,
       true, true, false
where not exists (
  select 1 from public.registry_module_versions
   where module_key = 'lead_recovery' and version = 1
);

insert into public.registry_connectors (key, display_name, category, status, description) values
  ('twilio', 'Twilio', 'telephony', 'available', 'The number that forwards a call and texts the caller back.'),
  ('arc_web_intake', 'ARC website intake', 'intake', 'available', 'A form on the client''s own site posting leads into ARC.'),
  ('anthropic', 'Anthropic', 'ai', 'available', 'Optional reply classification, inside ARC''s deterministic safety fence.'),
  ('google_calendar', 'Google Calendar', 'calendar', 'planned', 'Booking into a connected calendar. No adapter exists yet.'),
  ('jobber', 'Jobber', 'fsm', 'planned', 'Field-service management. No adapter exists yet.'),
  ('housecall_pro', 'Housecall Pro', 'fsm', 'planned', 'Field-service management. No adapter exists yet.'),
  ('servicetitan', 'ServiceTitan', 'fsm', 'planned', 'Field-service management. No adapter exists yet.'),
  ('gohighlevel', 'GoHighLevel', 'crm', 'planned', 'CRM and pipelines. No adapter exists yet.')
on conflict (key) do nothing;

-- Only the three connectors ARC has adapter code for get versions. A planned
-- connector with a version and capabilities would let a module resolve as
-- satisfiable when nothing can serve it.
insert into public.registry_connector_versions (
  connector_key, version, status, auth_type, connection_owner,
  supports_reauthorization, expects_refresh_token,
  webhook_signature, health_check, token_refresh, rate_limit,
  supports_reconciliation, supports_idempotency_key, limitation
)
select * from (values
  ('twilio', 1, 'available', 'arc_managed', 'arc', false, false,
   'hmac_sha1_twilio', 'provider_api', 'not_applicable', 'provider-enforced; ARC applies bounded backoff',
   false, false, 'Reconciliation of an ambiguous send is manual until ARC-200.'),
  ('arc_web_intake', 1, 'available', 'signed_webhook', 'arc', true, false,
   'shared_key', 'inbound_only', 'not_applicable', 'per-key and per-IP, in-process per instance',
   false, true, 'Origin, honeypot and dwell checks are client-controlled; server-verifiable anti-abuse is still open (audit G-C5).'),
  ('anthropic', 1, 'available', 'api_key', 'arc', false, false,
   'none', 'none', 'not_applicable', 'provider-enforced; 8s client timeout',
   false, false, null)
) as v(connector_key, version, status, auth_type, connection_owner,
       supports_reauthorization, expects_refresh_token,
       webhook_signature, health_check, token_refresh, rate_limit,
       supports_reconciliation, supports_idempotency_key, limitation)
where not exists (
  select 1 from public.registry_connector_versions e
   where e.connector_key = v.connector_key and e.version = v.version
);

insert into public.registry_connector_capabilities (connector_version_id, capability_key)
select cv.id, cap.key
  from public.registry_connector_versions cv
  join (values
    ('twilio', 1, 'receive_calls'),
    ('twilio', 1, 'receive_call_status'),
    ('twilio', 1, 'send_sms'),
    ('twilio', 1, 'receive_sms'),
    ('twilio', 1, 'receive_delivery_status'),
    ('arc_web_intake', 1, 'receive_web_leads'),
    ('anthropic', 1, 'classify_text')
  ) as cap(connector_key, version, key)
    on cap.connector_key = cv.connector_key and cap.version = cv.version
on conflict do nothing;

-- Lead Recovery v1's capability requirements.
insert into public.registry_module_requirements
  (module_version_id, module_key, requirement_key, kind, description, when_config_field)
select mv.id, 'lead_recovery', r.requirement_key, r.kind, r.description, null
  from public.registry_module_versions mv
  join (values
    ('intake', 'any_of', 'Some way for a lead to arrive — a forwarded number, a website form, or both.'),
    ('missed_call_detection', 'optional', 'Without the dial-result callback, only web-form leads are recoverable.'),
    ('conversation', 'all_of', 'Texting the caller back, and hearing the reply — including STOP.'),
    ('delivery_evidence', 'all_of', 'Settling whether a sent message actually arrived.'),
    ('reply_classification', 'optional', 'Without a classifier every reply goes to a person, which is the safe default rather than a failure.')
  ) as r(requirement_key, kind, description) on true
 where mv.module_key = 'lead_recovery' and mv.version = 1
on conflict (module_version_id, requirement_key) do nothing;

insert into public.registry_module_requirement_capabilities (requirement_id, capability_key)
select req.id, c.capability_key
  from public.registry_module_requirements req
  join public.registry_module_versions mv on mv.id = req.module_version_id
  join (values
    ('intake', 'receive_calls'),
    ('intake', 'receive_web_leads'),
    ('missed_call_detection', 'receive_call_status'),
    ('conversation', 'send_sms'),
    ('conversation', 'receive_sms'),
    ('delivery_evidence', 'receive_delivery_status'),
    ('reply_classification', 'classify_text')
  ) as c(requirement_key, capability_key) on c.requirement_key = req.requirement_key
 where mv.module_key = 'lead_recovery' and mv.version = 1
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------------

-- Registry rows are global product facts, not tenant data, so every signed-in
-- user may read them. There is nothing tenant-scoped to leak: no tenant id, no
-- customer data, no credential.
--
-- Nobody may write them from a browser — not a client, not an operator. Global
-- definitions change through reviewed code and a migration, which is the whole
-- point of a registry: an operator who could mark a planned module `available`
-- from the console could switch on a module with no validator behind it.

alter table public.registry_capabilities                     enable row level security;
alter table public.registry_modules                          enable row level security;
alter table public.registry_module_aliases                   enable row level security;
alter table public.registry_module_versions                  enable row level security;
alter table public.registry_connectors                       enable row level security;
alter table public.registry_connector_versions               enable row level security;
alter table public.registry_connector_capabilities           enable row level security;
alter table public.registry_module_requirements              enable row level security;
alter table public.registry_module_requirement_capabilities  enable row level security;

drop policy if exists registry_capabilities_read on public.registry_capabilities;
create policy registry_capabilities_read on public.registry_capabilities
  for select to authenticated using (true);

drop policy if exists registry_modules_read on public.registry_modules;
create policy registry_modules_read on public.registry_modules
  for select to authenticated using (true);

drop policy if exists registry_module_aliases_read on public.registry_module_aliases;
create policy registry_module_aliases_read on public.registry_module_aliases
  for select to authenticated using (true);

drop policy if exists registry_module_versions_read on public.registry_module_versions;
create policy registry_module_versions_read on public.registry_module_versions
  for select to authenticated using (true);

drop policy if exists registry_connectors_read on public.registry_connectors;
create policy registry_connectors_read on public.registry_connectors
  for select to authenticated using (true);

-- operator-only: auth type, health-check strategy and known limitations are
-- operational detail a client has no use for and an attacker would enjoy.
drop policy if exists registry_connector_versions_read on public.registry_connector_versions;
create policy registry_connector_versions_read on public.registry_connector_versions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists registry_connector_capabilities_read on public.registry_connector_capabilities;
create policy registry_connector_capabilities_read on public.registry_connector_capabilities
  for select to authenticated using (public.is_arc_admin());

drop policy if exists registry_module_requirements_read on public.registry_module_requirements;
create policy registry_module_requirements_read on public.registry_module_requirements
  for select to authenticated using (public.is_arc_admin());

drop policy if exists registry_module_requirement_capabilities_read
  on public.registry_module_requirement_capabilities;
create policy registry_module_requirement_capabilities_read
  on public.registry_module_requirement_capabilities
  for select to authenticated using (public.is_arc_admin());

-- No insert, update or delete policy on any registry table, for any role. The
-- absence is the write protection, as in 0004, 0010 and 0011.

revoke all on function public.registry_version_is_immutable() from public, anon, authenticated;
revoke all on function public.registry_capability_links_are_immutable() from public, anon, authenticated;
