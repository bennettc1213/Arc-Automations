-- Makes the idempotency index usable as an ON CONFLICT target.
--
-- 0001 declared it partial (`where event_key is not null`). Postgres will not
-- match a partial index in ON CONFLICT unless the statement repeats the index
-- predicate, and PostgREST's on_conflict only names columns, so every upsert
-- from /api/ingest failed with "no unique or exclusion constraint matching the
-- ON CONFLICT specification".
--
-- The predicate bought nothing: Postgres treats NULLs as distinct in a unique
-- index by default, so rows with no event_key never conflict with each other
-- either way. Dropping it makes the index a valid conflict target and changes
-- no behaviour.

drop index if exists public.events_tenant_event_key_uniq;

create unique index if not exists events_tenant_event_key_uniq
  on public.events (tenant_id, event_key);
