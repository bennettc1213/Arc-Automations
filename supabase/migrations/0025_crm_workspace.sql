-- ===========================================================================
-- 0025 — the CRM workspace: stages a client can shape, and what each one waits on (ARC-360)
-- ===========================================================================
--
-- ARC-340 (0023) built the records and ARC-350 (0024) the doors into them. This is
-- what the day-to-day workspace needs that neither held:
--
--   * what a lead in a stage is waiting on. "waiting on the customer" (a quote is
--     out, a reply is owed) is a different queue from "waiting on us", and the
--     only honest place to say which is the stage itself — never guessed from a
--     stage's name. `crm_pipeline_stages.waits_on`.
--   * a pipeline a client can shape inside a constrained model: rename, reorder,
--     add, retire. A stage's key and kind never change once it exists (a lead's
--     status is its stage's kind, so changing a kind would close or reopen leads
--     that nobody moved), and a stage with open leads cannot be retired out from
--     under them. One function, `crm_save_stages`, in one transaction, and every
--     save is kept whole in `crm_pipeline_revisions` — whoever made it.
--
-- What this is not: evidence. Nothing here is counted on any page, and moving a
-- lead to a `won` stage is a CRM state, not a verified outcome (that is still the
-- `events` log). No browser role writes anything here, as in 0023.
--
-- Refusals arrive as `arc_crm:<code>: <message>`, as in 0023.
--
-- Rollback: drop crm_save_stages, crm_pipeline_revisions, the stage guard and the
--   `waits_on` column, and re-create crm_ensure_default_pipeline / crm_create_pipeline
--   from 0023.
--
-- Forward-only and additive.

-- ---------------------------------------------------------------------------
-- 1. what a stage waits on
-- ---------------------------------------------------------------------------

alter table public.crm_pipeline_stages
  add column if not exists waits_on text not null default 'us'
    check (waits_on in ('us', 'customer'));

-- the default pipeline's own stage that means "the quote is with them". only that
-- stage, only on the default pipeline 0023 made, and only while it still says 'us'.
update public.crm_pipeline_stages s
   set waits_on = 'customer'
  from public.crm_pipelines p
 where p.id = s.pipeline_id
   and p.key = 'sales'
   and s.key = 'estimate_sent'
   and s.waits_on = 'us';

-- ---------------------------------------------------------------------------
-- 2. a stage keeps its identity
-- ---------------------------------------------------------------------------

create or replace function public.crm_pipeline_stages_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.pipeline_id <> old.pipeline_id or new.id <> old.id then
      raise exception 'arc_crm:immutable: a stage never moves to another pipeline' using errcode = 'P0001';
    end if;
    if new.key <> old.key then
      raise exception 'arc_crm:immutable: a stage keeps its key — rename it instead' using errcode = 'P0001';
    end if;
    -- a lead's status is its stage's kind. changing a kind would close or reopen
    -- every lead in it without anybody moving one.
    if new.kind <> old.kind then
      raise exception 'arc_crm:immutable: a stage keeps its kind — add a new stage and move the leads' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    if new.archived_at is not null and old.archived_at is null then
      if exists (
        select 1 from public.crm_leads l
         where l.stage_id = new.id and l.archived_at is null and l.status = 'open'
      ) then
        raise exception 'arc_crm:conflict: the stage "%" still has open leads — move them first', new.name using errcode = 'P0001';
      end if;
    end if;
  end if;
  if new.kind <> 'open' then
    -- a closed lead is not waiting on anybody.
    new.waits_on := 'us';
  end if;
  return new;
end;
$fn$;

drop trigger if exists crm_pipeline_stages_guard on public.crm_pipeline_stages;
create trigger crm_pipeline_stages_guard
  before insert or update on public.crm_pipeline_stages
  for each row execute function public.crm_pipeline_stages_guard();

-- ---------------------------------------------------------------------------
-- 3. every save of a pipeline's stages, kept whole
-- ---------------------------------------------------------------------------

create table if not exists public.crm_pipeline_revisions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  pipeline_id uuid not null,
  actor_type  text not null check (actor_type in ('operator', 'client_user')),
  actor_id    uuid not null,
  -- the stages as they stood after the save, in order: id, key, name, kind,
  -- waits_on, marks_qualified, retired.
  stages      jsonb not null check (jsonb_typeof(stages) = 'array'),
  created_at  timestamptz not null default now(),
  foreign key (pipeline_id, tenant_id) references public.crm_pipelines (id, tenant_id) on delete cascade
);

create index if not exists crm_pipeline_revisions_idx on public.crm_pipeline_revisions (tenant_id, pipeline_id, created_at desc);

drop trigger if exists crm_pipeline_revisions_immutable on public.crm_pipeline_revisions;
create trigger crm_pipeline_revisions_immutable
  before update on public.crm_pipeline_revisions
  for each row execute function public.crm_history_is_immutable();
drop trigger if exists crm_pipeline_revisions_immutable_delete on public.crm_pipeline_revisions;
create trigger crm_pipeline_revisions_immutable_delete
  before delete on public.crm_pipeline_revisions
  for each row when (not public.tenant_purge_in_progress(old.tenant_id))
  execute function public.crm_history_is_immutable();

-- ---------------------------------------------------------------------------
-- 4. saving a pipeline's stages
-- ---------------------------------------------------------------------------
--
-- `p_stages` is the whole ordered list, as the screen shows it:
--   [{ "id"?, "key", "name", "kind"?, "waits_on"?, "marks_qualified"?, "retired"? }]
-- A stage with an id is that stage (renamed, moved, retired or brought back); one
-- without is new. Every existing stage must be in the list — a stage is retired,
-- never dropped by being left out. At least one open stage stays live.

create or replace function public.crm_save_stages(
  p_tenant uuid, p_pipeline uuid, p_stages jsonb, p_actor_type text, p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_stage    jsonb;
  v_position integer := 0;
  v_current  public.crm_pipeline_stages;
  v_seen     uuid[] := '{}';
  v_after    jsonb;
begin
  perform public.crm_check_actor(p_tenant, p_actor_type, p_actor);
  if p_actor_type = 'client_user' and not exists (
    select 1 from public.tenant_members m where m.tenant_id = p_tenant and m.user_id = p_actor and m.role = 'owner'
  ) then
    raise exception 'arc_crm:forbidden: only the account owner can change the pipeline' using errcode = 'P0001';
  end if;
  if p_actor_type not in ('operator', 'client_user') then
    raise exception 'arc_crm:forbidden: a pipeline is changed by a person' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.crm_pipelines p where p.id = p_pipeline and p.tenant_id = p_tenant and p.archived_at is null) then
    raise exception 'arc_crm:not_found: that pipeline does not exist for this client' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_stages) is distinct from 'array' or jsonb_array_length(p_stages) = 0 or jsonb_array_length(p_stages) > 20 then
    raise exception 'arc_crm:invalid: a pipeline has 1 to 20 stages' using errcode = 'P0001';
  end if;

  -- lock the pipeline's stages so two saves cannot interleave.
  perform 1 from public.crm_pipeline_stages s where s.pipeline_id = p_pipeline order by s.id for update;

  for v_stage in select * from jsonb_array_elements(p_stages) loop
    v_position := v_position + 10;
    if coalesce(v_stage ->> 'id', '') <> '' then
      select * into v_current from public.crm_pipeline_stages s
       where s.id = (v_stage ->> 'id')::uuid and s.pipeline_id = p_pipeline and s.tenant_id = p_tenant;
      if not found then
        raise exception 'arc_crm:not_found: a stage in the list is not part of this pipeline' using errcode = 'P0001';
      end if;
      if (v_stage ->> 'id')::uuid = any (v_seen) then
        raise exception 'arc_crm:invalid: a stage is listed twice' using errcode = 'P0001';
      end if;
      v_seen := v_seen || v_current.id;
      update public.crm_pipeline_stages set
        name = coalesce(v_stage ->> 'name', name),
        position = v_position,
        waits_on = coalesce(v_stage ->> 'waits_on', waits_on),
        marks_qualified = coalesce((v_stage ->> 'marks_qualified')::boolean, marks_qualified),
        archived_at = case
          when coalesce((v_stage ->> 'retired')::boolean, false) then coalesce(archived_at, now())
          else null
        end
       where id = v_current.id;
    else
      begin
        insert into public.crm_pipeline_stages (tenant_id, pipeline_id, key, name, position, kind, waits_on, marks_qualified)
        values (p_tenant, p_pipeline, v_stage ->> 'key', v_stage ->> 'name', v_position,
          coalesce(v_stage ->> 'kind', 'open'), coalesce(v_stage ->> 'waits_on', 'us'),
          coalesce((v_stage ->> 'marks_qualified')::boolean, false))
        returning id into v_current.id;
      exception when unique_violation then
        raise exception 'arc_crm:key_taken: two stages of one pipeline cannot share the key %', v_stage ->> 'key' using errcode = 'P0001';
      end;
      v_seen := v_seen || v_current.id;
    end if;
  end loop;

  if exists (select 1 from public.crm_pipeline_stages s where s.pipeline_id = p_pipeline and s.id <> all (v_seen)) then
    raise exception 'arc_crm:invalid: every stage is in the list — retire a stage instead of leaving it out' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.crm_pipeline_stages s where s.pipeline_id = p_pipeline and s.kind = 'open' and s.archived_at is null) then
    raise exception 'arc_crm:invalid: a pipeline needs at least one open stage' using errcode = 'P0001';
  end if;

  select jsonb_agg(jsonb_build_object(
           'id', s.id, 'key', s.key, 'name', s.name, 'kind', s.kind, 'waits_on', s.waits_on,
           'marks_qualified', s.marks_qualified, 'retired', s.archived_at is not null
         ) order by s.position, s.key)
    into v_after
    from public.crm_pipeline_stages s where s.pipeline_id = p_pipeline;

  insert into public.crm_pipeline_revisions (tenant_id, pipeline_id, actor_type, actor_id, stages)
  values (p_tenant, p_pipeline, p_actor_type, p_actor, v_after);
  perform public.crm_audit(p_actor_type, p_actor, 'crm.pipeline.stages_saved', 'crm_pipeline', p_pipeline,
    jsonb_build_object('tenant_id', p_tenant, 'stages', jsonb_array_length(v_after)));

  return jsonb_build_object(
    'pipeline', (select to_jsonb(p) from public.crm_pipelines p where p.id = p_pipeline),
    'stages', (select jsonb_agg(to_jsonb(s) order by s.position, s.key) from public.crm_pipeline_stages s where s.pipeline_id = p_pipeline)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. the two pipeline makers learn `waits_on`
-- ---------------------------------------------------------------------------

create or replace function public.crm_ensure_default_pipeline(p_tenant uuid)
returns uuid
language plpgsql
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  select p.id into v_id from public.crm_pipelines p
   where p.tenant_id = p_tenant and p.is_default and p.archived_at is null;
  if found then return v_id; end if;

  insert into public.crm_pipelines (tenant_id, key, name, is_default)
  values (p_tenant, 'sales', 'Sales', true)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select p.id into v_id from public.crm_pipelines p
     where p.tenant_id = p_tenant and p.is_default and p.archived_at is null;
    if v_id is null then
      raise exception 'arc_crm:invalid: this client has a retired "sales" pipeline and no default — make one default' using errcode = 'P0001';
    end if;
    return v_id;
  end if;

  insert into public.crm_pipeline_stages (tenant_id, pipeline_id, key, name, position, kind, waits_on, marks_qualified) values
    (p_tenant, v_id, 'new',           'New',           10, 'open', 'us',       false),
    (p_tenant, v_id, 'contacted',     'Contacted',     20, 'open', 'us',       false),
    (p_tenant, v_id, 'qualified',     'Qualified',     30, 'open', 'us',       true),
    (p_tenant, v_id, 'estimate_sent', 'Estimate sent', 40, 'open', 'customer', false),
    (p_tenant, v_id, 'won',           'Won',           50, 'won',  'us',       false),
    (p_tenant, v_id, 'lost',          'Lost',          60, 'lost', 'us',       false);
  return v_id;
end;
$fn$;

create or replace function public.crm_create_pipeline(p_tenant uuid, p_pipeline jsonb)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_id       uuid;
  v_stage    jsonb;
  v_position integer := 0;
  p_stages   jsonb := p_pipeline -> 'stages';
begin
  if jsonb_typeof(p_stages) is distinct from 'array' or not exists (
    select 1 from jsonb_array_elements(p_stages) s where coalesce(s ->> 'kind', 'open') = 'open'
  ) then
    raise exception 'arc_crm:invalid: a pipeline needs at least one open stage' using errcode = 'P0001';
  end if;
  if coalesce((p_pipeline ->> 'is_default')::boolean, false) then
    update public.crm_pipelines set is_default = false where tenant_id = p_tenant and is_default;
  end if;
  begin
    insert into public.crm_pipelines (tenant_id, key, name, is_default)
    values (p_tenant, p_pipeline ->> 'key', p_pipeline ->> 'name', coalesce((p_pipeline ->> 'is_default')::boolean, false))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'arc_crm:key_taken: this client already has a pipeline with the key %', p_pipeline ->> 'key' using errcode = 'P0001';
  end;
  begin
    for v_stage in select * from jsonb_array_elements(p_stages) loop
      v_position := v_position + 10;
      insert into public.crm_pipeline_stages (tenant_id, pipeline_id, key, name, position, kind, waits_on, marks_qualified)
      values (p_tenant, v_id, v_stage ->> 'key', v_stage ->> 'name', v_position,
        coalesce(v_stage ->> 'kind', 'open'), coalesce(v_stage ->> 'waits_on', 'us'),
        coalesce((v_stage ->> 'marks_qualified')::boolean, false));
    end loop;
  exception when unique_violation then
    raise exception 'arc_crm:invalid: two stages of one pipeline cannot share a key' using errcode = 'P0001';
  end;
  return jsonb_build_object(
    'pipeline', (select to_jsonb(p) from public.crm_pipelines p where p.id = v_id),
    'stages', (select jsonb_agg(to_jsonb(s) order by s.position) from public.crm_pipeline_stages s where s.pipeline_id = v_id)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. RLS and grants, as 0023
-- ---------------------------------------------------------------------------

alter table public.crm_pipeline_revisions enable row level security;
drop policy if exists crm_pipeline_revisions_read on public.crm_pipeline_revisions;
create policy crm_pipeline_revisions_read on public.crm_pipeline_revisions
  for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_arc_admin());
revoke insert, update, delete, truncate on public.crm_pipeline_revisions from anon, authenticated;
revoke all on public.crm_pipeline_revisions from anon;

revoke all on function public.crm_pipeline_stages_guard() from public, anon, authenticated;
revoke all on function public.crm_save_stages(uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.crm_ensure_default_pipeline(uuid) from public, anon, authenticated;
revoke all on function public.crm_create_pipeline(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.crm_save_stages(uuid, uuid, jsonb, text, uuid) to service_role;
grant execute on function public.crm_ensure_default_pipeline(uuid) to service_role;
grant execute on function public.crm_create_pipeline(uuid, jsonb) to service_role;
