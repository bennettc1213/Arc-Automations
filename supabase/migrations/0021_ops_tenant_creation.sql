-- ===========================================================================
-- 0021 — Operator tenant creation and module selection (ARC-300)
-- ===========================================================================
--
-- Until now a client was created by the ops console inserting a `tenants` row
-- straight from the browser, under the 0003 admin insert policy. Nothing
-- recorded who did it, nothing selected a module, and a module's lifecycle
-- (0015) only began when an operator later found the Lead Recovery panel and
-- pressed "select". This migration makes creation one operator action with one
-- transaction behind it:
--
--   create_tenant()      the tenant, the selection of each chosen module through
--                        0015's own apply_tenant_module_transition (so each gets
--                        its lifecycle row and first history row exactly as a
--                        later selection would), the readiness step that the
--                        creation itself satisfies, the creation record and the
--                        audit row. All of it or none of it.
--   tenant_creations     one row per tenant created this way: who, when, which
--                        modules, under which idempotency key. Never updated.
--
-- Selecting is not activating. A module chosen here is `configuring`; the only
-- way to `active` is still ARC-120's gate, and nothing here can reach it.
--
-- The browser insert policy on `tenants` is dropped, so the only way to create a
-- client is the service path above. Update stays as it was (the client page
-- edits a tenant's details) — this migration is about creation.
--
-- Rollback: drop function public.create_tenant(uuid, jsonb, text[], text);
--   drop function public.tenant_creation_record(uuid, boolean);
--   drop table public.tenant_creations;
--   and re-create 0003's tenants_admin_insert policy. Tenants created through
--   the function stay; they are ordinary tenants.
--
-- Forward-only and additive, apart from the one policy drop above.

-- ---------------------------------------------------------------------------
-- 1. the creation record
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_creations (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  -- an arc_admins member at the moment of creation (create_tenant checks it).
  -- no foreign key to auth.users: removing an operator's login later must not
  -- rewrite or block the record of what they did.
  actor_user_id   uuid not null,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  slug            text not null,
  modules         text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create or replace function public.tenant_creations_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_tenant:immutable: a creation record is never rewritten' using errcode = 'P0001';
end;
$fn$;

drop trigger if exists tenant_creations_immutable on public.tenant_creations;
create trigger tenant_creations_immutable
  before update on public.tenant_creations
  for each row execute function public.tenant_creations_are_immutable();

alter table public.tenant_creations enable row level security;

-- operators read it on the client page. nobody writes it but create_tenant.
drop policy if exists tenant_creations_select_admin on public.tenant_creations;
create policy tenant_creations_select_admin on public.tenant_creations
  for select to authenticated
  using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 2. what create_tenant answers with
-- ---------------------------------------------------------------------------

create or replace function public.tenant_creation_record(p_tenant uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
    'replayed', p_replayed,
    'tenant', to_jsonb(t),
    'creation', to_jsonb(c),
    'lifecycles', coalesce((
      select jsonb_agg(to_jsonb(tm) order by tm.module_key)
        from public.tenant_modules tm where tm.tenant_id = p_tenant
    ), '[]'::jsonb)
  )
  from public.tenants t
  join public.tenant_creations c on c.tenant_id = t.id
  where t.id = p_tenant;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. create_tenant
-- ---------------------------------------------------------------------------
--
-- Refusals arrive as `arc_tenant:<code>: <message>` (the lifecycle's own, from
-- the selection, as `arc_lifecycle:<code>: …`), which the ops function turns
-- into a status and a code. The `ops` function validates the same things first
-- (`_shared/tenants/model.ts`) so an operator reads every problem at once; this
-- is the check that cannot be skipped.

create or replace function public.create_tenant(
  p_actor           uuid,
  p_tenant          jsonb,
  p_modules         text[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_existing   public.tenant_creations;
  v_tenant     public.tenants;
  v_modules    text[];
  v_key        text;
  v_constraint text;
  v_name       text := btrim(coalesce(p_tenant ->> 'name', ''));
  v_slug       text := btrim(coalesce(p_tenant ->> 'slug', ''));
  v_client_id  text := nullif(btrim(coalesce(p_tenant ->> 'client_id', '')), '');
  v_timezone   text := coalesce(nullif(btrim(coalesce(p_tenant ->> 'timezone', '')), ''), 'America/Denver');
  v_status     text := coalesce(nullif(btrim(coalesce(p_tenant ->> 'status', '')), ''), 'onboarding');
begin
  -- who. the same definition of an operator the RLS policies use, and the
  -- signed-in caller when there is one.
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_tenant:forbidden: creating a client is an operator action' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_tenant:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200 then
    raise exception 'arc_tenant:invalid: an idempotency key of 8 to 200 characters is required' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct btrim(m) order by btrim(m)), '{}'::text[])
    into v_modules
    from unnest(coalesce(p_modules, '{}'::text[])) m;

  -- a repeat of the same request is the same answer, not a second client.
  select * into v_existing from public.tenant_creations c where c.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.slug <> v_slug or v_existing.modules <> v_modules then
      raise exception 'arc_tenant:idempotency_conflict: this idempotency key already created % with other details', v_existing.slug
        using errcode = 'P0001';
    end if;
    return public.tenant_creation_record(v_existing.tenant_id, true);
  end if;

  -- the tenant's own fields.
  if v_name = '' or length(v_name) > 120 then
    raise exception 'arc_tenant:invalid: a business name of 1 to 120 characters is required' using errcode = 'P0001';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 64 then
    raise exception 'arc_tenant:invalid: the account handle is lowercase letters, digits and single dashes' using errcode = 'P0001';
  end if;
  if v_client_id is not null and v_client_id !~ '^ARC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$' then
    raise exception 'arc_tenant:invalid: a client ID looks like ARC-4K7P-92QX' using errcode = 'P0001';
  end if;
  if v_status not in ('onboarding', 'active', 'paused') then
    raise exception 'arc_tenant:invalid: a new client is onboarding, active or paused' using errcode = 'P0001';
  end if;
  begin
    perform now() at time zone v_timezone;
  exception when others then
    raise exception 'arc_tenant:invalid: "%" is not a timezone', v_timezone using errcode = 'P0001';
  end;

  -- the modules: registered, and selectable in both the definition and a version.
  -- (whether a connector ARC offers could serve one is the registry's static
  -- answer, checked by the ops function; 0015 re-checks the version here too.)
  if coalesce(array_length(v_modules, 1), 0) > 10 then
    raise exception 'arc_tenant:invalid: at most 10 modules' using errcode = 'P0001';
  end if;
  foreach v_key in array v_modules loop
    if not exists (select 1 from public.registry_modules rm where rm.key = v_key) then
      raise exception 'arc_tenant:module_not_found: "%" is not a registered module', v_key using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.registry_modules rm
        join public.registry_module_versions mv on mv.module_key = rm.key
       where rm.key = v_key and rm.status in ('pilot', 'available') and mv.status in ('pilot', 'available')
    ) then
      raise exception 'arc_tenant:module_unavailable: % cannot be given to a client yet', v_key using errcode = 'P0001';
    end if;
  end loop;

  -- the tenant.
  begin
    insert into public.tenants (
      name, slug, client_id, company, timezone, status, plan, notes,
      login_email, contact_name, contact_phone, onboarded_at
    ) values (
      v_name, v_slug, coalesce(v_client_id, public.gen_client_id()),
      nullif(btrim(coalesce(p_tenant ->> 'company', '')), ''),
      v_timezone, v_status,
      nullif(btrim(coalesce(p_tenant ->> 'plan', '')), ''),
      nullif(btrim(coalesce(p_tenant ->> 'notes', '')), ''),
      lower(nullif(btrim(coalesce(p_tenant ->> 'login_email', '')), '')),
      nullif(btrim(coalesce(p_tenant ->> 'contact_name', '')), ''),
      nullif(btrim(coalesce(p_tenant ->> 'contact_phone', '')), ''),
      case when v_status = 'active' then now() end
    )
    returning * into v_tenant;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint like '%client_id%' then
      raise exception 'arc_tenant:client_id_taken: that client ID is in use — generate another' using errcode = 'P0001';
    end if;
    raise exception 'arc_tenant:slug_taken: another client already uses the handle %', v_slug using errcode = 'P0001';
  end;

  -- each module through the lifecycle's one door: unselected → configuring, with
  -- its history row, the operator as actor, and nothing authorised.
  foreach v_key in array v_modules loop
    perform public.apply_tenant_module_transition(
      v_tenant.id, v_key, 'select', 0, 'operator', p_actor,
      'operator_selected', 'selected when the client was created',
      'create:' || p_idempotency_key || ':' || v_key,
      jsonb_build_object('pending_requirements', '[]'::jsonb, 'authorized', null)
    );
    -- the one readiness step the creation itself proves. a module with no
    -- onboarding checklist in 0010's table has none to tick.
    begin
      insert into public.module_onboarding (tenant_id, module_key, step_key, done_at, note)
      values (v_tenant.id, v_key, 'tenant_created', now(), 'recorded when the client was created')
      on conflict (tenant_id, module_key, step_key) do nothing;
    exception when check_violation then null;
    end;
  end loop;

  insert into public.tenant_creations (tenant_id, actor_user_id, idempotency_key, slug, modules)
  values (v_tenant.id, p_actor, p_idempotency_key, v_slug, v_modules);

  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (p_actor, 'tenant.created', 'tenant', v_tenant.id::text, jsonb_build_object(
    'slug', v_tenant.slug,
    'client_id', v_tenant.client_id,
    'status', v_tenant.status,
    'modules', to_jsonb(v_modules),
    'idempotency_key', p_idempotency_key
  ));

  return public.tenant_creation_record(v_tenant.id, false);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. who may call it, and the door it replaces
-- ---------------------------------------------------------------------------

revoke all on function public.create_tenant(uuid, jsonb, text[], text) from public, anon, authenticated;
revoke all on function public.tenant_creation_record(uuid, boolean) from public, anon, authenticated;
revoke all on function public.tenant_creations_are_immutable() from public, anon, authenticated;
grant execute on function public.create_tenant(uuid, jsonb, text[], text) to service_role;
grant execute on function public.tenant_creation_record(uuid, boolean) to service_role;
grant select on public.tenant_creations to authenticated, service_role;

-- creation goes through create_tenant, so the browser can no longer insert a
-- tenant row of its own. every other tenants policy is unchanged.
drop policy if exists tenants_admin_insert on public.tenants;
