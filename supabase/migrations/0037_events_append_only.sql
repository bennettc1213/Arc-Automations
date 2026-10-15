-- The event log refuses every change, whoever holds the key.
--
-- `events` has been append-only by row level security since 0001: a browser can read its own
-- client's rows and write none. Code holding the service key could still update or delete a
-- row, and nothing in the schema refused it (ARC_LEAD_RECOVERY_READINESS.md §7.4, item 1).
-- Every figure on either side is read off this log, so it now has the guard the other
-- append-only tables have: an update, a delete or a truncate is refused for every role.
--
-- What still works: an insert, and the writer's `on conflict do nothing` (an ignored
-- duplicate is not an update). Deleting a client cascades into `events`; purge_test_tenant
-- (0022) refuses any client with an event, so the one exception it needs is for a row it can
-- never find — kept anyway, the same WHEN clause as 0022's seven guards, so the two cannot
-- drift. Any other client with history cannot be deleted at all: it is deboarded (0007).
--
-- Rollback: drop trigger events_append_only on public.events;
--   drop trigger events_append_only_delete on public.events;
--   drop trigger events_no_truncate on public.events;
--   drop function public.events_are_append_only();
--
-- Requires 0022.

create function public.events_are_append_only()
returns trigger language plpgsql set search_path = public as $fn$
begin
  raise exception 'events is append-only: % refused', lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$fn$;
revoke all on function public.events_are_append_only() from public, anon, authenticated;

create trigger events_append_only
  before update on public.events
  for each row execute function public.events_are_append_only();

create trigger events_append_only_delete
  before delete on public.events
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.events_are_append_only();

create trigger events_no_truncate
  before truncate on public.events
  for each statement execute function public.events_are_append_only();
