-- Public form capacity is shared by every edge instance. A public form key is a
-- routing identifier, never authentication. This limits the cost of abuse.
create table if not exists public.public_intake_capacity (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  scope text not null check (scope in ('form_hour', 'recipient_day')),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null check (hits between 1 and 30),
  primary key (tenant_id, scope, subject_hash, window_start)
);
create index if not exists public_intake_capacity_expiry_idx
  on public.public_intake_capacity (window_start);
alter table public.public_intake_capacity enable row level security;
revoke all on public.public_intake_capacity from anon, authenticated;

create table if not exists public.public_intake_admissions (
  key_id uuid not null references public.intake_keys(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  submission_id text not null check (length(submission_id) between 1 and 120),
  admitted_at timestamptz not null default now(),
  primary key (key_id, submission_id)
);
create index if not exists public_intake_admissions_expiry_idx
  on public.public_intake_admissions (admitted_at);
alter table public.public_intake_admissions enable row level security;
revoke all on public.public_intake_admissions from anon, authenticated;

alter table public.leads add column if not exists permission_evidence jsonb
  check (permission_evidence is null or (
    jsonb_typeof(permission_evidence) = 'object' and char_length(permission_evidence::text) <= 1000
  ));

create or replace function public.consume_public_intake_capacity(
  p_key uuid, p_recipient text, p_submission text
) returns void language plpgsql set search_path = public
as $fn$
declare v_tenant uuid; v_count integer; v_subject text; v_admitted integer;
begin
  select k.tenant_id into v_tenant from public.intake_keys k
    where k.id = p_key and k.revoked_at is null;
  if v_tenant is null then
    raise exception 'arc_intake:unknown_form: this form is unavailable' using errcode = 'P0001';
  end if;
  if p_submission is null or length(p_submission) not between 1 and 120 then
    raise exception 'arc_intake:invalid: submission identity is required' using errcode = 'P0001';
  end if;
  insert into public.public_intake_admissions (key_id, tenant_id, submission_id)
    values (p_key, v_tenant, p_submission)
    on conflict (key_id, submission_id) do nothing returning 1 into v_admitted;
  if v_admitted is null then return; end if;
  v_subject := encode(digest(p_key::text, 'sha256'), 'hex');
  insert into public.public_intake_capacity (tenant_id, scope, subject_hash, window_start, hits)
    values (v_tenant, 'form_hour', v_subject, date_trunc('hour', now()), 1)
    on conflict (tenant_id, scope, subject_hash, window_start)
    do update set hits = public.public_intake_capacity.hits + 1
      where public.public_intake_capacity.hits < 30
    returning hits into v_count;
  if v_count is null then
    raise exception 'arc_intake:rate_limited: this form reached its hourly limit' using errcode = 'P0001';
  end if;
  if p_recipient is not null then
    v_count := null;
    v_subject := encode(digest(v_tenant::text || ':' || p_recipient, 'sha256'), 'hex');
    insert into public.public_intake_capacity (tenant_id, scope, subject_hash, window_start, hits)
      values (v_tenant, 'recipient_day', v_subject, date_trunc('day', now()), 1)
      on conflict (tenant_id, scope, subject_hash, window_start)
      do update set hits = public.public_intake_capacity.hits + 1
        where public.public_intake_capacity.hits < 3
      returning hits into v_count;
    if v_count is null then
      raise exception 'arc_intake:rate_limited: this contact reached its daily limit' using errcode = 'P0001';
    end if;
  end if;
end;
$fn$;
revoke all on function public.consume_public_intake_capacity(uuid,text,text) from public, anon, authenticated;
grant execute on function public.consume_public_intake_capacity(uuid,text,text) to service_role;
