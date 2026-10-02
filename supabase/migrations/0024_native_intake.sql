-- ===========================================================================
-- 0024 — ARC-native lead capture: forms, imports, API intake, attribution (ARC-350)
-- ===========================================================================
--
-- How a lead gets into 0023's CRM when the business has no lead platform of its
-- own: a form ARC hosts (or the same form framed on their site), a CSV, a
-- person typing one in, or their own system posting to an authenticated
-- endpoint. Every one of them ends in the same function, `crm_intake_arrival`,
-- which writes the source record, finds or creates the contact, and creates
-- the lead — or links the arrival to the lead that person already has — in one
-- transaction, behind one lock per client.
--
-- What this is not:
--   * not Lead Recovery. Nothing here sends anything, starts a run or writes
--     `leads` (0010). That engine's own `intakeLead` is still the only thing
--     that does, and still the only thing that writes `lead_received`.
--   * not evidence for a figure. `events` is untouched; no page counts these
--     tables. `crm_source_events` is the record of how a lead arrived.
--   * not safety truth. `crm_consent_records` is what a person was shown and
--     what they ticked, kept so it can be proved later. Whether an address may
--     be messaged is still `suppressions` and the engine's rules, read when
--     sending (0010, 0023).
--   * not a form engine. A form's definition is validated JSON with a closed
--     list of field types and no logic (`_shared/intake/model.ts`).
--
-- Rollback: drop crm_consent_records, crm_import_rows, crm_imports,
--   crm_intake_endpoints, crm_intake_forms and the functions below, and drop
--   the three columns this adds to crm_source_events.
--
-- Forward-only and additive. Refusals arrive as `arc_crm:<code>: <message>`.

-- ---------------------------------------------------------------------------
-- 1. forms
-- ---------------------------------------------------------------------------

-- The public key is the only thing a browser is ever given: opaque, random,
-- and not the tenant's id. It is printed in a link, so it is public by
-- construction; what a valid one can do is create a lead for the client that
-- published the form, and nothing else.
create table if not exists public.crm_intake_forms (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  public_key      text not null unique check (public_key ~ '^arcf_[a-z0-9]{32}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- goes up by one whenever the definition changes, so an arrival and a consent
  -- record can say which wording the person was shown.
  version         integer not null default 1 check (version >= 1),
  definition      jsonb not null check (
    jsonb_typeof(definition) = 'object'
    and char_length(definition::text) <= 20000
    and public.crm_text_is_clean(definition::text)
  ),
  -- a second arrival from somebody with an open lead this recent joins that
  -- lead instead of making another. 0 turns it off.
  dedupe_minutes  integer not null default 1440 check (dedupe_minutes between 0 and 43200),
  -- the most submissions this form accepts in an hour, counted in the database
  -- so it holds across every instance of the function.
  hourly_cap      integer not null default 120 check (hourly_cap between 1 and 5000),
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by_type text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by      uuid not null,
  unique (id, tenant_id)
);

create index if not exists crm_intake_forms_tenant_idx on public.crm_intake_forms (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. API intake endpoints
-- ---------------------------------------------------------------------------

-- A bearer token ARC issues for a client's own system to post leads with. The
-- 0001 ingest_tokens pattern: the SHA-256 of the token, never the token — it is
-- shown once when made, so a database read cannot be replayed as write access.
create table if not exists public.crm_intake_endpoints (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- the last four characters, so an operator can tell two endpoints apart.
  token_hint      text not null check (token_hint ~ '^[a-z0-9]{4}$'),
  created_at      timestamptz not null default now(),
  created_by_type text not null,
  created_by      uuid,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by_type text,
  revoked_by      uuid,
  unique (id, tenant_id),
  check ((revoked_at is null) = (revoked_by_type is null))
);

create index if not exists crm_intake_endpoints_tenant_idx on public.crm_intake_endpoints (tenant_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. imports
-- ---------------------------------------------------------------------------

-- A CSV, as a stored job: the preview writes every row and what would happen to
-- it, and the commit works through the rows that are ready, a batch at a time.
-- So a preview is exactly what will be imported, and an import that stops
-- half-way carries on from the row it reached.
create table if not exists public.crm_imports (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  file_name       text not null check (char_length(btrim(file_name)) between 1 and 200 and public.crm_text_is_clean(file_name)),
  status          text not null default 'previewed' check (status in ('previewed', 'importing', 'completed', 'cancelled')),
  -- { "<column heading>": "<what it is>" } as the operator confirmed it.
  mapping         jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object' and public.crm_text_is_clean(mapping::text)),
  dedupe_minutes  integer not null default 1440 check (dedupe_minutes between 0 and 43200),
  total_rows      integer not null default 0 check (total_rows >= 0),
  created_at      timestamptz not null default now(),
  created_by_type text not null,
  created_by      uuid,
  committed_at    timestamptz,
  completed_at    timestamptz,
  unique (id, tenant_id)
);

create index if not exists crm_imports_tenant_idx on public.crm_imports (tenant_id, created_at desc);

create table if not exists public.crm_import_rows (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  import_id    uuid not null,
  row_number   integer not null check (row_number >= 1),
  status       text not null check (status in ('ready', 'invalid', 'duplicate_in_file', 'imported', 'skipped', 'failed')),
  -- the normalised contact and lead this row becomes. empty for a row that is
  -- not valid: what was wrong is named in `problems`, by field, never by value.
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and public.crm_text_is_clean(payload::text)),
  problems     jsonb not null default '[]'::jsonb check (jsonb_typeof(problems) = 'array'),
  -- what the preview found for this row's phone and email.
  match        text check (match is null or match in ('new_contact', 'existing_contact', 'ambiguous_contact')),
  outcome      text check (outcome is null or outcome in ('created', 'duplicate', 'replayed', 'failed')),
  contact_id   uuid,
  lead_id      uuid,
  processed_at timestamptz,
  unique (import_id, row_number),
  foreign key (import_id, tenant_id) references public.crm_imports (id, tenant_id) on delete cascade,
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id)
);

create index if not exists crm_import_rows_status_idx on public.crm_import_rows (import_id, status, row_number);

-- ---------------------------------------------------------------------------
-- 4. which door an arrival came through
-- ---------------------------------------------------------------------------

-- What ARC knows for itself about an arrival, as opposed to what a browser
-- claimed (the campaign and referrer in `detail`). At most one is set.
alter table public.crm_source_events add column if not exists form_id uuid;
alter table public.crm_source_events add column if not exists endpoint_id uuid;
alter table public.crm_source_events add column if not exists import_id uuid;

do $$
begin
  alter table public.crm_source_events
    add constraint crm_source_events_form_fk foreign key (form_id, tenant_id) references public.crm_intake_forms (id, tenant_id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.crm_source_events
    add constraint crm_source_events_endpoint_fk foreign key (endpoint_id, tenant_id) references public.crm_intake_endpoints (id, tenant_id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.crm_source_events
    add constraint crm_source_events_import_fk foreign key (import_id, tenant_id) references public.crm_imports (id, tenant_id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.crm_source_events
    add constraint crm_source_events_one_door check (num_nonnulls(form_id, endpoint_id, import_id) <= 1);
exception when duplicate_object then null;
end $$;

create index if not exists crm_source_events_form_idx
  on public.crm_source_events (tenant_id, form_id, received_at desc) where form_id is not null;

-- ---------------------------------------------------------------------------
-- 5. consent, as it was given
-- ---------------------------------------------------------------------------

-- One row per channel a person was asked about on one arrival: the address,
-- whether they agreed, and the exact words they were shown. Written with the
-- arrival and never changed. It is kept by address, like `suppressions`, so a
-- merge of two contacts moves nothing here.
create table if not exists public.crm_consent_records (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  source_event_id uuid not null,
  contact_id      uuid,
  channel         text not null check (channel in ('phone', 'sms', 'email')),
  address         text not null check (char_length(address) between 3 and 200),
  granted         boolean not null,
  disclosure      text not null check (char_length(btrim(disclosure)) between 1 and 1000 and public.crm_text_is_clean(disclosure)),
  form_id         uuid,
  form_version    integer,
  captured_at     timestamptz not null default now(),
  foreign key (source_event_id, tenant_id) references public.crm_source_events (id, tenant_id),
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (form_id, tenant_id) references public.crm_intake_forms (id, tenant_id)
);

create index if not exists crm_consent_records_address_idx on public.crm_consent_records (tenant_id, channel, address, captured_at desc);

drop trigger if exists crm_consent_records_immutable on public.crm_consent_records;
create trigger crm_consent_records_immutable
  before update on public.crm_consent_records
  for each row execute function public.crm_history_is_immutable();
drop trigger if exists crm_consent_records_immutable_delete on public.crm_consent_records;
create trigger crm_consent_records_immutable_delete
  before delete on public.crm_consent_records
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 6. guards
-- ---------------------------------------------------------------------------

create or replace function public.crm_intake_forms_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id or new.public_key <> old.public_key then
      raise exception 'arc_crm:immutable: a form keeps its client and its link' using errcode = 'P0001';
    end if;
    if old.status = 'archived' and new.status = 'published' then
      raise exception 'arc_crm:invalid: an archived form is restored as a draft first' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    new.version := case when new.definition is distinct from old.definition then old.version + 1 else old.version end;
    new.published_at := case when new.status = 'published' and old.status <> 'published' then now() else old.published_at end;
  else
    new.version := 1;
    new.published_at := case when new.status = 'published' then now() end;
  end if;
  if new.status = 'published' and coalesce(jsonb_array_length(new.definition -> 'fields'), 0) = 0 then
    raise exception 'arc_crm:invalid: a form with no fields cannot be published' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

create or replace function public.crm_intake_forms_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' or new.status <> old.status then
    perform public.crm_audit(new.updated_by_type, new.updated_by, 'crm.intake_form.' || new.status, 'crm_intake_form', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'version', new.version));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_intake_forms_guard on public.crm_intake_forms;
create trigger crm_intake_forms_guard
  before insert or update on public.crm_intake_forms
  for each row execute function public.crm_intake_forms_guard();
drop trigger if exists crm_intake_forms_history on public.crm_intake_forms;
create trigger crm_intake_forms_history
  after insert or update on public.crm_intake_forms
  for each row execute function public.crm_intake_forms_history();

-- an endpoint is made, used, and revoked. it is never repointed or revived.
create or replace function public.crm_intake_endpoints_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.crm_check_actor(new.tenant_id, new.created_by_type, new.created_by);
    if new.revoked_at is not null then
      raise exception 'arc_crm:invalid: an endpoint is not created revoked' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['last_used_at', 'revoked_at', 'revoked_by_type', 'revoked_by'])
     <> (to_jsonb(old) - array['last_used_at', 'revoked_at', 'revoked_by_type', 'revoked_by']) then
    raise exception 'arc_crm:immutable: an endpoint is revoked, never changed — revoke it and make another' using errcode = 'P0001';
  end if;
  if old.revoked_at is not null then
    raise exception 'arc_crm:immutable: this endpoint is revoked' using errcode = 'P0001';
  end if;
  if new.revoked_at is not null then
    perform public.crm_check_actor(new.tenant_id, new.revoked_by_type, new.revoked_by);
    new.revoked_at := now();
  end if;
  return new;
end;
$fn$;

create or replace function public.crm_intake_endpoints_history()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.crm_audit(new.created_by_type, new.created_by, 'crm.intake_endpoint.created', 'crm_intake_endpoint', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'name', new.name));
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform public.crm_audit(new.revoked_by_type, new.revoked_by, 'crm.intake_endpoint.revoked', 'crm_intake_endpoint', new.id,
      jsonb_build_object('tenant_id', new.tenant_id, 'name', new.name));
  end if;
  return null;
end;
$fn$;

drop trigger if exists crm_intake_endpoints_guard on public.crm_intake_endpoints;
create trigger crm_intake_endpoints_guard
  before insert or update on public.crm_intake_endpoints
  for each row execute function public.crm_intake_endpoints_guard();
drop trigger if exists crm_intake_endpoints_history on public.crm_intake_endpoints;
create trigger crm_intake_endpoints_history
  after insert or update on public.crm_intake_endpoints
  for each row execute function public.crm_intake_endpoints_history();

create or replace function public.crm_imports_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.crm_check_actor(new.tenant_id, new.created_by_type, new.created_by);
    return new;
  end if;
  if new.tenant_id <> old.tenant_id or new.id <> old.id or new.created_by is distinct from old.created_by then
    raise exception 'arc_crm:immutable: an import keeps its client and who started it' using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'arc_crm:immutable: this import is % and is not changed', old.status using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists crm_imports_guard on public.crm_imports;
create trigger crm_imports_guard
  before insert or update on public.crm_imports
  for each row execute function public.crm_imports_guard();

-- ---------------------------------------------------------------------------
-- 7. one arrival
-- ---------------------------------------------------------------------------
--
-- The whole of an intake, or none of it. `p_arrival` is what the service
-- already validated and normalised:
--
--   { source, actor_type, actor_id, idempotency_key, external_ref, detail,
--     form_id | endpoint_id | import_id,
--     contact_id            an existing contact a person chose, or
--     contact: { display_name, first_name, last_name, phone, email, ... },
--     lead: { title, summary, service_id, service_category_id, priority },
--     dedupe_minutes, on_ambiguous: 'refuse' | 'new_contact',
--     consent: [{ channel, address, granted, disclosure }] }
--
-- Returns { outcome, source_event_id, contact_id, lead_id, contact_matched,
-- ambiguous }, where outcome is
--
--   created    a new lead (on a new or an existing contact)
--   duplicate  this person already has an open lead inside the window; the
--              arrival is recorded and linked to it, and no second lead is made
--   replayed   this idempotency key was seen before; nothing was written
--
-- An existing contact is never edited here: an arrival may add a customer,
-- never overwrite one.

create or replace function public.crm_intake_arrival(p_tenant uuid, p_arrival jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_actor_type  text := p_arrival ->> 'actor_type';
  v_actor       uuid := nullif(p_arrival ->> 'actor_id', '')::uuid;
  v_key         text := nullif(p_arrival ->> 'idempotency_key', '');
  v_contact_in  jsonb := coalesce(p_arrival -> 'contact', '{}'::jsonb);
  v_lead_in     jsonb := coalesce(p_arrival -> 'lead', '{}'::jsonb);
  v_phone       text := nullif(v_contact_in ->> 'phone', '');
  v_email       text := nullif(v_contact_in ->> 'email', '');
  v_form_id     uuid := nullif(p_arrival ->> 'form_id', '')::uuid;
  v_endpoint_id uuid := nullif(p_arrival ->> 'endpoint_id', '')::uuid;
  v_import_id   uuid := nullif(p_arrival ->> 'import_id', '')::uuid;
  v_dedupe      integer := coalesce((p_arrival ->> 'dedupe_minutes')::integer, 0);
  v_contact_id  uuid := nullif(p_arrival ->> 'contact_id', '')::uuid;
  v_form        public.crm_intake_forms;
  v_existing    public.crm_source_events;
  v_matches     uuid[] := '{}';
  v_both        uuid[] := '{}';
  v_matched     boolean := false;
  v_ambiguous   boolean := false;
  v_duplicate   boolean := false;
  v_display     text;
  v_lead_id     uuid;
  v_open_lead   uuid;
  v_open_contact uuid;
  v_event_id    uuid;
  v_pipeline    uuid;
  v_stage       uuid;
  v_count       integer;
  v_consent     jsonb;
begin
  perform public.crm_check_actor(p_tenant, v_actor_type, v_actor);

  -- one arrival at a time per client: two posts from one person in the same
  -- instant are then a lead and its duplicate, not two leads and two contacts.
  perform pg_advisory_xact_lock(hashtextextended('arc_crm_intake:' || p_tenant::text, 0));

  if v_key is not null then
    select * into v_existing from public.crm_source_events e
     where e.tenant_id = p_tenant and e.idempotency_key = v_key;
    if found then
      return jsonb_build_object('outcome', 'replayed', 'source_event_id', v_existing.id,
        'contact_id', v_existing.contact_id, 'lead_id', v_existing.lead_id, 'contact_matched', true, 'ambiguous', false);
    end if;
  end if;

  if v_form_id is not null then
    select * into v_form from public.crm_intake_forms f where f.id = v_form_id and f.tenant_id = p_tenant;
    if not found or v_form.status <> 'published' then
      raise exception 'arc_crm:not_found: that form is not accepting submissions' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.crm_source_events e
     where e.tenant_id = p_tenant and e.form_id = v_form_id and e.received_at > now() - interval '1 hour';
    if v_count >= v_form.hourly_cap then
      raise exception 'arc_crm:rate_limited: this form has taken as many submissions as it accepts in an hour' using errcode = 'P0001';
    end if;
  end if;
  if v_endpoint_id is not null and not exists (
    select 1 from public.crm_intake_endpoints x where x.id = v_endpoint_id and x.tenant_id = p_tenant and x.revoked_at is null
  ) then
    raise exception 'arc_crm:not_found: that endpoint is revoked or does not exist for this client' using errcode = 'P0001';
  end if;

  -- whose arrival is it.
  if v_contact_id is not null then
    if not exists (
      select 1 from public.crm_contacts c
       where c.id = v_contact_id and c.tenant_id = p_tenant and c.archived_at is null and c.merged_into_id is null
    ) then
      raise exception 'arc_crm:contact_unavailable: that contact is archived, merged, or not this client''s' using errcode = 'P0001';
    end if;
    v_matches := array[v_contact_id];
    v_matched := true;
  elsif v_phone is not null or v_email is not null then
    select coalesce(array_agg(c.id order by c.created_at, c.id), '{}') into v_matches
      from public.crm_contacts c
     where c.tenant_id = p_tenant and c.merged_into_id is null and c.archived_at is null
       and ((v_phone is not null and c.phone = v_phone) or (v_email is not null and c.email = v_email));
    if cardinality(v_matches) = 1 then
      v_contact_id := v_matches[1];
      v_matched := true;
    elsif cardinality(v_matches) > 1 then
      -- several people share this phone or this email. the one who has both is
      -- not a guess; anything less is.
      select coalesce(array_agg(c.id), '{}') into v_both
        from public.crm_contacts c
       where c.id = any (v_matches) and c.phone = v_phone and c.email = v_email;
      if cardinality(v_both) = 1 then
        v_contact_id := v_both[1];
        v_matched := true;
      elsif coalesce(p_arrival ->> 'on_ambiguous', 'refuse') = 'refuse' then
        raise exception 'arc_crm:ambiguous_contact: % contacts share this phone or email — choose one, or merge them',
          cardinality(v_matches) using errcode = 'P0001';
      else
        v_ambiguous := true;
      end if;
    end if;
  end if;

  -- does that person already have an open lead this recent.
  if v_dedupe > 0 and cardinality(v_matches) > 0 then
    select l.id, l.contact_id into v_open_lead, v_open_contact
      from public.crm_leads l
     where l.tenant_id = p_tenant and l.contact_id = any (v_matches)
       and l.status = 'open' and l.archived_at is null
       and l.created_at > now() - make_interval(mins => v_dedupe)
     order by l.created_at desc
     limit 1;
    if found then
      v_lead_id := v_open_lead;
      v_contact_id := v_open_contact;
      v_duplicate := true;
      v_matched := true;
      v_ambiguous := false;
    end if;
  end if;

  if v_contact_id is null then
    v_display := coalesce(
      nullif(btrim(v_contact_in ->> 'display_name'), ''),
      nullif(btrim(concat_ws(' ', v_contact_in ->> 'first_name', v_contact_in ->> 'last_name')), ''),
      v_phone, v_email);
    if v_display is null then
      raise exception 'arc_crm:invalid: a contact needs a name, a phone number or an email address' using errcode = 'P0001';
    end if;
    insert into public.crm_contacts (
      tenant_id, display_name, first_name, last_name, phone, email, preferred_channel,
      address_line1, address_line2, city, region, postal_code, country, updated_by_type, updated_by
    ) values (
      p_tenant, v_display, nullif(v_contact_in ->> 'first_name', ''), nullif(v_contact_in ->> 'last_name', ''),
      v_phone, v_email, nullif(v_contact_in ->> 'preferred_channel', ''),
      nullif(v_contact_in ->> 'address_line1', ''), nullif(v_contact_in ->> 'address_line2', ''),
      nullif(v_contact_in ->> 'city', ''), nullif(v_contact_in ->> 'region', ''),
      nullif(v_contact_in ->> 'postal_code', ''), nullif(v_contact_in ->> 'country', ''),
      v_actor_type, v_actor
    ) returning id into v_contact_id;
  end if;

  insert into public.crm_source_events (
    tenant_id, source, detail, external_ref, idempotency_key, contact_id, lead_id, form_id, endpoint_id, import_id
  ) values (
    p_tenant, p_arrival ->> 'source', coalesce(p_arrival -> 'detail', '{}'::jsonb), nullif(p_arrival ->> 'external_ref', ''),
    v_key, v_contact_id, case when v_duplicate then v_lead_id end, v_form_id, v_endpoint_id, v_import_id
  ) returning id into v_event_id;

  if not v_duplicate then
    v_pipeline := public.crm_ensure_default_pipeline(p_tenant);
    select s.id into v_stage from public.crm_pipeline_stages s
     where s.pipeline_id = v_pipeline and s.tenant_id = p_tenant and s.kind = 'open' and s.archived_at is null
     order by s.position, s.key
     limit 1;
    if not found then
      raise exception 'arc_crm:invalid_stage: this client''s default pipeline has no open stage' using errcode = 'P0001';
    end if;
    insert into public.crm_leads (
      tenant_id, contact_id, title, summary, source, source_event_id, service_id, service_category_id,
      pipeline_id, stage_id, priority, updated_by_type, updated_by
    ) values (
      p_tenant, v_contact_id, v_lead_in ->> 'title', nullif(v_lead_in ->> 'summary', ''), p_arrival ->> 'source', v_event_id,
      nullif(v_lead_in ->> 'service_id', '')::uuid, nullif(v_lead_in ->> 'service_category_id', '')::uuid,
      v_pipeline, v_stage, coalesce(nullif(v_lead_in ->> 'priority', ''), 'normal'), v_actor_type, v_actor
    ) returning id into v_lead_id;
    update public.crm_source_events set lead_id = v_lead_id where id = v_event_id;

    if v_ambiguous then
      -- nobody was there to choose, so the lead is kept and a person is asked.
      insert into public.crm_tasks (tenant_id, contact_id, lead_id, kind, title, detail, updated_by_type, updated_by)
      values (p_tenant, v_contact_id, v_lead_id, 'other', 'Check for a duplicate contact',
        format('%s other contacts share this phone or email. Merge them if they are one person.', cardinality(v_matches)),
        v_actor_type, v_actor);
    end if;
  end if;

  for v_consent in select * from jsonb_array_elements(coalesce(p_arrival -> 'consent', '[]'::jsonb)) loop
    insert into public.crm_consent_records (
      tenant_id, source_event_id, contact_id, channel, address, granted, disclosure, form_id, form_version
    ) values (
      p_tenant, v_event_id, v_contact_id, v_consent ->> 'channel', v_consent ->> 'address',
      coalesce((v_consent ->> 'granted')::boolean, false), v_consent ->> 'disclosure',
      v_form_id, case when v_form_id is not null then v_form.version end
    );
  end loop;

  return jsonb_build_object(
    'outcome', case when v_duplicate then 'duplicate' else 'created' end,
    'source_event_id', v_event_id, 'contact_id', v_contact_id, 'lead_id', v_lead_id,
    'contact_matched', v_matched, 'ambiguous', v_ambiguous
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. an import: what the preview found, and the commit
-- ---------------------------------------------------------------------------

-- for each row that is ready: is its phone or email already a customer.
create or replace function public.crm_import_annotate(p_tenant uuid, p_import uuid)
returns void
language sql
set search_path = public
as $fn$
  update public.crm_import_rows r
     set match = case m.n when 0 then 'new_contact' when 1 then 'existing_contact' else 'ambiguous_contact' end
    from (
      select r2.id, (
        select count(*) from public.crm_contacts c
         where c.tenant_id = p_tenant and c.merged_into_id is null and c.archived_at is null
           and ((r2.payload #>> '{contact,phone}' is not null and c.phone = r2.payload #>> '{contact,phone}')
             or (r2.payload #>> '{contact,email}' is not null and c.email = r2.payload #>> '{contact,email}'))
      ) as n
        from public.crm_import_rows r2
       where r2.import_id = p_import and r2.tenant_id = p_tenant and r2.status = 'ready'
    ) m
   where r.id = m.id;
$fn$;

-- how an import stands: rows by status, and what the preview found for the ready ones.
-- a function rather than a read of the rows, which an API page would cut off at 1000.
create or replace function public.crm_import_summary(p_tenant uuid, p_import uuid)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
    'by_status', coalesce((
      select jsonb_object_agg(s.status, s.n) from (
        select r.status, count(*) as n from public.crm_import_rows r
         where r.import_id = p_import and r.tenant_id = p_tenant group by r.status
      ) s), '{}'::jsonb),
    'by_match', coalesce((
      select jsonb_object_agg(m.match, m.n) from (
        select r.match, count(*) as n from public.crm_import_rows r
         where r.import_id = p_import and r.tenant_id = p_tenant and r.status = 'ready' and r.match is not null group by r.match
      ) m), '{}'::jsonb)
  );
$fn$;

-- the next batch of ready rows, each through crm_intake_arrival. a row that is
-- refused is marked failed with the reason and the rest carry on. calling it
-- again continues; calling it when nothing is ready completes the import.
create or replace function public.crm_import_commit(
  p_tenant uuid, p_import uuid, p_actor_type text, p_actor uuid, p_limit integer default 200
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_import    public.crm_imports;
  v_row       public.crm_import_rows;
  v_result    jsonb;
  v_done      integer := 0;
  v_remaining integer;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  select * into v_import from public.crm_imports i where i.id = p_import and i.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_crm:not_found: no such import for this client' using errcode = 'P0001';
  end if;
  if v_import.status in ('completed', 'cancelled') then
    raise exception 'arc_crm:conflict: this import is already %', v_import.status using errcode = 'P0001';
  end if;
  update public.crm_imports set status = 'importing', committed_at = coalesce(committed_at, now()) where id = p_import;

  for v_row in
    select * from public.crm_import_rows r
     where r.import_id = p_import and r.tenant_id = p_tenant and r.status = 'ready'
     order by r.row_number
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  loop
    begin
      v_result := public.crm_intake_arrival(p_tenant, v_row.payload || jsonb_build_object(
        'source', 'import',
        'idempotency_key', 'import:' || p_import::text || ':' || v_row.row_number::text,
        'import_id', p_import,
        'actor_type', p_actor_type,
        'actor_id', p_actor,
        'dedupe_minutes', v_import.dedupe_minutes,
        'on_ambiguous', 'refuse',
        'detail', jsonb_build_object('import', jsonb_build_object('file_name', v_import.file_name, 'row', v_row.row_number))
      ));
      update public.crm_import_rows set
        status = case when v_result ->> 'outcome' = 'created' then 'imported' else 'skipped' end,
        outcome = v_result ->> 'outcome',
        contact_id = (v_result ->> 'contact_id')::uuid,
        lead_id = (v_result ->> 'lead_id')::uuid,
        processed_at = now()
       where id = v_row.id;
    exception when others then
      -- ARC's own refusals are sentences written for a person. anything else is
      -- the database's, and may quote the row; it is not repeated.
      update public.crm_import_rows set
        status = 'failed', outcome = 'failed', processed_at = now(),
        problems = jsonb_build_array(jsonb_build_object('field', 'row', 'message',
          case when sqlerrm ~ '^arc_crm:[a-z_]+: ' then regexp_replace(sqlerrm, '^arc_crm:[a-z_]+: ', '')
               else 'the database refused this row' end))
       where id = v_row.id;
    end;
    v_done := v_done + 1;
  end loop;

  select count(*) into v_remaining from public.crm_import_rows r
   where r.import_id = p_import and r.tenant_id = p_tenant and r.status = 'ready';
  if v_remaining = 0 then
    update public.crm_imports set status = 'completed', completed_at = now() where id = p_import;
    perform public.crm_audit(p_actor_type, p_actor, 'crm.import.completed', 'crm_import', p_import,
      jsonb_build_object('tenant_id', p_tenant, 'file_name', v_import.file_name, 'rows', v_import.total_rows));
  end if;

  return jsonb_build_object('processed', v_done, 'remaining', v_remaining,
    'status', case when v_remaining = 0 then 'completed' else 'importing' end);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. RLS and grants
-- ---------------------------------------------------------------------------

-- 0023's pattern: a client reads their own rows, an operator reads everything,
-- and nobody holding a browser key writes anything. The endpoints table is the
-- exception on the read side — it holds token hashes, so only an operator reads it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'crm_intake_forms', 'crm_imports', 'crm_import_rows', 'crm_consent_records'
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

alter table public.crm_intake_endpoints enable row level security;
drop policy if exists crm_intake_endpoints_read on public.crm_intake_endpoints;
create policy crm_intake_endpoints_read on public.crm_intake_endpoints
  for select to authenticated using (public.is_arc_admin());
revoke insert, update, delete, truncate on public.crm_intake_endpoints from anon, authenticated;
revoke all on public.crm_intake_endpoints from anon;

revoke all on function public.crm_intake_forms_guard() from public, anon, authenticated;
revoke all on function public.crm_intake_forms_history() from public, anon, authenticated;
revoke all on function public.crm_intake_endpoints_guard() from public, anon, authenticated;
revoke all on function public.crm_intake_endpoints_history() from public, anon, authenticated;
revoke all on function public.crm_imports_guard() from public, anon, authenticated;
revoke all on function public.crm_intake_arrival(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_import_annotate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_import_summary(uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_import_commit(uuid, uuid, text, uuid, integer) from public, anon, authenticated;

grant execute on function public.crm_intake_arrival(uuid, jsonb) to service_role;
grant execute on function public.crm_import_annotate(uuid, uuid) to service_role;
grant execute on function public.crm_import_summary(uuid, uuid) to service_role;
grant execute on function public.crm_import_commit(uuid, uuid, text, uuid, integer) to service_role;
