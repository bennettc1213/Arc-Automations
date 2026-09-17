-- The services Arc is building for each client, and the checklist behind each one.
--
-- Arc sells a menu of services — speed-to-lead, missed-call text-back, a lead
-- qualification agent — rather than hours. So a client is not "on a retainer",
-- they bought specific things, and each of those things is a job with an end:
-- built in Arc's n8n, then integrated into the client's business, then done.
-- Until now nothing recorded which things, or how far along each one was.
--
-- Two tables:
--
--   client_services       one row per service a client bought.
--   client_service_steps  that service's checklist, one row per step.
--
-- The steps are copied in from the console's catalog
-- (src/portal/lib/service-catalog.js) when the service is added, not read from
-- it live. A checklist is what was agreed and worked through for this client; if
-- the catalog gains a step next month, a build that finished in March should not
-- reopen with an unticked box in it. It also means a step can be added for one
-- client ("port their old number from Ooma") or removed where it does not apply.
--
-- No status column. Whether a service is building, integrating or delivered is
-- read off its steps by the console, so it cannot disagree with them — the same
-- rule the pipeline verdict follows. And "delivered" means the checklist is done,
-- not that anything is sending: the console shows the event log beside each step
-- that the log can prove, and the pipeline check stays the only green that means
-- "working".

create table if not exists public.client_services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- the catalog key: speed-to-lead, missed-call-text-back, … (matches site.js)
  service_key text not null,
  -- the name when it was sold. a service renamed on the site does not rename a
  -- deal already made.
  name        text not null,
  created_at  timestamptz not null default now(),

  unique (tenant_id, service_key),
  -- lets the steps table prove a step and its service belong to one client.
  unique (id, tenant_id)
);

create index if not exists client_services_tenant_idx on public.client_services (tenant_id);

create table if not exists public.client_service_steps (
  id          uuid primary key default gen_random_uuid(),
  service_id  uuid not null,
  -- carried on every step so the console reads a client's checklist in one
  -- query, and pinned to the service's own tenant by the foreign key below.
  tenant_id   uuid not null,
  -- the catalog step it was copied from. null for a step added by hand.
  step_key    text,
  -- building it (in Arc's n8n, on test data) or integrating it (their number,
  -- their CRM, their team, real traffic).
  phase       text not null check (phase in ('build', 'integrate')),
  position    integer not null default 0,
  label       text not null check (char_length(trim(label)) > 0),
  detail      text,
  -- set by the trigger below, not by the browser.
  done_at     timestamptz,
  done_by     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  foreign key (service_id, tenant_id)
    references public.client_services (id, tenant_id) on delete cascade
);

create index if not exists client_service_steps_service_idx
  on public.client_service_steps (service_id, phase, position);
create index if not exists client_service_steps_tenant_idx
  on public.client_service_steps (tenant_id);

-- ---------------------------------------------------------------------------
-- who ticked it, and when — stamped by the database
-- ---------------------------------------------------------------------------

-- The browser says "done" or "not done" and nothing else. When a step goes from
-- open to done, the time is the database's clock and the operator is whoever is
-- signed in; ticking an already-done step again keeps the original stamp, and
-- unticking clears both. A checklist whose dates the browser could set would be
-- a checklist that can be backdated.
create or replace function public.stamp_client_service_step()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.done_at is null then
    new.done_by := null;
  elsif tg_op = 'INSERT' or old.done_at is null then
    new.done_at := now();
    new.done_by := auth.uid();
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
  end if;
  return new;
end;
$fn$;

drop trigger if exists client_service_steps_stamp on public.client_service_steps;
create trigger client_service_steps_stamp
  before insert or update of done_at on public.client_service_steps
  for each row execute function public.stamp_client_service_step();

-- ---------------------------------------------------------------------------
-- Policies: operators only
-- ---------------------------------------------------------------------------

-- Not readable by the client. Steps carry operator detail ("their office manager
-- is the one to train") that was never written for them to read. If the portal
-- grows a "what we are building for you" page, that is a new select policy with
-- its own decision behind it.

alter table public.client_services enable row level security;
alter table public.client_service_steps enable row level security;

drop policy if exists client_services_admin on public.client_services;
create policy client_services_admin on public.client_services
  for all to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

drop policy if exists client_service_steps_admin on public.client_service_steps;
create policy client_service_steps_admin on public.client_service_steps
  for all to authenticated
  using (public.is_arc_admin()) with check (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- add_client_services
-- ---------------------------------------------------------------------------

-- A service and its checklist are one write. Inserting the service and then its
-- steps as two requests from the browser leaves, on the second one failing, a
-- service with no checklist — which would read as "delivered, 0 of 0". Here it
-- is one transaction: every service in the list lands with all its steps, or
-- nothing does.
--
-- p_services: [{ "key", "name", "steps": [{ "key", "phase", "label", "detail" }] }]
-- A service the client already has is skipped, not duplicated, and named in the
-- result so the console can say so.
--
-- security invoker: it runs as the operator, so the policies above still decide
-- whether any of it is allowed. The explicit check is only there to fail with a
-- sentence instead of a row-level-security error.
create or replace function public.add_client_services(p_tenant uuid, p_services jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_service jsonb;
  v_id      uuid;
  v_added   text[] := '{}';
  v_skipped text[] := '{}';
begin
  if not public.is_arc_admin() then
    raise exception 'only an arc operator can add services to a client' using errcode = '42501';
  end if;
  if jsonb_typeof(p_services) is distinct from 'array' then
    raise exception 'services must be a list' using errcode = '22023';
  end if;

  for v_service in select value from jsonb_array_elements(p_services) loop
    if coalesce(trim(v_service->>'key'), '') = '' or coalesce(trim(v_service->>'name'), '') = '' then
      raise exception 'every service needs a key and a name' using errcode = '22023';
    end if;

    v_id := null;
    insert into public.client_services (tenant_id, service_key, name)
    values (p_tenant, v_service->>'key', v_service->>'name')
    on conflict (tenant_id, service_key) do nothing
    returning id into v_id;

    if v_id is null then
      v_skipped := v_skipped || (v_service->>'key');
      continue;
    end if;

    insert into public.client_service_steps
      (service_id, tenant_id, step_key, phase, position, label, detail)
    select v_id,
           p_tenant,
           step->>'key',
           step->>'phase',
           (ord - 1)::integer,
           step->>'label',
           nullif(step->>'detail', '')
      from jsonb_array_elements(coalesce(v_service->'steps', '[]'::jsonb))
           with ordinality as s(step, ord);

    v_added := v_added || (v_service->>'key');
  end loop;

  return jsonb_build_object('added', to_jsonb(v_added), 'skipped', to_jsonb(v_skipped));
end;
$fn$;

revoke all on function public.add_client_services(uuid, jsonb) from public, anon;
grant execute on function public.add_client_services(uuid, jsonb) to authenticated;
