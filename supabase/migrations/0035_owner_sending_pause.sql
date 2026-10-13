-- An owner can pause and resume ARC's texts to their own customers.
--
-- Not the module lifecycle (0015): that is the operator's decision, and its pause stops the
-- module. This is the owner's own switch, beside it. While it is on, ARC sends no text to a
-- customer of this business; calls, forms and replies are still recorded, and the owner is
-- still alerted to each new lead — the alert is a text to staff, which this does not stop.
--
-- A text refused by it is cancelled and its lead handed to the owner, exactly as the
-- emergency stop (0033) and a lapsed subscription (0031) do, so resuming sends nothing that
-- was held: there is nothing held. A text the carrier already accepted is not recalled.
--
-- Requires 0033.

create table public.owner_sending_pauses (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  paused     boolean not null default false,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
alter table public.owner_sending_pauses enable row level security;
create policy owner_sending_pauses_member_read on public.owner_sending_pauses
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());
revoke insert, update, delete on public.owner_sending_pauses from anon, authenticated;

-- The owner's own call. Who they are is their sign-in; a body cannot name another business
-- and be believed. Asking for the state it is already in changes and records nothing.
create function public.self_service_set_sending_pause(p_tenant uuid, p_paused boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_row public.owner_sending_pauses%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_members m
      where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001';
  end if;
  if p_paused is null then
    raise exception 'arc_account:invalid: say whether texts are paused' using errcode = 'P0001';
  end if;
  insert into public.owner_sending_pauses (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  select * into v_row from public.owner_sending_pauses where tenant_id = p_tenant for update;
  if v_row.paused is distinct from p_paused then
    update public.owner_sending_pauses
       set paused = p_paused, changed_by = auth.uid(), changed_at = now()
     where tenant_id = p_tenant returning * into v_row;
    insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
      values (auth.uid(), case when p_paused then 'owner.sending_paused' else 'owner.sending_resumed' end,
        'tenant', p_tenant::text, '{}'::jsonb);
  end if;
  return jsonb_build_object('paused', v_row.paused, 'changed_at', v_row.changed_at);
end $fn$;
revoke all on function public.self_service_set_sending_pause(uuid, boolean) from public, anon;
grant execute on function public.self_service_set_sending_pause(uuid, boolean) to authenticated;

-- 0033's outermost send gate, with the owner's pause added after the emergency stop. A
-- synthetic check is not stopped by either, and only a text to a customer is stopped by this
-- one: the owner still hears about the lead.
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
  return query select r.attempt_id, r.reserved, r.state, r.attempt_no
    from public.reserve_lead_recovery_effect_billing(
      p_tenant, p_effect_key, p_effect_type, p_idempotency, p_worker, p_lease, p_run, p_lead, p_action,
      p_conversation, p_destination, p_is_canary) r;
end $fn$;
revoke all on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.reserve_lead_recovery_effect(uuid,text,text,text,text,uuid,uuid,uuid,uuid,uuid,text,boolean) to service_role;
