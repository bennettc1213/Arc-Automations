-- Owner-created accounts and customer proposals. These records never activate a module.
-- Operational configuration remains in the versioned configuration tables (0014).
create table if not exists public.self_service_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_setup_answers (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  business_type text not null default '',
  services text[] not null default '{}',
  service_area text[] not null default '{}',
  working_days text not null default 'Monday-Friday'
    check (working_days in ('Monday-Friday', 'Monday-Saturday', 'Every day')),
  opens_at time not null default '08:00',
  closes_at time not null default '17:00',
  owner_phone text check (owner_phone is null or owner_phone ~ '^\+[1-9][0-9]{7,14}$'),
  handoff text not null default 'inbox' check (handoff in ('inbox', 'inbox_and_text')),
  step smallint not null default 0 check (step between 0 and 5),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  check (opens_at < closes_at),
  check (char_length(business_type) <= 80),
  check (cardinality(services) <= 30 and cardinality(service_area) <= 100)
);

create table if not exists public.customer_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('inbound', 'missed', 'followup')),
  revision integer not null default 1 check (revision > 0),
  config jsonb not null check (jsonb_typeof(config) = 'object' and char_length(config::text) <= 12000
    and public.crm_text_is_clean(config::text)
    and config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id)
);
create index if not exists customer_campaign_drafts_tenant_idx
  on public.customer_campaign_drafts (tenant_id, updated_at desc);

-- Existing businesses can use the same setup editor without creating a second account.
insert into public.tenant_setup_answers (tenant_id)
  select id from public.tenants on conflict (tenant_id) do nothing;

alter table public.self_service_accounts enable row level security;
alter table public.tenant_setup_answers enable row level security;
alter table public.customer_campaign_drafts enable row level security;
create policy self_service_accounts_read on public.self_service_accounts
  for select to authenticated using (user_id = auth.uid());
create policy tenant_setup_answers_read on public.tenant_setup_answers
  for select to authenticated using (public.is_tenant_member(tenant_id));
create policy customer_campaign_drafts_read on public.customer_campaign_drafts
  for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.self_service_accounts, public.tenant_setup_answers,
  public.customer_campaign_drafts from anon, authenticated;

create or replace function public.self_service_create_business(p_name text, p_timezone text)
returns uuid language plpgsql security definer set search_path = public
as $fn$
declare v_user uuid := auth.uid(); v_tenant uuid; v_name text := btrim(p_name); v_zone text := btrim(p_timezone);
begin
  if v_user is null then raise exception 'arc_account:unauthorized: sign in first' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('arc_signup:' || v_user::text, 0));
  select a.tenant_id into v_tenant from public.self_service_accounts a where a.user_id = v_user;
  if v_tenant is not null then return v_tenant; end if;
  if exists (select 1 from public.tenant_members m where m.user_id = v_user) then
    raise exception 'arc_account:already_linked: this login already belongs to a business' using errcode = 'P0001';
  end if;
  if v_name is null or length(v_name) < 2 or length(v_name) > 80 or v_name ~ '[<>]' then
    raise exception 'arc_account:invalid: business name must be 2 to 80 plain characters' using errcode = 'P0001';
  end if;
  if v_zone is null or not exists (select 1 from pg_timezone_names where name = v_zone) then
    raise exception 'arc_account:invalid: choose a valid timezone' using errcode = 'P0001';
  end if;
  v_tenant := gen_random_uuid();
  insert into public.tenants (id, name, slug, timezone, status)
    values (v_tenant, v_name, 'self-' || replace(v_tenant::text, '-', ''), v_zone, 'onboarding');
  insert into public.tenant_members (user_id, tenant_id, role) values (v_user, v_tenant, 'owner');
  insert into public.self_service_accounts (user_id, tenant_id) values (v_user, v_tenant);
  insert into public.tenant_setup_answers (tenant_id) values (v_tenant);
  return v_tenant;
end;
$fn$;

create or replace function public.self_service_save_setup(
  p_tenant uuid, p_expected integer, p_business jsonb, p_step smallint
) returns integer language plpgsql security definer set search_path = public
as $fn$
declare v_revision integer; v_services text[]; v_areas text[];
begin
  if auth.uid() is null or not exists (
    select 1 from public.tenant_members m where m.tenant_id = p_tenant
      and m.user_id = auth.uid() and m.role = 'owner'
  ) then raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001'; end if;
  if p_business is null or jsonb_typeof(p_business) <> 'object'
    or p_business - array['name','timezone','trade','services','area','days','open','close','alerts','ownerPhone'] <> '{}'::jsonb
    or char_length(p_business::text) > 8000 then
    raise exception 'arc_account:invalid: unsupported business settings' using errcode = 'P0001';
  end if;
  if length(btrim(p_business->>'name')) not between 2 and 80
    or not exists (select 1 from pg_timezone_names where name = p_business->>'timezone')
    or length(coalesce(p_business->>'trade','')) > 80
    or p_business->>'days' not in ('Monday-Friday','Monday-Saturday','Every day')
    or p_business->>'alerts' not in ('Inbox only','Inbox and owner text')
    or coalesce(p_business->>'open','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_business->>'close','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or (p_business->>'open')::time >= (p_business->>'close')::time
    or p_step not between 0 and 5 then
    raise exception 'arc_account:invalid: check business name, timezone, hours and preferences' using errcode = 'P0001';
  end if;
  v_services := string_to_array(coalesce(p_business->>'services',''), ',');
  v_areas := string_to_array(coalesce(p_business->>'area',''), ',');
  if cardinality(v_services) > 30 or cardinality(v_areas) > 100
    or length(coalesce(p_business->>'services','')) > 2000
    or length(coalesce(p_business->>'area','')) > 4000 then
    raise exception 'arc_account:invalid: too many services or areas' using errcode = 'P0001';
  end if;
  if nullif(p_business->>'ownerPhone','') is not null
    and (p_business->>'ownerPhone') !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'arc_account:invalid: owner phone must include country code' using errcode = 'P0001';
  end if;
  select s.revision into v_revision from public.tenant_setup_answers s
    where s.tenant_id = p_tenant for update;
  if v_revision is null or p_expected is distinct from v_revision then
    raise exception 'arc_account:stale: reload setup before saving' using errcode = 'P0001';
  end if;
  update public.tenants set name = btrim(p_business->>'name'), timezone = p_business->>'timezone'
    where id = p_tenant;
  update public.tenant_setup_answers set
    business_type = btrim(coalesce(p_business->>'trade','')),
    services = v_services, service_area = v_areas,
    working_days = p_business->>'days', opens_at = (p_business->>'open')::time,
    closes_at = (p_business->>'close')::time,
    owner_phone = nullif(p_business->>'ownerPhone',''),
    handoff = case when p_business->>'alerts' = 'Inbox and owner text' then 'inbox_and_text' else 'inbox' end,
    step = p_step, revision = revision + 1, updated_at = now()
    where tenant_id = p_tenant returning revision into v_revision;
  return v_revision;
end;
$fn$;

create or replace function public.self_service_save_campaign(
  p_tenant uuid, p_id uuid, p_expected integer, p_config jsonb
) returns uuid language plpgsql security definer set search_path = public
as $fn$
declare v_id uuid; v_revision integer; v_kind text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.tenant_members m where m.tenant_id = p_tenant
      and m.user_id = auth.uid() and m.role = 'owner'
  ) then raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object'
    or char_length(p_config::text) > 12000
    or p_config - array['id','tenantId','kind','name','source','channel','version','revision','runtime','createdAt','updatedAt','audience','message','questions','cooldown','delay','followupHours','maxContacts','afterHours','handoff','approval','tone','cta','offer','summary','followup'] <> '{}'::jsonb
    or length(coalesce(p_config->>'name','')) not between 1 and 120
    or length(coalesce(p_config->>'message','')) not between 1 and 1600
    or p_config->>'channel' <> 'sms'
    or coalesce(p_config->>'message','') !~* '\mstop\M'
    or position('{{business}}' in coalesce(p_config->>'message','')) = 0
    or jsonb_typeof(p_config->'questions') <> 'array'
    or jsonb_array_length(p_config->'questions') > 8 then
    raise exception 'arc_account:invalid: campaign draft failed validation' using errcode = 'P0001';
  end if;
  v_kind := p_config->>'kind';
  if v_kind not in ('inbound','missed','followup') then
    raise exception 'arc_account:invalid: unsupported campaign' using errcode = 'P0001';
  end if;
  if (v_kind = 'inbound' and p_config->>'source' <> 'form')
    or (v_kind = 'missed' and p_config->>'source' <> 'phone')
    or (v_kind = 'followup' and p_config->>'source' not in ('existing','form'))
    or p_config->>'audience' not in ('inquiry','incomplete','reactivation')
    or not public.crm_text_is_clean(p_config::text) then
    raise exception 'arc_account:invalid: campaign source, audience or content is unsupported' using errcode = 'P0001';
  end if;
  if coalesce(p_config->>'cooldown','') !~ '^[0-9]{1,3}$'
    or coalesce(p_config->>'delay','') !~ '^[0-9]{1,2}$'
    or coalesce(p_config->>'followupHours','') !~ '^[0-9]{2,4}$'
    or coalesce(p_config->>'maxContacts','') !~ '^[1-3]$' then
    raise exception 'arc_account:invalid: campaign timing and limits are required' using errcode = 'P0001';
  end if;
  if (p_config->>'cooldown')::integer not between 1 and 720
    or (p_config->>'delay')::integer not between 0 and 60
    or (p_config->>'followupHours')::integer not between 24 and 2160 then
    raise exception 'arc_account:invalid: campaign timing is outside supported bounds' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_config->'questions') q
    where jsonb_typeof(q) <> 'object' or q - array['key','text','required'] <> '{}'::jsonb
      or length(coalesce(q->>'text','')) not between 1 and 240
      or q->>'key' not in ('service','location','urgency','timing')
      or jsonb_typeof(q->'required') <> 'boolean') then
    raise exception 'arc_account:invalid: qualification question is unsupported' using errcode = 'P0001';
  end if;
  if p_id is null then
    if coalesce(p_expected,0) <> 0 then raise exception 'arc_account:stale: reload campaigns' using errcode = 'P0001'; end if;
    insert into public.customer_campaign_drafts (tenant_id,kind,config)
      values (p_tenant,v_kind,p_config - array['id','tenantId','runtime','createdAt','updatedAt','revision']) returning id into v_id;
  else
    select d.revision into v_revision from public.customer_campaign_drafts d
      where d.id = p_id and d.tenant_id = p_tenant for update;
    if v_revision is null then raise exception 'arc_account:not_found: campaign not found' using errcode = 'P0001'; end if;
    if v_revision <> p_expected then raise exception 'arc_account:stale: reload campaigns' using errcode = 'P0001'; end if;
    update public.customer_campaign_drafts set kind = v_kind,
      config = p_config - array['id','tenantId','runtime','createdAt','updatedAt','revision'],
      revision = revision + 1, updated_at = now() where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$fn$;

revoke all on function public.self_service_create_business(text,text) from public, anon;
revoke all on function public.self_service_save_setup(uuid,integer,jsonb,smallint) from public, anon;
revoke all on function public.self_service_save_campaign(uuid,uuid,integer,jsonb) from public, anon;
grant execute on function public.self_service_create_business(text,text) to authenticated;
grant execute on function public.self_service_save_setup(uuid,integer,jsonb,smallint) to authenticated;
grant execute on function public.self_service_save_campaign(uuid,uuid,integer,jsonb) to authenticated;
