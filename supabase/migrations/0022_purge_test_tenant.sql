-- ===========================================================================
-- 0022 — Permanently deleting a test client (purge_test_tenant)
-- ===========================================================================
--
-- A client that was only ever set up — created, given a module, configured,
-- given a service checklist or a token nobody used — and never did anything
-- real can now be deleted outright. That is what a test client is, and a
-- roster full of them is noise.
--
-- A client that did anything real cannot, by this or any other path: an event,
-- a lead, a conversation or message, a run of any kind (even a synthetic
-- canary), a queued action, an attempt, a sending snapshot, a dispatch, a
-- provider connection or OAuth session, an opt-out, or an ingest token that
-- was used. Those are the record of what Arc did, and that record is never
-- erased; such a client is deboarded (0007) instead, which keeps it.
--
-- How it gets past the append-only guards. Seven tables refuse every delete
-- (0014's configuration versions and drafts, 0015's lifecycle, transitions and
-- evidence). Their guard triggers are re-created here as two triggers each: the
-- same function for insert and update, unchanged, and the same function for
-- delete with one exception in its WHEN clause — `tenant_purge_in_progress`,
-- which is true only inside purge_test_tenant's own transaction, for the one
-- tenant it has already written down in `tenant_purges`. Setting the flag by
-- hand does nothing without that row, and the row is only ever written by the
-- function after every check has passed.
--
-- What remains afterwards: one `tenant_purges` row (who, when, and the client's
-- name, handle and client ID) and one `admin_actions` row (`tenant.purged`).
-- The operator's own login and any auth user the client had are not touched.
--
-- Rollback: drop function public.purge_test_tenant(uuid, uuid, text);
--   drop function public.tenant_purge_in_progress(uuid); drop table public.tenant_purges;
--   and re-create the seven guard triggers as single insert/update/delete
--   triggers exactly as 0014 and 0015 wrote them.

-- ---------------------------------------------------------------------------
-- 1. the record that outlives the client
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_purges (
  id            uuid primary key default gen_random_uuid(),
  -- no foreign key: the tenant is gone by the time this is read.
  tenant_id     uuid not null unique,
  actor_user_id uuid not null,
  name          text not null,
  slug          text not null,
  client_id     text,
  created_at    timestamptz,
  purged_at     timestamptz not null default now()
);

create or replace function public.tenant_purges_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'arc_tenant:immutable: a purge record is never rewritten or removed' using errcode = 'P0001';
end;
$fn$;

drop trigger if exists tenant_purges_immutable on public.tenant_purges;
create trigger tenant_purges_immutable
  before update or delete on public.tenant_purges
  for each row execute function public.tenant_purges_are_immutable();

alter table public.tenant_purges enable row level security;

drop policy if exists tenant_purges_select_admin on public.tenant_purges;
create policy tenant_purges_select_admin on public.tenant_purges
  for select to authenticated
  using (public.is_arc_admin());

-- ---------------------------------------------------------------------------
-- 2. the one exception the guards make
-- ---------------------------------------------------------------------------

create or replace function public.tenant_purge_in_progress(p_tenant uuid)
returns boolean
language sql
stable
set search_path = public
as $fn$
  select current_setting('arc.purging_tenant', true) = p_tenant::text
     and exists (select 1 from public.tenant_purges p where p.tenant_id = p_tenant);
$fn$;

drop trigger if exists tenant_config_versions_guard on public.tenant_config_versions;
create trigger tenant_config_versions_guard
  before insert or update on public.tenant_config_versions
  for each row execute function public.tenant_config_versions_guard();
drop trigger if exists tenant_config_versions_guard_delete on public.tenant_config_versions;
create trigger tenant_config_versions_guard_delete
  before delete on public.tenant_config_versions
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.tenant_config_versions_guard();

drop trigger if exists module_config_versions_guard on public.module_config_versions;
create trigger module_config_versions_guard
  before insert or update on public.module_config_versions
  for each row execute function public.module_config_versions_guard();
drop trigger if exists module_config_versions_guard_delete on public.module_config_versions;
create trigger module_config_versions_guard_delete
  before delete on public.module_config_versions
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.module_config_versions_guard();

drop trigger if exists tenant_config_drafts_guard on public.tenant_config_drafts;
create trigger tenant_config_drafts_guard
  before insert or update on public.tenant_config_drafts
  for each row execute function public.config_drafts_guard();
drop trigger if exists tenant_config_drafts_guard_delete on public.tenant_config_drafts;
create trigger tenant_config_drafts_guard_delete
  before delete on public.tenant_config_drafts
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.config_drafts_guard();

drop trigger if exists module_config_drafts_guard on public.module_config_drafts;
create trigger module_config_drafts_guard
  before insert or update on public.module_config_drafts
  for each row execute function public.config_drafts_guard();
drop trigger if exists module_config_drafts_guard_delete on public.module_config_drafts;
create trigger module_config_drafts_guard_delete
  before delete on public.module_config_drafts
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.config_drafts_guard();

drop trigger if exists tenant_module_transitions_guard on public.tenant_module_transitions;
create trigger tenant_module_transitions_guard
  before insert or update on public.tenant_module_transitions
  for each row execute function public.tenant_module_transitions_guard();
drop trigger if exists tenant_module_transitions_guard_delete on public.tenant_module_transitions;
create trigger tenant_module_transitions_guard_delete
  before delete on public.tenant_module_transitions
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.tenant_module_transitions_guard();

drop trigger if exists tenant_module_evidence_guard on public.tenant_module_evidence;
create trigger tenant_module_evidence_guard
  before insert or update on public.tenant_module_evidence
  for each row execute function public.tenant_module_evidence_guard();
drop trigger if exists tenant_module_evidence_guard_delete on public.tenant_module_evidence;
create trigger tenant_module_evidence_guard_delete
  before delete on public.tenant_module_evidence
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.tenant_module_evidence_guard();

drop trigger if exists tenant_modules_guard on public.tenant_modules;
create trigger tenant_modules_guard
  before insert or update on public.tenant_modules
  for each row execute function public.tenant_modules_guard();
drop trigger if exists tenant_modules_guard_delete on public.tenant_modules;
create trigger tenant_modules_guard_delete
  before delete on public.tenant_modules
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.tenant_modules_guard();

-- ---------------------------------------------------------------------------
-- 3. purge_test_tenant
-- ---------------------------------------------------------------------------
--
-- Refusals arrive as `arc_tenant:<code>: <message>`:
--   forbidden             not an operator, or not the signed-in caller
--   not_found             no such client
--   confirmation_mismatch the handle typed is not this client's
--   tenant_has_activity   it did something real — the message lists what

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

  -- everything that means the client did something real. each is listed, so
  -- the refusal says what is standing in the way.
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
      ('suppressions',                   'opt-outs')
    ) as c(tbl, label)
  loop
    execute format('select count(*) from public.%I where tenant_id = $1', v_check.tbl) into v_count using p_tenant;
    if v_count > 0 then
      v_activity := v_activity || format('%s %s', v_count, v_check.label);
    end if;
  end loop;
  -- (an OAuth session lives in arc_private, which this function's caller cannot
  -- read — 0016 keeps it that way. its foreign key to tenants is RESTRICT, so a
  -- client with one is refused by the delete below instead.)
  select count(*) into v_count from public.ingest_tokens k where k.tenant_id = p_tenant and k.last_used_at is not null;
  if v_count > 0 then
    v_activity := v_activity || format('%s ingest tokens that were used', v_count);
  end if;

  if array_length(v_activity, 1) > 0 then
    raise exception 'arc_tenant:tenant_has_activity: % has real activity (%) — deboard it instead; its history is kept',
      v_tenant.slug, array_to_string(v_activity, ', ') using errcode = 'P0001';
  end if;

  -- the record first: it is what the guards' exception checks for.
  insert into public.tenant_purges (tenant_id, actor_user_id, name, slug, client_id, created_at)
  values (v_tenant.id, p_actor, v_tenant.name, v_tenant.slug, v_tenant.client_id, v_tenant.created_at)
  returning * into v_record;
  perform set_config('arc.purging_tenant', p_tenant::text, true);

  -- one statement, so the setup rows that point at each other (a lifecycle and
  -- its evidence, a version and its draft) go together.
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

revoke all on function public.purge_test_tenant(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.tenant_purge_in_progress(uuid) from public, anon, authenticated;
revoke all on function public.tenant_purges_are_immutable() from public, anon, authenticated;
grant execute on function public.purge_test_tenant(uuid, uuid, text) to service_role;
-- the guards' WHEN clause runs as whoever is deleting; for anyone else the
-- missing grant is one more refusal.
grant execute on function public.tenant_purge_in_progress(uuid) to service_role;
grant select on public.tenant_purges to authenticated, service_role;
