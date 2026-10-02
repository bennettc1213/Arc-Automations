-- ===========================================================================
-- 0023 — Universal CRM core and business profile (ARC-340)
-- ===========================================================================
--
-- One customer/lead model for all three routes (ARC-330). ARC Native uses it as
-- the CRM. Hybrid and Connected use the same rows as ARC's normalised working
-- copy, each mapped to the record it mirrors in the client's own system
-- (`crm_external_mappings`) under a declared authority (`crm_source_policies`).
-- There is no second contact model for any module: Lead Recovery's `leads`
-- (0010) stays the engine's narrow operational row, and a CRM lead may point at
-- one (`crm_leads.recovery_lead_id`).
--
-- What this is not:
--   * not evidence. `events` is still the only log a figure is derived from;
--     nothing on any page counts these tables.
--   * not safety truth. A contact carries no consent or opt-out column. Whether
--     an address may be messaged is `suppressions` (0010) and the engine's own
--     rules, read at the moment of sending; a contact only names the address.
--   * not a credential store. Every free-text column refuses secret-shaped
--     values (`crm_text_is_clean`).
--   * not a second name or timezone. The business's name and timezone stay on
--     `tenants` and in the published tenant settings (0014); the profile adds
--     what no table held: hours, public contact channels, locations, service
--     areas, services, and the route an operator recorded.
--
-- Who writes. No browser role has a write policy on any table here. Writes
-- come from the service role — an edge function that checked the caller — and
-- every row that changes a contact, lead, task or note names its actor
-- (`updated_by_type`, `updated_by`), which the guards check against
-- `arc_admins` / `tenant_members` again. The history (`crm_activities`) is
-- written by triggers in the same statement, so a change cannot happen and go
-- unrecorded, whichever path made it.
--
-- Refusals arrive as `arc_crm:<code>: <message>`.
--
-- Rollback: drop the tables below (crm_* and business_*), the crm_* functions,
--   and re-create purge_test_tenant from 0022. Nothing existing is altered
--   except that function, which gains three lines in its activity list.
--
-- Forward-only and additive.

-- ---------------------------------------------------------------------------
-- 0. helpers
-- ---------------------------------------------------------------------------

-- the same shapes 0012 and 0016 refuse, in one place for every CRM text column.
-- the optional quotes are for a jsonb column read as text.
create or replace function public.crm_text_is_clean(p text)
returns boolean
language sql
immutable
as $fn$
  select p is null or p !~* '((auth_?token|access_?token|refresh_?token|api[_-]?key|client_?secret|secret|password|private_?key)"?\s*[:=]\s*"?[^\s"]{8,}|bearer\s+[a-z0-9._~+/=-]{8,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.|\m(sk|pk|rk)_(live|test)_[a-z0-9]{8,})'
$fn$;

-- who is acting. an operator is in arc_admins; a client user is a member of
-- this tenant; `system` is ARC's own intake, `external` a sync from the
-- client's system — neither has a person behind it.
create or replace function public.crm_check_actor(p_tenant uuid, p_type text, p_actor uuid)
returns void
language plpgsql
set search_path = public
as $fn$
begin
  if p_type = 'operator' then
    if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
      raise exception 'arc_crm:forbidden: this actor is not an operator' using errcode = 'P0001';
    end if;
  elsif p_type = 'client_user' then
    if p_actor is null or not exists (
      select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.user_id = p_actor
    ) then
      raise exception 'arc_crm:forbidden: this user does not belong to this client' using errcode = 'P0001';
    end if;
  elsif p_type in ('system', 'external') then
    null;
  else
    raise exception 'arc_crm:invalid: an actor is operator, client_user, system or external' using errcode = 'P0001';
  end if;
end;
$fn$;

-- an owner is somebody who could open the record: a member of the tenant, or
-- an operator.
create or replace function public.crm_check_owner(p_tenant uuid, p_owner uuid)
returns void
language plpgsql
set search_path = public
as $fn$
begin
  if p_owner is null then return; end if;
  if not exists (select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.user_id = p_owner)
     and not exists (select 1 from public.arc_admins a where a.user_id = p_owner) then
    raise exception 'arc_crm:invalid_owner: an owner must belong to this client or be an operator' using errcode = 'P0001';
  end if;
end;
$fn$;

-- true only inside crm_merge_contacts, for the tenant it is merging in.
create or replace function public.crm_merging(p_tenant uuid)
returns boolean
language sql
stable
as $fn$
  select coalesce(current_setting('arc.crm_merging', true), '') = p_tenant::text;
$fn$;

-- the names of the columns that differ. names only: the history says what
-- changed, the row says what it is now, and no value is copied into a log.
create or replace function public.crm_changed_fields(p_old jsonb, p_new jsonb, p_skip text[])
returns text[]
language sql
immutable
as $fn$
  select coalesce(array_agg(n.key order by n.key), '{}'::text[])
    from jsonb_each(p_new) n
   where n.key <> all (p_skip)
     and n.value is distinct from (p_old -> n.key);
$fn$;

-- ---------------------------------------------------------------------------
-- 1. the business: profile, locations, service areas, services
-- ---------------------------------------------------------------------------

create table if not exists public.business_profiles (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,
  public_phone      text check (public_phone is null or public_phone ~ '^\+[1-9][0-9]{7,15}$'),
  public_email      text check (public_email is null or (public_email = lower(public_email) and public_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')),
  website_url       text check (website_url is null or (website_url ~ '^https://[^\s?#]+$' and char_length(website_url) <= 200)),
  -- { "mon": [{ "open": "08:00", "close": "17:00" }], ... } — a day left out is closed.
  business_hours    jsonb not null default '{}'::jsonb check (
    jsonb_typeof(business_hours) = 'object'
    and business_hours - array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] = '{}'::jsonb
  ),
  -- the route (ARC-330) an operator recorded for this client. null until one is.
  -- confirming it with the client is onboarding's job; this is where it is kept.
  route             text check (route is null or route in ('native', 'hybrid', 'connected')),
  route_recorded_at timestamptz,
  route_recorded_by uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by_type   text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by        uuid not null
);

create table if not exists public.business_locations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  address_line1 text check (address_line1 is null or char_length(address_line1) <= 200),
  address_line2 text check (address_line2 is null or char_length(address_line2) <= 200),
  city          text check (city is null or char_length(city) <= 120),
  region        text check (region is null or char_length(region) <= 120),
  postal_code   text check (postal_code is null or char_length(postal_code) <= 20),
  country       text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  -- null means the tenant's own timezone. set only for a location in another one.
  timezone      text check (timezone is null or char_length(timezone) <= 64),
  phone         text check (phone is null or phone ~ '^\+[1-9][0-9]{7,15}$'),
  is_primary    boolean not null default false,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, tenant_id)
);

create unique index if not exists business_locations_one_primary
  on public.business_locations (tenant_id) where is_primary and archived_at is null;
create index if not exists business_locations_tenant_idx on public.business_locations (tenant_id);

create table if not exists public.business_service_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  location_id uuid,
  kind        text not null check (kind in ('postal_code', 'city', 'county', 'region', 'radius_miles')),
  value       text not null check (char_length(btrim(value)) between 1 and 120 and public.crm_text_is_clean(value)),
  label       text check (label is null or char_length(label) <= 120),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (location_id, tenant_id) references public.business_locations (id, tenant_id),
  -- a radius is measured from somewhere.
  check (kind <> 'radius_miles' or (location_id is not null and value ~ '^[0-9]{1,3}$'))
);

create unique index if not exists business_service_areas_unique
  on public.business_service_areas (tenant_id, kind, lower(value), coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where archived_at is null;

create table if not exists public.business_service_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key),
  unique (id, tenant_id)
);

create table if not exists public.business_services (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  category_id              uuid,
  key                      text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name                     text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  description              text check (description is null or (char_length(description) <= 1000 and public.crm_text_is_clean(description))),
  default_duration_minutes integer check (default_duration_minutes is null or default_duration_minutes between 5 and 1440),
  -- whether a customer may ask for it on a form or a booking page.
  is_bookable              boolean not null default false,
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id, key),
  unique (id, tenant_id),
  foreign key (category_id, tenant_id) references public.business_service_categories (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- 2. contacts
-- ---------------------------------------------------------------------------

create table if not exists public.crm_contacts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  display_name      text not null check (char_length(btrim(display_name)) between 1 and 200 and public.crm_text_is_clean(display_name)),
  first_name        text check (first_name is null or (char_length(first_name) <= 100 and public.crm_text_is_clean(first_name))),
  last_name         text check (last_name is null or (char_length(last_name) <= 100 and public.crm_text_is_clean(last_name))),
  -- one spelling each, as everywhere else: E.164, and a lowercased address.
  -- normalised by the caller (`_shared/phone.ts`), refused here otherwise —
  -- "(614) 555-0137" would never match the suppression list's "+16145550137".
  phone             text check (phone is null or phone ~ '^\+[1-9][0-9]{7,15}$'),
  email             text check (email is null or (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' and char_length(email) <= 200)),
  preferred_channel text check (preferred_channel is null or preferred_channel in ('phone', 'sms', 'email')),
  address_line1     text check (address_line1 is null or (char_length(address_line1) <= 200 and public.crm_text_is_clean(address_line1))),
  address_line2     text check (address_line2 is null or (char_length(address_line2) <= 200 and public.crm_text_is_clean(address_line2))),
  city              text check (city is null or char_length(city) <= 120),
  region            text check (region is null or char_length(region) <= 120),
  postal_code       text check (postal_code is null or char_length(postal_code) <= 20),
  country           text check (country is null or country ~ '^[A-Z]{2}$'),
  -- which of the business's locations serves this customer, when that is known.
  location_id       uuid,
  -- no foreign key to auth.users, as in 0021: removing a login must not rewrite
  -- a customer record. crm_check_owner decides who may be named.
  owner_user_id     uuid,
  merged_into_id    uuid,
  archived_at       timestamptz,
  archived_reason   text check (archived_reason is null or (char_length(archived_reason) <= 300 and public.crm_text_is_clean(archived_reason))),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by_type   text not null,
  updated_by        uuid,
  unique (id, tenant_id),
  foreign key (location_id, tenant_id) references public.business_locations (id, tenant_id),
  foreign key (merged_into_id, tenant_id) references public.crm_contacts (id, tenant_id),
  check (merged_into_id is null or merged_into_id <> id)
);

-- lookups, not uniqueness: a household shares a number, and two real people can
-- share an inbox. finding the matches is the database's job; deciding they are
-- one person is a merge, which is audited.
create index if not exists crm_contacts_phone_idx on public.crm_contacts (tenant_id, phone) where phone is not null;
create index if not exists crm_contacts_email_idx on public.crm_contacts (tenant_id, email) where email is not null;
create index if not exists crm_contacts_tenant_idx on public.crm_contacts (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. pipelines and stages
-- ---------------------------------------------------------------------------

create table if not exists public.crm_pipelines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key),
  unique (id, tenant_id)
);

create unique index if not exists crm_pipelines_one_default
  on public.crm_pipelines (tenant_id) where is_default and archived_at is null;

create table if not exists public.crm_pipeline_stages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  pipeline_id     uuid not null,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  position        integer not null check (position >= 0),
  -- what being in this stage means for the lead: still open, won, or lost.
  kind            text not null default 'open' check (kind in ('open', 'won', 'lost')),
  marks_qualified boolean not null default false,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (pipeline_id, key),
  unique (id, pipeline_id),
  unique (id, tenant_id),
  foreign key (pipeline_id, tenant_id) references public.crm_pipelines (id, tenant_id) on delete cascade
);

create index if not exists crm_pipeline_stages_order_idx on public.crm_pipeline_stages (pipeline_id, position, key);

-- ---------------------------------------------------------------------------
-- 4. where a lead came from
-- ---------------------------------------------------------------------------

-- One row per arrival: a call, a form post, an import line, a webhook. Kept
-- whether or not it became a lead. 0010's four sources are a subset.
create table if not exists public.crm_source_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  source          text not null check (source in (
    'missed_call', 'inbound_call', 'inbound_sms', 'inbound_email', 'web_form',
    'manual', 'import', 'webhook', 'referral', 'external_system', 'other'
  )),
  -- attribution: campaign, form id, landing page, referrer. never a credential.
  detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and public.crm_text_is_clean(detail::text)),
  external_ref    text check (external_ref is null or (char_length(external_ref) <= 200 and public.crm_text_is_clean(external_ref))),
  -- a redelivered webhook or a re-run import is the same arrival, not a second.
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  contact_id      uuid,
  lead_id         uuid,
  -- the evidence row, when the arrival was also written to the event log.
  event_id        uuid references public.events(id),
  received_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id)
);

create unique index if not exists crm_source_events_idempotency
  on public.crm_source_events (tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists crm_source_events_tenant_idx on public.crm_source_events (tenant_id, received_at desc);

-- ---------------------------------------------------------------------------
-- 5. leads / opportunities
-- ---------------------------------------------------------------------------

create table if not exists public.crm_leads (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  contact_id             uuid not null,
  title                  text not null check (char_length(btrim(title)) between 1 and 200 and public.crm_text_is_clean(title)),
  summary                text check (summary is null or (char_length(summary) <= 2000 and public.crm_text_is_clean(summary))),
  source                 text not null check (source in (
    'missed_call', 'inbound_call', 'inbound_sms', 'inbound_email', 'web_form',
    'manual', 'import', 'webhook', 'referral', 'external_system', 'other'
  )),
  source_event_id        uuid,
  service_id             uuid,
  service_category_id    uuid,
  pipeline_id            uuid not null,
  stage_id               uuid not null,
  -- the stage's kind, written by the guard. never typed.
  status                 text not null default 'open' check (status in ('open', 'won', 'lost')),
  owner_user_id          uuid,
  priority               text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  -- a value only with where it came from. ARC never estimates one on its own.
  estimated_value_cents  bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  estimated_value_source text check (estimated_value_source is null or estimated_value_source in (
    'customer_provided', 'operator_entered', 'external_system', 'price_book'
  )),
  qualified_at           timestamptz,
  closed_at              timestamptz,
  closed_reason          text check (closed_reason is null or (char_length(closed_reason) <= 300 and public.crm_text_is_clean(closed_reason))),
  -- the engine's row for the same lead (0010), when Lead Recovery handled it.
  recovery_lead_id       uuid,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by_type        text not null,
  updated_by             uuid,
  unique (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (pipeline_id, tenant_id) references public.crm_pipelines (id, tenant_id),
  foreign key (stage_id, pipeline_id) references public.crm_pipeline_stages (id, pipeline_id),
  foreign key (source_event_id, tenant_id) references public.crm_source_events (id, tenant_id),
  foreign key (service_id, tenant_id) references public.business_services (id, tenant_id),
  foreign key (service_category_id, tenant_id) references public.business_service_categories (id, tenant_id),
  foreign key (recovery_lead_id, tenant_id) references public.leads (id, tenant_id),
  check ((estimated_value_cents is null) = (estimated_value_source is null)),
  check ((status = 'open') = (closed_at is null))
);

create unique index if not exists crm_leads_one_per_recovery_lead
  on public.crm_leads (tenant_id, recovery_lead_id) where recovery_lead_id is not null;
create index if not exists crm_leads_contact_idx on public.crm_leads (tenant_id, contact_id);
create index if not exists crm_leads_stage_idx on public.crm_leads (tenant_id, pipeline_id, stage_id) where archived_at is null;
create index if not exists crm_leads_tenant_idx on public.crm_leads (tenant_id, created_at desc);

do $$
begin
  alter table public.crm_source_events
    add constraint crm_source_events_lead_fk foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id);
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 6. notes, tasks, and the timeline
-- ---------------------------------------------------------------------------

create table if not exists public.crm_notes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  contact_id       uuid,
  lead_id          uuid,
  body             text not null check (char_length(btrim(body)) between 1 and 5000 and public.crm_text_is_clean(body)),
  author_type      text not null,
  author_id        uuid,
  archived_at      timestamptz,
  archived_by_type text,
  archived_by      uuid,
  created_at       timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id),
  check (contact_id is not null or lead_id is not null),
  check ((archived_at is null) = (archived_by_type is null))
);

create index if not exists crm_notes_contact_idx on public.crm_notes (tenant_id, contact_id, created_at desc);
create index if not exists crm_notes_lead_idx on public.crm_notes (tenant_id, lead_id, created_at desc);

create table if not exists public.crm_tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  contact_id       uuid,
  lead_id          uuid,
  kind             text not null default 'follow_up' check (kind in ('follow_up', 'call', 'visit', 'other')),
  title            text not null check (char_length(btrim(title)) between 1 and 200 and public.crm_text_is_clean(title)),
  detail           text check (detail is null or (char_length(detail) <= 2000 and public.crm_text_is_clean(detail))),
  due_at           timestamptz,
  status           text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  assigned_user_id uuid,
  completed_at     timestamptz,
  completed_by     uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by_type  text not null,
  updated_by       uuid,
  unique (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id),
  check (contact_id is not null or lead_id is not null),
  check ((status = 'done') = (completed_at is not null))
);

create index if not exists crm_tasks_open_idx on public.crm_tasks (tenant_id, due_at) where status = 'open';
create index if not exists crm_tasks_contact_idx on public.crm_tasks (tenant_id, contact_id);
create index if not exists crm_tasks_lead_idx on public.crm_tasks (tenant_id, lead_id);

-- What happened to a record, in order. Append-only, written by the triggers
-- below. Operational history of the CRM — not the evidence log, which is
-- `events`; a row may point at the event that proves it.
create table if not exists public.crm_activities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  contact_id    uuid,
  lead_id       uuid,
  activity_type text not null check (activity_type in (
    'contact_created', 'contact_updated', 'contact_archived', 'contact_restored',
    'contact_merged', 'contact_owner_changed',
    'lead_created', 'lead_updated', 'lead_stage_changed', 'lead_owner_changed',
    'lead_archived', 'lead_restored',
    'note_added', 'note_archived',
    'task_created', 'task_updated', 'task_completed', 'task_cancelled', 'task_reopened',
    'mapping_added', 'mapping_removed'
  )),
  actor_type    text not null check (actor_type in ('operator', 'client_user', 'system', 'external')),
  actor_id      uuid,
  summary       text not null check (char_length(summary) <= 300),
  detail        jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  event_id      uuid references public.events(id),
  occurred_at   timestamptz not null default now(),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id),
  check (contact_id is not null or lead_id is not null)
);

create index if not exists crm_activities_contact_idx on public.crm_activities (tenant_id, contact_id, occurred_at desc);
create index if not exists crm_activities_lead_idx on public.crm_activities (tenant_id, lead_id, occurred_at desc);

create or replace function public.crm_log(
  p_tenant uuid, p_contact uuid, p_lead uuid, p_type text,
  p_actor_type text, p_actor uuid, p_summary text, p_detail jsonb default '{}'::jsonb
)
returns void
language sql
set search_path = public
as $fn$
  insert into public.crm_activities (tenant_id, contact_id, lead_id, activity_type, actor_type, actor_id, summary, detail)
  values (p_tenant, p_contact, p_lead, p_type, p_actor_type, p_actor, p_summary, coalesce(p_detail, '{}'::jsonb));
$fn$;

-- a merge, an archive or a change of owner by an operator also goes in the
-- operator audit log (0004). a client user's own is in the timeline above,
-- which names them; admin_actions stays the record of what operators did.
create or replace function public.crm_audit(
  p_actor_type text, p_actor uuid, p_action text, p_target_type text, p_target uuid, p_metadata jsonb
)
returns void
language plpgsql
set search_path = public
as $fn$
begin
  if p_actor_type = 'operator' then
    insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
    values (p_actor, p_action, p_target_type, p_target::text, coalesce(p_metadata, '{}'::jsonb));
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. external mappings and who is the authority
-- ---------------------------------------------------------------------------

-- "this ARC record is that record in their system". One live mapping per
-- record per connector, and one ARC record per external id — a second would
-- be two ARC records claiming to be the same customer over there.
create table if not exists public.crm_external_mappings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  object_type     text not null check (object_type in ('contact', 'lead', 'task', 'note', 'location', 'service')),
  object_id       uuid not null,
  connector_key   text not null references public.registry_connectors(key) on delete restrict,
  external_id     text not null check (char_length(btrim(external_id)) between 1 and 200 and public.crm_text_is_clean(external_id)),
  created_at      timestamptz not null default now(),
  created_by_type text not null,
  created_by      uuid,
  removed_at      timestamptz,
  removed_by_type text,
  removed_by      uuid,
  check ((removed_at is null) = (removed_by_type is null))
);

create unique index if not exists crm_external_mappings_one_per_external
  on public.crm_external_mappings (tenant_id, connector_key, object_type, external_id) where removed_at is null;
create unique index if not exists crm_external_mappings_one_per_object
  on public.crm_external_mappings (tenant_id, connector_key, object_type, object_id) where removed_at is null;
create index if not exists crm_external_mappings_object_idx on public.crm_external_mappings (tenant_id, object_type, object_id);

-- Per kind of record: is ARC the authority, is their system, or is it split
-- field by field. No row means ARC. There is no "both, latest wins".
create table if not exists public.crm_source_policies (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  object_type   text not null check (object_type in ('contact', 'lead', 'task', 'note', 'location', 'service')),
  authority     text not null check (authority in ('arc', 'external', 'hybrid')),
  connector_key text references public.registry_connectors(key) on delete restrict,
  -- hybrid only: { "phone": "external", "owner_user_id": "arc" }. a field not
  -- named belongs to ARC.
  field_owners  jsonb not null default '{}'::jsonb check (jsonb_typeof(field_owners) = 'object'),
  note          text check (note is null or (char_length(note) <= 500 and public.crm_text_is_clean(note))),
  updated_at    timestamptz not null default now(),
  updated_by    uuid not null,
  primary key (tenant_id, object_type),
  check ((authority = 'arc') = (connector_key is null)),
  check ((authority = 'hybrid') = (field_owners <> '{}'::jsonb))
);

-- ---------------------------------------------------------------------------
-- 8. guards and history
-- ---------------------------------------------------------------------------

-- the profile: who, and a route that agrees with the policies.
create or replace function public.business_profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  if tg_op = 'INSERT' or new.route is distinct from old.route then
    if tg_op = 'INSERT' and new.route is null then
      new.route_recorded_at := null;
      new.route_recorded_by := null;
    else
      if new.updated_by_type <> 'operator' then
        raise exception 'arc_crm:forbidden: a route is recorded by an operator' using errcode = 'P0001';
      end if;
      if new.route = 'native' and exists (
        select 1 from public.crm_source_policies p where p.tenant_id = new.tenant_id and p.authority <> 'arc'
      ) then
        raise exception 'arc_crm:route_conflict: this client has records owned by an external system — ARC Native keeps every record in ARC' using errcode = 'P0001';
      end if;
      new.route_recorded_at := now();
      new.route_recorded_by := new.updated_by;
    end if;
  else
    new.route_recorded_at := old.route_recorded_at;
    new.route_recorded_by := old.route_recorded_by;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.business_profiles_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (tg_op = 'INSERT' and new.route is not null) or (tg_op = 'UPDATE' and new.route is distinct from old.route) then
    perform public.crm_audit('operator', new.updated_by, 'crm.route.recorded', 'tenant', new.tenant_id,
      jsonb_build_object('route', new.route, 'previous', case when tg_op = 'UPDATE' then old.route end));
  end if;
  return null;
end;
$fn$;

drop trigger if exists business_profiles_guard on public.business_profiles;
create trigger business_profiles_guard
  before insert or update on public.business_profiles
  for each row execute function public.business_profiles_guard();
drop trigger if exists business_profiles_history on public.business_profiles;
create trigger business_profiles_history
  after insert or update on public.business_profiles
  for each row execute function public.business_profiles_history();

-- a location's timezone, when it names one, is a real one.
create or replace function public.business_locations_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' and new.tenant_id <> old.tenant_id then
    raise exception 'arc_crm:immutable: a location never changes client' using errcode = 'P0001';
  end if;
  if new.timezone is not null then
    begin
      perform now() at time zone new.timezone;
    exception when others then
      raise exception 'arc_crm:invalid: "%" is not a timezone', new.timezone using errcode = 'P0001';
    end;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists business_locations_guard on public.business_locations;
create trigger business_locations_guard
  before insert or update on public.business_locations
  for each row execute function public.business_locations_guard();

-- contacts.
create or replace function public.crm_contacts_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id then
      raise exception 'arc_crm:immutable: a contact never changes client' using errcode = 'P0001';
    end if;
    if old.merged_into_id is not null and not public.crm_merging(new.tenant_id) then
      raise exception 'arc_crm:merged: this contact was merged into another and is read-only' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if new.merged_into_id is not null
     and (tg_op = 'INSERT' or new.merged_into_id is distinct from old.merged_into_id)
     and not public.crm_merging(new.tenant_id) then
    raise exception 'arc_crm:invalid: contacts are merged by crm_merge_contacts, which records it' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id then
    perform public.crm_check_owner(new.tenant_id, new.owner_user_id);
  end if;
  if new.archived_at is null then
    new.archived_reason := null;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_contacts_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    perform public.crm_log(new.tenant_id, new.id, null, 'contact_created', new.updated_by_type, new.updated_by, 'Contact created');
    return null;
  end if;
  if new.merged_into_id is not null and old.merged_into_id is null then
    perform public.crm_log(new.tenant_id, new.id, null, 'contact_merged', new.updated_by_type, new.updated_by,
      'Merged into another contact', jsonb_build_object('merged_into_id', new.merged_into_id));
    return null;
  end if;
  if (new.archived_at is null) <> (old.archived_at is null) then
    if new.archived_at is not null then
      perform public.crm_log(new.tenant_id, new.id, null, 'contact_archived', new.updated_by_type, new.updated_by,
        'Contact archived', jsonb_build_object('reason', new.archived_reason));
      perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.contact.archived', 'crm_contact', new.id,
        jsonb_build_object('tenant_id', new.tenant_id, 'reason', new.archived_reason));
    else
      perform public.crm_log(new.tenant_id, new.id, null, 'contact_restored', new.updated_by_type, new.updated_by, 'Contact restored');
      perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.contact.restored', 'crm_contact', new.id,
        jsonb_build_object('tenant_id', new.tenant_id));
    end if;
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    perform public.crm_log(new.tenant_id, new.id, null, 'contact_owner_changed', new.updated_by_type, new.updated_by,
      'Owner changed', jsonb_build_object('from', old.owner_user_id, 'to', new.owner_user_id));
    perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.contact.owner_changed', 'crm_contact', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'from', old.owner_user_id, 'to', new.owner_user_id));
  end if;
  v_fields := public.crm_changed_fields(to_jsonb(old), to_jsonb(new),
    array['updated_at', 'updated_by', 'updated_by_type', 'archived_at', 'archived_reason', 'owner_user_id', 'merged_into_id']);
  if cardinality(v_fields) > 0 then
    perform public.crm_log(new.tenant_id, new.id, null, 'contact_updated', new.updated_by_type, new.updated_by,
      'Contact updated', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_contacts_guard on public.crm_contacts;
create trigger crm_contacts_guard
  before insert or update on public.crm_contacts
  for each row execute function public.crm_contacts_guard();
drop trigger if exists crm_contacts_history on public.crm_contacts;
create trigger crm_contacts_history
  after insert or update on public.crm_contacts
  for each row execute function public.crm_contacts_history();

-- leads: the stage belongs to the pipeline, and the status is the stage's.
create or replace function public.crm_leads_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_stage   public.crm_pipeline_stages;
  v_contact public.crm_contacts;
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id then
      raise exception 'arc_crm:immutable: a lead never changes client' using errcode = 'P0001';
    end if;
    if new.contact_id <> old.contact_id and not public.crm_merging(new.tenant_id) then
      raise exception 'arc_crm:invalid: a lead keeps its contact — merge the two contacts instead' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);

  if tg_op = 'INSERT' then
    select * into v_contact from public.crm_contacts c where c.id = new.contact_id and c.tenant_id = new.tenant_id;
    if not found then
      raise exception 'arc_crm:not_found: that contact does not exist for this client' using errcode = 'P0001';
    end if;
    if v_contact.archived_at is not null or v_contact.merged_into_id is not null then
      raise exception 'arc_crm:contact_unavailable: that contact is archived or was merged' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.crm_pipelines p where p.id = new.pipeline_id and p.archived_at is not null) then
      raise exception 'arc_crm:invalid_stage: that pipeline is retired' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id then
    perform public.crm_check_owner(new.tenant_id, new.owner_user_id);
  end if;

  if tg_op = 'INSERT' or new.stage_id <> old.stage_id or new.pipeline_id <> old.pipeline_id then
    select * into v_stage from public.crm_pipeline_stages s
     where s.id = new.stage_id and s.pipeline_id = new.pipeline_id and s.tenant_id = new.tenant_id;
    if not found then
      raise exception 'arc_crm:invalid_stage: that stage is not part of this pipeline' using errcode = 'P0001';
    end if;
    if v_stage.archived_at is not null then
      raise exception 'arc_crm:invalid_stage: the stage "%" is retired', v_stage.key using errcode = 'P0001';
    end if;
    new.status := v_stage.kind;
    if v_stage.kind = 'open' then
      new.closed_at := null;
      new.closed_reason := null;
    else
      if v_stage.kind = 'lost' and coalesce(btrim(new.closed_reason), '') = '' then
        raise exception 'arc_crm:invalid: closing a lead as lost needs a reason' using errcode = 'P0001';
      end if;
      new.closed_at := now();
    end if;
    if v_stage.marks_qualified then
      new.qualified_at := coalesce(case when tg_op = 'UPDATE' then old.qualified_at end, now());
    elsif tg_op = 'UPDATE' then
      new.qualified_at := old.qualified_at;
    else
      new.qualified_at := null;
    end if;
  else
    new.status := old.status;
    new.closed_at := old.closed_at;
    new.qualified_at := old.qualified_at;
    if old.status = 'open' then
      new.closed_reason := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_leads_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_fields text[];
  v_from   text;
  v_to     text;
begin
  if tg_op = 'INSERT' then
    perform public.crm_log(new.tenant_id, new.contact_id, new.id, 'lead_created', new.updated_by_type, new.updated_by,
      'Lead created', jsonb_build_object('source', new.source));
    return null;
  end if;
  if new.stage_id <> old.stage_id then
    select s.key into v_from from public.crm_pipeline_stages s where s.id = old.stage_id;
    select s.key into v_to from public.crm_pipeline_stages s where s.id = new.stage_id;
    perform public.crm_log(new.tenant_id, new.contact_id, new.id, 'lead_stage_changed', new.updated_by_type, new.updated_by,
      'Stage changed', jsonb_build_object('from', v_from, 'to', v_to, 'status', new.status));
  end if;
  if (new.archived_at is null) <> (old.archived_at is null) then
    perform public.crm_log(new.tenant_id, new.contact_id, new.id,
      case when new.archived_at is not null then 'lead_archived' else 'lead_restored' end,
      new.updated_by_type, new.updated_by,
      case when new.archived_at is not null then 'Lead archived' else 'Lead restored' end);
    perform public.crm_audit(new.updated_by_type, new.updated_by,
      case when new.archived_at is not null then 'crm.lead.archived' else 'crm.lead.restored' end,
      'crm_lead', new.id, jsonb_build_object('tenant_id', new.tenant_id));
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    perform public.crm_log(new.tenant_id, new.contact_id, new.id, 'lead_owner_changed', new.updated_by_type, new.updated_by,
      'Owner changed', jsonb_build_object('from', old.owner_user_id, 'to', new.owner_user_id));
    perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.lead.owner_changed', 'crm_lead', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'from', old.owner_user_id, 'to', new.owner_user_id));
  end if;
  v_fields := public.crm_changed_fields(to_jsonb(old), to_jsonb(new),
    array['updated_at', 'updated_by', 'updated_by_type', 'archived_at', 'owner_user_id', 'stage_id', 'status', 'closed_at', 'qualified_at']);
  if cardinality(v_fields) > 0 then
    perform public.crm_log(new.tenant_id, new.contact_id, new.id, 'lead_updated', new.updated_by_type, new.updated_by,
      'Lead updated', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_leads_guard on public.crm_leads;
create trigger crm_leads_guard
  before insert or update on public.crm_leads
  for each row execute function public.crm_leads_guard();
drop trigger if exists crm_leads_history on public.crm_leads;
create trigger crm_leads_history
  after insert or update on public.crm_leads
  for each row execute function public.crm_leads_history();

-- notes: what was written stays written. a note is archived, never edited.
create or replace function public.crm_notes_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.crm_check_actor(new.tenant_id, new.author_type, new.author_id);
    if new.archived_at is not null then
      raise exception 'arc_crm:invalid: a note is not created archived' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if public.crm_merging(new.tenant_id) then
    if (to_jsonb(new) - 'contact_id') <> (to_jsonb(old) - 'contact_id') then
      raise exception 'arc_crm:immutable: a merge only moves a note to the surviving contact' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['archived_at', 'archived_by_type', 'archived_by'])
     <> (to_jsonb(old) - array['archived_at', 'archived_by_type', 'archived_by']) then
    raise exception 'arc_crm:immutable: a note is never edited — archive it and write another' using errcode = 'P0001';
  end if;
  if old.archived_at is not null then
    raise exception 'arc_crm:immutable: this note is already archived' using errcode = 'P0001';
  end if;
  if new.archived_at is null then
    raise exception 'arc_crm:invalid: the only change to a note is archiving it' using errcode = 'P0001';
  end if;
  perform public.crm_check_actor(new.tenant_id, new.archived_by_type, new.archived_by);
  new.archived_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_notes_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log(new.tenant_id, new.contact_id, new.lead_id, 'note_added', new.author_type, new.author_id,
      'Note added', jsonb_build_object('note_id', new.id));
  elsif new.archived_at is not null and old.archived_at is null then
    perform public.crm_log(new.tenant_id, new.contact_id, new.lead_id, 'note_archived', new.archived_by_type, new.archived_by,
      'Note archived', jsonb_build_object('note_id', new.id));
    perform public.crm_audit(new.archived_by_type, new.archived_by, 'crm.note.archived', 'crm_note', new.id,
      jsonb_build_object('tenant_id', new.tenant_id));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_notes_guard on public.crm_notes;
create trigger crm_notes_guard
  before insert or update on public.crm_notes
  for each row execute function public.crm_notes_guard();
drop trigger if exists crm_notes_history on public.crm_notes;
create trigger crm_notes_history
  after insert or update on public.crm_notes
  for each row execute function public.crm_notes_history();

-- tasks.
create or replace function public.crm_tasks_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id then
      raise exception 'arc_crm:immutable: a task never changes client' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'INSERT' or new.assigned_user_id is distinct from old.assigned_user_id then
    perform public.crm_check_owner(new.tenant_id, new.assigned_user_id);
  end if;
  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status <> 'done' then
      new.completed_at := now();
      new.completed_by := new.updated_by;
    else
      new.completed_at := old.completed_at;
      new.completed_by := old.completed_by;
    end if;
  else
    new.completed_at := null;
    new.completed_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_tasks_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_type text;
begin
  if tg_op = 'INSERT' then
    v_type := 'task_created';
  elsif new.status <> old.status then
    v_type := case new.status when 'done' then 'task_completed' when 'cancelled' then 'task_cancelled' else 'task_reopened' end;
  else
    v_type := 'task_updated';
  end if;
  perform public.crm_log(new.tenant_id, new.contact_id, new.lead_id, v_type, new.updated_by_type, new.updated_by,
    initcap(replace(v_type, '_', ' ')), jsonb_build_object('task_id', new.id));
  return null;
end;
$fn$;

drop trigger if exists crm_tasks_guard on public.crm_tasks;
create trigger crm_tasks_guard
  before insert or update on public.crm_tasks
  for each row execute function public.crm_tasks_guard();
drop trigger if exists crm_tasks_history on public.crm_tasks;
create trigger crm_tasks_history
  after insert or update on public.crm_tasks
  for each row execute function public.crm_tasks_history();

-- the timeline and the source records are history. the only delete either
-- ever sees is the cascade of a test client being purged (0022).
create or replace function public.crm_history_is_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_crm:immutable: % is history and is never rewritten or removed', tg_table_name using errcode = 'P0001';
end;
$fn$;

drop trigger if exists crm_activities_immutable on public.crm_activities;
create trigger crm_activities_immutable
  before update on public.crm_activities
  for each row execute function public.crm_history_is_immutable();
drop trigger if exists crm_activities_immutable_delete on public.crm_activities;
create trigger crm_activities_immutable_delete
  before delete on public.crm_activities
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- a source record gains its contact and its lead once, and nothing else moves.
create or replace function public.crm_source_events_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (to_jsonb(new) - array['contact_id', 'lead_id']) <> (to_jsonb(old) - array['contact_id', 'lead_id']) then
    raise exception 'arc_crm:immutable: a source record is never rewritten' using errcode = 'P0001';
  end if;
  if public.crm_merging(new.tenant_id) then
    return new;
  end if;
  if (old.contact_id is not null and new.contact_id is distinct from old.contact_id)
     or (old.lead_id is not null and new.lead_id is distinct from old.lead_id) then
    raise exception 'arc_crm:immutable: a source record keeps the contact and lead it was given' using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists crm_source_events_guard on public.crm_source_events;
create trigger crm_source_events_guard
  before update on public.crm_source_events
  for each row execute function public.crm_source_events_guard();
drop trigger if exists crm_source_events_immutable_delete on public.crm_source_events;
create trigger crm_source_events_immutable_delete
  before delete on public.crm_source_events
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- mappings: the record exists in this tenant, and a mapping is removed, never
-- repointed.
create or replace function public.crm_external_mappings_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_exists boolean;
begin
  if tg_op = 'UPDATE' then
    if public.crm_merging(new.tenant_id) then
      if (to_jsonb(new) - 'object_id') <> (to_jsonb(old) - 'object_id') then
        raise exception 'arc_crm:immutable: a merge only moves a mapping to the surviving contact' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if (to_jsonb(new) - array['removed_at', 'removed_by_type', 'removed_by'])
       <> (to_jsonb(old) - array['removed_at', 'removed_by_type', 'removed_by'])
       or old.removed_at is not null or new.removed_at is null then
      raise exception 'arc_crm:immutable: a mapping is removed, never repointed — remove it and add another' using errcode = 'P0001';
    end if;
    perform public.crm_check_actor(new.tenant_id, new.removed_by_type, new.removed_by);
    new.removed_at := now();
    return new;
  end if;

  perform public.crm_check_actor(new.tenant_id, new.created_by_type, new.created_by);
  if new.removed_at is not null then
    raise exception 'arc_crm:invalid: a mapping is not created removed' using errcode = 'P0001';
  end if;
  v_exists := case new.object_type
    when 'contact'  then exists (select 1 from public.crm_contacts x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'lead'     then exists (select 1 from public.crm_leads x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'task'     then exists (select 1 from public.crm_tasks x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'note'     then exists (select 1 from public.crm_notes x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'location' then exists (select 1 from public.business_locations x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'service'  then exists (select 1 from public.business_services x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    else false
  end;
  if not v_exists then
    raise exception 'arc_crm:not_found: that % does not exist for this client', new.object_type using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

create or replace function public.crm_external_mappings_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_removed boolean := tg_op = 'UPDATE' and new.removed_at is not null and old.removed_at is null;
begin
  if new.object_type not in ('contact', 'lead') or (tg_op = 'UPDATE' and not v_removed) then
    return null;
  end if;
  perform public.crm_log(
    new.tenant_id,
    case when new.object_type = 'contact' then new.object_id
         else (select l.contact_id from public.crm_leads l where l.id = new.object_id) end,
    case when new.object_type = 'lead' then new.object_id end,
    case when v_removed then 'mapping_removed' else 'mapping_added' end,
    case when v_removed then new.removed_by_type else new.created_by_type end,
    case when v_removed then new.removed_by else new.created_by end,
    case when v_removed then 'External mapping removed' else 'External mapping added' end,
    jsonb_build_object('connector_key', new.connector_key, 'external_id', new.external_id)
  );
  return null;
end;
$fn$;

drop trigger if exists crm_external_mappings_guard on public.crm_external_mappings;
create trigger crm_external_mappings_guard
  before insert or update on public.crm_external_mappings
  for each row execute function public.crm_external_mappings_guard();
drop trigger if exists crm_external_mappings_history on public.crm_external_mappings;
create trigger crm_external_mappings_history
  after insert or update on public.crm_external_mappings
  for each row execute function public.crm_external_mappings_history();

-- policies: an operator's decision, a real shape, and never against the route.
create or replace function public.crm_source_policies_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, 'operator', new.updated_by);
  if exists (select 1 from jsonb_each(new.field_owners) e where e.value not in ('"arc"'::jsonb, '"external"'::jsonb)) then
    raise exception 'arc_crm:invalid: each field is owned by "arc" or "external"' using errcode = 'P0001';
  end if;
  if new.authority <> 'arc' and exists (
    select 1 from public.business_profiles b where b.tenant_id = new.tenant_id and b.route = 'native'
  ) then
    raise exception 'arc_crm:route_conflict: this client is on ARC Native, where ARC holds every record' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_source_policies_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_audit('operator', new.updated_by, 'crm.source_policy.set', 'tenant', new.tenant_id,
    jsonb_build_object('object_type', new.object_type, 'authority', new.authority,
      'connector_key', new.connector_key, 'fields', new.field_owners));
  return null;
end;
$fn$;

drop trigger if exists crm_source_policies_guard on public.crm_source_policies;
create trigger crm_source_policies_guard
  before insert or update on public.crm_source_policies
  for each row execute function public.crm_source_policies_guard();
drop trigger if exists crm_source_policies_history on public.crm_source_policies;
create trigger crm_source_policies_history
  after insert or update on public.crm_source_policies
  for each row execute function public.crm_source_policies_history();

-- ---------------------------------------------------------------------------
-- 9. the default pipeline
-- ---------------------------------------------------------------------------

-- A lead needs somewhere to be. The first lead a client gets creates this, and
-- nothing after it does: a client's own pipeline, once made default, wins.
create or replace function public.crm_ensure_default_pipeline(p_tenant uuid)
returns uuid
language plpgsql
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  select p.id into v_id from public.crm_pipelines p
   where p.tenant_id = p_tenant and p.is_default and p.archived_at is null;
  if found then return v_id; end if;

  insert into public.crm_pipelines (tenant_id, key, name, is_default)
  values (p_tenant, 'sales', 'Sales', true)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select p.id into v_id from public.crm_pipelines p
     where p.tenant_id = p_tenant and p.is_default and p.archived_at is null;
    if v_id is null then
      raise exception 'arc_crm:invalid: this client has a retired "sales" pipeline and no default — make one default' using errcode = 'P0001';
    end if;
    return v_id;
  end if;

  insert into public.crm_pipeline_stages (tenant_id, pipeline_id, key, name, position, kind, marks_qualified) values
    (p_tenant, v_id, 'new',           'New',           10, 'open', false),
    (p_tenant, v_id, 'contacted',     'Contacted',     20, 'open', false),
    (p_tenant, v_id, 'qualified',     'Qualified',     30, 'open', true),
    (p_tenant, v_id, 'estimate_sent', 'Estimate sent', 40, 'open', false),
    (p_tenant, v_id, 'won',           'Won',           50, 'won',  false),
    (p_tenant, v_id, 'lost',          'Lost',          60, 'lost', false);
  return v_id;
end;
$fn$;

-- a client's own pipeline: the pipeline and its stages, or neither.
-- stages ride inside the one document: { key, name, is_default, stages: [...] }.
create or replace function public.crm_create_pipeline(p_tenant uuid, p_pipeline jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_id       uuid;
  v_stage    jsonb;
  v_position integer := 0;
  p_stages   jsonb := p_pipeline -> 'stages';
begin
  if jsonb_typeof(p_stages) is distinct from 'array' or not exists (
    select 1 from jsonb_array_elements(p_stages) s where coalesce(s ->> 'kind', 'open') = 'open'
  ) then
    raise exception 'arc_crm:invalid: a pipeline needs at least one open stage' using errcode = 'P0001';
  end if;
  if coalesce((p_pipeline ->> 'is_default')::boolean, false) then
    update public.crm_pipelines set is_default = false where tenant_id = p_tenant and is_default;
  end if;
  begin
    insert into public.crm_pipelines (tenant_id, key, name, is_default)
    values (p_tenant, p_pipeline ->> 'key', p_pipeline ->> 'name', coalesce((p_pipeline ->> 'is_default')::boolean, false))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'arc_crm:key_taken: this client already has a pipeline with the key %', p_pipeline ->> 'key' using errcode = 'P0001';
  end;
  begin
    for v_stage in select * from jsonb_array_elements(p_stages) loop
      v_position := v_position + 10;
      insert into public.crm_pipeline_stages (tenant_id, pipeline_id, key, name, position, kind, marks_qualified)
      values (p_tenant, v_id, v_stage ->> 'key', v_stage ->> 'name', v_position,
        coalesce(v_stage ->> 'kind', 'open'), coalesce((v_stage ->> 'marks_qualified')::boolean, false));
    end loop;
  exception when unique_violation then
    raise exception 'arc_crm:invalid: two stages of one pipeline cannot share a key' using errcode = 'P0001';
  end;
  return jsonb_build_object(
    'pipeline', (select to_jsonb(p) from public.crm_pipelines p where p.id = v_id),
    'stages', (select jsonb_agg(to_jsonb(s) order by s.position) from public.crm_pipeline_stages s where s.pipeline_id = v_id)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. merging two contacts
-- ---------------------------------------------------------------------------
--
-- "These two are one person" is a decision, so it is one function, one
-- transaction and one audit row. Everything the loser had moves to the winner;
-- the loser stays as a read-only row pointing at the winner, so an id anybody
-- kept still resolves, and its own timeline is still its own.

create or replace function public.crm_merge_contacts(
  p_tenant uuid, p_winner uuid, p_loser uuid, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_winner public.crm_contacts;
  v_loser  public.crm_contacts;
  v_leads  integer;
  v_notes  integer;
  v_tasks  integer;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_winner = p_loser then
    raise exception 'arc_crm:invalid: a contact cannot be merged into itself' using errcode = 'P0001';
  end if;
  -- locked in id order, so two merges of the same pair cannot deadlock.
  perform 1 from public.crm_contacts c
    where c.tenant_id = p_tenant and c.id in (p_winner, p_loser) order by c.id for update;
  select * into v_winner from public.crm_contacts c where c.id = p_winner and c.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_crm:not_found: the contact to keep does not exist for this client' using errcode = 'P0001';
  end if;
  select * into v_loser from public.crm_contacts c where c.id = p_loser and c.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_crm:not_found: the contact to merge does not exist for this client' using errcode = 'P0001';
  end if;
  if v_winner.merged_into_id is not null or v_winner.archived_at is not null or v_loser.merged_into_id is not null then
    raise exception 'arc_crm:contact_unavailable: an archived or already merged contact cannot take part in a merge' using errcode = 'P0001';
  end if;

  perform set_config('arc.crm_merging', p_tenant::text, true);

  update public.crm_leads set contact_id = p_winner, updated_by_type = p_actor_type, updated_by = p_actor
   where tenant_id = p_tenant and contact_id = p_loser;
  get diagnostics v_leads = row_count;
  update public.crm_notes set contact_id = p_winner where tenant_id = p_tenant and contact_id = p_loser;
  get diagnostics v_notes = row_count;
  update public.crm_tasks set contact_id = p_winner, updated_by_type = p_actor_type, updated_by = p_actor
   where tenant_id = p_tenant and contact_id = p_loser;
  get diagnostics v_tasks = row_count;
  update public.crm_source_events set contact_id = p_winner where tenant_id = p_tenant and contact_id = p_loser;
  begin
    update public.crm_external_mappings set object_id = p_winner
     where tenant_id = p_tenant and object_type = 'contact' and object_id = p_loser and removed_at is null;
  exception when unique_violation then
    raise exception 'arc_crm:mapping_conflict: both contacts are mapped to the same external system — remove one mapping first' using errcode = 'P0001';
  end;
  -- anything already merged into the loser now points at the winner: one hop, always.
  update public.crm_contacts set merged_into_id = p_winner, updated_by_type = p_actor_type, updated_by = p_actor
   where tenant_id = p_tenant and merged_into_id = p_loser;

  -- the winner keeps what it has and takes what it lacked.
  update public.crm_contacts set
    first_name = coalesce(first_name, v_loser.first_name),
    last_name = coalesce(last_name, v_loser.last_name),
    phone = coalesce(phone, v_loser.phone),
    email = coalesce(email, v_loser.email),
    preferred_channel = coalesce(preferred_channel, v_loser.preferred_channel),
    address_line1 = coalesce(address_line1, v_loser.address_line1),
    address_line2 = coalesce(address_line2, v_loser.address_line2),
    city = coalesce(city, v_loser.city),
    region = coalesce(region, v_loser.region),
    postal_code = coalesce(postal_code, v_loser.postal_code),
    country = coalesce(country, v_loser.country),
    location_id = coalesce(location_id, v_loser.location_id),
    updated_by_type = p_actor_type, updated_by = p_actor
   where id = p_winner
   returning * into v_winner;
  update public.crm_contacts set
    merged_into_id = p_winner, archived_at = coalesce(archived_at, now()), archived_reason = 'merged',
    updated_by_type = p_actor_type, updated_by = p_actor
   where id = p_loser;

  perform set_config('arc.crm_merging', '', true);

  perform public.crm_log(p_tenant, p_winner, null, 'contact_merged', p_actor_type, p_actor, 'Another contact was merged into this one',
    jsonb_build_object('merged_contact_id', p_loser, 'leads', v_leads, 'notes', v_notes, 'tasks', v_tasks));
  perform public.crm_audit(p_actor_type, p_actor, 'crm.contact.merged', 'crm_contact', p_winner,
    jsonb_build_object('tenant_id', p_tenant, 'merged_contact_id', p_loser, 'leads', v_leads, 'notes', v_notes, 'tasks', v_tasks));

  return jsonb_build_object(
    'contact', to_jsonb(v_winner),
    'merged_contact_id', p_loser,
    'moved', jsonb_build_object('leads', v_leads, 'notes', v_notes, 'tasks', v_tasks)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 11. a client with customers is not a test client
-- ---------------------------------------------------------------------------

-- 0022's purge, with three more things that mean the client did something
-- real. A business profile, a pipeline or a service list is setup and still
-- goes with the client; a customer, a lead or an arrival does not.
create or replace function public.purge_test_tenant(p_actor uuid, p_tenant uuid, p_confirm_slug text)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_tenant   public.tenants;
  v_activity text[] := '{}';
  v_count    bigint;
  v_check    record;
  v_record   public.tenant_purges;
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_tenant:forbidden: deleting a client is an operator action' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_tenant:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants t where t.id = p_tenant for update;
  if not found then
    raise exception 'arc_tenant:not_found: this client does not exist' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_confirm_slug), '') <> v_tenant.slug then
    raise exception 'arc_tenant:confirmation_mismatch: type the handle % to confirm', v_tenant.slug using errcode = 'P0001';
  end if;

  for v_check in
    select * from (values
      ('events',                         'events'),
      ('leads',                          'leads'),
      ('conversations',                  'conversations'),
      ('messages',                       'messages'),
      ('handoffs',                       'handoffs'),
      ('automation_runs',                'runs (including synthetic canaries)'),
      ('scheduled_actions',              'queued actions'),
      ('automation_action_attempts',     'action attempts'),
      ('lead_recovery_effect_attempts',  'sending attempts'),
      ('lead_recovery_config_snapshots', 'sending snapshots'),
      ('runner_dispatches',              'runner dispatches'),
      ('runner_bridge_log',              'runner bridge requests'),
      ('provider_connections',           'provider connections'),
      ('suppressions',                   'opt-outs'),
      ('crm_contacts',                   'customer records'),
      ('crm_leads',                      'CRM leads'),
      ('crm_source_events',              'lead source records')
    ) as c(tbl, label)
  loop
    execute format('select count(*) from public.%I where tenant_id = $1', v_check.tbl) into v_count using p_tenant;
    if v_count > 0 then
      v_activity := v_activity || format('%s %s', v_count, v_check.label);
    end if;
  end loop;
  select count(*) into v_count from public.ingest_tokens k where k.tenant_id = p_tenant and k.last_used_at is not null;
  if v_count > 0 then
    v_activity := v_activity || format('%s ingest tokens that were used', v_count);
  end if;

  if array_length(v_activity, 1) > 0 then
    raise exception 'arc_tenant:tenant_has_activity: % has real activity (%) — deboard it instead; its history is kept',
      v_tenant.slug, array_to_string(v_activity, ', ') using errcode = 'P0001';
  end if;

  insert into public.tenant_purges (tenant_id, actor_user_id, name, slug, client_id, created_at)
  values (v_tenant.id, p_actor, v_tenant.name, v_tenant.slug, v_tenant.client_id, v_tenant.created_at)
  returning * into v_record;
  perform set_config('arc.purging_tenant', p_tenant::text, true);

  begin
    delete from public.tenants t where t.id = p_tenant;
  exception when foreign_key_violation then
    raise exception 'arc_tenant:tenant_has_activity: % still has an OAuth session or connection record — deboard it instead; its history is kept',
      v_tenant.slug using errcode = 'P0001';
  end;

  perform set_config('arc.purging_tenant', '', true);

  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (p_actor, 'tenant.purged', 'tenant', p_tenant::text, jsonb_build_object(
    'name', v_tenant.name, 'slug', v_tenant.slug, 'client_id', v_tenant.client_id
  ));

  return to_jsonb(v_record);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 12. RLS and grants
-- ---------------------------------------------------------------------------

-- The 0010 pattern on every table: a client reads their own rows, an operator
-- reads everything, and nobody holding a browser key writes anything.
do $$
declare
  t text;
begin
  foreach t in array array[
    'business_profiles', 'business_locations', 'business_service_areas',
    'business_service_categories', 'business_services',
    'crm_contacts', 'crm_pipelines', 'crm_pipeline_stages', 'crm_source_events',
    'crm_leads', 'crm_notes', 'crm_tasks', 'crm_activities',
    'crm_external_mappings', 'crm_source_policies'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin())',
      t || '_read', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke all on function public.crm_text_is_clean(text) from public, anon, authenticated;
revoke all on function public.crm_check_actor(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_check_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_merging(uuid) from public, anon, authenticated;
revoke all on function public.crm_changed_fields(jsonb, jsonb, text[]) from public, anon, authenticated;
revoke all on function public.crm_log(uuid, uuid, uuid, text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.crm_audit(text, uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_ensure_default_pipeline(uuid) from public, anon, authenticated;
revoke all on function public.crm_create_pipeline(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_merge_contacts(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.purge_test_tenant(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.business_profiles_guard() from public, anon, authenticated;
revoke all on function public.business_profiles_history() from public, anon, authenticated;
revoke all on function public.business_locations_guard() from public, anon, authenticated;
revoke all on function public.crm_contacts_guard() from public, anon, authenticated;
revoke all on function public.crm_contacts_history() from public, anon, authenticated;
revoke all on function public.crm_leads_guard() from public, anon, authenticated;
revoke all on function public.crm_leads_history() from public, anon, authenticated;
revoke all on function public.crm_notes_guard() from public, anon, authenticated;
revoke all on function public.crm_notes_history() from public, anon, authenticated;
revoke all on function public.crm_tasks_guard() from public, anon, authenticated;
revoke all on function public.crm_tasks_history() from public, anon, authenticated;
revoke all on function public.crm_history_is_immutable() from public, anon, authenticated;
revoke all on function public.crm_source_events_guard() from public, anon, authenticated;
revoke all on function public.crm_external_mappings_guard() from public, anon, authenticated;
revoke all on function public.crm_external_mappings_history() from public, anon, authenticated;
revoke all on function public.crm_source_policies_guard() from public, anon, authenticated;
revoke all on function public.crm_source_policies_history() from public, anon, authenticated;

grant execute on function public.crm_text_is_clean(text) to service_role;
grant execute on function public.crm_check_actor(uuid, text, uuid) to service_role;
grant execute on function public.crm_check_owner(uuid, uuid) to service_role;
grant execute on function public.crm_merging(uuid) to service_role;
grant execute on function public.crm_changed_fields(jsonb, jsonb, text[]) to service_role;
grant execute on function public.crm_log(uuid, uuid, uuid, text, text, uuid, text, jsonb) to service_role;
grant execute on function public.crm_audit(text, uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.crm_ensure_default_pipeline(uuid) to service_role;
grant execute on function public.crm_create_pipeline(uuid, jsonb) to service_role;
grant execute on function public.crm_merge_contacts(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.purge_test_tenant(uuid, uuid, text) to service_role;
