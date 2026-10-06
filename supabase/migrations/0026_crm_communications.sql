-- ===========================================================================
-- 0026 — the communications hub: conversations, messages and their evidence (ARC-370)
-- ===========================================================================
--
-- ARC-340 (0023) built the customer and lead records, ARC-350 (0024) the doors
-- into them, ARC-360 (0025) the workspace a business works them from. This is the
-- conversation with the customer: what was said, by whom, on which channel, and
-- what ARC knows about whether it arrived.
--
--   crm_conversations         one thread per client, channel and address. Kept by
--                             ADDRESS, like `suppressions` and 0024's consent
--                             records, so merging two contacts moves nothing and a
--                             changed phone number does not rewrite who was texted.
--                             Which customer a thread belongs to is read from the
--                             contacts that hold that address — never stored.
--   crm_messages              one row per message, either direction. An outbound
--                             message a person wrote is queued here together with
--                             its durable action, in one transaction.
--   crm_conversation_events   append-only evidence: queued, sending, sent,
--                             delivered, read, failed, blocked, and who put an
--                             address on the do-not-contact list.
--   crm_snippets              a client's canned replies. Text a person picks,
--                             reads and sends; nothing fills one in for them.
--
-- ---------------------------------------------------------------------------
-- Sending is ARC-200's queue, not a second one
-- ---------------------------------------------------------------------------
--
-- A message a person writes becomes a `crm_message` run and one `send_message`
-- action (0017's vocabulary: an external effect, held while its module is paused,
-- and needing a verified connection). So the lease, the fence, the gate, the
-- attempt rows, the backoff and "an unknown outcome is never resent" are 0017's,
-- unchanged. The run belongs to a module that is cleared to message this client's
-- customers and is pinned to the versions an operator authorised: 0015's guard
-- refuses the run otherwise, and the message is not written.
--
-- What the queue cannot know is decided here, twice: `crm_message_gate` is read
-- when a message is queued and again — under the message's lock — immediately
-- before it is sent (`crm_message_begin_send`). It reads the do-not-contact list,
-- the latest consent evidence, and Lead Recovery's own rows by reference:
--
--   do_not_contact      the address is on `suppressions`.
--   consent_declined    the customer was asked and said no, and has not written since.
--   automation_active   Lead Recovery is still talking to this number. A person
--                       takes the conversation over there first; two voices on one
--                       thread is what takeover exists to prevent.
--   safety_review       Lead Recovery flagged the lead. The sender must have read
--                       the flag — and a flag raised after the message was queued
--                       was not read, so it blocks the send.
--
-- An inbound STOP writes the suppression in the same transaction that records the
-- message, and stops anything still queued on the thread.
--
-- What this is not:
--   * not evidence. Nothing here writes `events`, and no figure reads these tables.
--     A text a person sent from here is not a Lead Recovery outcome.
--   * not a second message store for Lead Recovery. Its `conversations` and
--     `messages` (0010) stay the engine's; the timeline reads them by reference.
--   * not a credential store. A message row names a connection by id. Every text
--     column refuses secret-shaped values; an INBOUND message that looks like one
--     is kept with its body withheld rather than refused, because refusing it
--     would lose the fact that the customer wrote.
--   * not consent. `consent_basis` records what was on file when a person sent;
--     whether an address may be contacted is still `suppressions`, read at the send.
--
-- Who writes: no browser role, on any of it — the 0023 pattern. Every write is one
-- of the functions below, called by the service role after an edge function checked
-- the caller, and each checks the actor again.
--
-- Refusals arrive as `arc_crm:<code>: <message>`, as in 0023.
--
-- Rollback: drop the four tables and the crm_message_* / crm_conversation_* /
--   crm_suppress_address / crm_apply_suppression / crm_address_ok / crm_thread_lock functions,
--   restore automation_runs_kind_check and suppressions_source_check to their
--   0017 / 0010 lists, and re-create purge_test_tenant from 0023.
--
-- Forward-only and additive. Two check constraints are widened in place.

-- ---------------------------------------------------------------------------
-- 0. two vocabularies gain a word each
-- ---------------------------------------------------------------------------

-- a run that is one message a person wrote. the scheduler creates it (0017's
-- guards treat every kind but `lead_conversation` alike).
alter table public.automation_runs drop constraint if exists automation_runs_kind_check;
alter table public.automation_runs add constraint automation_runs_kind_check
  check (run_kind in ('lead_conversation', 'connector_test', 'observation_window', 'crm_message'));

-- a client's own team can put an address on the do-not-contact list. 0010 had no
-- word for them: 'operator' is ARC's staff.
alter table public.suppressions drop constraint if exists suppressions_source_check;
alter table public.suppressions add constraint suppressions_source_check
  check (source is null or source in ('customer', 'operator', 'provider', 'system', 'client_user'));

-- ---------------------------------------------------------------------------
-- 1. helpers
-- ---------------------------------------------------------------------------

-- one spelling per channel, as everywhere else: E.164, and a lowercased address.
create or replace function public.crm_address_ok(p_channel text, p_address text)
returns boolean
language sql
immutable
as $fn$
  select coalesce(case p_channel
    when 'sms' then p_address ~ '^\+[1-9][0-9]{7,15}$'
    when 'email' then p_address = lower(p_address) and p_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' and char_length(p_address) <= 200
    else false
  end, false);
$fn$;

-- ---------------------------------------------------------------------------
-- 2. conversations
-- ---------------------------------------------------------------------------

create table if not exists public.crm_conversations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  channel          text not null check (channel in ('sms', 'email')),
  -- the other end of the thread. never the business's own number.
  address          text not null,
  -- who on the team has this thread. crm_check_owner decides who may be named.
  assigned_user_id uuid,
  last_message_at  timestamptz,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  -- the team's read mark, not each person's: unread means "nobody here has looked
  -- since the customer last wrote".
  last_read_at     timestamptz,
  last_read_by     uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, channel, address),
  unique (id, tenant_id),
  check (public.crm_address_ok(channel, address))
);

create index if not exists crm_conversations_recent_idx on public.crm_conversations (tenant_id, last_message_at desc nulls last);

create or replace function public.crm_conversations_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id or new.channel <> old.channel or new.address <> old.address then
      raise exception 'arc_crm:immutable: a conversation keeps its client, its channel and its address' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  if tg_op = 'INSERT' or new.assigned_user_id is distinct from old.assigned_user_id then
    perform public.crm_check_owner(new.tenant_id, new.assigned_user_id);
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists crm_conversations_guard on public.crm_conversations;
create trigger crm_conversations_guard
  before insert or update on public.crm_conversations
  for each row execute function public.crm_conversations_guard();
drop trigger if exists crm_conversations_immutable_delete on public.crm_conversations;
create trigger crm_conversations_immutable_delete
  before delete on public.crm_conversations
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. messages
-- ---------------------------------------------------------------------------

create table if not exists public.crm_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  conversation_id     uuid not null,
  -- the conversation's own, copied by the guard so a message reads without a join.
  channel             text not null check (channel in ('sms', 'email')),
  address             text not null,
  direction           text not null check (direction in ('inbound', 'outbound')),
  -- manual           a person wrote it in ARC.
  -- automation       an ARC module queued it. nothing does yet; the word is here so
  --                  a person's message can never be mistaken for one.
  -- provider         it arrived through a connected provider.
  -- external_system  the client's own system reported it, either direction.
  origin              text not null check (origin in ('manual', 'automation', 'provider', 'external_system')),
  body                text not null check (char_length(body) between 1 and 5000 and public.crm_text_is_clean(body)),
  -- true when an inbound body looked like a credential and was not kept.
  body_withheld       boolean not null default false,
  -- who it was about when it was recorded. the thread is found by address; these
  -- say which customer and which lead a person (or the arrival) tied it to.
  contact_id          uuid,
  lead_id             uuid,
  author_type         text not null check (author_type in ('operator', 'client_user', 'system', 'external', 'customer')),
  author_id           uuid,
  -- the connector it went or came through, and that side's id for it. together
  -- they are what makes a redelivered webhook one message.
  connector_key       text check (connector_key is null or connector_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  external_id         text check (external_id is null or (char_length(btrim(external_id)) between 1 and 200 and public.crm_text_is_clean(external_id))),
  -- ARC's connection metadata (0016). never a credential.
  connection_id       uuid,
  snippet_key         text check (snippet_key is null or snippet_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  status              text not null check (status in (
    'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked', 'unknown', 'cancelled', 'received'
  )),
  -- why it is blocked, failed or unknown: a code, and a sentence safe to show.
  status_code         text check (status_code is null or status_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  status_detail       text check (status_detail is null or (char_length(status_detail) <= 300 and public.crm_text_is_clean(status_detail))),
  -- what was on file when a person sent it. a record of what they were shown,
  -- not permission: the do-not-contact list is still read at the send.
  consent_basis       text check (consent_basis is null or consent_basis in ('recorded_grant', 'inbound_message', 'none_on_file')),
  -- the safety flags the sender confirmed having read.
  safety_acknowledged text[] not null default '{}',
  -- references only: [{ "kind": "provider_media", "ref": "...", "content_type": "image/jpeg" }].
  -- never a link, never a file. ARC has no approved store for one yet.
  attachments         jsonb not null default '[]'::jsonb check (
    jsonb_typeof(attachments) = 'array'
    and jsonb_array_length(attachments) <= 10
    and attachments::text !~* '(https?:|data:|file:)'
    and public.crm_text_is_clean(attachments::text)
  ),
  -- the durable action that sends it (0017). set once, with the message.
  run_id              uuid,
  action_id           uuid,
  -- the sender's own key: a double click is one message.
  client_key          text check (client_key is null or char_length(client_key) between 8 and 120),
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  unique (id, tenant_id),
  foreign key (conversation_id, tenant_id) references public.crm_conversations (id, tenant_id) on delete cascade,
  foreign key (contact_id, tenant_id) references public.crm_contacts (id, tenant_id),
  foreign key (lead_id, tenant_id) references public.crm_leads (id, tenant_id),
  foreign key (connection_id, tenant_id) references public.provider_connections (id, tenant_id),
  foreign key (run_id, tenant_id) references public.automation_runs (id, tenant_id),
  foreign key (action_id, tenant_id) references public.scheduled_actions (id, tenant_id),
  check (public.crm_address_ok(channel, address)),
  check ((run_id is null) = (action_id is null)),
  check ((direction = 'inbound') = (status = 'received')),
  check ((direction = 'inbound') = (author_type = 'customer'))
);

create unique index if not exists crm_messages_external_uniq
  on public.crm_messages (tenant_id, connector_key, external_id) where external_id is not null;
create unique index if not exists crm_messages_client_key_uniq
  on public.crm_messages (tenant_id, client_key) where client_key is not null;
create index if not exists crm_messages_thread_idx on public.crm_messages (tenant_id, conversation_id, occurred_at desc);
create index if not exists crm_messages_lead_idx on public.crm_messages (tenant_id, lead_id) where lead_id is not null;

-- what a message is never changes; where it has got to moves forward only.
create or replace function public.crm_messages_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_conv public.crm_conversations;
  v_ok   boolean;
begin
  if tg_op = 'INSERT' then
    select * into v_conv from public.crm_conversations c where c.id = new.conversation_id and c.tenant_id = new.tenant_id;
    if not found then
      raise exception 'arc_crm:not_found: that conversation does not exist for this client' using errcode = 'P0001';
    end if;
    new.channel := v_conv.channel;
    new.address := v_conv.address;
    if new.direction = 'inbound' then
      if new.origin not in ('provider', 'external_system') then
        raise exception 'arc_crm:invalid: an inbound message arrives through a provider or the client''s own system' using errcode = 'P0001';
      end if;
    elsif new.origin = 'provider' then
      raise exception 'arc_crm:invalid: a provider reports what arrived, not what ARC sent' using errcode = 'P0001';
    elsif new.origin in ('manual', 'automation') then
      if new.status <> 'queued' then
        raise exception 'arc_crm:invalid: a message ARC sends is queued first' using errcode = 'P0001';
      end if;
      if new.origin = 'manual' then
        if new.author_type not in ('operator', 'client_user') then
          raise exception 'arc_crm:invalid: a message a person wrote names the person' using errcode = 'P0001';
        end if;
        perform public.crm_check_actor(new.tenant_id, new.author_type, new.author_id);
      elsif new.author_type <> 'system' then
        raise exception 'arc_crm:invalid: an automated message is ARC''s, not a person''s' using errcode = 'P0001';
      end if;
    elsif new.status not in ('sent', 'delivered', 'read', 'failed') then
      raise exception 'arc_crm:invalid: a message their system reports has already left it' using errcode = 'P0001';
    end if;
    new.created_at := now();
    return new;
  end if;

  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.conversation_id <> old.conversation_id
     or new.channel <> old.channel or new.address <> old.address
     or new.direction <> old.direction or new.origin <> old.origin
     or new.body <> old.body or new.body_withheld <> old.body_withheld
     or new.contact_id is distinct from old.contact_id or new.lead_id is distinct from old.lead_id
     or new.author_type <> old.author_type or new.author_id is distinct from old.author_id
     or new.connector_key is distinct from old.connector_key or new.connection_id is distinct from old.connection_id
     or new.snippet_key is distinct from old.snippet_key or new.client_key is distinct from old.client_key
     or new.consent_basis is distinct from old.consent_basis or new.safety_acknowledged <> old.safety_acknowledged
     or new.attachments <> old.attachments
     or new.occurred_at <> old.occurred_at or new.created_at <> old.created_at then
    raise exception 'arc_crm:immutable: a message is never rewritten — only where it has got to changes' using errcode = 'P0001';
  end if;
  if old.external_id is not null and new.external_id is distinct from old.external_id then
    raise exception 'arc_crm:immutable: a message keeps the id its provider gave it' using errcode = 'P0001';
  end if;
  if old.run_id is not null and (new.run_id is distinct from old.run_id or new.action_id is distinct from old.action_id) then
    raise exception 'arc_crm:immutable: a message keeps the action that sends it' using errcode = 'P0001';
  end if;
  if new.status <> old.status then
    v_ok := case old.status
      when 'queued'    then new.status in ('sending', 'blocked', 'cancelled')
      -- back to queued: it provably did not leave, and will be tried again.
      when 'sending'   then new.status in ('sent', 'failed', 'unknown', 'queued', 'blocked')
      -- a person reconciled it, or the gate stopped the retry.
      when 'unknown'   then new.status in ('sent', 'queued', 'sending', 'failed', 'blocked')
      when 'sent'      then new.status in ('delivered', 'read', 'failed')
      when 'delivered' then new.status = 'read'
      else false
    end;
    if not v_ok then
      raise exception 'arc_crm:immutable: a % message does not become %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists crm_messages_guard on public.crm_messages;
create trigger crm_messages_guard
  before insert or update on public.crm_messages
  for each row execute function public.crm_messages_guard();
drop trigger if exists crm_messages_immutable_delete on public.crm_messages;
create trigger crm_messages_immutable_delete
  before delete on public.crm_messages
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 4. the evidence
-- ---------------------------------------------------------------------------

create table if not exists public.crm_conversation_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null,
  message_id      uuid,
  kind            text not null check (kind in (
    'received', 'queued', 'sending', 'retry', 'sent', 'delivered', 'read', 'failed',
    'blocked', 'unknown', 'cancelled', 'reconciled', 'do_not_contact', 'assigned'
  )),
  actor_type      text not null check (actor_type in ('operator', 'client_user', 'system', 'external', 'customer', 'provider')),
  actor_id        uuid,
  code            text check (code is null or code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- the provider's own id for the request or the report, when it gave one.
  evidence_ref    text check (evidence_ref is null or (char_length(evidence_ref) <= 200 and public.crm_text_is_clean(evidence_ref))),
  detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and public.crm_text_is_clean(detail::text)),
  occurred_at     timestamptz not null default now(),
  foreign key (conversation_id, tenant_id) references public.crm_conversations (id, tenant_id) on delete cascade,
  foreign key (message_id, tenant_id) references public.crm_messages (id, tenant_id) on delete cascade
);

create index if not exists crm_conversation_events_thread_idx on public.crm_conversation_events (tenant_id, conversation_id, occurred_at desc);
create index if not exists crm_conversation_events_message_idx on public.crm_conversation_events (message_id) where message_id is not null;
-- a provider that reports the same thing twice has reported it once.
create unique index if not exists crm_conversation_events_report_uniq
  on public.crm_conversation_events (message_id, kind, evidence_ref)
  where actor_type = 'provider' and message_id is not null and evidence_ref is not null;

drop trigger if exists crm_conversation_events_immutable on public.crm_conversation_events;
create trigger crm_conversation_events_immutable
  before update on public.crm_conversation_events
  for each row execute function public.crm_history_is_immutable();
drop trigger if exists crm_conversation_events_immutable_delete on public.crm_conversation_events;
create trigger crm_conversation_events_immutable_delete
  before delete on public.crm_conversation_events
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 5. canned replies
-- ---------------------------------------------------------------------------

create table if not exists public.crm_snippets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text not null check (char_length(btrim(name)) between 1 and 120 and public.crm_text_is_clean(name)),
  channel         text not null default 'any' check (channel in ('any', 'sms', 'email')),
  body            text not null check (char_length(btrim(body)) between 1 and 1600 and public.crm_text_is_clean(body)),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by_type text not null check (updated_by_type in ('operator', 'client_user')),
  updated_by      uuid not null,
  unique (tenant_id, key),
  unique (id, tenant_id)
);

create or replace function public.crm_snippets_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.id <> old.id or new.key <> old.key then
      raise exception 'arc_crm:immutable: a canned reply keeps its key' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;
  perform public.crm_check_actor(new.tenant_id, new.updated_by_type, new.updated_by);
  if new.updated_by_type = 'client_user' and not exists (
    select 1 from public.tenant_members m where m.tenant_id = new.tenant_id and m.user_id = new.updated_by and m.role = 'owner'
  ) then
    raise exception 'arc_crm:forbidden: only the account owner can change the canned replies' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists crm_snippets_guard on public.crm_snippets;
create trigger crm_snippets_guard
  before insert or update on public.crm_snippets
  for each row execute function public.crm_snippets_guard();

-- ---------------------------------------------------------------------------
-- 6. the thread for an address
-- ---------------------------------------------------------------------------

create or replace function public.crm_conversation_for(p_tenant uuid, p_channel text, p_address text)
returns uuid
language plpgsql
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  if not public.crm_address_ok(p_channel, p_address) then
    raise exception 'arc_crm:invalid: that is not an address this channel can reach' using errcode = 'P0001';
  end if;
  select c.id into v_id from public.crm_conversations c
   where c.tenant_id = p_tenant and c.channel = p_channel and c.address = p_address;
  if found then return v_id; end if;
  insert into public.crm_conversations (tenant_id, channel, address)
  values (p_tenant, p_channel, p_address)
  on conflict (tenant_id, channel, address) do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.crm_conversations c
     where c.tenant_id = p_tenant and c.channel = p_channel and c.address = p_address;
  end if;
  return v_id;
end;
$fn$;

-- one thread at a time: a send, an arrival and an opt-out for the same address
-- are decided in order, never interleaved.
create or replace function public.crm_thread_lock(p_tenant uuid, p_channel text, p_address text)
returns void
language sql
set search_path = public
as $fn$
  select pg_advisory_xact_lock(hashtextextended('arc_crm_thread:' || p_tenant::text || ':' || p_channel || ':' || p_address, 0));
$fn$;

-- Every function below that changes a message takes its thread's lock BEFORE the
-- message's row lock — the order an arrival takes them in — so a send and a STOP
-- for the same address queue up behind each other instead of deadlocking.
create or replace function public.crm_message_lock(p_tenant uuid, p_message uuid)
returns public.crm_messages
language plpgsql
set search_path = public
as $fn$
declare
  v_msg public.crm_messages;
begin
  select * into v_msg from public.crm_messages m where m.id = p_message and m.tenant_id = p_tenant;
  if not found then return null; end if;
  perform public.crm_thread_lock(p_tenant, v_msg.channel, v_msg.address);
  select * into v_msg from public.crm_messages m where m.id = p_message and m.tenant_id = p_tenant for update;
  return v_msg;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. may this address be written to, right now
-- ---------------------------------------------------------------------------
--
-- No rows means yes. One row is the first reason it may not, most serious first.
-- Read when a message is queued and again immediately before it is sent — the gap
-- between the two is where the STOP arrives.

create or replace function public.crm_message_gate(
  p_tenant uuid, p_channel text, p_address text, p_acknowledged text[] default '{}'
)
returns table (code text, detail text)
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_reason   text;
  v_granted  boolean;
  v_asked_at timestamptz;
  v_inbound  timestamptz;
  v_lead     record;
begin
  select s.reason into v_reason from public.suppressions s
   where s.tenant_id = p_tenant and s.channel = p_channel and s.address = p_address
     and (s.expires_at is null or s.expires_at > now());
  if found then
    return query select 'do_not_contact'::text,
      format('this address is on the do-not-contact list (%s)', replace(v_reason, '_', ' '));
    return;
  end if;

  -- the latest time this person was asked. a "no" stands until they write to the
  -- business themselves, which is them asking to be answered.
  select c.granted, c.captured_at into v_granted, v_asked_at from public.crm_consent_records c
   where c.tenant_id = p_tenant and c.channel = p_channel and c.address = p_address
   order by c.captured_at desc limit 1;
  if found and not v_granted then
    select c.last_inbound_at into v_inbound from public.crm_conversations c
     where c.tenant_id = p_tenant and c.channel = p_channel and c.address = p_address;
    if v_inbound is null or v_inbound <= v_asked_at then
      return query select 'consent_declined'::text,
        'this customer was asked and did not agree to be contacted this way'::text;
      return;
    end if;
  end if;

  if p_channel = 'sms' then
    for v_lead in
      select l.safety_flags, l.status, r.state, r.stopped_at
        from public.leads l
        left join public.automation_runs r
          on r.lead_id = l.id and r.tenant_id = l.tenant_id and r.run_kind = 'lead_conversation'
       where l.tenant_id = p_tenant and l.phone = p_address and not l.is_canary
       order by l.created_at desc
    loop
      if v_lead.state in ('new', 'response_queued', 'awaiting_reply', 'qualifying') and v_lead.stopped_at is null then
        return query select 'automation_active'::text,
          'lead recovery is still handling this conversation — take it over there before writing to this customer'::text;
        return;
      end if;
      if cardinality(v_lead.safety_flags) > 0
         and v_lead.status not in ('closed', 'booked', 'suppressed')
         and not (v_lead.safety_flags <@ coalesce(p_acknowledged, '{}'::text[])) then
        return query select 'safety_review'::text,
          format('this customer''s lead was flagged (%s) — read the flag and confirm before writing',
            replace(array_to_string(v_lead.safety_flags, ', '), '_', ' '));
        return;
      end if;
    end loop;
  end if;
  return;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. the do-not-contact list, from here
-- ---------------------------------------------------------------------------

-- The one write to `suppressions` this migration makes, used by an inbound STOP,
-- a carrier's opt-out report and a person at the screen. It only ever adds: a
-- temporary block becomes permanent, and nothing here lifts one.
create or replace function public.crm_apply_suppression(
  p_tenant uuid, p_conversation uuid, p_reason text, p_source text, p_note text,
  p_actor_type text, p_actor uuid
)
returns boolean
language plpgsql
set search_path = public
as $fn$
declare
  v_conv    public.crm_conversations;
  v_already boolean;
begin
  select * into v_conv from public.crm_conversations c where c.id = p_conversation and c.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_crm:not_found: that conversation does not exist for this client' using errcode = 'P0001';
  end if;
  v_already := exists (
    select 1 from public.suppressions s
     where s.tenant_id = p_tenant and s.channel = v_conv.channel and s.address = v_conv.address and s.expires_at is null
  );
  insert into public.suppressions (tenant_id, channel, address, reason, source, note)
  values (p_tenant, v_conv.channel, v_conv.address, p_reason, p_source, p_note)
  on conflict (tenant_id, channel, address) do update
    set reason = case when suppressions.expires_at is null then suppressions.reason else excluded.reason end,
        source = case when suppressions.expires_at is null then suppressions.source else excluded.source end,
        note = case when suppressions.expires_at is null then suppressions.note else excluded.note end,
        expires_at = null;

  -- anything still waiting to go to this address stops now, not at its send.
  update public.crm_messages m
     set status = 'blocked', status_code = 'do_not_contact', failed_at = now(),
         status_detail = 'the address was put on the do-not-contact list before this was sent'
   where m.tenant_id = p_tenant and m.conversation_id = v_conv.id and m.direction = 'outbound' and m.status = 'queued';

  if not v_already then
    insert into public.crm_conversation_events (tenant_id, conversation_id, kind, actor_type, actor_id, code)
    values (p_tenant, v_conv.id, 'do_not_contact', p_actor_type, p_actor, p_reason);
  end if;
  return not v_already;
end;
$fn$;

-- a person at the screen: "this customer asked us to stop".
create or replace function public.crm_suppress_address(
  p_tenant uuid, p_request jsonb, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_channel text := p_request ->> 'channel';
  v_address text := p_request ->> 'address';
  v_reason  text := coalesce(nullif(p_request ->> 'reason', ''), 'staff_suppressed');
  v_note    text := nullif(btrim(coalesce(p_request ->> 'note', '')), '');
  v_conv    uuid;
  v_added   boolean;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: this is a person''s decision' using errcode = 'P0001';
  end if;
  if v_reason not in ('opt_out', 'wrong_contact', 'staff_suppressed', 'compliance', 'other') then
    raise exception 'arc_crm:invalid: the reason is opt_out, wrong_contact, staff_suppressed, compliance or other' using errcode = 'P0001';
  end if;
  if v_note is not null and (char_length(v_note) > 300 or not public.crm_text_is_clean(v_note)) then
    raise exception 'arc_crm:invalid: the note is at most 300 characters and never a credential' using errcode = 'P0001';
  end if;
  if not public.crm_address_ok(v_channel, v_address) then
    raise exception 'arc_crm:invalid: that is not an address this channel can reach' using errcode = 'P0001';
  end if;
  perform public.crm_thread_lock(p_tenant, v_channel, v_address);
  v_conv := public.crm_conversation_for(p_tenant, v_channel, v_address);
  v_added := public.crm_apply_suppression(p_tenant, v_conv, v_reason,
    case when p_actor_type = 'operator' then 'operator' else 'client_user' end, v_note, p_actor_type, p_actor);
  if v_added then
    perform public.crm_audit(p_actor_type, p_actor, 'crm.do_not_contact.added', 'crm_conversation', v_conv,
      jsonb_build_object('tenant_id', p_tenant, 'channel', v_channel, 'reason', v_reason));
  end if;
  return jsonb_build_object('outcome', case when v_added then 'added' else 'already' end, 'conversation_id', v_conv);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. a message a person wrote, and the action that sends it
-- ---------------------------------------------------------------------------
--
-- `p_message`:
--   { contact_id, lead_id?, channel, body, client_key, snippet_key?, acknowledged_safety: [...],
--     module_key, config_snapshot_id, connection_id, runner_kind? }
-- The last four are the route the caller resolved; 0013, 0015 and 0017 check each
-- of them again on the run and the action, and a refusal there writes nothing.

create or replace function public.crm_queue_message(
  p_tenant uuid, p_message jsonb, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_channel    text := p_message ->> 'channel';
  v_body       text := btrim(coalesce(p_message ->> 'body', ''));
  v_contact_id uuid := nullif(p_message ->> 'contact_id', '')::uuid;
  v_lead_id    uuid := nullif(p_message ->> 'lead_id', '')::uuid;
  v_client_key text := nullif(p_message ->> 'client_key', '');
  v_snippet    text := nullif(p_message ->> 'snippet_key', '');
  v_ack        text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p_message -> 'acknowledged_safety', '[]'::jsonb))), '{}'::text[]);
  v_module     text := p_message ->> 'module_key';
  v_snapshot   uuid := nullif(p_message ->> 'config_snapshot_id', '')::uuid;
  v_connection uuid := nullif(p_message ->> 'connection_id', '')::uuid;
  v_runner     text := nullif(p_message ->> 'runner_kind', '');
  v_contact    public.crm_contacts;
  v_address    text;
  v_connector  text;
  v_conv       uuid;
  v_gate       record;
  v_existing   public.crm_messages;
  v_msg        public.crm_messages;
  v_granted    boolean;
  v_basis      text;
  v_run        uuid;
  v_action     uuid;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: a message from this screen is written by a person' using errcode = 'P0001';
  end if;
  if v_channel is null or v_channel not in ('sms', 'email') then
    raise exception 'arc_crm:invalid: the channel is sms or email' using errcode = 'P0001';
  end if;
  if v_body = '' or char_length(v_body) > 1600 then
    raise exception 'arc_crm:invalid: a message is 1 to 1600 characters' using errcode = 'P0001';
  end if;
  if not public.crm_text_is_clean(v_body) then
    raise exception 'arc_crm:invalid: that looks like it carries a credential — those are never sent from here' using errcode = 'P0001';
  end if;
  if v_client_key is null or char_length(v_client_key) not between 8 and 120 then
    raise exception 'arc_crm:invalid: a message carries its own key, so a double click is one message' using errcode = 'P0001';
  end if;

  select * into v_contact from public.crm_contacts c where c.id = v_contact_id and c.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_crm:not_found: that customer does not exist for this client' using errcode = 'P0001';
  end if;
  if v_contact.archived_at is not null or v_contact.merged_into_id is not null then
    raise exception 'arc_crm:contact_unavailable: that customer is archived or was merged' using errcode = 'P0001';
  end if;
  v_address := case v_channel when 'sms' then v_contact.phone else v_contact.email end;
  if v_address is null then
    raise exception 'arc_crm:no_address: this customer has no % on file',
      case v_channel when 'sms' then 'mobile number' else 'email address' end using errcode = 'P0001';
  end if;
  if v_lead_id is not null and not exists (
    select 1 from public.crm_leads l where l.id = v_lead_id and l.tenant_id = p_tenant and l.contact_id = v_contact_id
  ) then
    raise exception 'arc_crm:not_found: that lead is not this customer''s' using errcode = 'P0001';
  end if;

  perform public.crm_thread_lock(p_tenant, v_channel, v_address);

  select * into v_existing from public.crm_messages m where m.tenant_id = p_tenant and m.client_key = v_client_key;
  if found then
    return jsonb_build_object('outcome', 'replayed', 'message', to_jsonb(v_existing));
  end if;

  select * into v_gate from public.crm_message_gate(p_tenant, v_channel, v_address, v_ack) limit 1;
  if found then
    raise exception 'arc_crm:%: %', v_gate.code, v_gate.detail using errcode = 'P0001';
  end if;

  select c.connector_key into v_connector from public.provider_connections c
   where c.id = v_connection and c.tenant_id = p_tenant;
  if not found then
    raise exception 'arc_crm:no_channel: no provider is connected to send this through' using errcode = 'P0001';
  end if;

  v_conv := public.crm_conversation_for(p_tenant, v_channel, v_address);

  select c.granted into v_granted from public.crm_consent_records c
   where c.tenant_id = p_tenant and c.channel = v_channel and c.address = v_address
   order by c.captured_at desc limit 1;
  v_basis := case
    when v_granted is true then 'recorded_grant'
    when v_channel = 'sms' and exists (
      select 1 from public.leads l where l.tenant_id = p_tenant and l.phone = v_address and l.consent_sms and not l.is_canary
    ) then 'recorded_grant'
    when exists (select 1 from public.crm_conversations c where c.id = v_conv and c.last_inbound_at is not null) then 'inbound_message'
    else 'none_on_file'
  end;

  insert into public.crm_messages (
    tenant_id, conversation_id, channel, address, direction, origin, body, contact_id, lead_id,
    author_type, author_id, connector_key, connection_id, snippet_key, status, consent_basis,
    safety_acknowledged, client_key
  ) values (
    p_tenant, v_conv, v_channel, v_address, 'outbound', 'manual', v_body, v_contact_id, v_lead_id,
    p_actor_type, p_actor, v_connector, v_connection, v_snippet, 'queued', v_basis,
    v_ack, v_client_key
  ) returning * into v_msg;

  -- the run: 0013 pins it, 0015 refuses it unless the module is active on exactly
  -- the versions an operator authorised, 0017 stamps what it started under.
  begin
    insert into public.automation_runs (
      tenant_id, run_kind, module_key, config_snapshot_id, run_mode, correlation_id, idempotency_key,
      runner_kind, created_by_type, created_by, lead_id, started_at
    ) values (
      p_tenant, 'crm_message', v_module, v_snapshot, 'live', v_msg.id, 'crm-message:' || v_msg.id::text,
      v_runner, case when p_actor_type = 'operator' then 'operator' else 'system' end,
      case when p_actor_type = 'operator' then p_actor end, null, null
    ) returning id into v_run;
  exception
    when raise_exception then
      raise exception 'arc_crm:module_not_ready: %', regexp_replace(sqlerrm, '^[a-z_]+:\s*([a-z_]+:\s*)?', '') using errcode = 'P0001';
    when foreign_key_violation or check_violation or not_null_violation then
      raise exception 'arc_crm:module_not_ready: the module that would send this is not set up for this client' using errcode = 'P0001';
  end;

  begin
    select s.action_id into v_action from public.schedule_automation_action(
      p_tenant, v_run, 'send_message', now(), 'send_message:' || v_msg.id::text,
      jsonb_build_object('message_id', v_msg.id), null, v_connection
    ) s;
  exception
    when raise_exception or foreign_key_violation or check_violation then
      raise exception 'arc_crm:no_channel: %', regexp_replace(sqlerrm, '^[a-z_]+:\s*([a-z_]+:\s*)?', '') using errcode = 'P0001';
  end;

  update public.crm_messages set run_id = v_run, action_id = v_action where id = v_msg.id returning * into v_msg;
  update public.crm_conversations set last_message_at = now() where id = v_conv;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, actor_id, detail)
  values (p_tenant, v_conv, v_msg.id, 'queued', p_actor_type, p_actor, jsonb_build_object('consent_basis', v_basis));

  return jsonb_build_object('outcome', 'queued', 'message', to_jsonb(v_msg));
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. the send itself: re-read first, record after
-- ---------------------------------------------------------------------------

-- Called by the worker that holds the action's lease, immediately before anything
-- is asked of a provider. Under the message's lock it reads the gate again; a
-- message that may no longer be sent is marked blocked here and nothing leaves.
create or replace function public.crm_message_begin_send(p_tenant uuid, p_message uuid, p_attempt text default null)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_msg     public.crm_messages;
  v_gate    record;
  v_code    text;
  v_detail  text;
begin
  v_msg := public.crm_message_lock(p_tenant, p_message);
  if v_msg.id is null then
    return jsonb_build_object('proceed', false, 'code', 'message_missing');
  end if;
  if v_msg.direction <> 'outbound' or v_msg.status not in ('queued', 'sending', 'unknown') then
    return jsonb_build_object('proceed', false, 'code', 'already_settled', 'status', v_msg.status);
  end if;

  if exists (
    select 1 from public.crm_contacts c
     where c.id = v_msg.contact_id and c.tenant_id = p_tenant and c.archived_at is not null and c.merged_into_id is null
  ) then
    v_code := 'contact_unavailable';
    v_detail := 'the customer was archived before this was sent';
  else
    select * into v_gate from public.crm_message_gate(p_tenant, v_msg.channel, v_msg.address, v_msg.safety_acknowledged) limit 1;
    if found then
      v_code := v_gate.code;
      v_detail := v_gate.detail;
    end if;
  end if;

  if v_code is not null then
    update public.crm_messages
       set status = 'blocked', status_code = v_code, status_detail = left(v_detail, 300), failed_at = now()
     where id = v_msg.id;
    insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, code)
    values (p_tenant, v_msg.conversation_id, v_msg.id, 'blocked', 'system', v_code);
    return jsonb_build_object('proceed', false, 'code', v_code, 'detail', v_detail);
  end if;

  if v_msg.status <> 'sending' then
    update public.crm_messages set status = 'sending', status_code = null, status_detail = null where id = v_msg.id;
  end if;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, detail)
  values (p_tenant, v_msg.conversation_id, v_msg.id, 'sending', 'system',
    case when p_attempt is null then '{}'::jsonb else jsonb_build_object('attempt', left(p_attempt, 100)) end);
  return jsonb_build_object(
    'proceed', true, 'message_id', v_msg.id, 'channel', v_msg.channel, 'address', v_msg.address,
    'body', v_msg.body, 'connection_id', v_msg.connection_id, 'connector_key', v_msg.connector_key
  );
end;
$fn$;

-- What the provider said, as far as anybody knows:
--   sent     it took the message and gave an id.
--   retry    it provably did not leave. back to queued; the action's backoff decides when.
--   failed   it provably did not leave and will not be tried again.
--   unknown  it may have left. nothing resends it; a person reconciles it.
create or replace function public.crm_message_finish_send(
  p_tenant uuid, p_message uuid, p_outcome text,
  p_external_id text default null, p_code text default null, p_detail text default null
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_msg    public.crm_messages;
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('sent', 'retry', 'failed', 'unknown') then
    raise exception 'arc_crm:invalid: a send ends sent, retry, failed or unknown' using errcode = 'P0001';
  end if;
  v_msg := public.crm_message_lock(p_tenant, p_message);
  if v_msg.id is null then
    raise exception 'arc_crm:not_found: that message does not exist for this client' using errcode = 'P0001';
  end if;
  if v_msg.status <> 'sending' then
    return jsonb_build_object('recorded', false, 'status', v_msg.status);
  end if;
  v_status := case p_outcome when 'retry' then 'queued' else p_outcome end;
  update public.crm_messages
     set status = v_status,
         external_id = case when p_outcome = 'sent' then coalesce(nullif(btrim(coalesce(p_external_id, '')), ''), external_id) else external_id end,
         sent_at = case when p_outcome = 'sent' then now() else sent_at end,
         failed_at = case when p_outcome = 'failed' then now() else failed_at end,
         status_code = case when p_outcome = 'sent' then null else p_code end,
         status_detail = case when p_outcome = 'sent' then null else public.scheduler_safe_text(p_detail, 300) end
   where id = v_msg.id
   returning * into v_msg;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, code, evidence_ref)
  values (p_tenant, v_msg.conversation_id, v_msg.id, case p_outcome when 'retry' then 'retry' else v_status end, 'system',
    case when p_outcome = 'sent' then null else p_code end,
    case when p_outcome = 'sent' then v_msg.external_id end);
  if p_outcome = 'sent' then
    update public.crm_conversations set last_outbound_at = now(), last_message_at = now() where id = v_msg.conversation_id;
  end if;
  return jsonb_build_object('recorded', true, 'status', v_msg.status);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 11. a message that arrived, or that their own system reports
-- ---------------------------------------------------------------------------
--
-- `p_message`:
--   { channel, address, direction?, origin?, connector_key, external_id, body, occurred_at?,
--     opt_out_reason?, attachments? }
-- `address` is the customer's. `opt_out_reason` is the caller's reading of the body
-- by ARC's deterministic rules (`engine/rules.ts`) — never a model's — and an
-- inbound message carrying one writes the suppression here, in this transaction.

create or replace function public.crm_message_arrival(p_tenant uuid, p_message jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_channel     text := p_message ->> 'channel';
  v_address     text := p_message ->> 'address';
  v_direction   text := coalesce(nullif(p_message ->> 'direction', ''), 'inbound');
  v_origin      text := coalesce(nullif(p_message ->> 'origin', ''), 'provider');
  v_connector   text := nullif(p_message ->> 'connector_key', '');
  v_external    text := nullif(btrim(coalesce(p_message ->> 'external_id', '')), '');
  v_body        text := btrim(coalesce(p_message ->> 'body', ''));
  v_occurred    timestamptz := coalesce(nullif(p_message ->> 'occurred_at', '')::timestamptz, now());
  v_opt         text := nullif(p_message ->> 'opt_out_reason', '');
  v_attachments jsonb := coalesce(p_message -> 'attachments', '[]'::jsonb);
  v_inbound     boolean;
  v_withheld    boolean := false;
  v_existing    public.crm_messages;
  v_conv        uuid;
  v_matches     uuid[];
  v_leads       uuid[];
  v_contact     uuid;
  v_lead        uuid;
  v_id          uuid;
  v_suppressed  boolean := false;
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant) then
    raise exception 'arc_crm:not_found: this client does not exist' using errcode = 'P0001';
  end if;
  if v_direction not in ('inbound', 'outbound') or v_origin not in ('provider', 'external_system') then
    raise exception 'arc_crm:invalid: an arrival is inbound or outbound, from a provider or the client''s own system' using errcode = 'P0001';
  end if;
  v_inbound := v_direction = 'inbound';
  if not v_inbound and v_origin <> 'external_system' then
    raise exception 'arc_crm:invalid: only the client''s own system reports a message it sent' using errcode = 'P0001';
  end if;
  if v_connector is null or v_connector !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'arc_crm:invalid: an arrival names the connector it came through' using errcode = 'P0001';
  end if;
  if v_external is null or char_length(v_external) > 200 then
    raise exception 'arc_crm:invalid: an arrival carries that side''s id for the message' using errcode = 'P0001';
  end if;
  if v_opt is not null and v_opt not in ('opt_out', 'wrong_contact') then
    raise exception 'arc_crm:invalid: an opt-out reason is opt_out or wrong_contact' using errcode = 'P0001';
  end if;
  if not public.crm_address_ok(v_channel, v_address) then
    raise exception 'arc_crm:invalid: that is not an address this channel can reach' using errcode = 'P0001';
  end if;

  perform public.crm_thread_lock(p_tenant, v_channel, v_address);

  select * into v_existing from public.crm_messages m
   where m.tenant_id = p_tenant and m.connector_key = v_connector and m.external_id = v_external;
  if found then
    return jsonb_build_object('outcome', 'duplicate', 'message_id', v_existing.id, 'conversation_id', v_existing.conversation_id,
      'contact_id', v_existing.contact_id, 'lead_id', v_existing.lead_id, 'suppressed', false);
  end if;

  if v_body = '' then v_body := '[no text]'; end if;
  if char_length(v_body) > 5000 then v_body := left(v_body, 4990) || ' […]'; end if;
  -- kept, with the body withheld: refusing it would lose the fact that they wrote.
  if not public.crm_text_is_clean(v_body) then
    v_body := '[withheld: this message looked like it carried a credential]';
    v_withheld := true;
  end if;

  v_conv := public.crm_conversation_for(p_tenant, v_channel, v_address);

  -- the one live contact at this address, and that contact's one open lead. two of
  -- either is never guessed at: the message is kept on the thread, tied to neither.
  select array_agg(c.id) into v_matches from public.crm_contacts c
   where c.tenant_id = p_tenant and c.archived_at is null and c.merged_into_id is null
     and (case v_channel when 'sms' then c.phone else c.email end) = v_address;
  if coalesce(cardinality(v_matches), 0) = 1 then
    v_contact := v_matches[1];
    select array_agg(l.id) into v_leads from public.crm_leads l
     where l.tenant_id = p_tenant and l.contact_id = v_contact and l.status = 'open' and l.archived_at is null;
    if coalesce(cardinality(v_leads), 0) = 1 then v_lead := v_leads[1]; end if;
  end if;

  begin
    insert into public.crm_messages (
      tenant_id, conversation_id, channel, address, direction, origin, body, body_withheld, contact_id, lead_id,
      author_type, connector_key, external_id, status, attachments, occurred_at, sent_at
    ) values (
      p_tenant, v_conv, v_channel, v_address, v_direction, v_origin, v_body, v_withheld, v_contact, v_lead,
      case when v_inbound then 'customer' else 'external' end, v_connector, v_external,
      case when v_inbound then 'received' else 'sent' end, v_attachments, v_occurred,
      case when v_inbound then null else v_occurred end
    ) returning id into v_id;
  exception when unique_violation then
    select * into v_existing from public.crm_messages m
     where m.tenant_id = p_tenant and m.connector_key = v_connector and m.external_id = v_external;
    return jsonb_build_object('outcome', 'duplicate', 'message_id', v_existing.id, 'conversation_id', v_existing.conversation_id,
      'contact_id', v_existing.contact_id, 'lead_id', v_existing.lead_id, 'suppressed', false);
  end;

  update public.crm_conversations c
     set last_message_at = greatest(coalesce(c.last_message_at, v_occurred), v_occurred),
         last_inbound_at = case when v_inbound then greatest(coalesce(c.last_inbound_at, v_occurred), v_occurred) else c.last_inbound_at end,
         last_outbound_at = case when v_inbound then c.last_outbound_at else greatest(coalesce(c.last_outbound_at, v_occurred), v_occurred) end
   where c.id = v_conv;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, evidence_ref, occurred_at)
  values (p_tenant, v_conv, v_id, case when v_inbound then 'received' else 'sent' end,
    case when v_inbound then 'customer' else 'external' end, v_external, v_occurred);

  if v_inbound and v_opt is not null then
    perform public.crm_apply_suppression(p_tenant, v_conv, v_opt, 'customer', null, 'customer', null);
    v_suppressed := true;
  end if;

  return jsonb_build_object('outcome', 'recorded', 'message_id', v_id, 'conversation_id', v_conv,
    'contact_id', v_contact, 'lead_id', v_lead, 'suppressed', v_suppressed);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 12. what the provider says happened to something that was sent
-- ---------------------------------------------------------------------------
--
-- `p_report`: { connector_key, external_id, state: delivered|read|failed, event_id?, occurred_at?, code?, opted_out? }
-- Every report is kept. A message only moves forward: a late "delivered" does not
-- undo a "read", and nothing reported here turns a failure into a delivery.

create or replace function public.crm_message_delivery(p_tenant uuid, p_report jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_connector text := nullif(p_report ->> 'connector_key', '');
  v_external  text := nullif(btrim(coalesce(p_report ->> 'external_id', '')), '');
  v_state     text := p_report ->> 'state';
  v_event     text := nullif(btrim(coalesce(p_report ->> 'event_id', '')), '');
  v_occurred  timestamptz := coalesce(nullif(p_report ->> 'occurred_at', '')::timestamptz, now());
  v_code      text := nullif(p_report ->> 'code', '');
  v_opted_out boolean := coalesce((p_report ->> 'opted_out')::boolean, false);
  v_msg       public.crm_messages;
  v_id        uuid;
  v_next      text;
begin
  if v_state is null or v_state not in ('delivered', 'read', 'failed') then
    raise exception 'arc_crm:invalid: a delivery report says delivered, read or failed' using errcode = 'P0001';
  end if;
  if v_connector is null or v_external is null then
    raise exception 'arc_crm:invalid: a delivery report names the connector and the message' using errcode = 'P0001';
  end if;
  select m.id into v_id from public.crm_messages m
   where m.tenant_id = p_tenant and m.connector_key = v_connector and m.external_id = v_external and m.direction = 'outbound';
  if not found then
    return jsonb_build_object('outcome', 'unknown_message');
  end if;
  v_msg := public.crm_message_lock(p_tenant, v_id);

  begin
    insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, code, evidence_ref, occurred_at)
    values (p_tenant, v_msg.conversation_id, v_msg.id, v_state, 'provider', v_code, coalesce(v_event, v_state), v_occurred);
  exception when unique_violation then
    return jsonb_build_object('outcome', 'duplicate', 'message_id', v_msg.id, 'status', v_msg.status);
  end;

  v_next := case
    when v_state = 'delivered' and v_msg.status = 'sent' then 'delivered'
    when v_state = 'read' and v_msg.status in ('sent', 'delivered') then 'read'
    when v_state = 'failed' and v_msg.status = 'sent' then 'failed'
  end;
  if v_next is not null then
    update public.crm_messages
       set status = v_next,
           delivered_at = case when v_next in ('delivered', 'read') then coalesce(delivered_at, v_occurred) else delivered_at end,
           read_at = case when v_next = 'read' then v_occurred else read_at end,
           failed_at = case when v_next = 'failed' then v_occurred else failed_at end,
           status_code = case when v_next = 'failed' then coalesce(v_code, 'delivery_failed') else status_code end,
           status_detail = case when v_next = 'failed' then 'the provider reported that this did not arrive' else status_detail end
     where id = v_msg.id
     returning * into v_msg;
  end if;

  -- a customer can opt out to the carrier without ever writing to the business.
  if v_opted_out then
    perform public.crm_apply_suppression(p_tenant, v_msg.conversation_id, 'opt_out', 'provider', null, 'provider', null);
  end if;
  return jsonb_build_object('outcome', 'recorded', 'message_id', v_msg.id, 'status', v_msg.status);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 13. a person's other decisions about a thread or a message
-- ---------------------------------------------------------------------------

-- `p_change`: { "read": true } and/or { "assigned_user_id": uuid | null }.
create or replace function public.crm_conversation_update(
  p_tenant uuid, p_conversation uuid, p_change jsonb, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_conv   public.crm_conversations;
  v_target uuid;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: this is a person''s decision' using errcode = 'P0001';
  end if;
  select * into v_conv from public.crm_conversations c where c.id = p_conversation and c.tenant_id = p_tenant for update;
  if not found then
    raise exception 'arc_crm:not_found: that conversation does not exist for this client' using errcode = 'P0001';
  end if;

  if coalesce((p_change ->> 'read')::boolean, false) then
    update public.crm_conversations set last_read_at = now(), last_read_by = p_actor where id = v_conv.id;
  end if;

  if p_change ? 'assigned_user_id' then
    v_target := nullif(p_change ->> 'assigned_user_id', '')::uuid;
    -- taking a thread yourself is ordinary work; handing it to somebody else is the owner's call.
    if p_actor_type = 'client_user' and v_target is distinct from p_actor and not exists (
      select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.user_id = p_actor and m.role = 'owner'
    ) then
      raise exception 'arc_crm:forbidden: only the account owner hands a conversation to somebody else' using errcode = 'P0001';
    end if;
    if v_target is distinct from v_conv.assigned_user_id then
      update public.crm_conversations set assigned_user_id = v_target where id = v_conv.id;
      insert into public.crm_conversation_events (tenant_id, conversation_id, kind, actor_type, actor_id, detail)
      values (p_tenant, v_conv.id, 'assigned', p_actor_type, p_actor, jsonb_build_object('from', v_conv.assigned_user_id, 'to', v_target));
    end if;
  end if;

  select * into v_conv from public.crm_conversations c where c.id = p_conversation;
  return to_jsonb(v_conv);
end;
$fn$;

-- a message that has not started sending can be called back.
create or replace function public.crm_message_cancel(p_tenant uuid, p_message uuid, p_actor_type text, p_actor uuid)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_msg public.crm_messages;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: this is a person''s decision' using errcode = 'P0001';
  end if;
  v_msg := public.crm_message_lock(p_tenant, p_message);
  if v_msg.id is null then
    raise exception 'arc_crm:not_found: that message does not exist for this client' using errcode = 'P0001';
  end if;
  if v_msg.status <> 'queued' then
    raise exception 'arc_crm:conflict: only a message that has not started sending can be cancelled — this one is %', v_msg.status using errcode = 'P0001';
  end if;
  update public.crm_messages
     set status = 'cancelled', status_code = 'cancelled_by_person', status_detail = null, failed_at = now()
   where id = v_msg.id returning * into v_msg;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, actor_id)
  values (p_tenant, v_msg.conversation_id, v_msg.id, 'cancelled', p_actor_type, p_actor);
  -- the run goes with it. a worker that already holds the action finds the message
  -- cancelled when it re-reads it, and sends nothing.
  if v_msg.run_id is not null then
    begin
      perform public.finish_automation_run(p_tenant, v_msg.run_id, 'cancelled', 'message_cancelled', 'the message was cancelled before it was sent');
    exception when raise_exception then
      null;
    end;
  end if;
  return to_jsonb(v_msg);
end;
$fn$;

-- An operator settled an unknown outcome (0017's resolve_ambiguous_automation_action,
-- called first by the same request). The message follows the decision.
create or replace function public.crm_message_reconciled(p_tenant uuid, p_message uuid, p_resolution text, p_actor uuid)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_msg public.crm_messages;
begin
  perform public.crm_check_actor(p_tenant, 'operator', p_actor);
  if p_resolution is null or p_resolution not in ('effect_happened', 'effect_absent') then
    raise exception 'arc_crm:invalid: the resolution is effect_happened or effect_absent' using errcode = 'P0001';
  end if;
  v_msg := public.crm_message_lock(p_tenant, p_message);
  if v_msg.id is null then
    raise exception 'arc_crm:not_found: that message does not exist for this client' using errcode = 'P0001';
  end if;
  if v_msg.status not in ('sending', 'unknown') then
    raise exception 'arc_crm:conflict: only a message whose outcome is unknown is reconciled — this one is %', v_msg.status using errcode = 'P0001';
  end if;
  if p_resolution = 'effect_happened' then
    update public.crm_messages
       set status = 'sent', sent_at = now(), status_code = 'confirmed_by_operator',
           status_detail = 'an operator confirmed with the provider that this was sent'
     where id = v_msg.id returning * into v_msg;
    update public.crm_conversations set last_outbound_at = now(), last_message_at = now() where id = v_msg.conversation_id;
  else
    update public.crm_messages set status = 'queued', status_code = null, status_detail = null
     where id = v_msg.id returning * into v_msg;
  end if;
  insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, actor_id, code)
  values (p_tenant, v_msg.conversation_id, v_msg.id, 'reconciled', 'operator', p_actor, p_resolution);
  perform public.crm_audit('operator', p_actor, 'crm.message.reconciled', 'crm_message', v_msg.id,
    jsonb_build_object('tenant_id', p_tenant, 'resolution', p_resolution));
  return to_jsonb(v_msg);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 14. a client with conversations is not a test client
-- ---------------------------------------------------------------------------

-- 0023's purge, with two more things that mean the client did something real.
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
      ('suppressions',                   'opt-outs'),
      ('crm_contacts',                   'customer records'),
      ('crm_leads',                      'CRM leads'),
      ('crm_source_events',              'lead source records'),
      ('crm_conversations',              'customer conversations'),
      ('crm_messages',                   'customer messages')
    ) as c(tbl, label)
  loop
    execute format('select count(*) from public.%I where tenant_id = $1', v_check.tbl) into v_count using p_tenant;
    if v_count > 0 then
      v_activity := v_activity || format('%s %s', v_count, v_check.label);
    end if;
  end loop;
  select count(*) into v_count from public.ingest_tokens k where k.tenant_id = p_tenant and k.last_used_at is not null;
  if v_count > 0 then
    v_activity := v_activity || format('%s ingest tokens that were used', v_count);
  end if;

  if array_length(v_activity, 1) > 0 then
    raise exception 'arc_tenant:tenant_has_activity: % has real activity (%) — deboard it instead; its history is kept',
      v_tenant.slug, array_to_string(v_activity, ', ') using errcode = 'P0001';
  end if;

  insert into public.tenant_purges (tenant_id, actor_user_id, name, slug, client_id, created_at)
  values (v_tenant.id, p_actor, v_tenant.name, v_tenant.slug, v_tenant.client_id, v_tenant.created_at)
  returning * into v_record;
  perform set_config('arc.purging_tenant', p_tenant::text, true);

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

-- ---------------------------------------------------------------------------
-- 15. RLS and grants, as 0023
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['crm_conversations', 'crm_messages', 'crm_conversation_events', 'crm_snippets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin())',
      t || '_read', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

revoke all on function public.crm_address_ok(text, text) from public, anon, authenticated;
revoke all on function public.crm_conversations_guard() from public, anon, authenticated;
revoke all on function public.crm_messages_guard() from public, anon, authenticated;
revoke all on function public.crm_snippets_guard() from public, anon, authenticated;
revoke all on function public.crm_conversation_for(uuid, text, text) from public, anon, authenticated;
revoke all on function public.crm_thread_lock(uuid, text, text) from public, anon, authenticated;
revoke all on function public.crm_message_lock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_message_gate(uuid, text, text, text[]) from public, anon, authenticated;
revoke all on function public.crm_apply_suppression(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_suppress_address(uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_queue_message(uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_message_begin_send(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.crm_message_finish_send(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.crm_message_arrival(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_message_delivery(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.crm_conversation_update(uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_message_cancel(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_message_reconciled(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.purge_test_tenant(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.crm_address_ok(text, text) to service_role;
grant execute on function public.crm_conversation_for(uuid, text, text) to service_role;
grant execute on function public.crm_thread_lock(uuid, text, text) to service_role;
grant execute on function public.crm_message_lock(uuid, uuid) to service_role;
grant execute on function public.crm_message_gate(uuid, text, text, text[]) to service_role;
grant execute on function public.crm_apply_suppression(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.crm_suppress_address(uuid, jsonb, text, uuid) to service_role;
grant execute on function public.crm_queue_message(uuid, jsonb, text, uuid) to service_role;
grant execute on function public.crm_message_begin_send(uuid, uuid, text) to service_role;
grant execute on function public.crm_message_finish_send(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.crm_message_arrival(uuid, jsonb) to service_role;
grant execute on function public.crm_message_delivery(uuid, jsonb) to service_role;
grant execute on function public.crm_conversation_update(uuid, uuid, jsonb, text, uuid) to service_role;
grant execute on function public.crm_message_cancel(uuid, uuid, text, uuid) to service_role;
grant execute on function public.crm_message_reconciled(uuid, uuid, text, uuid) to service_role;
grant execute on function public.purge_test_tenant(uuid, uuid, text) to service_role;
