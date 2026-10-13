-- Self-service businesses require provider-backed access before a live external effect.
-- Legacy operator-managed tenants retain their existing lifecycle contract during migration.
create table public.saas_billing_accounts (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'none'
    check (status in ('none','incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused')),
  period_start timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  action_cap integer not null default 0 check (action_cap between 0 and 100000),
  provider_observed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((period_start is null and period_end is null) or period_start < period_end)
);
create table public.saas_usage_actions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  effect_key text not null,
  period_start timestamptz not null,
  effect_type text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id,effect_key)
);
create index saas_usage_actions_period_idx on public.saas_usage_actions(tenant_id,period_start);
create table public.saas_stripe_events (
  event_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null,
  received_at timestamptz not null default now()
);
create index saas_stripe_events_tenant_idx on public.saas_stripe_events(tenant_id,received_at desc);

insert into public.saas_billing_accounts(tenant_id)
  select tenant_id from public.self_service_accounts on conflict do nothing;
create or replace function public.saas_billing_on_signup() returns trigger
language plpgsql security definer set search_path=public as $fn$
begin
  insert into public.saas_billing_accounts(tenant_id) values(new.tenant_id) on conflict do nothing;
  return new;
end $fn$;
create trigger saas_billing_on_signup after insert on public.self_service_accounts
  for each row execute function public.saas_billing_on_signup();

alter table public.saas_billing_accounts enable row level security;
alter table public.saas_usage_actions enable row level security;
alter table public.saas_stripe_events enable row level security;
create policy saas_billing_owner_read on public.saas_billing_accounts for select to authenticated
  using (exists(select 1 from public.tenant_members m where m.tenant_id=saas_billing_accounts.tenant_id
    and m.user_id=auth.uid() and m.role='owner'));
create policy saas_usage_owner_read on public.saas_usage_actions for select to authenticated
  using (exists(select 1 from public.tenant_members m where m.tenant_id=saas_usage_actions.tenant_id
    and m.user_id=auth.uid() and m.role='owner'));
revoke insert,update,delete on public.saas_billing_accounts,public.saas_usage_actions,public.saas_stripe_events from anon,authenticated;

-- Only a trusted server can bind a customer. A second concurrent Checkout request keeps the
-- original binding and leaves the unused Stripe customer for operator cleanup.
create function public.saas_bind_stripe_customer(p_tenant uuid,p_customer text) returns text
language plpgsql security definer set search_path=public as $fn$
declare v_customer text;
begin
  if p_customer !~ '^cus_[A-Za-z0-9]+$' then raise exception 'arc_billing:invalid_customer' using errcode='P0001'; end if;
  select stripe_customer_id into v_customer from public.saas_billing_accounts
    where tenant_id=p_tenant for update;
  if not found then raise exception 'arc_billing:unknown_tenant' using errcode='P0001'; end if;
  if v_customer is null then
    update public.saas_billing_accounts set stripe_customer_id=p_customer,updated_at=now()
      where tenant_id=p_tenant;
    return p_customer;
  end if;
  return v_customer;
end $fn$;

-- Event insertion and the current provider snapshot commit together. The webhook retrieves
-- current subscription state from Stripe first, so late event delivery cannot roll it back.
create function public.saas_apply_stripe_subscription(
  p_event text,p_type text,p_customer text,p_subscription text,p_price text,p_status text,
  p_start timestamptz,p_end timestamptz,p_cancel boolean,p_cap integer,p_observed timestamptz
) returns boolean language plpgsql security definer set search_path=public as $fn$
declare v_tenant uuid;
begin
  if p_event !~ '^evt_[A-Za-z0-9]+$' or p_type is null or length(p_type)>100
    or p_subscription !~ '^sub_[A-Za-z0-9]+$' or p_price !~ '^price_[A-Za-z0-9]+$'
    or p_status not in ('incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused')
    or p_start is null or p_end is null or p_start >= p_end or p_cap not between 1 and 100000
    or p_observed is null then
    raise exception 'arc_billing:invalid_snapshot' using errcode='P0001';
  end if;
  select tenant_id into v_tenant from public.saas_billing_accounts
    where stripe_customer_id=p_customer for update;
  if v_tenant is null then raise exception 'arc_billing:unknown_customer' using errcode='P0001'; end if;
  insert into public.saas_stripe_events(event_id,tenant_id,event_type)
    values(p_event,v_tenant,p_type) on conflict do nothing;
  if not found then return false; end if;
  update public.saas_billing_accounts set stripe_subscription_id=p_subscription,
    stripe_price_id=p_price,status=p_status,period_start=p_start,period_end=p_end,
    cancel_at_period_end=coalesce(p_cancel,false),action_cap=p_cap,
    provider_observed_at=p_observed,updated_at=now()
    where tenant_id=v_tenant and (provider_observed_at is null or provider_observed_at <= p_observed);
  return true;
end $fn$;

-- Preserve the lifecycle implementation from 0015, then wrap the one transactional
-- reservation point used by all Lead Recovery customer and staff SMS effects.
alter function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean)
  rename to reserve_lead_recovery_effect_lifecycle;
create function public.reserve_lead_recovery_effect(
  p_tenant uuid,p_effect_key text,p_effect_type text,p_idempotency text,p_worker text,p_lease uuid,
  p_run uuid default null,p_lead uuid default null,p_action uuid default null,
  p_conversation uuid default null,p_destination text default null,p_is_canary boolean default false
) returns table(attempt_id uuid,reserved boolean,state text,attempt_no integer)
language plpgsql security definer set search_path=public as $fn$
declare v_account public.saas_billing_accounts%rowtype; v_used integer; v_result record;
begin
  if not p_is_canary and exists(select 1 from public.self_service_accounts where tenant_id=p_tenant) then
    -- Serializes simultaneous sends across workers for this business and billing period.
    select * into v_account from public.saas_billing_accounts where tenant_id=p_tenant for update;
    if not found or v_account.status not in ('active','trialing')
      or v_account.period_start is null or now()<v_account.period_start or now()>=v_account.period_end then
      raise exception 'arc_billing:access_denied: subscription is not active' using errcode='P0001';
    end if;
    select count(*) into v_used from public.saas_usage_actions
      where tenant_id=p_tenant and period_start=v_account.period_start;
    if v_used>=v_account.action_cap and not exists(
      select 1 from public.saas_usage_actions where tenant_id=p_tenant and effect_key=p_effect_key
    ) then raise exception 'arc_billing:usage_cap: action limit reached' using errcode='P0001'; end if;
  end if;
  select * into v_result from public.reserve_lead_recovery_effect_lifecycle(
    p_tenant,p_effect_key,p_effect_type,p_idempotency,p_worker,p_lease,p_run,p_lead,p_action,
    p_conversation,p_destination,p_is_canary);
  if v_result.reserved and not p_is_canary and v_account.tenant_id is not null then
    insert into public.saas_usage_actions(tenant_id,effect_key,period_start,effect_type)
      values(p_tenant,p_effect_key,v_account.period_start,p_effect_type) on conflict do nothing;
  end if;
  return query select v_result.attempt_id::uuid,v_result.reserved::boolean,v_result.state::text,v_result.attempt_no::integer;
end $fn$;

revoke all on function public.saas_bind_stripe_customer(uuid,text) from public,anon,authenticated;
revoke all on function public.saas_apply_stripe_subscription(text,text,text,text,text,text,timestamptz,timestamptz,boolean,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.reserve_lead_recovery_effect_lifecycle(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.saas_bind_stripe_customer(uuid,text) to service_role;
grant execute on function public.saas_apply_stripe_subscription(text,text,text,text,text,text,timestamptz,timestamptz,boolean,integer,timestamptz) to service_role;
grant execute on function public.reserve_lead_recovery_effect_lifecycle(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;
grant execute on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;

-- ARC-370's owner-written messages use a different runner. Gate them in its existing
-- transactional begin-send step, with the same period and one unit per logical message.
alter function public.crm_message_begin_send(uuid,uuid,text) rename to crm_message_begin_send_policy;
create function public.crm_message_begin_send(p_tenant uuid,p_message uuid,p_attempt text default null)
returns jsonb language plpgsql set search_path=public as $fn$
declare v_account public.saas_billing_accounts%rowtype; v_message public.crm_messages%rowtype;
  v_used integer; v_result jsonb; v_code text; v_detail text;
begin
  if exists(select 1 from public.self_service_accounts where tenant_id=p_tenant) then
    select * into v_account from public.saas_billing_accounts where tenant_id=p_tenant for update;
    select * into v_message from public.crm_messages where tenant_id=p_tenant and id=p_message for update;
    if v_message.id is not null and v_message.direction='outbound'
      and v_message.status in ('queued','sending','unknown') then
      if v_account.tenant_id is null or v_account.status not in ('active','trialing')
        or v_account.period_start is null or now()<v_account.period_start or now()>=v_account.period_end then
        v_code := 'subscription_inactive'; v_detail := 'billing access is not active';
      else
        select count(*) into v_used from public.saas_usage_actions
          where tenant_id=p_tenant and period_start=v_account.period_start;
        if v_used>=v_account.action_cap and not exists(select 1 from public.saas_usage_actions
          where tenant_id=p_tenant and effect_key='crm:'||p_message::text) then
          v_code := 'usage_cap'; v_detail := 'message action limit reached';
        end if;
      end if;
      if v_code is not null then
        update public.crm_messages set status='blocked',status_code=v_code,status_detail=v_detail,
          failed_at=now() where id=p_message and tenant_id=p_tenant;
        insert into public.crm_conversation_events(tenant_id,conversation_id,message_id,kind,actor_type,code)
          values(p_tenant,v_message.conversation_id,p_message,'blocked','system',v_code);
        return jsonb_build_object('proceed',false,'code',v_code,'detail',v_detail);
      end if;
    end if;
  end if;
  v_result := public.crm_message_begin_send_policy(p_tenant,p_message,p_attempt);
  if v_result->>'proceed'='true' and v_account.tenant_id is not null then
    insert into public.saas_usage_actions(tenant_id,effect_key,period_start,effect_type)
      values(p_tenant,'crm:'||p_message::text,v_account.period_start,'manual_message')
      on conflict do nothing;
  end if;
  return v_result;
end $fn$;
revoke all on function public.crm_message_begin_send_policy(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.crm_message_begin_send(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.crm_message_begin_send_policy(uuid,uuid,text) to service_role;
grant execute on function public.crm_message_begin_send(uuid,uuid,text) to service_role;
