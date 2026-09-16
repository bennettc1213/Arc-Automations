-- What each connection costs, who pays for it, and when it renews.
--
-- 0003 recorded *that* a client is wired to n8n or Twilio and 0005 taught the
-- console when that wiring has gone quiet. Neither says whether the account
-- behind it is still paid for — and an n8n instance whose card expired stops
-- sending in exactly the way a broken workflow does. The console can now tell
-- the two apart: "stale, and the subscription lapsed on the 3rd" is a different
-- phone call from "stale, and fully paid through March".
--
-- Still no secrets. `credential_hint` is the last four characters of a key, so
-- two keys can be told apart on screen and a rotated one can be spotted; the key
-- itself lives in n8n's credential store or in Supabase function secrets, and
-- `credential_location` says which. A table the browser can read is the wrong
-- place for anything replayable, and the check below makes that a constraint
-- rather than a convention.

alter table public.connections
  -- which service from the console's catalog (src/portal/lib/integrations.js):
  -- n8n, twilio, openai, … `kind` stays as the broad category.
  add column if not exists provider            text,
  -- the account at that provider: login email, Twilio account SID, workspace.
  add column if not exists account_ref         text,
  add column if not exists credential_hint     text,
  add column if not exists credential_location text,
  add column if not exists verified_at         timestamptz,

  add column if not exists billing_status      text not null default 'none',
  add column if not exists paid_by             text,
  add column if not exists cost_cents          integer,
  add column if not exists billing_cycle       text,
  add column if not exists renews_at           date;

alter table public.connections drop constraint if exists connections_billing_status_check;
alter table public.connections add constraint connections_billing_status_check
  check (billing_status in ('none', 'trial', 'active', 'past_due', 'cancelled'));

alter table public.connections drop constraint if exists connections_paid_by_check;
alter table public.connections add constraint connections_paid_by_check
  check (paid_by is null or paid_by in ('arc', 'client'));

alter table public.connections drop constraint if exists connections_billing_cycle_check;
alter table public.connections add constraint connections_billing_cycle_check
  check (billing_cycle is null or billing_cycle in ('monthly', 'annual', 'usage'));

alter table public.connections drop constraint if exists connections_cost_check;
alter table public.connections add constraint connections_cost_check
  check (cost_cents is null or cost_cents >= 0);

-- Four characters is a hint. Anything longer is somebody pasting a key into a
-- field that says not to, and the database refuses it rather than keeping it.
alter table public.connections drop constraint if exists connections_credential_hint_check;
alter table public.connections add constraint connections_credential_hint_check
  check (credential_hint is null or char_length(credential_hint) <= 4);

-- Legacy rows get a provider where their kind names exactly one service.
update public.connections
  set provider = kind
  where provider is null and kind in ('n8n', 'twilio', 'gohighlevel');

create index if not exists connections_renews_idx
  on public.connections (renews_at)
  where renews_at is not null;
