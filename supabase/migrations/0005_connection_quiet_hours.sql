-- How long this connection is allowed to say nothing before the console calls
-- it stale.
--
-- The check used to be a flat 48 hours for everybody. That number was chosen for
-- a plumbing contractor whose speed-to-lead can legitimately sleep through a
-- quiet weekend, and for that client it is right — a console that cried "down"
-- every Monday morning is one nobody reads by March.
--
-- It is badly wrong for restoration. That work is 24/7 emergency response; a
-- shop taking four leads a day that goes silent at noon on Tuesday would not be
-- flagged until Thursday, and the jobs lost in between are exactly the ones that
-- pay. Two days of silence is not a quiet spell there, it is an outage.
--
-- So the console derives the threshold from each workflow's own observed cadence
-- (twice its p90 quiet stretch — see connectionLiveness in src/portal/lib/ops.js)
-- and uses this column two ways: as the fallback while there is too little
-- history to describe a cadence, and as the ceiling, so setting it by hand
-- always tightens rather than loosens. Deriving beats declaring, but a human who
-- knows something the log does not should still be able to say so.

alter table public.connections
  add column if not exists expected_quiet_hours integer;

-- 48 keeps the previous behaviour for every row that already exists and for any
-- connection nobody has an opinion about.
alter table public.connections
  alter column expected_quiet_hours set default 48;

update public.connections
  set expected_quiet_hours = 48
  where expected_quiet_hours is null;

-- A sanity range, not a policy. Under an hour is not a monitoring threshold, it
-- is a hair trigger; over a month is not monitoring at all.
alter table public.connections drop constraint if exists connections_quiet_hours_check;
alter table public.connections add constraint connections_quiet_hours_check
  check (expected_quiet_hours is null or (expected_quiet_hours between 1 and 744));
