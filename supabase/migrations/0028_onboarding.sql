-- ===========================================================================
-- 0028 — route-aware onboarding (ARC-390)
-- ===========================================================================
--
-- ARC-330 named the three routes a company can take into ARC. ARC-340 to
-- ARC-380 built what a route is made of: the customer and lead records, the
-- doors a lead comes in by, the workspace, the conversation, the calendar.
-- This is the part that puts a real company on a route: what it has today, who
-- provides each capability from now on, and what is still missing.
--
--   tenant_onboarding         one row per client: what the business said it has
--                             (`answers`), and the operator's decision (`plan`)
--                             — a route, and for each capability ARC, their own
--                             system, or not part of this setup. A revision
--                             that moves on every change.
--   tenant_onboarding_events  append-only: answers saved, plan saved, route
--                             changed, authority changed, an ARC piece set up.
--                             Who and when, on every one.
--
-- ---------------------------------------------------------------------------
-- What is stored, and what is not
-- ---------------------------------------------------------------------------
--
-- Progress is not stored. A step of onboarding is done because the thing exists
-- — the hours are set, the form is published, the authority matches the plan —
-- and `onboarding_facts` counts those things from the tables that hold them,
-- every time. So closing the page loses nothing, reopening it cannot show a
-- stale tick, and there is no second place for "is the form published" to be
-- wrong in.
--
-- ---------------------------------------------------------------------------
-- A plan is a decision on paper
-- ---------------------------------------------------------------------------
--
-- Saving a plan writes the plan. It selects no module (0015), activates
-- nothing, publishes no form, connects no provider, records no route and moves
-- no record's authority. The two things a plan can lead to are separate acts:
--
--   * the route (0023 `business_profiles.route`) and who owns each kind of
--     record (0023 `crm_source_policies`) change only in
--     `onboarding_apply_authority`, which works out what would change, counts
--     the records it touches, and refuses unless the caller sends back the
--     digest of exactly that — so the change that is applied is the change
--     that was read. An operator's act, in the audit log twice: here, and by
--     0023's own policy and route triggers.
--   * going live is 0015's gate, on the activation page. Nothing here reaches it.
--
-- A change of route or authority deletes nothing: no customer, lead, message,
-- appointment or mapping. Handing a kind of record to their system leaves ARC's
-- copy where it is (0023 then refuses an ARC-side edit of the fields they own);
-- taking it back leaves every mapping as history.
--
-- What this is not:
--   * not evidence. Nothing here writes `events`, and no figure reads these tables.
--   * not a credential store. Both jsonb columns refuse secret-shaped values;
--     a tool is named here, never signed into.
--   * not per-client logic. A plan is validated data with a closed vocabulary.
--
-- Who writes: no browser role. Refusals arrive as `arc_onboarding:<code>: <message>`.
--
-- Rollback: drop the two tables and the onboarding_* functions. Nothing
--   existing is altered.
--
-- Forward-only and additive.

-- ---------------------------------------------------------------------------
-- 0. the vocabulary
-- ---------------------------------------------------------------------------

-- what a business does, never the product it does it with. the model's
-- CAPABILITY_KEYS (`_shared/onboarding/model.ts`), in its order.
create or replace function public.onboarding_capabilities()
returns text[]
language sql
immutable
as $fn$
  select array[
    'customer_records', 'lead_intake', 'lead_pipeline', 'website_form', 'messaging',
    'email', 'calendar', 'booking', 'field_service', 'accounting'
  ]::text[];
$fn$;

-- the kind of record (0023, 0027) whose source of truth a capability decides.
create or replace function public.onboarding_capability_object(p_capability text)
returns text
language sql
immutable
as $fn$
  select case p_capability
    when 'customer_records' then 'contact'
    when 'lead_pipeline' then 'lead'
    when 'calendar' then 'appointment'
  end;
$fn$;

create or replace function public.onboarding_check_operator(p_actor uuid)
returns void
language plpgsql
set search_path = public
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_onboarding:forbidden: onboarding a client is an operator action' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_onboarding:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;
end;
$fn$;

-- why a plan may not be kept, or null. the model checks more (which kind of
-- provider can hold which capability); this is the part that protects data:
-- the closed vocabulary, a connector the registry knows, and ARC Native
-- keeping every record in ARC.
create or replace function public.onboarding_plan_problem(p_plan jsonb)
returns text
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_route     text;
  v_key       text;
  v_choice    jsonb;
  v_source    text;
  v_connector text;
  v_tool      text;
begin
  if jsonb_typeof(p_plan) <> 'object' then
    return 'a plan is an object';
  end if;
  if p_plan - array['route', 'capabilities'] <> '{}'::jsonb then
    return 'a plan holds a route and capabilities, and nothing else';
  end if;
  v_route := p_plan ->> 'route';
  if v_route is null or v_route not in ('native', 'hybrid', 'connected') then
    return 'a route is native, hybrid or connected';
  end if;
  if coalesce(jsonb_typeof(p_plan -> 'capabilities'), 'object') <> 'object' then
    return 'capabilities is an object keyed by capability';
  end if;
  for v_key, v_choice in select e.key, e.value from jsonb_each(coalesce(p_plan -> 'capabilities', '{}'::jsonb)) e loop
    if v_key <> all (public.onboarding_capabilities()) then
      return format('"%s" is not a capability', v_key);
    end if;
    if jsonb_typeof(v_choice) <> 'object' or v_choice - array['source', 'connector_key', 'tool'] <> '{}'::jsonb then
      return format('%s is a source, and for another system its connector or its name', v_key);
    end if;
    v_source := v_choice ->> 'source';
    v_connector := v_choice ->> 'connector_key';
    v_tool := v_choice ->> 'tool';
    if v_source is null or v_source not in ('arc', 'external', 'not_needed') then
      return format('%s is provided by arc, external or not_needed', v_key);
    end if;
    if v_source <> 'external' and (v_connector is not null or v_tool is not null) then
      return format('%s names another system, so it is external', v_key);
    end if;
    if v_source = 'external' then
      if v_connector is null and coalesce(btrim(v_tool), '') = '' then
        return format('%s is kept in another system — name it', v_key);
      end if;
      if v_connector is not null and not exists (select 1 from public.registry_connectors c where c.key = v_connector) then
        return format('"%s" is not a connector ARC has', v_connector);
      end if;
      if v_tool is not null and char_length(v_tool) > 80 then
        return format('the name of the tool for %s is longer than 80 characters', v_key);
      end if;
      if v_route = 'native' and public.onboarding_capability_object(v_key) is not null then
        return format('ARC Native keeps every record in ARC — %s cannot be kept in another system', v_key);
      end if;
    end if;
  end loop;
  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. the plan, and what was said
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_onboarding (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  -- what the business said it has today. evidence of a conversation; nothing
  -- reads it to decide anything but a suggestion.
  answers    jsonb not null default '{}'::jsonb check (
    jsonb_typeof(answers) = 'object'
    and char_length(answers::text) <= 8000
    and public.crm_text_is_clean(answers::text)
  ),
  -- the operator's decision. null until one is made.
  plan       jsonb check (
    plan is null or (
      jsonb_typeof(plan) = 'object'
      and char_length(plan::text) <= 8000
      and public.crm_text_is_clean(plan::text)
    )
  ),
  -- +1 on every change, so a page drawn from an older one cannot overwrite it.
  revision   integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- no foreign key to auth.users, as in 0021: removing an operator's login
  -- must not rewrite what they decided.
  updated_by uuid not null
);

create table if not exists public.tenant_onboarding_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  event_type    text not null check (event_type in (
    'answers_saved', 'plan_saved', 'route_changed', 'authority_changed', 'capability_enabled'
  )),
  actor_user_id uuid not null,
  -- the plan's revision once this had happened.
  revision      integer not null check (revision >= 0),
  -- what changed, as keys and counts. never what a customer's record says.
  detail        jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and public.crm_text_is_clean(detail::text)),
  occurred_at   timestamptz not null default now(),
  -- two lines written by one action share a time; this keeps the order they
  -- were written in.
  seq           bigint generated always as identity
);

create index if not exists tenant_onboarding_events_idx on public.tenant_onboarding_events (tenant_id, seq desc);

-- the row: an operator, a plan that is a plan, and a revision that only moves on.
create or replace function public.tenant_onboarding_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_problem text;
begin
  perform public.onboarding_check_operator(new.updated_by);
  if new.plan is not null then
    v_problem := public.onboarding_plan_problem(new.plan);
    if v_problem is not null then
      raise exception 'arc_onboarding:invalid: %', v_problem using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.plan is not null and new.plan is null then
      raise exception 'arc_onboarding:invalid: a plan is replaced by another plan, never cleared' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
  else
    new.revision := 1;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists tenant_onboarding_guard on public.tenant_onboarding;
create trigger tenant_onboarding_guard
  before insert or update on public.tenant_onboarding
  for each row execute function public.tenant_onboarding_guard();

create or replace function public.tenant_onboarding_events_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_onboarding:immutable: onboarding history is never rewritten' using errcode = 'P0001';
end;
$fn$;

drop trigger if exists tenant_onboarding_events_immutable on public.tenant_onboarding_events;
create trigger tenant_onboarding_events_immutable
  before update on public.tenant_onboarding_events
  for each row execute function public.tenant_onboarding_events_are_immutable();
-- the one exception every append-only table here makes: a test client being
-- purged (0022), for the client that purge recorded.
drop trigger if exists tenant_onboarding_events_immutable_delete on public.tenant_onboarding_events;
create trigger tenant_onboarding_events_immutable_delete
  before delete on public.tenant_onboarding_events
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.tenant_onboarding_events_are_immutable();

-- one event, and the operator audit log (0004) beside it.
create or replace function public.onboarding_log(
  p_tenant uuid, p_actor uuid, p_type text, p_revision integer, p_detail jsonb
)
returns void
language plpgsql
set search_path = public
as $fn$
begin
  insert into public.tenant_onboarding_events (tenant_id, event_type, actor_user_id, revision, detail)
  values (p_tenant, p_type, p_actor, p_revision, coalesce(p_detail, '{}'::jsonb));
  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (p_actor, 'onboarding.' || p_type, 'tenant', p_tenant::text,
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('revision', p_revision));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. saving
-- ---------------------------------------------------------------------------

-- Answers, a plan, or both. `p_expected` is the revision the page was drawn
-- from (0 when it read no row); a stale one is refused, never merged. Saving
-- what is already there changes nothing and is not an event.
create or replace function public.onboarding_save(
  p_tenant uuid, p_actor uuid, p_expected integer, p_answers jsonb, p_plan jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_tenant  public.tenants;
  v_old     public.tenant_onboarding;
  v_row     public.tenant_onboarding;
  v_answers jsonb := case when jsonb_typeof(p_answers) = 'null' then null else p_answers end;
  v_plan    jsonb := case when jsonb_typeof(p_plan) = 'null' then null else p_plan end;
  v_said    boolean;
  v_decided boolean;
begin
  perform public.onboarding_check_operator(p_actor);
  select * into v_tenant from public.tenants t where t.id = p_tenant;
  if not found then
    raise exception 'arc_onboarding:not_found: this client does not exist' using errcode = 'P0001';
  end if;
  if v_tenant.status = 'archived' then
    raise exception 'arc_onboarding:tenant_inactive: this client is archived — restore them before onboarding' using errcode = 'P0001';
  end if;
  if v_answers is null and v_plan is null then
    raise exception 'arc_onboarding:invalid: nothing to save' using errcode = 'P0001';
  end if;

  select * into v_old from public.tenant_onboarding o where o.tenant_id = p_tenant for update;
  if not found then
    if coalesce(p_expected, 0) <> 0 then
      raise exception 'arc_onboarding:stale: this client has no onboarding record at revision % — reload before saving', p_expected using errcode = 'P0001';
    end if;
    begin
      insert into public.tenant_onboarding (tenant_id, answers, plan, updated_by)
      values (p_tenant, coalesce(v_answers, '{}'::jsonb), v_plan, p_actor)
      returning * into v_row;
    exception when unique_violation then
      raise exception 'arc_onboarding:stale: somebody else started this client''s onboarding — reload before saving' using errcode = 'P0001';
    end;
    v_said := v_answers is not null;
    v_decided := v_plan is not null;
  else
    if p_expected is distinct from v_old.revision then
      raise exception 'arc_onboarding:stale: this client''s onboarding is at revision %, not % — reload before saving', v_old.revision, coalesce(p_expected, 0) using errcode = 'P0001';
    end if;
    v_said := v_answers is not null and v_answers is distinct from v_old.answers;
    v_decided := v_plan is not null and v_plan is distinct from v_old.plan;
    if not v_said and not v_decided then
      return to_jsonb(v_old);
    end if;
    update public.tenant_onboarding o
       set answers = coalesce(v_answers, o.answers), plan = coalesce(v_plan, o.plan), updated_by = p_actor
     where o.tenant_id = p_tenant
    returning * into v_row;
  end if;

  if v_said then
    perform public.onboarding_log(p_tenant, p_actor, 'answers_saved', v_row.revision, jsonb_build_object(
      'questions', (select count(*) from jsonb_object_keys(coalesce(v_row.answers -> 'discovery', '{}'::jsonb))),
      'capabilities', (select count(*) from jsonb_object_keys(coalesce(v_row.answers -> 'tools', '{}'::jsonb)))
    ));
  end if;
  if v_decided then
    -- which side provides what, by key. the name a business gave a tool is in
    -- the plan itself and is not copied into the log.
    perform public.onboarding_log(p_tenant, p_actor, 'plan_saved', v_row.revision, jsonb_build_object(
      'route', v_row.plan ->> 'route',
      'previous_route', v_old.plan ->> 'route',
      'sources', coalesce((
        select jsonb_object_agg(e.key, case
          when e.value ->> 'source' = 'external' then 'external:' || coalesce(e.value ->> 'connector_key', 'unlisted')
          else e.value ->> 'source' end)
          from jsonb_each(coalesce(v_row.plan -> 'capabilities', '{}'::jsonb)) e
      ), '{}'::jsonb)
    ));
  end if;
  return to_jsonb(v_row);
end;
$fn$;

-- An ARC piece set up from the onboarding page: a draft form, an appointment
-- type, a draft booking page, the pipeline. The piece itself is written by the
-- service that owns it; this is the line that says onboarding asked for it.
create or replace function public.onboarding_record(p_tenant uuid, p_actor uuid, p_detail jsonb)
returns void
language plpgsql
set search_path = public
as $fn$
declare
  v_revision integer;
begin
  perform public.onboarding_check_operator(p_actor);
  select o.revision into v_revision from public.tenant_onboarding o where o.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_onboarding:not_found: this client has no onboarding record' using errcode = 'P0001';
  end if;
  perform public.onboarding_log(p_tenant, p_actor, 'capability_enabled', v_revision, p_detail);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. what exists
-- ---------------------------------------------------------------------------

-- how many of a kind of record ARC holds for a client, and how many of them
-- are linked to a record in each connected system (0023's mappings).
create or replace function public.onboarding_record_counts(p_tenant uuid, p_object text)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_total bigint;
begin
  if p_object = 'contact' then
    select count(*) into v_total from public.crm_contacts c where c.tenant_id = p_tenant and c.merged_into_id is null;
  elsif p_object = 'lead' then
    select count(*) into v_total from public.crm_leads l where l.tenant_id = p_tenant;
  elsif p_object = 'appointment' then
    select count(*) into v_total from public.crm_appointments a where a.tenant_id = p_tenant;
  else
    raise exception 'arc_onboarding:invalid: no capability decides who keeps %', p_object using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'total', v_total,
    'mapped', coalesce((
      select jsonb_object_agg(m.connector_key, m.n)
        from (
          select x.connector_key, count(*) as n
            from public.crm_external_mappings x
           where x.tenant_id = p_tenant and x.object_type = p_object and x.removed_at is null
           group by x.connector_key
        ) m
    ), '{}'::jsonb)
  );
end;
$fn$;

-- Everything a step of onboarding is read off, in one answer. Counts and
-- states only: no customer's name, no address, no token.
create or replace function public.onboarding_facts(p_tenant uuid)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
    'route', (select b.route from public.business_profiles b where b.tenant_id = p_tenant),
    'hours_set', coalesce((select b.business_hours <> '{}'::jsonb from public.business_profiles b where b.tenant_id = p_tenant), false),
    'public_phone', coalesce((select b.public_phone is not null from public.business_profiles b where b.tenant_id = p_tenant), false),
    'services', (select count(*) from public.business_services s where s.tenant_id = p_tenant and s.archived_at is null),
    'pipeline', exists (select 1 from public.crm_pipelines p where p.tenant_id = p_tenant and p.archived_at is null),
    'forms', jsonb_build_object(
      'total', (select count(*) from public.crm_intake_forms f where f.tenant_id = p_tenant and f.status <> 'archived'),
      'published', (select count(*) from public.crm_intake_forms f where f.tenant_id = p_tenant and f.status = 'published')
    ),
    'endpoints', (select count(*) from public.crm_intake_endpoints e where e.tenant_id = p_tenant and e.revoked_at is null),
    'imports', jsonb_build_object(
      'completed', (select count(*) from public.crm_imports i where i.tenant_id = p_tenant and i.status = 'completed')
    ),
    'appointment_types', (select count(*) from public.crm_appointment_types t where t.tenant_id = p_tenant and t.archived_at is null),
    'booking_pages', jsonb_build_object(
      'total', (select count(*) from public.crm_booking_pages g where g.tenant_id = p_tenant and g.status <> 'archived'),
      'published', (select count(*) from public.crm_booking_pages g where g.tenant_id = p_tenant and g.status = 'published')
    ),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object('object_type', p.object_type, 'authority', p.authority, 'connector_key', p.connector_key) order by p.object_type)
        from public.crm_source_policies p where p.tenant_id = p_tenant
    ), '[]'::jsonb),
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object('connector_key', c.connector_key, 'status', c.status) order by c.connector_key)
        from public.provider_connections c where c.tenant_id = p_tenant and c.ended_at is null
    ), '[]'::jsonb),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object('module_key', m.module_key, 'state', m.state) order by m.module_key)
        from public.tenant_modules m where m.tenant_id = p_tenant
    ), '[]'::jsonb),
    'records', jsonb_build_object(
      'contact', public.onboarding_record_counts(p_tenant, 'contact'),
      'lead', public.onboarding_record_counts(p_tenant, 'lead'),
      'appointment', public.onboarding_record_counts(p_tenant, 'appointment')
    )
  );
$fn$;

-- ---------------------------------------------------------------------------
-- 4. the route, and where each kind of record is kept
-- ---------------------------------------------------------------------------

-- What the plan asks for that is not yet so: the route recorded on the business
-- profile, and the authority for the three kinds of record a capability decides.
-- Each change carries how many records it touches and how many of those are
-- linked to the other system. `digest` names exactly this answer; it is null
-- when nothing is pending.
--
-- A capability nobody has decided makes no claim — except on ARC Native, where
-- every record is ARC's whatever is undecided. Their system is the authority
-- only where the plan names a connector the registry has; a tool ARC has no
-- entry for cannot be handed anything. A field-by-field split an operator
-- already made with that same system (0023 `hybrid`) is left alone.
create or replace function public.onboarding_authority_pending(p_tenant uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_plan       jsonb;
  v_route_to   text;
  v_route_from text;
  v_route      jsonb;
  v_changes    jsonb := '[]'::jsonb;
  v_pair       record;
  v_choice     jsonb;
  v_object     text;
  v_to_auth    text;
  v_to_conn    text;
  v_from_auth  text;
  v_from_conn  text;
  v_counts     jsonb;
begin
  select o.plan into v_plan from public.tenant_onboarding o where o.tenant_id = p_tenant;
  if v_plan is null then
    return jsonb_build_object('digest', null, 'route', null, 'changes', '[]'::jsonb);
  end if;
  v_route_to := v_plan ->> 'route';
  select b.route into v_route_from from public.business_profiles b where b.tenant_id = p_tenant;
  if v_route_to is distinct from v_route_from then
    v_route := jsonb_build_object('from', v_route_from, 'to', v_route_to);
  end if;

  for v_pair in
    select c.capability from (values (1, 'customer_records'), (2, 'lead_pipeline'), (3, 'calendar')) as c(ord, capability) order by c.ord
  loop
    v_choice := v_plan -> 'capabilities' -> v_pair.capability;
    if v_choice is null and v_route_to <> 'native' then
      continue;
    end if;
    v_object := public.onboarding_capability_object(v_pair.capability);
    if v_choice ->> 'source' = 'external' and v_choice ->> 'connector_key' is not null then
      v_to_auth := 'external';
      v_to_conn := v_choice ->> 'connector_key';
    else
      v_to_auth := 'arc';
      v_to_conn := null;
    end if;
    select p.authority, p.connector_key into v_from_auth, v_from_conn
      from public.crm_source_policies p where p.tenant_id = p_tenant and p.object_type = v_object;
    if not found then
      v_from_auth := 'arc';
      v_from_conn := null;
    end if;
    if (v_to_auth = 'arc' and v_from_auth = 'arc')
       or (v_to_auth = 'external' and v_from_auth in ('external', 'hybrid') and v_from_conn = v_to_conn) then
      continue;
    end if;
    v_counts := public.onboarding_record_counts(p_tenant, v_object);
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'object_type', v_object,
      'capability', v_pair.capability,
      'from', jsonb_build_object('authority', v_from_auth, 'connector_key', v_from_conn),
      'to', jsonb_build_object('authority', v_to_auth, 'connector_key', v_to_conn),
      'records', (v_counts ->> 'total')::integer,
      'mapped', coalesce((v_counts -> 'mapped' ->> coalesce(v_to_conn, v_from_conn))::integer, 0)
    ));
  end loop;

  if v_route is null and v_changes = '[]'::jsonb then
    return jsonb_build_object('digest', null, 'route', null, 'changes', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'digest', md5(coalesce(v_route::text, '') || v_changes::text),
    'route', v_route,
    'changes', v_changes
  );
end;
$fn$;

create or replace function public.onboarding_write_route(p_tenant uuid, p_actor uuid, p_route text)
returns void
language sql
set search_path = public
as $fn$
  insert into public.business_profiles (tenant_id, route, updated_by_type, updated_by)
  values (p_tenant, p_route, 'operator', p_actor)
  on conflict (tenant_id) do update
    set route = excluded.route, updated_by_type = 'operator', updated_by = excluded.updated_by;
$fn$;

-- Make it so: the route, and each kind of record's authority, as the plan has
-- them. One transaction, or nothing.
--
-- `p_digest` is what `onboarding_authority_pending` answered when the operator
-- read what this would do. If a record was added, a mapping made or the plan
-- changed since, the digest is different and this refuses: the change applied
-- is the change that was acknowledged, with the counts that were shown.
--
-- The order is 0023's: ARC Native cannot be recorded while their system owns
-- anything, and their system cannot be given anything while the route is ARC
-- Native — so the route goes first when leaving Native, and last when arriving.
-- Each write is the 0023 table's own, through its own guard and its own audit
-- trigger. Nothing is deleted.
create or replace function public.onboarding_apply_authority(p_tenant uuid, p_actor uuid, p_digest text)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_tenant  public.tenants;
  v_row     public.tenant_onboarding;
  v_pending jsonb;
  v_change  jsonb;
  v_route   text;
begin
  perform public.onboarding_check_operator(p_actor);
  select * into v_tenant from public.tenants t where t.id = p_tenant;
  if not found then
    raise exception 'arc_onboarding:not_found: this client does not exist' using errcode = 'P0001';
  end if;
  if v_tenant.status = 'archived' then
    raise exception 'arc_onboarding:tenant_inactive: this client is archived — nothing about where their records are kept can change' using errcode = 'P0001';
  end if;

  select * into v_row from public.tenant_onboarding o where o.tenant_id = p_tenant for update;
  if not found or v_row.plan is null then
    raise exception 'arc_onboarding:nothing_to_apply: this client has no plan yet' using errcode = 'P0001';
  end if;

  v_pending := public.onboarding_authority_pending(p_tenant);
  if v_pending ->> 'digest' is null then
    raise exception 'arc_onboarding:nothing_to_apply: every record is already kept where the plan says' using errcode = 'P0001';
  end if;
  if p_digest is distinct from v_pending ->> 'digest' then
    raise exception 'arc_onboarding:impact_changed: what this would change is not what was shown — read it again before applying' using errcode = 'P0001';
  end if;

  v_route := v_pending -> 'route' ->> 'to';
  if v_route is not null and v_route <> 'native' then
    perform public.onboarding_write_route(p_tenant, p_actor, v_route);
  end if;
  for v_change in select e.value from jsonb_array_elements(v_pending -> 'changes') e loop
    insert into public.crm_source_policies (tenant_id, object_type, authority, connector_key, field_owners, note, updated_by)
    values (
      p_tenant, v_change ->> 'object_type', v_change -> 'to' ->> 'authority', v_change -> 'to' ->> 'connector_key',
      '{}'::jsonb, 'set from the onboarding plan', p_actor
    )
    on conflict (tenant_id, object_type) do update
      set authority = excluded.authority, connector_key = excluded.connector_key,
          field_owners = '{}'::jsonb, note = excluded.note, updated_by = excluded.updated_by;
  end loop;
  if v_route = 'native' then
    perform public.onboarding_write_route(p_tenant, p_actor, v_route);
  end if;

  -- the plan did not change, but what is true of it did: anyone holding the
  -- page as it was must read it again.
  update public.tenant_onboarding o set updated_by = p_actor where o.tenant_id = p_tenant returning * into v_row;

  if v_pending -> 'route' <> 'null'::jsonb then
    perform public.onboarding_log(p_tenant, p_actor, 'route_changed', v_row.revision, v_pending -> 'route');
  end if;
  if jsonb_array_length(v_pending -> 'changes') > 0 then
    perform public.onboarding_log(p_tenant, p_actor, 'authority_changed', v_row.revision,
      jsonb_build_object('changes', v_pending -> 'changes'));
  end if;
  return v_pending || jsonb_build_object('revision', v_row.revision);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. RLS and grants
-- ---------------------------------------------------------------------------

-- An operator's working record of a client, as 0021's creation record is:
-- operators read it, and nobody holding a browser key writes it.
do $$
declare
  t text;
begin
  foreach t in array array['tenant_onboarding', 'tenant_onboarding_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_arc_admin())',
      t || '_read', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke all on function public.onboarding_capabilities() from public, anon, authenticated;
revoke all on function public.onboarding_capability_object(text) from public, anon, authenticated;
revoke all on function public.onboarding_check_operator(uuid) from public, anon, authenticated;
revoke all on function public.onboarding_plan_problem(jsonb) from public, anon, authenticated;
revoke all on function public.tenant_onboarding_guard() from public, anon, authenticated;
revoke all on function public.tenant_onboarding_events_are_immutable() from public, anon, authenticated;
revoke all on function public.onboarding_log(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.onboarding_save(uuid, uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.onboarding_record(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.onboarding_record_counts(uuid, text) from public, anon, authenticated;
revoke all on function public.onboarding_facts(uuid) from public, anon, authenticated;
revoke all on function public.onboarding_authority_pending(uuid) from public, anon, authenticated;
revoke all on function public.onboarding_write_route(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.onboarding_apply_authority(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.onboarding_capabilities() to service_role;
grant execute on function public.onboarding_capability_object(text) to service_role;
grant execute on function public.onboarding_check_operator(uuid) to service_role;
grant execute on function public.onboarding_plan_problem(jsonb) to service_role;
grant execute on function public.onboarding_log(uuid, uuid, text, integer, jsonb) to service_role;
grant execute on function public.onboarding_save(uuid, uuid, integer, jsonb, jsonb) to service_role;
grant execute on function public.onboarding_record(uuid, uuid, jsonb) to service_role;
grant execute on function public.onboarding_record_counts(uuid, text) to service_role;
grant execute on function public.onboarding_facts(uuid) to service_role;
grant execute on function public.onboarding_authority_pending(uuid) to service_role;
grant execute on function public.onboarding_write_route(uuid, uuid, text) to service_role;
grant execute on function public.onboarding_apply_authority(uuid, uuid, text) to service_role;
