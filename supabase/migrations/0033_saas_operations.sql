-- ARC SaaS foundation: the two things an operator and an owner still could not see or do.
--
--   1. One switch that stops every real send, for every business, at the two places a send
--      is reserved. Ingestion is untouched: calls, forms and replies are still recorded. A
--      synthetic (canary) send is not stopped, so the path can still be tested while it is on.
--   2. A business's readiness, read off the rows that decide it. Nothing here is ticked by a
--      person and nothing is stored: an account existing is not proof a text can be sent.
--
-- Requires 0031 (the billing gate this wraps) and 0032.

-- ── 1. the emergency stop ────────────────────────────────────────────────────────────────

create table public.platform_controls (
  id              boolean primary key default true check (id),
  sending_stopped boolean not null default false,
  reason          text check (reason is null or char_length(reason) between 3 and 300),
  changed_by      uuid references auth.users(id) on delete set null,
  changed_at      timestamptz not null default now(),
  -- a stop always says why; "resumed" may too
  check (not sending_stopped or reason is not null)
);
insert into public.platform_controls default values;

alter table public.platform_controls enable row level security;
create policy platform_controls_operator_read on public.platform_controls
  for select to authenticated using (public.is_arc_admin());
revoke insert, update, delete on public.platform_controls from anon, authenticated;

-- Read by the send gates below and by the readiness function. Definer rights so the gate
-- does not depend on the caller being able to read the table.
create function public.platform_sending_stopped() returns boolean
language sql stable security definer set search_path = public as $fn$
  select coalesce((select sending_stopped from public.platform_controls where id), false);
$fn$;

-- The actor is the operator the `ops` function verified; it is checked again here. Turning
-- it off resumes nothing by itself: every send that was refused was cancelled and handed to
-- a person, so there is no queue to flush.
create function public.set_platform_sending_stop(p_actor uuid, p_stopped boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_row public.platform_controls%rowtype;
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_platform:forbidden: stopping or resuming sending is an operator action' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_platform:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;
  if p_stopped is null then
    raise exception 'arc_platform:invalid: say whether sending is stopped' using errcode = 'P0001';
  end if;
  if p_stopped and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'arc_platform:invalid: say why sending is being stopped' using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 300 then
    raise exception 'arc_platform:invalid: the reason is too long' using errcode = 'P0001';
  end if;

  select * into v_row from public.platform_controls where id for update;
  if v_row.sending_stopped is distinct from p_stopped then
    update public.platform_controls
       set sending_stopped = p_stopped, reason = v_reason, changed_by = p_actor, changed_at = now()
     where id returning * into v_row;
    insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
      values (p_actor, case when p_stopped then 'platform.sending_stopped' else 'platform.sending_resumed' end,
        'platform', 'sending', jsonb_build_object('reason', v_reason));
  end if;
  return jsonb_build_object('sending_stopped', v_row.sending_stopped, 'reason', v_row.reason,
    'changed_at', v_row.changed_at, 'changed_by', v_row.changed_by);
end $fn$;

revoke all on function public.platform_sending_stopped() from public, anon, authenticated;
revoke all on function public.set_platform_sending_stop(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.platform_sending_stopped() to service_role;
grant execute on function public.set_platform_sending_stop(uuid, boolean, text) to service_role;

-- The one reservation point for every Lead Recovery customer and staff text. 0015's lifecycle
-- check and 0031's billing check stay exactly as they are, one layer down.
alter function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean)
  rename to reserve_lead_recovery_effect_billing;
create function public.reserve_lead_recovery_effect(
  p_tenant uuid, p_effect_key text, p_effect_type text, p_idempotency text, p_worker text, p_lease uuid,
  p_run uuid default null, p_lead uuid default null, p_action uuid default null,
  p_conversation uuid default null, p_destination text default null, p_is_canary boolean default false
) returns table(attempt_id uuid, reserved boolean, state text, attempt_no integer)
language plpgsql security definer set search_path = public as $fn$
begin
  if not p_is_canary and public.platform_sending_stopped() then
    raise exception 'arc_platform:sending_stopped: ARC has stopped all sending' using errcode = 'P0001';
  end if;
  return query select r.attempt_id, r.reserved, r.state, r.attempt_no
    from public.reserve_lead_recovery_effect_billing(
      p_tenant, p_effect_key, p_effect_type, p_idempotency, p_worker, p_lease, p_run, p_lead, p_action,
      p_conversation, p_destination, p_is_canary) r;
end $fn$;
revoke all on function public.reserve_lead_recovery_effect_billing(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public, anon, authenticated;
revoke all on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.reserve_lead_recovery_effect_billing(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;
grant execute on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;

-- A message a person wrote (ARC-370) is stopped at its own begin-send step, the same way a
-- lapsed subscription is: marked blocked with the reason, never left to look pending.
alter function public.crm_message_begin_send(uuid,uuid,text) rename to crm_message_begin_send_billing;
create function public.crm_message_begin_send(p_tenant uuid, p_message uuid, p_attempt text default null)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_message public.crm_messages%rowtype;
begin
  if public.platform_sending_stopped() then
    select * into v_message from public.crm_messages where tenant_id = p_tenant and id = p_message for update;
    if v_message.id is not null and v_message.direction = 'outbound'
      and v_message.status in ('queued', 'sending', 'unknown') then
      update public.crm_messages set status = 'blocked', status_code = 'sending_stopped',
        status_detail = 'ARC has stopped all sending', failed_at = now()
        where id = p_message and tenant_id = p_tenant;
      insert into public.crm_conversation_events (tenant_id, conversation_id, message_id, kind, actor_type, code)
        values (p_tenant, v_message.conversation_id, p_message, 'blocked', 'system', 'sending_stopped');
      return jsonb_build_object('proceed', false, 'code', 'sending_stopped', 'detail', 'ARC has stopped all sending');
    end if;
  end if;
  return public.crm_message_begin_send_billing(p_tenant, p_message, p_attempt);
end $fn$;
revoke all on function public.crm_message_begin_send_billing(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.crm_message_begin_send(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.crm_message_begin_send_billing(uuid,uuid,text) to service_role;
grant execute on function public.crm_message_begin_send(uuid,uuid,text) to service_role;

-- ── 2. readiness, derived ────────────────────────────────────────────────────────────────

-- Seven separate answers, each a boolean and a closed code the portal words. An owner reads
-- their own; an operator reads anyone's. Nothing is written.
create function public.self_service_readiness(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_setup public.tenant_setup_answers%rowtype;
  v_module public.tenant_modules%rowtype;
  v_billing public.saas_billing_accounts%rowtype;
  v_key public.intake_keys%rowtype;
  v_self boolean; v_drafts integer; v_sender_steps integer; v_routing_steps integer; v_stopped boolean; v_used integer;
  v_configuration jsonb; v_source jsonb; v_sender jsonb; v_routing jsonb; v_test jsonb; v_subscription jsonb; v_active jsonb;
begin
  if auth.uid() is null or not (public.is_arc_admin() or exists (
    select 1 from public.tenant_members m
     where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.role = 'owner')) then
    raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001';
  end if;

  select * into v_setup from public.tenant_setup_answers where tenant_id = p_tenant;
  select count(*) into v_drafts from public.customer_campaign_drafts where tenant_id = p_tenant;
  v_configuration := case
    when v_setup.tenant_id is null or btrim(v_setup.business_type) = ''
      or cardinality(v_setup.services) = 0 or cardinality(v_setup.service_area) = 0
      then jsonb_build_object('ok', false, 'code', 'business_details_missing')
    when v_drafts = 0 then jsonb_build_object('ok', false, 'code', 'no_campaign')
    else jsonb_build_object('ok', true, 'code', 'complete') end;

  select * into v_key from public.intake_keys
    where tenant_id = p_tenant and revoked_at is null order by created_at desc limit 1;
  v_source := case
    when v_key.id is null then jsonb_build_object('ok', false, 'code', 'no_form')
    when v_key.last_used_at is null then jsonb_build_object('ok', false, 'code', 'awaiting_first_inquiry')
    else jsonb_build_object('ok', true, 'code', 'verified') end;

  select * into v_module from public.tenant_modules where tenant_id = p_tenant and module_key = 'lead_recovery';
  select count(*) into v_sender_steps from public.module_onboarding
    where tenant_id = p_tenant and module_key = 'lead_recovery' and done_at is not null
      and step_key in ('twilio_connected', 'compliance_approved');
  v_sender := case
    when v_module.id is null or v_module.state = 'unselected' then jsonb_build_object('ok', false, 'code', 'not_started')
    when v_sender_steps < 2 then jsonb_build_object('ok', false, 'code', 'pending_review')
    else jsonb_build_object('ok', true, 'code', 'ready') end;

  -- the phone side: somebody answered a test call on the forwarding number, and a dry run of
  -- the voice webhook answered correctly. both are the operator's attested checklist steps.
  select count(*) into v_routing_steps from public.module_onboarding
    where tenant_id = p_tenant and module_key = 'lead_recovery' and done_at is not null
      and step_key in ('staff_destination_verified', 'routing_tested');
  v_routing := case
    when v_module.id is null or v_module.state = 'unselected' then jsonb_build_object('ok', false, 'code', 'not_started')
    when v_routing_steps < 2 then jsonb_build_object('ok', false, 'code', 'not_tested')
    else jsonb_build_object('ok', true, 'code', 'tested') end;

  v_test := case
    when v_module.id is null or v_module.test_evidence_id is null then jsonb_build_object('ok', false, 'code', 'not_run')
    when 'retest' = any (v_module.pending_requirements)
      or v_module.tested_module_config_version_id is distinct from v_module.observed_module_config_version_id
      or v_module.tested_tenant_config_version_id is distinct from v_module.observed_tenant_config_version_id
      then jsonb_build_object('ok', false, 'code', 'retest_required')
    else jsonb_build_object('ok', true, 'code', 'passed') end;

  v_self := exists (select 1 from public.self_service_accounts where tenant_id = p_tenant);
  select * into v_billing from public.saas_billing_accounts where tenant_id = p_tenant;
  if v_billing.tenant_id is not null and v_billing.period_start is not null then
    select count(*) into v_used from public.saas_usage_actions
      where tenant_id = p_tenant and period_start = v_billing.period_start;
  end if;
  v_subscription := case
    -- an operator-managed client is not gated on a subscription (0031)
    when not v_self then jsonb_build_object('ok', true, 'code', 'not_required')
    when v_billing.tenant_id is null or v_billing.status = 'none' then jsonb_build_object('ok', false, 'code', 'none')
    when v_billing.status not in ('active', 'trialing') then jsonb_build_object('ok', false, 'code', v_billing.status)
    when v_billing.period_end is null or now() >= v_billing.period_end then jsonb_build_object('ok', false, 'code', 'period_ended')
    when coalesce(v_used, 0) >= v_billing.action_cap then jsonb_build_object('ok', false, 'code', 'usage_cap')
    else jsonb_build_object('ok', true, 'code', 'eligible') end;

  v_stopped := public.platform_sending_stopped();
  v_active := case
    when v_stopped then jsonb_build_object('ok', false, 'code', 'sending_stopped')
    when v_module.id is null or v_module.state not in ('active', 'paused') then jsonb_build_object('ok', false, 'code', 'not_active')
    when v_module.state = 'paused' then jsonb_build_object('ok', false, 'code', 'paused')
    when cardinality(v_module.pending_requirements) > 0 then jsonb_build_object('ok', false, 'code', 'held_for_review')
    else jsonb_build_object('ok', true, 'code', 'active') end;

  return jsonb_build_object(
    'configuration', v_configuration, 'source', v_source, 'sender', v_sender,
    'routing', v_routing, 'test', v_test, 'subscription', v_subscription, 'active', v_active,
    'usage', case when v_billing.tenant_id is null or v_billing.period_start is null then null
      else jsonb_build_object('used', coalesce(v_used, 0), 'cap', v_billing.action_cap) end);
end $fn$;
revoke all on function public.self_service_readiness(uuid) from public, anon;
grant execute on function public.self_service_readiness(uuid) to authenticated;
