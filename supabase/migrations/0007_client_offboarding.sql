-- Deboarding: taking a client out of the system without erasing what we did.
--
-- 0003 added 'archived' to tenants.status and said "archive is what removing a
-- client from the roster actually means" — but nothing ever did the removing.
-- Setting the status by hand left the client's ingest tokens valid, their login
-- still attached, and their connections still marked connected: an archived
-- client whose n8n could keep writing events into a tenant nobody was watching.
--
-- Deboarding is five writes that only make sense together, so they happen in one
-- transaction here rather than as five round trips from an edge function that
-- could stop halfway:
--
--   1. every ingest token is revoked, so the pipeline cannot write another event
--   2. every tenant_members row is removed, so no login can read the account
--   3. every connection not already retired is marked retired
--   4. the tenant is archived, with when and why
--   5. (the audit row is written by the `ops` function that calls this)
--
-- Nothing is deleted. The events stay — they are the record of what the service
-- did, and a past client's report still has to be producible from them — and so
-- do the alerts, unresolved ones included. Stamping an incident resolved because
-- the engagement ended would write a fix time for a fix that never happened.

alter table public.tenants
  add column if not exists archived_at    timestamptz,
  -- one of the reasons the console offers (contract ended, went elsewhere, …),
  -- free text rather than a check constraint so a new reason is not a migration.
  add column if not exists archive_reason text,
  add column if not exists archive_note   text;

create index if not exists tenants_archived_idx
  on public.tenants (archived_at desc)
  where archived_at is not null;

-- A tenant archived by hand before this migration has no archive date. The
-- creation date is the only honest lower bound we hold, and the console labels
-- a backfilled row as such by the missing reason.
update public.tenants
  set archived_at = created_at
  where status = 'archived' and archived_at is null;

-- ---------------------------------------------------------------------------
-- deboard_tenant
-- ---------------------------------------------------------------------------

create or replace function public.deboard_tenant(
  p_tenant uuid,
  p_reason text,
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status     text;
  v_tokens     int;
  v_members    uuid[];
  v_retired    int;
  v_now        timestamptz := now();
begin
  -- `for update` holds the row, so two operators pressing the button at once
  -- cannot both get past the already-archived check.
  select status into v_status from public.tenants where id = p_tenant for update;

  if not found then
    raise exception 'no client with that id' using errcode = 'P0002';
  end if;
  if v_status = 'archived' then
    raise exception 'that client is already a past client' using errcode = 'P0001';
  end if;

  with revoked as (
    update public.ingest_tokens
       set revoked_at = v_now
     where tenant_id = p_tenant and revoked_at is null
     returning 1
  )
  select count(*) into v_tokens from revoked;

  with removed as (
    delete from public.tenant_members
     where tenant_id = p_tenant
     returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into v_members from removed;

  with retired as (
    update public.connections
       set status = 'retired', updated_at = v_now
     where tenant_id = p_tenant and status <> 'retired'
     returning 1
  )
  select count(*) into v_retired from retired;

  update public.tenants
     set status         = 'archived',
         archived_at    = v_now,
         archive_reason = nullif(trim(p_reason), ''),
         archive_note   = nullif(trim(p_note), '')
   where id = p_tenant;

  return jsonb_build_object(
    'archived_at',         v_now,
    'tokens_revoked',      v_tokens,
    'members_removed',     coalesce(array_length(v_members, 1), 0),
    'member_ids',          to_jsonb(v_members),
    'connections_retired', v_retired
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- restore_tenant
-- ---------------------------------------------------------------------------

-- Bringing a past client back. Deliberately does not undo the deboarding: the
-- revoked tokens stay revoked (a new one is minted, so the old value that may
-- still be sitting in an n8n credential is dead for good), and access is
-- re-granted with the link-account button rather than by re-inserting rows for
-- people who may no longer work there.
create or replace function public.restore_tenant(
  p_tenant uuid,
  p_status text default 'paused'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
begin
  if p_status not in ('onboarding', 'active', 'paused') then
    raise exception 'restore to onboarding, active or paused' using errcode = '22023';
  end if;

  select status into v_status from public.tenants where id = p_tenant for update;

  if not found then
    raise exception 'no client with that id' using errcode = 'P0002';
  end if;
  if v_status <> 'archived' then
    raise exception 'that client is not a past client' using errcode = 'P0001';
  end if;

  update public.tenants
     set status = p_status,
         archived_at = null,
         archive_reason = null,
         archive_note = null
   where id = p_tenant;

  return jsonb_build_object('status', p_status);
end;
$fn$;

-- Both run as their owner, so nobody but the service role may call them. The
-- `ops` function checks is_arc_admin() before it does, and writes the audit row;
-- a browser calling these directly would do neither.
revoke all on function public.deboard_tenant(uuid, text, text) from public, anon, authenticated;
revoke all on function public.restore_tenant(uuid, text) from public, anon, authenticated;
grant execute on function public.deboard_tenant(uuid, text, text) to service_role;
grant execute on function public.restore_tenant(uuid, text) to service_role;
