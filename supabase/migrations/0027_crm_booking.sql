-- ===========================================================================
-- 0027 — scheduling, availability and booking (ARC-380)
-- ===========================================================================
--
-- ARC-340 (0023) built the customer and lead records, ARC-350 (0024) the doors
-- into them, ARC-360 (0025) the workspace, ARC-370 (0026) the conversation. This
-- is the appointment: a lead becomes a time on a day, without another booking
-- product and without ARC becoming a dispatch system.
--
--   crm_booking_settings     one row per client: which hours bookings follow, the
--                            step between offered times, the notice a booking
--                            needs, how far ahead the calendar is open, buffers,
--                            how many appointments may overlap, and what a
--                            customer may change from their own link.
--   crm_appointment_types    what can be booked: a name, a length, its own
--                            buffers, and whether a customer's booking is a
--                            REQUEST until a person confirms it.
--   crm_booking_pages        a page ARC hosts (`/book/<key>`), as 0024's forms
--                            are: an opaque public key, a status, a version.
--   crm_appointments         one row per appointment. Requested or confirmed
--                            holds its time; everything else has let it go.
--   crm_appointment_links    the SHA-256 of a customer's own change/cancel link.
--                            No browser role reads this table at all.
--   crm_appointment_events   append-only: requested, confirmed, declined,
--                            rescheduled (from, to), cancelled, completed,
--                            no-show, and what an external calendar reported.
--
-- ---------------------------------------------------------------------------
-- Two appointments cannot take the same time
-- ---------------------------------------------------------------------------
--
-- The check is in the row's own guard, behind one advisory lock per client, so
-- it holds whichever path wrote the row: the hosted page, a person in the
-- workspace, a reschedule, a reconciliation. An appointment's buffer is kept
-- clear of the other's actual time, in both directions; `capacity` says how
-- many may overlap (one crew: 1).
--
-- ---------------------------------------------------------------------------
-- Whose calendar it is
-- ---------------------------------------------------------------------------
--
-- ARC-340's source-of-truth policy gains a seventh kind of record: `appointment`.
-- No row means ARC keeps the calendar. Where the client's own calendar is the
-- authority for the time (`external`, or `hybrid` with `starts_at` theirs):
--
--   * ARC offers no times. It does not know what is free there, and saying so
--     would be inventing availability.
--   * a booking from the hosted page is a `requested` appointment with
--     `sync_state = 'pending'` — a preferred time, for their calendar to answer.
--   * nobody on ARC's side confirms, moves or cancels it; that happens there,
--     and arrives through `crm_appointment_external_report`.
--
-- A report that disagrees with a field ARC owns is never applied and never
-- dropped: the appointment is marked `conflict`, frozen, and a person chooses
-- (`crm_appointment_reconcile`). Nothing is merged and nothing is "latest wins".
--
-- What this is not:
--   * not evidence. Nothing here writes `events`, and no figure reads these
--     tables. A confirmed appointment is a calendar entry, not a proven job.
--   * not dispatch. No routes, no technician schedules, no time tracking, no
--     inventory, estimates, invoices or job costing. `assigned_user_id` names
--     who has it; `capacity` is a number.
--   * not a message. Nothing here texts or emails anybody: a confirmation or a
--     reminder is a message, and messages are 0026's, behind its own gate.
--   * not a credential store. Every text column refuses secret-shaped values.
--
-- Who writes: no browser role, on any of it — the 0023 pattern. Refusals arrive
-- as `arc_crm:<code>: <message>`.
--
-- Rollback: drop the six tables and the crm_book* / crm_appointment* /
--   crm_booking* functions, drop crm_contacts_move_appointments, restore the
--   three check constraints widened in section 0 to their 0023 lists and
--   crm_external_mappings_guard to 0023's, and re-create purge_test_tenant from
--   0026.
--
-- Forward-only and additive. Three check constraints are widened in place.

-- ---------------------------------------------------------------------------
-- 0. three vocabularies gain appointments
-- ---------------------------------------------------------------------------

-- the timeline says an appointment was made, moved or called off, next to
-- everything else that happened to the lead.
alter table public.crm_activities drop constraint if exists crm_activities_activity_type_check;
alter table public.crm_activities add constraint crm_activities_activity_type_check
  check (activity_type in (
    'contact_created', 'contact_updated', 'contact_archived', 'contact_restored',
    'contact_merged', 'contact_owner_changed',
    'lead_created', 'lead_updated', 'lead_stage_changed', 'lead_owner_changed',
    'lead_archived', 'lead_restored',
    'note_added', 'note_archived',
    'task_created', 'task_updated', 'task_completed', 'task_cancelled', 'task_reopened',
    'mapping_added', 'mapping_removed',
    'appointment_requested', 'appointment_confirmed', 'appointment_declined', 'appointment_rescheduled',
    'appointment_cancelled', 'appointment_completed', 'appointment_no_show'
  ));

-- an appointment can be the same thing as an entry in their calendar, and can
-- have an authority of its own.
alter table public.crm_external_mappings drop constraint if exists crm_external_mappings_object_type_check;
alter table public.crm_external_mappings add constraint crm_external_mappings_object_type_check
  check (object_type in ('contact', 'lead', 'task', 'note', 'location', 'service', 'appointment'));

alter table public.crm_source_policies drop constraint if exists crm_source_policies_object_type_check;
alter table public.crm_source_policies add constraint crm_source_policies_object_type_check
  check (object_type in ('contact', 'lead', 'task', 'note', 'location', 'service', 'appointment'));

-- ---------------------------------------------------------------------------
-- 1. the rules a booking follows
-- ---------------------------------------------------------------------------

-- No row means the defaults below, read through crm_booking_rules. A client is
-- bookable from the moment it has opening hours and one appointment type.
create table if not exists public.crm_booking_settings (
  tenant_id                      uuid primary key references public.tenants(id) on delete cascade,
  -- the hours on the business profile (0023), or hours kept only for bookings.
  hours_source                   text not null default 'business_hours' check (hours_source in ('business_hours', 'custom')),
  -- { "mon": [{ "open": "08:00", "close": "17:00" }], ... } — a day left out is closed.
  custom_hours                   jsonb not null default '{}'::jsonb check (
    jsonb_typeof(custom_hours) = 'object'
    and custom_hours - array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] = '{}'::jsonb
  ),
  -- ["2026-12-25", ...] in the business's own calendar. closed all day.
  closed_dates                   jsonb not null default '[]'::jsonb check (
    jsonb_typeof(closed_dates) = 'array' and jsonb_array_length(closed_dates) <= 60
  ),
  slot_step_minutes              integer not null default 30 check (slot_step_minutes in (15, 30, 60)),
  -- how much notice a booking needs, and how far ahead the calendar is open.
  min_lead_minutes               integer not null default 120 check (min_lead_minutes between 0 and 43200),
  max_days_ahead                 integer not null default 30 check (max_days_ahead between 1 and 365),
  buffer_before_minutes          integer not null default 0 check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes           integer not null default 0 check (buffer_after_minutes between 0 and 240),
  -- how many appointments may overlap. one crew is 1.
  capacity                       integer not null default 1 check (capacity between 1 and 20),
  -- what a customer may do from the link they were given, and until when.
  customer_may_cancel            boolean not null default true,
  customer_may_reschedule        boolean not null default true,
  customer_change_cutoff_minutes integer not null default 240 check (customer_change_cutoff_minutes between 0 and 43200),
  -- refuse a hosted booking whose address is outside the service areas (0023).
  enforce_service_area           boolean not null default false,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  updated_by_type                text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by                     uuid not null
);

create table if not exists public.crm_appointment_types (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  key                   text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name                  text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  description           text check (description is null or (char_length(description) <= 500 and public.crm_text_is_clean(description))),
  -- the service it is a visit for, when it is for one.
  service_id            uuid,
  duration_minutes      integer not null check (duration_minutes between 5 and 480),
  -- null means the client's own setting.
  buffer_before_minutes integer check (buffer_before_minutes is null or buffer_before_minutes between 0 and 240),
  buffer_after_minutes  integer check (buffer_after_minutes is null or buffer_after_minutes between 0 and 240),
  -- a customer's booking is a request until a person confirms it.
  requires_approval     boolean not null default true,
  -- offered on a hosted booking page. off: a person can still book it.
  is_public             boolean not null default true,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  updated_by_type       text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by            uuid not null,
  unique (tenant_id, key),
  unique (id, tenant_id),
  foreign key (service_id, tenant_id) references public.business_services (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- 2. the hosted page
-- ---------------------------------------------------------------------------

-- 0024's form, for a time instead of an enquiry: the key is the only thing a
-- browser is given, it is not the client's id, and what a valid one can do is
-- book an appointment with the client that published the page.
create table if not exists public.crm_booking_pages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  public_key      text not null unique check (public_key ~ '^arcb_[a-z0-9]{32}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  version         integer not null default 1 check (version >= 1),
  definition      jsonb not null check (
    jsonb_typeof(definition) = 'object'
    and char_length(definition::text) <= 8000
    and public.crm_text_is_clean(definition::text)
  ),
  -- somebody with an open lead this recent books onto that lead. 0 turns it off.
  dedupe_minutes  integer not null default 1440 check (dedupe_minutes between 0 and 43200),
  hourly_cap      integer not null default 60 check (hourly_cap between 1 and 1000),
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by_type text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by      uuid not null,
  unique (id, tenant_id)
);

create index if not exists crm_booking_pages_tenant_idx on public.crm_booking_pages (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. appointments
-- ---------------------------------------------------------------------------

create table if not exists public.crm_appointments (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  contact_id           uuid not null,
  -- the lead this is the appointment for, when there is one.
  lead_id              uuid,
  appointment_type_id  uuid,
  -- the type's name when it was booked. a renamed type does not rename history.
  title                text not null check (char_length(btrim(title)) between 1 and 200 and public.crm_text_is_clean(title)),
  service_id           uuid,
  location_id          uuid,
  status               text not null check (status in ('requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show')),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  -- the time with its buffers. another appointment's actual time stays out of it.
  busy_from            timestamptz not null,
  busy_until           timestamptz not null,
  -- the business's timezone when it was booked, so it reads the same later.
  timezone             text not null check (char_length(timezone) between 1 and 64),
  -- where the visit is.
  address_line1        text check (address_line1 is null or (char_length(address_line1) <= 200 and public.crm_text_is_clean(address_line1))),
  city                 text check (city is null or char_length(city) <= 120),
  region               text check (region is null or char_length(region) <= 120),
  postal_code          text check (postal_code is null or char_length(postal_code) <= 20),
  customer_note        text check (customer_note is null or (char_length(customer_note) <= 1000 and public.crm_text_is_clean(customer_note))),
  source               text not null check (source in ('booking_page', 'staff', 'external_system')),
  booking_page_id      uuid,
  booking_page_version integer,
  source_event_id      uuid,
  -- a double click or a retried request is one booking.
  idempotency_key      text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  -- whether a customer's booking of it was a request. copied from the type, so
  -- changing the type later does not change what this one was.
  requires_approval    boolean not null default false,
  assigned_user_id     uuid,
  reschedule_count     integer not null default 0 check (reschedule_count >= 0),
  cancel_reason        text check (cancel_reason is null or (char_length(cancel_reason) <= 300 and public.crm_text_is_clean(cancel_reason))),
  confirmed_at         timestamptz,
  closed_at            timestamptz,
  -- how this row stands against their calendar, when there is one.
  sync_state           text not null default 'local' check (sync_state in ('local', 'pending', 'synced', 'conflict')),
  sync_detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(sync_detail) = 'object' and public.crm_text_is_clean(sync_detail::text)),
  last_synced_at       timestamptz,
  -- which door the last change came through.
  changed_via          text not null default 'workspace' check (changed_via in ('booking_page', 'manage_link', 'workspace', 'sync')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  updated_by_type      text not null,
  updated_by           uuid,
  unique (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id),
  foreign key (appointment_type_id, tenant_id) references public.crm_appointment_types (id, tenant_id),
  foreign key (service_id, tenant_id) references public.business_services (id, tenant_id),
  foreign key (location_id, tenant_id) references public.business_locations (id, tenant_id),
  foreign key (booking_page_id, tenant_id) references public.crm_booking_pages (id, tenant_id),
  foreign key (source_event_id, tenant_id) references public.crm_source_events (id, tenant_id),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours'),
  check (busy_from <= starts_at and busy_until >= ends_at),
  check ((status in ('declined', 'cancelled', 'completed', 'no_show')) = (closed_at is not null))
);

create unique index if not exists crm_appointments_idempotency
  on public.crm_appointments (tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists crm_appointments_time_idx on public.crm_appointments (tenant_id, starts_at);
create index if not exists crm_appointments_held_idx
  on public.crm_appointments (tenant_id, busy_from, busy_until) where status in ('requested', 'confirmed');
create index if not exists crm_appointments_lead_idx on public.crm_appointments (tenant_id, lead_id) where lead_id is not null;
create index if not exists crm_appointments_contact_idx on public.crm_appointments (tenant_id, contact_id);

-- A customer's own link to change or cancel one appointment. The 0001 pattern:
-- the SHA-256 of the token, never the token. It is shown once, on the page that
-- made the booking.
create table if not exists public.crm_appointment_links (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null,
  token_hash     text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  foreign key (appointment_id, tenant_id) references public.crm_appointments (id, tenant_id) on delete cascade
);

create index if not exists crm_appointment_links_appointment_idx on public.crm_appointment_links (tenant_id, appointment_id);

-- What happened to an appointment, in order. Append-only, written by the
-- trigger below in the same statement as the change.
create table if not exists public.crm_appointment_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null,
  event_type     text not null check (event_type in (
    'requested', 'confirmed', 'declined', 'rescheduled', 'cancelled', 'completed', 'no_show',
    'assigned', 'sync_applied', 'sync_conflict', 'reconciled'
  )),
  actor_type     text not null check (actor_type in ('operator', 'client_user', 'system', 'external')),
  actor_id       uuid,
  -- which door, and for a move, the time it had and the time it has.
  detail         jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and public.crm_text_is_clean(detail::text)),
  occurred_at    timestamptz not null default now(),
  foreign key (appointment_id, tenant_id) references public.crm_appointments (id, tenant_id) on delete cascade
);

create index if not exists crm_appointment_events_idx on public.crm_appointment_events (tenant_id, appointment_id, occurred_at);

drop trigger if exists crm_appointment_events_immutable on public.crm_appointment_events;
create trigger crm_appointment_events_immutable
  before update on public.crm_appointment_events
  for each row execute function public.crm_history_is_immutable();
drop trigger if exists crm_appointment_events_immutable_delete on public.crm_appointment_events;
create trigger crm_appointment_events_immutable_delete
  before delete on public.crm_appointment_events
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 4. the rules, read
-- ---------------------------------------------------------------------------

-- which side owns one field of an appointment. no policy row is ARC.
create or replace function public.crm_appointment_field_owner(p_tenant uuid, p_field text)
returns text
language sql
stable
set search_path = public
as $fn$
  select coalesce((
    select case p.authority
             when 'arc' then 'arc'
             when 'external' then 'external'
             else coalesce(p.field_owners ->> p_field, 'arc')
           end
      from public.crm_source_policies p
     where p.tenant_id = p_tenant and p.object_type = 'appointment'
  ), 'arc');
$fn$;

-- everything a booking is checked against, as one document: the settings (or
-- their defaults), the hours they point at, the business's timezone, and whose
-- calendar it is. the service reads this; so does crm_book_appointment.
create or replace function public.crm_booking_rules(p_tenant uuid)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
    'timezone', t.timezone,
    'hours_source', coalesce(s.hours_source, 'business_hours'),
    'hours', case when s.hours_source = 'custom' then s.custom_hours else coalesce(b.business_hours, '{}'::jsonb) end,
    'closed_dates', coalesce(s.closed_dates, '[]'::jsonb),
    'slot_step_minutes', coalesce(s.slot_step_minutes, 30),
    'min_lead_minutes', coalesce(s.min_lead_minutes, 120),
    'max_days_ahead', coalesce(s.max_days_ahead, 30),
    'buffer_before_minutes', coalesce(s.buffer_before_minutes, 0),
    'buffer_after_minutes', coalesce(s.buffer_after_minutes, 0),
    'capacity', coalesce(s.capacity, 1),
    'customer_may_cancel', coalesce(s.customer_may_cancel, true),
    'customer_may_reschedule', coalesce(s.customer_may_reschedule, true),
    'customer_change_cutoff_minutes', coalesce(s.customer_change_cutoff_minutes, 240),
    'enforce_service_area', coalesce(s.enforce_service_area, false),
    'authority', jsonb_build_object(
      'authority', coalesce(p.authority, 'arc'),
      'connector_key', p.connector_key,
      'time_owner', public.crm_appointment_field_owner(p_tenant, 'starts_at'),
      'status_owner', public.crm_appointment_field_owner(p_tenant, 'status')
    )
  )
    from public.tenants t
    left join public.crm_booking_settings s on s.tenant_id = t.id
    left join public.business_profiles b on b.tenant_id = t.id
    left join public.crm_source_policies p on p.tenant_id = t.id and p.object_type = 'appointment'
   where t.id = p_tenant;
$fn$;

-- why a time may not be booked, in the customer's words, or null. the hours are
-- read in the business's own timezone: 9am is 9am there, on both sides of a
-- clock change. an appointment sits inside one open period of one day.
create or replace function public.crm_booking_check_time(p_rules jsonb, p_starts timestamptz, p_ends timestamptz)
returns text
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_zone        text := p_rules ->> 'timezone';
  v_local_start timestamp := p_starts at time zone v_zone;
  v_local_end   timestamp := p_ends at time zone v_zone;
  v_day         text := (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from v_local_start)::integer + 1];
begin
  if p_starts < now() + make_interval(mins => (p_rules ->> 'min_lead_minutes')::integer) then
    return 'that time is too soon to book';
  end if;
  if p_starts > now() + make_interval(days => (p_rules ->> 'max_days_ahead')::integer) then
    return 'that time is further ahead than bookings are open';
  end if;
  if (p_rules -> 'closed_dates') ? to_char(v_local_start, 'YYYY-MM-DD') then
    return 'the business is closed that day';
  end if;
  if v_local_end::date <> v_local_start::date or not exists (
    select 1
      from jsonb_array_elements(coalesce(p_rules -> 'hours' -> v_day, '[]'::jsonb)) period
     where period ->> 'open' <= to_char(v_local_start, 'HH24:MI')
       and period ->> 'close' >= to_char(v_local_end, 'HH24:MI')
  ) then
    return 'that time is outside opening hours';
  end if;
  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. guards
-- ---------------------------------------------------------------------------

create or replace function public.crm_booking_settings_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id then
      raise exception 'arc_crm:immutable: booking settings never change client' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.closed_dates) d
     where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) then
    raise exception 'arc_crm:invalid: a closed date is written YYYY-MM-DD' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists crm_booking_settings_guard on public.crm_booking_settings;
create trigger crm_booking_settings_guard
  before insert or update on public.crm_booking_settings
  for each row execute function public.crm_booking_settings_guard();

-- a type keeps its key: an appointment and a page name it by that.
create or replace function public.crm_appointment_types_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id or new.key <> old.key then
      raise exception 'arc_crm:immutable: an appointment type keeps its client and its key' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists crm_appointment_types_guard on public.crm_appointment_types;
create trigger crm_appointment_types_guard
  before insert or update on public.crm_appointment_types
  for each row execute function public.crm_appointment_types_guard();

-- 0024's form guard, for a booking page.
create or replace function public.crm_booking_pages_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id or new.public_key <> old.public_key then
      raise exception 'arc_crm:immutable: a booking page keeps its client and its link' using errcode = 'P0001';
    end if;
    if old.status = 'archived' and new.status = 'published' then
      raise exception 'arc_crm:invalid: an archived booking page is restored as a draft first' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    new.version := case when new.definition is distinct from old.definition then old.version + 1 else old.version end;
    new.published_at := case when new.status = 'published' and old.status <> 'published' then now() else old.published_at end;
  else
    new.version := 1;
    new.published_at := case when new.status = 'published' then now() end;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_booking_pages_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.booking_page.' || new.status, 'crm_booking_page', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'version', new.version));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_booking_pages_guard on public.crm_booking_pages;
create trigger crm_booking_pages_guard
  before insert or update on public.crm_booking_pages
  for each row execute function public.crm_booking_pages_guard();
drop trigger if exists crm_booking_pages_history on public.crm_booking_pages;
create trigger crm_booking_pages_history
  after insert or update on public.crm_booking_pages
  for each row execute function public.crm_booking_pages_history();

-- one lock per client for anything that takes or moves a time.
create or replace function public.crm_booking_lock(p_tenant uuid)
returns void
language sql
set search_path = public
as $fn$
  select pg_advisory_xact_lock(hashtextextended('arc_crm_booking:' || p_tenant::text, 0));
$fn$;

-- An appointment: who, a legal change of status, and a time nobody else holds.
--
-- The legal changes a person can make (mirrored by `APPOINTMENT_TRANSITIONS`):
--
--   requested → confirmed | declined | cancelled
--   confirmed → cancelled | completed | no_show
--   confirmed → requested   only together with a new time: a customer moved an
--                           appointment that needs approval
--
-- Their calendar, where it is the authority, may report any status. So may a
-- reconciliation, which is a person accepting what it reported.
create or replace function public.crm_appointments_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_held         boolean := new.status in ('requested', 'confirmed');
  v_was_held     boolean := false;
  v_time_changed boolean := false;
  v_reconciling  boolean := false;
  v_theirs       boolean := new.updated_by_type = 'external';
  v_contact      public.crm_contacts;
  v_capacity     integer;
  v_overlaps     integer;
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id then
      raise exception 'arc_crm:immutable: an appointment never changes client' using errcode = 'P0001';
    end if;
    if new.contact_id <> old.contact_id then
      if not public.crm_merging(new.tenant_id) then
        raise exception 'arc_crm:invalid: an appointment keeps its customer — merge the two contacts instead' using errcode = 'P0001';
      end if;
      -- a merge moves the appointment to the surviving contact and nothing else.
      if (to_jsonb(new) - 'contact_id') <> (to_jsonb(old) - 'contact_id') then
        raise exception 'arc_crm:immutable: a merge only moves an appointment to the surviving contact' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if (new.source, new.booking_page_id, new.booking_page_version, new.source_event_id, new.idempotency_key, new.requires_approval, new.timezone)
       is distinct from
       (old.source, old.booking_page_id, old.booking_page_version, old.source_event_id, old.idempotency_key, old.requires_approval, old.timezone) then
      raise exception 'arc_crm:immutable: an appointment keeps where it came from' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    v_was_held := old.status in ('requested', 'confirmed');
    v_time_changed := (new.starts_at, new.ends_at, new.busy_from, new.busy_until)
      is distinct from (old.starts_at, old.ends_at, old.busy_from, old.busy_until);
    v_reconciling := old.sync_state = 'conflict' and new.sync_state <> 'conflict';
  end if;
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);

  if tg_op = 'INSERT' then
    select * into v_contact from public.crm_contacts c where c.id = new.contact_id and c.tenant_id = new.tenant_id;
    if not found then
      raise exception 'arc_crm:not_found: that customer does not exist for this client' using errcode = 'P0001';
    end if;
    if v_contact.archived_at is not null or v_contact.merged_into_id is not null then
      raise exception 'arc_crm:contact_unavailable: that customer is archived or was merged' using errcode = 'P0001';
    end if;
    if new.lead_id is not null and not exists (
      select 1 from public.crm_leads l where l.id = new.lead_id and l.tenant_id = new.tenant_id and l.contact_id = new.contact_id
    ) then
      raise exception 'arc_crm:not_found: that lead is not this customer''s' using errcode = 'P0001';
    end if;
    new.reschedule_count := 0;
  else
    if old.sync_state = 'conflict' and new.sync_state = 'conflict' and (new.status <> old.status or v_time_changed) then
      raise exception 'arc_crm:needs_reconciliation: their calendar and ARC disagree about this appointment — choose which is right first' using errcode = 'P0001';
    end if;
    if new.lead_id is distinct from old.lead_id then
      raise exception 'arc_crm:immutable: an appointment keeps the lead it was booked for' using errcode = 'P0001';
    end if;
    if not v_theirs and not v_reconciling then
      if new.status <> old.status and not (
        (old.status = 'requested' and new.status in ('confirmed', 'declined', 'cancelled'))
        or (old.status = 'confirmed' and new.status in ('cancelled', 'completed', 'no_show'))
        or (old.status = 'confirmed' and new.status = 'requested' and new.starts_at <> old.starts_at)
      ) then
        raise exception 'arc_crm:invalid_transition: an appointment that is % cannot become %', replace(old.status, '_', ' '), replace(new.status, '_', ' ')
          using errcode = 'P0001';
      end if;
      if v_time_changed and not v_was_held then
        raise exception 'arc_crm:immutable: an appointment that is % keeps its time', replace(old.status, '_', ' ') using errcode = 'P0001';
      end if;
    end if;
    new.reschedule_count := old.reschedule_count + case when new.starts_at <> old.starts_at then 1 else 0 end;
  end if;

  if tg_op = 'INSERT' or new.assigned_user_id is distinct from old.assigned_user_id then
    perform public.crm_check_owner(new.tenant_id, new.assigned_user_id);
  end if;

  if tg_op = 'INSERT' or new.status <> old.status then
    new.confirmed_at := case
      when new.status = 'confirmed' then now()
      when new.status = 'requested' then null
      when tg_op = 'UPDATE' then old.confirmed_at
    end;
    new.closed_at := case when v_held then null else now() end;
  else
    new.confirmed_at := old.confirmed_at;
    new.closed_at := old.closed_at;
  end if;

  -- the time is free, or the booking is refused. one booking at a time per
  -- client, so two people choosing the same slot in the same instant are a
  -- booking and a refusal, never two appointments.
  if v_held and (tg_op = 'INSERT' or v_time_changed or not v_was_held) then
    perform public.crm_booking_lock(new.tenant_id);
    select coalesce((select s.capacity from public.crm_booking_settings s where s.tenant_id = new.tenant_id), 1) into v_capacity;
    select count(*) into v_overlaps
      from public.crm_appointments a
     where a.tenant_id = new.tenant_id
       and a.id <> new.id
       and a.status in ('requested', 'confirmed')
       and ((a.busy_from < new.ends_at and a.busy_until > new.starts_at)
         or (a.starts_at < new.busy_until and a.ends_at > new.busy_from));
    if v_overlaps >= v_capacity then
      if v_theirs then
        -- their calendar is the authority: ARC records what it says, and says it overlaps.
        new.sync_detail := new.sync_detail || jsonb_build_object('overlaps', v_overlaps);
      else
        raise exception 'arc_crm:slot_taken: that time has just been taken — choose another' using errcode = 'P0001';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_appointments_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_via    jsonb := jsonb_build_object('via', new.changed_via);
  v_events text[] := '{}';
  v_event  text;
begin
  if tg_op = 'UPDATE' and new.contact_id <> old.contact_id then
    return null;
  end if;

  if tg_op = 'INSERT' then
    insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
    values (new.tenant_id, new.id, new.status, new.updated_by_type, new.updated_by,
      v_via || jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at));
    v_events := array[new.status];
  else
    if new.starts_at <> old.starts_at or new.ends_at <> old.ends_at then
      insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
      values (new.tenant_id, new.id, 'rescheduled', new.updated_by_type, new.updated_by,
        v_via || jsonb_build_object('from', old.starts_at, 'to', new.starts_at, 'status', new.status));
      v_events := array_append(v_events, 'rescheduled');
    end if;
    if new.status <> old.status and not (new.status = 'requested' and new.starts_at <> old.starts_at) then
      insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
      values (new.tenant_id, new.id, new.status, new.updated_by_type, new.updated_by,
        v_via || case when new.cancel_reason is not null and new.status in ('cancelled', 'declined')
                      then jsonb_build_object('reason', new.cancel_reason) else '{}'::jsonb end);
      v_events := array_append(v_events, new.status);
    end if;
    if new.assigned_user_id is distinct from old.assigned_user_id then
      insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
      values (new.tenant_id, new.id, 'assigned', new.updated_by_type, new.updated_by,
        jsonb_build_object('from', old.assigned_user_id, 'to', new.assigned_user_id));
    end if;
    if new.sync_state <> old.sync_state then
      if new.sync_state = 'conflict' then
        insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
        values (new.tenant_id, new.id, 'sync_conflict', new.updated_by_type, new.updated_by,
          jsonb_build_object('reason', new.sync_detail ->> 'reason'));
      elsif old.sync_state = 'conflict' then
        insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
        values (new.tenant_id, new.id, 'reconciled', new.updated_by_type, new.updated_by,
          jsonb_build_object('kept', case when new.sync_state = 'synced' then 'theirs' else 'ours' end));
      elsif new.sync_state = 'synced' then
        insert into public.crm_appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_id, detail)
        values (new.tenant_id, new.id, 'sync_applied', new.updated_by_type, new.updated_by, '{}'::jsonb);
      end if;
    end if;
  end if;

  -- the lead's and the customer's own timeline says it happened; the times are here.
  foreach v_event in array v_events loop
    perform public.crm_log(new.tenant_id, new.contact_id, new.lead_id, 'appointment_' || v_event, new.updated_by_type, new.updated_by,
      case v_event
        when 'requested' then 'Appointment requested'
        when 'confirmed' then 'Appointment confirmed'
        when 'declined' then 'Appointment request declined'
        when 'rescheduled' then 'Appointment moved'
        when 'cancelled' then 'Appointment cancelled'
        when 'completed' then 'Appointment completed'
        else 'Customer did not show'
      end,
      jsonb_build_object('appointment_id', new.id, 'via', new.changed_via));
    if v_event in ('declined', 'rescheduled', 'cancelled') then
      perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.appointment.' || v_event, 'crm_appointment', new.id,
        jsonb_build_object('tenant_id', new.tenant_id));
    end if;
  end loop;
  return null;
end;
$fn$;

drop trigger if exists crm_appointments_guard on public.crm_appointments;
create trigger crm_appointments_guard
  before insert or update on public.crm_appointments
  for each row execute function public.crm_appointments_guard();
drop trigger if exists crm_appointments_history on public.crm_appointments;
create trigger crm_appointments_history
  after insert or update on public.crm_appointments
  for each row execute function public.crm_appointments_history();

-- when two contacts are found to be one person (0023's crm_merge_contacts), the
-- appointments go with the leads, inside the same transaction.
create or replace function public.crm_contacts_move_appointments()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.merged_into_id is not null and old.merged_into_id is null and public.crm_merging(new.tenant_id) then
    update public.crm_appointments set contact_id = new.merged_into_id
     where tenant_id = new.tenant_id and contact_id = new.id;
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_contacts_move_appointments on public.crm_contacts;
create trigger crm_contacts_move_appointments
  after update on public.crm_contacts
  for each row execute function public.crm_contacts_move_appointments();

-- 0023's mapping guard, which now also knows an appointment is a record.
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
    when 'contact'     then exists (select 1 from public.crm_contacts x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'lead'        then exists (select 1 from public.crm_leads x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'task'        then exists (select 1 from public.crm_tasks x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'note'        then exists (select 1 from public.crm_notes x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'location'    then exists (select 1 from public.business_locations x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'service'     then exists (select 1 from public.business_services x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    when 'appointment' then exists (select 1 from public.crm_appointments x where x.id = new.object_id and x.tenant_id = new.tenant_id)
    else false
  end;
  if not v_exists then
    raise exception 'arc_crm:not_found: that % does not exist for this client', new.object_type using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. one booking
-- ---------------------------------------------------------------------------
--
-- The whole of a booking, or none of it. `p_booking` is what the service
-- already validated and normalised:
--
--   { actor_type, actor_id, source, changed_via, idempotency_key,
--     booking_page_id, appointment_type_id, starts_at,
--     contact_id [, lead_id]   an existing customer, chosen by a person, or
--     contact: {...}, lead: { title, summary, ... }, consent: [...], detail,
--     dedupe_minutes           a stranger on the hosted page: 0024's own
--                              crm_intake_arrival finds or makes the customer
--                              and the lead, in this transaction
--     address_line1, city, region, postal_code, customer_note,
--     assigned_user_id, status, enforce_rules, manage_token_hash }
--
-- Returns { outcome: booked | replayed, appointment, contact_id, lead_id }.
--
-- A stranger's booking is `requested` when the type needs approval and
-- `confirmed` when it does not. Where their own calendar owns the time it is
-- always `requested` and `pending`: a preferred time, not a promise.

create or replace function public.crm_book_appointment(p_tenant uuid, p_booking jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_actor_type text := p_booking ->> 'actor_type';
  v_actor      uuid := nullif(p_booking ->> 'actor_id', '')::uuid;
  v_key        text := nullif(p_booking ->> 'idempotency_key', '');
  v_page_id    uuid := nullif(p_booking ->> 'booking_page_id', '')::uuid;
  v_type_id    uuid := nullif(p_booking ->> 'appointment_type_id', '')::uuid;
  v_starts     timestamptz := nullif(p_booking ->> 'starts_at', '')::timestamptz;
  v_contact_id uuid := nullif(p_booking ->> 'contact_id', '')::uuid;
  v_lead_id    uuid := nullif(p_booking ->> 'lead_id', '')::uuid;
  v_link       text := nullif(p_booking ->> 'manage_token_hash', '');
  v_person     boolean := (p_booking ->> 'actor_type') in ('operator', 'client_user');
  v_page       public.crm_booking_pages;
  v_type       public.crm_appointment_types;
  v_existing   public.crm_appointments;
  v_row        public.crm_appointments;
  v_rules      jsonb;
  v_theirs     boolean;
  v_status     text;
  v_sync       text := 'local';
  v_before     integer;
  v_after      integer;
  v_ends       timestamptz;
  v_problem    text;
  v_arrival    jsonb;
  v_event_id   uuid;
  v_count      integer;
begin
  perform public.crm_check_actor(p_tenant, v_actor_type, v_actor);
  if v_actor_type = 'external' then
    raise exception 'arc_crm:invalid: an external calendar reports an appointment, it does not book one here' using errcode = 'P0001';
  end if;
  if v_starts is null then
    raise exception 'arc_crm:invalid: a booking needs a time' using errcode = 'P0001';
  end if;

  perform public.crm_booking_lock(p_tenant);

  if v_key is not null then
    select * into v_existing from public.crm_appointments a where a.tenant_id = p_tenant and a.idempotency_key = v_key;
    if found then
      -- the retried request holds a link of its own; it must work too.
      if v_link is not null then
        insert into public.crm_appointment_links (tenant_id, appointment_id, token_hash)
        values (p_tenant, v_existing.id, v_link) on conflict (token_hash) do nothing;
      end if;
      return jsonb_build_object('outcome', 'replayed', 'appointment', to_jsonb(v_existing),
        'contact_id', v_existing.contact_id, 'lead_id', v_existing.lead_id);
    end if;
  end if;

  if v_page_id is not null then
    select * into v_page from public.crm_booking_pages g where g.id = v_page_id and g.tenant_id = p_tenant;
    if not found or v_page.status <> 'published' then
      raise exception 'arc_crm:not_found: that booking page is not taking bookings' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.crm_appointments a
     where a.tenant_id = p_tenant and a.booking_page_id = v_page_id and a.created_at > now() - interval '1 hour';
    if v_count >= v_page.hourly_cap then
      raise exception 'arc_crm:rate_limited: this page has taken as many bookings as it accepts in an hour' using errcode = 'P0001';
    end if;
  end if;

  select * into v_type from public.crm_appointment_types y where y.id = v_type_id and y.tenant_id = p_tenant;
  if not found or v_type.archived_at is not null or (v_page_id is not null and not v_type.is_public) then
    raise exception 'arc_crm:not_found: that kind of appointment is not offered' using errcode = 'P0001';
  end if;

  v_rules := public.crm_booking_rules(p_tenant);
  v_theirs := v_rules #>> '{authority,time_owner}' = 'external';
  if v_theirs and v_person then
    raise exception 'arc_crm:external_authority: this client''s appointments are booked in % — book it there',
      coalesce(v_rules #>> '{authority,connector_key}', 'their own calendar') using errcode = 'P0001';
  end if;

  if v_person then
    v_status := case when p_booking ->> 'status' = 'requested' then 'requested' else 'confirmed' end;
  elsif v_theirs then
    v_status := 'requested';
    v_sync := 'pending';
  else
    v_status := case when v_type.requires_approval then 'requested' else 'confirmed' end;
  end if;

  v_before := coalesce(v_type.buffer_before_minutes, (v_rules ->> 'buffer_before_minutes')::integer);
  v_after := coalesce(v_type.buffer_after_minutes, (v_rules ->> 'buffer_after_minutes')::integer);
  v_ends := v_starts + make_interval(mins => v_type.duration_minutes);

  if not v_person and v_starts <= now() then
    raise exception 'arc_crm:slot_unavailable: that time has passed' using errcode = 'P0001';
  end if;
  -- ARC's own hours and notice, when ARC keeps the calendar. a person in the
  -- workspace may book outside them on purpose (`enforce_rules: false`).
  if not v_theirs and (not v_person or coalesce((p_booking ->> 'enforce_rules')::boolean, true)) then
    v_problem := public.crm_booking_check_time(v_rules, v_starts, v_ends);
    if v_problem is not null then
      raise exception 'arc_crm:slot_unavailable: %', v_problem using errcode = 'P0001';
    end if;
  end if;

  if v_contact_id is null then
    if v_person then
      raise exception 'arc_crm:invalid: choose the customer this appointment is for' using errcode = 'P0001';
    end if;
    -- a stranger: the same arrival every other door uses. it adds a customer or
    -- finds the one they already are, and never edits one.
    v_arrival := public.crm_intake_arrival(p_tenant, jsonb_build_object(
      'source', 'web_form',
      'actor_type', v_actor_type,
      'actor_id', v_actor,
      'idempotency_key', case when v_key is not null then 'booking:' || v_key end,
      'detail', coalesce(p_booking -> 'detail', '{}'::jsonb),
      'contact', coalesce(p_booking -> 'contact', '{}'::jsonb),
      'lead', coalesce(p_booking -> 'lead', '{}'::jsonb),
      'consent', coalesce(p_booking -> 'consent', '[]'::jsonb),
      'dedupe_minutes', coalesce((p_booking ->> 'dedupe_minutes')::integer, 0),
      'on_ambiguous', 'new_contact'
    ));
    v_contact_id := (v_arrival ->> 'contact_id')::uuid;
    v_lead_id := (v_arrival ->> 'lead_id')::uuid;
    v_event_id := (v_arrival ->> 'source_event_id')::uuid;
  end if;

  insert into public.crm_appointments (
    tenant_id, contact_id, lead_id, appointment_type_id, title, service_id, location_id, status,
    starts_at, ends_at, busy_from, busy_until, timezone,
    address_line1, city, region, postal_code, customer_note,
    source, booking_page_id, booking_page_version, source_event_id, idempotency_key, requires_approval,
    assigned_user_id, sync_state, changed_via, updated_by_type, updated_by
  ) values (
    p_tenant, v_contact_id, v_lead_id, v_type.id, v_type.name, v_type.service_id, nullif(p_booking ->> 'location_id', '')::uuid, v_status,
    v_starts, v_ends, v_starts - make_interval(mins => v_before), v_ends + make_interval(mins => v_after), v_rules ->> 'timezone',
    nullif(p_booking ->> 'address_line1', ''), nullif(p_booking ->> 'city', ''), nullif(p_booking ->> 'region', ''),
    nullif(p_booking ->> 'postal_code', ''), nullif(p_booking ->> 'customer_note', ''),
    case when v_page_id is not null then 'booking_page' else 'staff' end,
    v_page_id, case when v_page_id is not null then v_page.version end, v_event_id, v_key,
    v_type.requires_approval and not v_person,
    nullif(p_booking ->> 'assigned_user_id', '')::uuid, v_sync,
    case when v_page_id is not null then 'booking_page' else 'workspace' end, v_actor_type, v_actor
  ) returning * into v_row;

  if v_link is not null then
    insert into public.crm_appointment_links (tenant_id, appointment_id, token_hash) values (p_tenant, v_row.id, v_link);
  end if;

  return jsonb_build_object('outcome', 'booked', 'appointment', to_jsonb(v_row),
    'contact_id', v_contact_id, 'lead_id', v_lead_id, 'arrival', v_arrival ->> 'outcome');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. a change to one appointment
-- ---------------------------------------------------------------------------
--
-- `p_change`: { action: confirm | decline | cancel | complete | no_show |
--               reschedule | assign,
--               starts_at, reason, assigned_user_id, changed_via, enforce_rules }
--
-- `changed_via: 'manage_link'` is the customer, from their own link: only a
-- cancel or a move, only while the appointment still holds its time, and only
-- as early as the client's settings say. A move of an appointment that needs
-- approval is a request again.

create or replace function public.crm_appointment_change(
  p_tenant uuid, p_appointment uuid, p_change jsonb, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_action   text := p_change ->> 'action';
  v_via      text := coalesce(nullif(p_change ->> 'changed_via', ''), 'workspace');
  v_customer boolean := coalesce(nullif(p_change ->> 'changed_via', ''), 'workspace') = 'manage_link';
  v_reason   text := nullif(btrim(coalesce(p_change ->> 'reason', '')), '');
  v_row      public.crm_appointments;
  v_rules    jsonb;
  v_where    text;
  v_starts   timestamptz;
  v_ends     timestamptz;
  v_problem  text;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type = 'external' then
    raise exception 'arc_crm:invalid: an external calendar reports a change, it does not make one here' using errcode = 'P0001';
  end if;
  if v_customer <> (p_actor_type = 'system') then
    raise exception 'arc_crm:forbidden: a customer''s link is the only thing that acts with nobody signed in' using errcode = 'P0001';
  end if;
  if v_action is null or v_action not in ('confirm', 'decline', 'cancel', 'complete', 'no_show', 'reschedule', 'assign') then
    raise exception 'arc_crm:invalid: that is not something an appointment can do' using errcode = 'P0001';
  end if;

  perform public.crm_booking_lock(p_tenant);
  select * into v_row from public.crm_appointments a where a.id = p_appointment and a.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_crm:not_found: no such appointment for this client' using errcode = 'P0001';
  end if;

  v_rules := public.crm_booking_rules(p_tenant);
  v_where := coalesce(v_rules #>> '{authority,connector_key}', 'their own calendar');
  if v_action = 'reschedule' and v_rules #>> '{authority,time_owner}' = 'external' then
    raise exception 'arc_crm:external_authority: this appointment''s time is kept in % — move it there', v_where using errcode = 'P0001';
  end if;
  if v_action in ('confirm', 'decline', 'cancel', 'complete', 'no_show') and v_rules #>> '{authority,status_owner}' = 'external' then
    raise exception 'arc_crm:external_authority: whether this appointment stands is kept in % — change it there', v_where using errcode = 'P0001';
  end if;
  if v_row.sync_state = 'conflict' and v_action <> 'assign' then
    raise exception 'arc_crm:needs_reconciliation: their calendar and ARC disagree about this appointment — choose which is right first' using errcode = 'P0001';
  end if;

  if v_customer then
    if v_action not in ('cancel', 'reschedule') then
      raise exception 'arc_crm:forbidden: this link can move or cancel the appointment, and nothing else' using errcode = 'P0001';
    end if;
    if v_row.status not in ('requested', 'confirmed') then
      raise exception 'arc_crm:conflict: this appointment is already %', replace(v_row.status, '_', ' ') using errcode = 'P0001';
    end if;
    if (v_action = 'cancel' and not (v_rules ->> 'customer_may_cancel')::boolean)
       or (v_action = 'reschedule' and not (v_rules ->> 'customer_may_reschedule')::boolean) then
      raise exception 'arc_crm:too_late: this cannot be changed online — please call us' using errcode = 'P0001';
    end if;
    if v_row.starts_at - now() < make_interval(mins => (v_rules ->> 'customer_change_cutoff_minutes')::integer) then
      raise exception 'arc_crm:too_late: it is too close to the appointment to change it online — please call us' using errcode = 'P0001';
    end if;
  end if;

  if v_action = 'confirm' then
    update public.crm_appointments set status = 'confirmed', changed_via = v_via, updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  elsif v_action in ('decline', 'cancel') then
    update public.crm_appointments set
      status = case v_action when 'decline' then 'declined' else 'cancelled' end,
      cancel_reason = v_reason, changed_via = v_via, updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  elsif v_action in ('complete', 'no_show') then
    if v_row.starts_at > now() then
      raise exception 'arc_crm:invalid: an appointment that has not started yet cannot be closed' using errcode = 'P0001';
    end if;
    update public.crm_appointments set
      status = case v_action when 'complete' then 'completed' else 'no_show' end,
      changed_via = v_via, updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  elsif v_action = 'reschedule' then
    v_starts := nullif(p_change ->> 'starts_at', '')::timestamptz;
    if v_starts is null then
      raise exception 'arc_crm:invalid: a new time is required' using errcode = 'P0001';
    end if;
    if v_starts = v_row.starts_at then
      raise exception 'arc_crm:invalid: that is the time it already has' using errcode = 'P0001';
    end if;
    v_ends := v_starts + (v_row.ends_at - v_row.starts_at);
    if v_customer or coalesce((p_change ->> 'enforce_rules')::boolean, true) then
      v_problem := public.crm_booking_check_time(v_rules, v_starts, v_ends);
      if v_problem is not null then
        raise exception 'arc_crm:slot_unavailable: %', v_problem using errcode = 'P0001';
      end if;
    end if;
    update public.crm_appointments set
      starts_at = v_starts,
      ends_at = v_ends,
      busy_from = v_starts - (v_row.starts_at - v_row.busy_from),
      busy_until = v_ends + (v_row.busy_until - v_row.ends_at),
      status = case when v_customer and v_row.requires_approval then 'requested' else v_row.status end,
      changed_via = v_via, updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  else
    update public.crm_appointments set
      assigned_user_id = nullif(p_change ->> 'assigned_user_id', '')::uuid,
      changed_via = v_via, updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. what their calendar says
-- ---------------------------------------------------------------------------
--
-- The contract an external calendar's connector reports through. `p_report`:
--
--   { connector_key, external_id, status, starts_at, ends_at, observed_at,
--     appointment_id   the ARC appointment this is their entry for (a pending
--                      request being answered), when it is not mapped yet
--     contact_id, lead_id, title   for an entry ARC has never seen }
--
-- Returns { outcome, appointment }:
--
--   created    their calendar is the authority and this entry is new to ARC
--   applied    ARC's copy now says what theirs says
--   unchanged  it already did
--   stale      an older observation than one already applied; nothing written
--   conflict   it disagrees with a field ARC owns (or with ARC's whole record,
--              where ARC keeps the calendar). NOT applied: the appointment is
--              frozen with the report kept beside it, for a person to settle.

create or replace function public.crm_appointment_external_report(p_tenant uuid, p_report jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_connector text := nullif(p_report ->> 'connector_key', '');
  v_external  text := nullif(btrim(coalesce(p_report ->> 'external_id', '')), '');
  v_status    text := p_report ->> 'status';
  v_starts    timestamptz := nullif(p_report ->> 'starts_at', '')::timestamptz;
  v_ends      timestamptz := nullif(p_report ->> 'ends_at', '')::timestamptz;
  v_observed  timestamptz := coalesce(nullif(p_report ->> 'observed_at', '')::timestamptz, now());
  v_adopt     uuid := nullif(p_report ->> 'appointment_id', '')::uuid;
  v_policy    public.crm_source_policies;
  v_row       public.crm_appointments;
  v_reported  jsonb;
  v_disagrees text;
begin
  if v_connector is null or v_external is null or v_starts is null or v_ends is null or v_ends <= v_starts
     or v_status is null or v_status not in ('requested', 'confirmed', 'declined', 'cancelled', 'completed', 'no_show') then
    raise exception 'arc_crm:invalid: a calendar report names its connector, its own id, a status and a time' using errcode = 'P0001';
  end if;

  perform public.crm_booking_lock(p_tenant);
  select * into v_policy from public.crm_source_policies p where p.tenant_id = p_tenant and p.object_type = 'appointment';
  if v_policy.connector_key is not null and v_policy.connector_key <> v_connector then
    raise exception 'arc_crm:arc_authority: % is the calendar these appointments come from, not %', v_policy.connector_key, v_connector
      using errcode = 'P0001';
  end if;

  select a.* into v_row
    from public.crm_external_mappings m
    join public.crm_appointments a on a.id = m.object_id and a.tenant_id = m.tenant_id
   where m.tenant_id = p_tenant and m.connector_key = v_connector and m.object_type = 'appointment'
     and m.external_id = v_external and m.removed_at is null
     for update of a;

  if v_row.id is null and v_adopt is not null then
    select * into v_row from public.crm_appointments a where a.id = v_adopt and a.tenant_id = p_tenant for update;
    if not found then
      raise exception 'arc_crm:not_found: no such appointment for this client' using errcode = 'P0001';
    end if;
    begin
      insert into public.crm_external_mappings (tenant_id, object_type, object_id, connector_key, external_id, created_by_type, created_by)
      values (p_tenant, 'appointment', v_row.id, v_connector, v_external, 'external', null);
    exception when unique_violation then
      raise exception 'arc_crm:mapping_conflict: that appointment is already another entry in their calendar' using errcode = 'P0001';
    end;
  end if;

  v_reported := jsonb_build_object('connector_key', v_connector, 'external_id', v_external, 'status', v_status,
    'starts_at', v_starts, 'ends_at', v_ends, 'observed_at', v_observed);

  if v_row.id is null then
    if public.crm_appointment_field_owner(p_tenant, 'starts_at') <> 'external' then
      raise exception 'arc_crm:arc_authority: ARC keeps this client''s calendar — an external one cannot add an appointment to it' using errcode = 'P0001';
    end if;
    if nullif(p_report ->> 'contact_id', '') is null then
      raise exception 'arc_crm:invalid: a reported appointment names a customer ARC already has' using errcode = 'P0001';
    end if;
    insert into public.crm_appointments (
      tenant_id, contact_id, lead_id, title, status, starts_at, ends_at, busy_from, busy_until, timezone,
      source, sync_state, last_synced_at, changed_via, updated_by_type, updated_by
    ) values (
      p_tenant, (p_report ->> 'contact_id')::uuid, nullif(p_report ->> 'lead_id', '')::uuid,
      coalesce(nullif(btrim(coalesce(p_report ->> 'title', '')), ''), 'Appointment'), v_status,
      v_starts, v_ends, v_starts, v_ends, (select t.timezone from public.tenants t where t.id = p_tenant),
      'external_system', 'synced', v_observed, 'sync', 'external', null
    ) returning * into v_row;
    insert into public.crm_external_mappings (tenant_id, object_type, object_id, connector_key, external_id, created_by_type, created_by)
    values (p_tenant, 'appointment', v_row.id, v_connector, v_external, 'external', null);
    return jsonb_build_object('outcome', 'created', 'appointment', to_jsonb(v_row));
  end if;

  if v_row.last_synced_at is not null and v_observed <= v_row.last_synced_at then
    return jsonb_build_object('outcome', 'stale', 'appointment', to_jsonb(v_row));
  end if;

  -- already waiting on a person: keep the newest thing their calendar said beside it.
  if v_row.sync_state = 'conflict' then
    update public.crm_appointments set
      sync_detail = sync_detail || jsonb_build_object('reported', v_reported),
      changed_via = 'sync', updated_by_type = 'external', updated_by = null
     where id = v_row.id returning * into v_row;
    return jsonb_build_object('outcome', 'conflict', 'appointment', to_jsonb(v_row));
  end if;

  v_disagrees := case
    when (v_starts, v_ends) is distinct from (v_row.starts_at, v_row.ends_at)
         and public.crm_appointment_field_owner(p_tenant, 'starts_at') = 'arc' then 'time'
    when v_status <> v_row.status and public.crm_appointment_field_owner(p_tenant, 'status') = 'arc' then 'status'
  end;

  if v_disagrees is not null then
    update public.crm_appointments set
      sync_state = 'conflict',
      sync_detail = jsonb_build_object('reason', v_disagrees, 'reported', v_reported),
      changed_via = 'sync', updated_by_type = 'external', updated_by = null
     where id = v_row.id returning * into v_row;
    return jsonb_build_object('outcome', 'conflict', 'appointment', to_jsonb(v_row));
  end if;

  if (v_starts, v_ends, v_status) is not distinct from (v_row.starts_at, v_row.ends_at, v_row.status) then
    update public.crm_appointments set
      sync_state = 'synced', sync_detail = '{}'::jsonb, last_synced_at = v_observed,
      changed_via = 'sync', updated_by_type = 'external', updated_by = null
     where id = v_row.id returning * into v_row;
    return jsonb_build_object('outcome', 'unchanged', 'appointment', to_jsonb(v_row));
  end if;

  update public.crm_appointments set
    starts_at = v_starts,
    ends_at = v_ends,
    busy_from = v_starts - (v_row.starts_at - v_row.busy_from),
    busy_until = v_ends + (v_row.busy_until - v_row.ends_at),
    status = v_status,
    sync_state = 'synced', sync_detail = '{}'::jsonb, last_synced_at = v_observed,
    changed_via = 'sync', updated_by_type = 'external', updated_by = null
   where id = v_row.id returning * into v_row;
  return jsonb_build_object('outcome', 'applied', 'appointment', to_jsonb(v_row));
end;
$fn$;

-- A person settles a disagreement. `keep_ours`: ARC's record stands, and it is
-- `pending` until their calendar is brought in line there. `accept_theirs`:
-- what their calendar reported is applied, as that person's decision — and is
-- still refused if the time it names is held by another appointment.
create or replace function public.crm_appointment_reconcile(
  p_tenant uuid, p_appointment uuid, p_resolution text, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_row      public.crm_appointments;
  v_reported jsonb;
  v_starts   timestamptz;
  v_ends     timestamptz;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: a person settles a disagreement' using errcode = 'P0001';
  end if;
  if p_resolution is null or p_resolution not in ('keep_ours', 'accept_theirs') then
    raise exception 'arc_crm:invalid: choose keep_ours or accept_theirs' using errcode = 'P0001';
  end if;

  perform public.crm_booking_lock(p_tenant);
  select * into v_row from public.crm_appointments a where a.id = p_appointment and a.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_crm:not_found: no such appointment for this client' using errcode = 'P0001';
  end if;
  if v_row.sync_state <> 'conflict' then
    raise exception 'arc_crm:conflict: this appointment is not waiting to be settled' using errcode = 'P0001';
  end if;
  v_reported := v_row.sync_detail -> 'reported';

  if p_resolution = 'keep_ours' then
    update public.crm_appointments set
      sync_state = 'pending',
      sync_detail = jsonb_build_object('kept', 'ours'),
      last_synced_at = coalesce((v_reported ->> 'observed_at')::timestamptz, last_synced_at),
      changed_via = 'workspace', updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  else
    v_starts := (v_reported ->> 'starts_at')::timestamptz;
    v_ends := (v_reported ->> 'ends_at')::timestamptz;
    update public.crm_appointments set
      starts_at = v_starts,
      ends_at = v_ends,
      busy_from = v_starts - (v_row.starts_at - v_row.busy_from),
      busy_until = v_ends + (v_row.busy_until - v_row.ends_at),
      status = v_reported ->> 'status',
      sync_state = 'synced', sync_detail = '{}'::jsonb,
      last_synced_at = (v_reported ->> 'observed_at')::timestamptz,
      changed_via = 'workspace', updated_by_type = p_actor_type, updated_by = p_actor
     where id = v_row.id returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. a client with appointments is not a test client
-- ---------------------------------------------------------------------------

-- 0026's purge, with one more thing that means the client did something real.
-- Booking settings, appointment types and a booking page are setup and still go
-- with the client; an appointment does not.
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
      ('crm_source_events',              'lead source records'),
      ('crm_conversations',              'customer conversations'),
      ('crm_messages',                   'customer messages'),
      ('crm_appointments',               'appointments')
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
-- 10. RLS and grants, as 0023
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['crm_booking_settings', 'crm_appointment_types', 'crm_booking_pages', 'crm_appointments', 'crm_appointment_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin())',
      t || '_read', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- the links table holds token hashes: RLS on and no policy at all, so no
-- browser role reads a row of it, operator or not.
alter table public.crm_appointment_links enable row level security;
revoke all on public.crm_appointment_links from anon, authenticated;

revoke all on function public.crm_appointment_field_owner(uuid, text) from public, anon, authenticated;
revoke all on function public.crm_booking_rules(uuid) from public, anon, authenticated;
revoke all on function public.crm_booking_check_time(jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.crm_booking_settings_guard() from public, anon, authenticated;
revoke all on function public.crm_appointment_types_guard() from public, anon, authenticated;
revoke all on function public.crm_booking_pages_guard() from public, anon, authenticated;
revoke all on function public.crm_booking_pages_history() from public, anon, authenticated;
revoke all on function public.crm_booking_lock(uuid) from public, anon, authenticated;
revoke all on function public.crm_appointments_guard() from public, anon, authenticated;
revoke all on function public.crm_appointments_history() from public, anon, authenticated;
revoke all on function public.crm_contacts_move_appointments() from public, anon, authenticated;
revoke all on function public.crm_external_mappings_guard() from public, anon, authenticated;
revoke all on function public.crm_book_appointment(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_appointment_change(uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_appointment_external_report(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_appointment_reconcile(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.purge_test_tenant(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.crm_appointment_field_owner(uuid, text) to service_role;
grant execute on function public.crm_booking_rules(uuid) to service_role;
grant execute on function public.crm_booking_check_time(jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.crm_booking_lock(uuid) to service_role;
grant execute on function public.crm_book_appointment(uuid, jsonb) to service_role;
grant execute on function public.crm_appointment_change(uuid, uuid, jsonb, text, uuid) to service_role;
grant execute on function public.crm_appointment_external_report(uuid, jsonb) to service_role;
grant execute on function public.crm_appointment_reconcile(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.purge_test_tenant(uuid, uuid, text) to service_role;
