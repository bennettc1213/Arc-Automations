-- An append-only record of what an operator did.
--
-- Today the blast radius of the ops password is read-only plus a handful of
-- tenant edits, so this is good hygiene. That changes the moment the console can
-- provision infrastructure and handle client credentials: an admin surface that
-- creates n8n workflows and mints tokens, with no record of who did what, is a
-- liability rather than a gap. This lands before that, not after it.
--
-- Two rules make the record worth having:
--
--   1. It is written from inside the edge functions, never from the browser. A
--      log the client is trusted to write is a log an attacker can skip. The
--      `ops` function holds the service-role key and already checks
--      is_arc_admin() on every call; the audit write rides in the same place, so
--      an action cannot succeed and go unlogged.
--
--   2. There is no update policy and no delete policy — not for admins, not for
--      anyone. RLS denies by default, so an omitted policy is a closed door.
--      Rows can be read by an admin, inserted by the service role, and after
--      that they are history.

create table if not exists public.admin_actions (
  id           uuid primary key default gen_random_uuid(),

  -- who. nullable on purpose: a future automated caller (the alert poller, a
  -- scheduled job) acts with no human behind it, and a null actor is a more
  -- honest record than borrowing somebody's id.
  actor_user_id uuid references auth.users(id) on delete set null,

  -- what. free text rather than an enum: a check constraint here would mean a
  -- migration every time the console learns a new verb, and the cost of a typo
  -- in a log is lower than the cost of an action that could not be logged.
  -- convention is dotted and past tense: tenant.created, token.minted,
  -- token.revoked, client_id.reissued, connection.updated, alert.raised.
  action        text not null,

  -- what it was done to.
  target_type   text,
  target_id     text,

  -- everything else. never a secret: this table is readable by every admin and
  -- the same rule that governs `connections` governs it — an ingest token's hash
  -- belongs here, the token never does.
  metadata      jsonb not null default '{}'::jsonb,

  occurred_at   timestamptz not null default now()
);

create index if not exists admin_actions_occurred_idx
  on public.admin_actions (occurred_at desc);

create index if not exists admin_actions_target_idx
  on public.admin_actions (target_type, target_id);

alter table public.admin_actions enable row level security;

-- Read: any admin. There is one operator today and this is still the right
-- shape — the point of an audit log is that the people who can act can all see
-- what the others did.
drop policy if exists admin_actions_select_admin on public.admin_actions;
create policy admin_actions_select_admin on public.admin_actions
  for select to authenticated
  using (public.is_arc_admin());

-- No insert policy for `authenticated`, deliberately. The service role bypasses
-- RLS, so the edge function can write; a signed-in browser cannot, so a row in
-- here always came through a code path that checked admin first.
--
-- No update policy. No delete policy. Append-only is enforced by their absence.
