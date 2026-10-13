-- Four things an owner can now do, and the two queue actions behind them.
--
--   questions        ARC asks the client's own questions one at a time after a reply
--                    (`questions.ask` in the Lead Recovery configuration; the engine's
--                    `ask_question`). An owner may publish which, and their words.
--   an owner's text  after taking a lead over, the owner writes to the customer themselves
--                    (`send_owner_reply`, reserved as `owner_sms`). Queued, never sent by the
--                    door that took it; the dispatcher sends it through the one reservation.
--   handing back     the reverse of a takeover is an engine transition and needs nothing
--                    here: no table mirrors the state machine's map.
--   one campaign     an owner pauses missed-call texts or website-inquiry texts on their
--                    own (`owner_campaign_pauses`), beside 0035's pause of everything.
--
-- What does not change: the reservation is still the one place a text is allowed to leave,
-- and every check 0015, 0031, 0033 and 0035 put there still runs, in the same order.
--
-- Requires 0035.

-- ---------------------------------------------------------------------------
-- 1. the two action types
-- ---------------------------------------------------------------------------

-- Drift-tested against ACTION_TYPES in supabase/functions/_shared/scheduler/model.ts.
insert into public.automation_action_types
  (key, dispatcher, effect_class, paused_policy, connection_requirement,
   default_max_attempts, retry_base_seconds, retry_ceiling_seconds, description)
values
  ('ask_question',     'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: one of the client''s questions, asked after the customer''s reply.'),
  ('send_owner_reply', 'lead_recovery_engine', 'external_effect', 'engine', 'none', 5, 60, 1800,
   'Lead Recovery: a text the owner wrote after taking the lead over.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. a text a person wrote
-- ---------------------------------------------------------------------------

-- Its own effect type, so the reservation can tell it from one of ARC's own: the owner's
-- pauses below are about what ARC sends by itself, and do not stop the owner's own words.
-- The emergency stop, the subscription, the cap and the lifecycle all still apply to it.
alter table public.lead_recovery_effect_attempts
  drop constraint if exists lead_recovery_effect_attempts_effect_type_check;
alter table public.lead_recovery_effect_attempts
  add constraint lead_recovery_effect_attempts_effect_type_check
  check (effect_type in ('customer_sms', 'staff_sms', 'owner_sms'));

-- Who wrote a message, when a person did. Null for a reviewed template and for the customer.
alter table public.messages
  add column if not exists author_user_id uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. pausing one campaign
-- ---------------------------------------------------------------------------

-- A campaign, to the engine, is how the lead arrived: there is one first text for a missed
-- call and one for a website inquiry (0034 keeps at most one campaign of each kind switched
-- on). So a campaign's pause is keyed on its kind. While it is on, ARC sends no text to a
-- customer who arrived that way; the lead is still recorded and the owner is still alerted.
-- Like 0035, a refused text is cancelled and the lead handed to the owner, so resuming
-- sends nothing that was held.
create table public.owner_campaign_pauses (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  kind       text not null check (kind in ('missed', 'inbound')),
  paused     boolean not null default false,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table public.owner_campaign_pauses enable row level security;
create policy owner_campaign_pauses_member_read on public.owner_campaign_pauses
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());
revoke insert, update, delete on public.owner_campaign_pauses from anon, authenticated;

-- The owner's own call, as 0035's is. Asking for the state it is already in changes and
-- records nothing.
create function public.self_service_set_campaign_pause(p_tenant uuid, p_kind text, p_paused boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_row public.owner_campaign_pauses%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_members m
      where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('missed', 'inbound') then
    raise exception 'arc_account:invalid: that kind of campaign cannot be paused' using errcode = 'P0001';
  end if;
  if p_paused is null then
    raise exception 'arc_account:invalid: say whether the campaign is paused' using errcode = 'P0001';
  end if;
  insert into public.owner_campaign_pauses (tenant_id, kind) values (p_tenant, p_kind)
    on conflict (tenant_id, kind) do nothing;
  select * into v_row from public.owner_campaign_pauses
   where tenant_id = p_tenant and kind = p_kind for update;
  if v_row.paused is distinct from p_paused then
    update public.owner_campaign_pauses
       set paused = p_paused, changed_by = auth.uid(), changed_at = now()
     where tenant_id = p_tenant and kind = p_kind returning * into v_row;
    insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
      values (auth.uid(), case when p_paused then 'owner.campaign_paused' else 'owner.campaign_resumed' end,
        'tenant', p_tenant::text, jsonb_build_object('kind', p_kind));
  end if;
  return jsonb_build_object('kind', v_row.kind, 'paused', v_row.paused, 'changed_at', v_row.changed_at);
end $fn$;
revoke all on function public.self_service_set_campaign_pause(uuid, text, boolean) from public, anon;
grant execute on function public.self_service_set_campaign_pause(uuid, text, boolean) to authenticated;

-- 0035's send gate, with the campaign's pause added after the owner's pause of everything.
-- Both stop only `customer_sms` — ARC's own texts to a customer. A staff alert is not
-- stopped (the owner still hears about the lead) and neither is `owner_sms`, a text the
-- owner wrote themselves. A synthetic check is stopped by none of the three.
create or replace function public.reserve_lead_recovery_effect(
  p_tenant uuid, p_effect_key text, p_effect_type text, p_idempotency text, p_worker text, p_lease uuid,
  p_run uuid default null, p_lead uuid default null, p_action uuid default null,
  p_conversation uuid default null, p_destination text default null, p_is_canary boolean default false
) returns table(attempt_id uuid, reserved boolean, state text, attempt_no integer)
language plpgsql security definer set search_path = public as $fn$
begin
  if not p_is_canary and public.platform_sending_stopped() then
    raise exception 'arc_platform:sending_stopped: ARC has stopped all sending' using errcode = 'P0001';
  end if;
  if not p_is_canary and p_effect_type = 'customer_sms' and exists (
    select 1 from public.owner_sending_pauses s where s.tenant_id = p_tenant and s.paused
  ) then
    raise exception 'arc_account:owner_paused: the business has paused its texts' using errcode = 'P0001';
  end if;
  if not p_is_canary and p_effect_type = 'customer_sms' and p_lead is not null and exists (
    select 1
      from public.leads l
      join public.owner_campaign_pauses s
        on s.tenant_id = l.tenant_id and s.paused
       and s.kind = case l.source when 'missed_call' then 'missed' when 'web_form' then 'inbound' end
     where l.id = p_lead and l.tenant_id = p_tenant
  ) then
    raise exception 'arc_account:campaign_paused: the business has paused this campaign' using errcode = 'P0001';
  end if;
  return query select r.attempt_id, r.reserved, r.state, r.attempt_no
    from public.reserve_lead_recovery_effect_billing(
      p_tenant, p_effect_key, p_effect_type, p_idempotency, p_worker, p_lease, p_run, p_lead, p_action,
      p_conversation, p_destination, p_is_canary) r;
end $fn$;
revoke all on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. what an owner may publish, widened by the questions
-- ---------------------------------------------------------------------------

-- 0034's closed list, with which questions are asked (`questions`) and the words of each
-- added. Still wording and nothing else: an owner reaches no number, hour, service area or
-- compliance field through it. Mirrored by OWNER_WORDING_FIELDS / OWNER_WORDING_TEMPLATES in
-- supabase/functions/_shared/config/owner-wording.ts; a test holds the two together.
create or replace function public.config_owner_wording_violation(p_before jsonb, p_after jsonb)
returns text language plpgsql immutable set search_path = public as $fn$
declare
  v_allowed constant text[] := array['first_response', 'first_response_form', 'followup', 'question_service', 'question_location', 'question_urgency', 'question_timing'];
begin
  if p_before is null or p_after is null or jsonb_typeof(p_before) <> 'object' or jsonb_typeof(p_after) <> 'object' then
    return 'not a configuration document';
  end if;
  if (p_after - 'templates' - 'followup' - 'questions') is distinct from (p_before - 'templates' - 'followup' - 'questions') then
    return 'a setting other than wording';
  end if;
  if (coalesce(p_after -> 'templates', '{}'::jsonb) - v_allowed)
     is distinct from (coalesce(p_before -> 'templates', '{}'::jsonb) - v_allowed) then
    return 'a template an owner may not change';
  end if;
  return null;
end $fn$;
