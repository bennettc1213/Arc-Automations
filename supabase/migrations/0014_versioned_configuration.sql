-- ===========================================================================
-- 0014 — Versioned tenant configuration
-- ===========================================================================
--
-- ARC-110. Until now a tenant's configuration was one mutable row per module
-- (`module_configs.config`, 0010) with a counter that went up on every edit and
-- no history. ARC-015 froze what each *run* used into a snapshot; nothing
-- recorded what the tenant's configuration *was* between runs, who changed it,
-- or what it replaced.
--
-- This migration gives configuration a lifecycle:
--
--   draft      mutable work in progress, guarded by a revision counter, never
--              read by anything that executes. at most one open per scope.
--   version    immutable, numbered 1, 2, 3… per scope. the highest number IS
--              the current configuration — there is no pointer to fall out of
--              step, no "active" flag to flip, and a rollback is the next number
--              carrying older content.
--
-- over two scopes:
--
--   tenant     tenant_settings@1: the facts every module of a tenant shares
--              (company name, timezone).
--   module     one document per (tenant, module): lead_recovery_config@1 minus
--              the tenant-owned fields. the registry (`ownerScope`) says which
--              scope owns each field, so composing the two is a disjoint union
--              and no precedence rule exists to get wrong.
--
-- ---------------------------------------------------------------------------
-- Who can write
-- ---------------------------------------------------------------------------
--
-- No browser role. Every table here has a select policy for operators and no
-- insert, update or delete policy for anyone — the 0010 pattern. Drafts are
-- written by the `ops` edge function under the service role, which validates
-- them against the registered schema first; publishing and rolling back are
-- each ONE function call (§9), executable by the service role only, that
-- re-checks the actor against `arc_admins`, takes a per-scope lock, compares the
-- caller's expected version and draft revision, inserts the version, closes the
-- draft and writes the audit row in one transaction.
--
-- Validation is TypeScript's, by design (ADR-010 §13, ARC-100 §2): the registry's
-- validators are executable, reviewed code and this repository does not load
-- executable code from a row. What the database guarantees is everything that
-- does not need the validator: numbering, lineage, immutability, tenant and
-- module containment, a registered schema, one open draft, no secret-shaped
-- strings, and a draft revision that proves the content published is the
-- content that was validated.
--
-- ---------------------------------------------------------------------------
-- Legacy configuration
-- ---------------------------------------------------------------------------
--
-- Every non-empty `module_configs.config` is copied into a pair of OPEN DRAFTS
-- (tenant fields → tenant draft, the rest → module draft) with its provenance
-- recorded in `origin`. It is NOT published here, because SQL cannot run the
-- registered validator and an unvalidated row must never become a version. The
-- `ops` action `config-import-legacy` validates each pair and publishes it as
-- version 1; a pair that fails stays an open draft — quarantined, with its
-- evidence, for an operator to correct through the ordinary draft path.
--
-- `module_configs.config` is then frozen (§8): the switch (`enabled`) still lives
-- on that row, but its configuration can no longer be written, so there is
-- exactly one place configuration is written from here on. The column is not
-- dropped: it is the evidence the drafts' provenance points at.
--
-- No snapshot, run or action is rewritten. A historical snapshot keeps null
-- version references, because which versions it came from cannot be proven.
--
-- Forward-only and additive. One constraint is replaced (§7: the snapshot's
-- one-row-per-hash rule becomes one-row-per-version-pair for versioned
-- snapshots) and one function is redefined with its signature unchanged (§7,
-- `automation_runs_guard_snapshot`). Nothing is dropped.

-- ---------------------------------------------------------------------------
-- 1. registered configuration schemas — relational identity for the registry
-- ---------------------------------------------------------------------------

-- `registry/schemas.ts` is authoritative for what a schema accepts. This table
-- is what a version row points at, so a version can only name a schema that is
-- registered, at the scope it was registered for. Drift-tested against the code
-- in tests/registry.test.js, like the rest of 0012.
create table if not exists public.registry_config_schemas (
  key          text not null,
  version      integer not null check (version >= 1),
  scope        text not null check (scope in ('tenant', 'module')),
  display_name text not null,
  created_at   timestamptz not null default now(),
  primary key (key, version),
  -- lets a version row carry (key, version, scope) as one foreign key, so a
  -- tenant version cannot name a module schema or the other way round.
  unique (key, version, scope)
);

insert into public.registry_config_schemas (key, version, scope, display_name) values
  ('tenant_settings',      1, 'tenant', 'Tenant settings'),
  ('lead_recovery_config', 1, 'module', 'Lead Recovery configuration')
on conflict (key, version) do nothing;

create or replace function public.registry_config_schemas_are_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  raise exception 'registry_config_schemas rows are fixed at registration (attempted %)', tg_op
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists registry_config_schemas_immutable on public.registry_config_schemas;
create trigger registry_config_schemas_immutable
  before update or delete on public.registry_config_schemas
  for each row execute function public.registry_config_schemas_are_immutable();

-- ---------------------------------------------------------------------------
-- 2. published versions
-- ---------------------------------------------------------------------------

-- The same refusal 0010 put on module_configs.config, restated for every column
-- that holds configuration or evidence about it. The validator's credential-shape
-- scan is the real defence; this catches whatever bypasses it.
--
-- `published_by` and `created_by` are plain uuids, not foreign keys to
-- auth.users: a version is history, and deleting a login must neither fail nor
-- rewrite who published what.

create table if not exists public.tenant_config_versions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  version                 integer not null check (version >= 1),
  schema_key              text not null,
  schema_version          integer not null,
  schema_scope            text not null default 'tenant' check (schema_scope = 'tenant'),
  config                  jsonb not null check (jsonb_typeof(config) = 'object'),
  config_hash             text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  parent_version_id       uuid,
  rollback_of_version_id  uuid,
  source                  text not null check (source in ('draft', 'rollback')),
  published_from_draft_id uuid,
  provenance              jsonb not null default '{}'::jsonb,
  change_impact           jsonb not null default '{}'::jsonb,
  created_by              uuid,
  published_by            uuid not null,
  published_at            timestamptz not null default now(),
  note                    text check (note is null or char_length(note) <= 300),

  unique (tenant_id, version),
  unique (id, tenant_id),
  foreign key (schema_key, schema_version, schema_scope)
    references public.registry_config_schemas (key, version, scope),
  foreign key (parent_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (rollback_of_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),

  constraint tenant_config_versions_lineage check ((version = 1) = (parent_version_id is null)),
  constraint tenant_config_versions_rollback check ((source = 'rollback') = (rollback_of_version_id is not null)),
  constraint tenant_config_versions_from_draft check ((source = 'draft') = (published_from_draft_id is not null)),
  constraint tenant_config_versions_no_secrets check (
    config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  ),
  constraint tenant_config_versions_impact_no_secrets check (
    change_impact::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  )
);

create table if not exists public.module_config_versions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  module_key              text not null references public.registry_modules(key) on delete restrict,
  version                 integer not null check (version >= 1),
  schema_key              text not null,
  schema_version          integer not null,
  schema_scope            text not null default 'module' check (schema_scope = 'module'),
  config                  jsonb not null check (jsonb_typeof(config) = 'object'),
  config_hash             text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  parent_version_id       uuid,
  rollback_of_version_id  uuid,
  source                  text not null check (source in ('draft', 'rollback')),
  published_from_draft_id uuid,
  provenance              jsonb not null default '{}'::jsonb,
  change_impact           jsonb not null default '{}'::jsonb,
  created_by              uuid,
  published_by            uuid not null,
  published_at            timestamptz not null default now(),
  note                    text check (note is null or char_length(note) <= 300),

  unique (tenant_id, module_key, version),
  unique (id, tenant_id),
  -- what a snapshot, a draft and a rollback point at: a version of THIS tenant's
  -- THIS module, structurally.
  unique (id, tenant_id, module_key),
  foreign key (schema_key, schema_version, schema_scope)
    references public.registry_config_schemas (key, version, scope),
  foreign key (parent_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (rollback_of_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),

  constraint module_config_versions_lineage check ((version = 1) = (parent_version_id is null)),
  constraint module_config_versions_rollback check ((source = 'rollback') = (rollback_of_version_id is not null)),
  constraint module_config_versions_from_draft check ((source = 'draft') = (published_from_draft_id is not null)),
  constraint module_config_versions_no_secrets check (
    config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  ),
  constraint module_config_versions_impact_no_secrets check (
    change_impact::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  )
);

create index if not exists tenant_config_versions_head_idx
  on public.tenant_config_versions (tenant_id, version desc);
create index if not exists module_config_versions_head_idx
  on public.module_config_versions (tenant_id, module_key, version desc);

-- Append-only, numbered without gaps, and each version names the one it replaced.
-- `version = head + 1` together with unique (scope, version) is the publication
-- concurrency rule: two writers who both read head N both try N+1 and exactly
-- one insert survives. Invoker rights — the only writer is the service role,
-- which these read as — and a fixed search_path so nothing can shadow `public`.
create or replace function public.tenant_config_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_head_id      uuid;
  v_head_version integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'arc_config:forbidden: a published tenant settings version is immutable (attempted %) — publish a new version instead', tg_op
      using errcode = 'P0001';
  end if;

  select v.id, v.version into v_head_id, v_head_version
    from public.tenant_config_versions v
   where v.tenant_id = new.tenant_id
   order by v.version desc
   limit 1;

  if new.version <> coalesce(v_head_version, 0) + 1 then
    raise exception 'arc_config:publication_conflict: tenant settings version % is not the next after %',
      new.version, coalesce(v_head_version, 0)
      using errcode = 'P0001';
  end if;
  if new.parent_version_id is distinct from v_head_id then
    raise exception 'arc_config:publication_conflict: a new version must name the version it replaces'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists tenant_config_versions_guard on public.tenant_config_versions;
create trigger tenant_config_versions_guard
  before insert or update or delete on public.tenant_config_versions
  for each row execute function public.tenant_config_versions_guard();

create or replace function public.module_config_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_head_id      uuid;
  v_head_version integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'arc_config:forbidden: a published module configuration version is immutable (attempted %) — publish a new version instead', tg_op
      using errcode = 'P0001';
  end if;

  -- the registry is the vocabulary: a module document must be written in the
  -- schema a version of that module a tenant may currently be given names.
  if not exists (
    select 1
      from public.registry_module_versions mv
     where mv.module_key = new.module_key
       and mv.status in ('pilot', 'available')
       and mv.config_schema_key = new.schema_key
       and mv.config_schema_version = new.schema_version
  ) then
    raise exception 'arc_config:schema_not_supported: %@% is not the configuration schema of a selectable % version',
      new.schema_key, new.schema_version, new.module_key
      using errcode = 'P0001';
  end if;

  select v.id, v.version into v_head_id, v_head_version
    from public.module_config_versions v
   where v.tenant_id = new.tenant_id
     and v.module_key = new.module_key
   order by v.version desc
   limit 1;

  if new.version <> coalesce(v_head_version, 0) + 1 then
    raise exception 'arc_config:publication_conflict: % version % is not the next after %',
      new.module_key, new.version, coalesce(v_head_version, 0)
      using errcode = 'P0001';
  end if;
  if new.parent_version_id is distinct from v_head_id then
    raise exception 'arc_config:publication_conflict: a new version must name the version it replaces'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists module_config_versions_guard on public.module_config_versions;
create trigger module_config_versions_guard
  before insert or update or delete on public.module_config_versions
  for each row execute function public.module_config_versions_guard();

-- The current configuration, derived — never stored. `security_invoker` so a
-- browser role reading these sees exactly what the version tables' RLS lets it.
create or replace view public.tenant_config_heads
  with (security_invoker = true) as
  select distinct on (tenant_id) *
    from public.tenant_config_versions
   order by tenant_id, version desc;

create or replace view public.module_config_heads
  with (security_invoker = true) as
  select distinct on (tenant_id, module_key) *
    from public.module_config_versions
   order by tenant_id, module_key, version desc;

-- ---------------------------------------------------------------------------
-- 3. drafts
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_config_drafts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  schema_key           text not null,
  schema_version       integer not null,
  schema_scope         text not null default 'tenant' check (schema_scope = 'tenant'),
  -- the head this draft was written against. 0/null when there was none.
  base_version_id      uuid,
  base_version         integer not null default 0 check (base_version >= 0),
  config               jsonb not null check (jsonb_typeof(config) = 'object'),
  -- the optimistic-concurrency token. set by the trigger, never by a caller.
  revision             integer not null default 1 check (revision >= 1),
  status               text not null default 'open'
                         check (status in ('open', 'published', 'discarded', 'superseded')),
  published_version_id uuid,
  origin               jsonb not null default '{}'::jsonb,
  created_by           uuid,
  updated_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  closed_at            timestamptz,

  unique (id, tenant_id),
  foreign key (schema_key, schema_version, schema_scope)
    references public.registry_config_schemas (key, version, scope),
  foreign key (base_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),
  foreign key (published_version_id, tenant_id)
    references public.tenant_config_versions (id, tenant_id),

  constraint tenant_config_drafts_base check ((base_version = 0) = (base_version_id is null)),
  constraint tenant_config_drafts_published check ((status = 'published') = (published_version_id is not null)),
  constraint tenant_config_drafts_closed check ((status = 'open') = (closed_at is null)),
  constraint tenant_config_drafts_no_secrets check (
    config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  )
);

create table if not exists public.module_config_drafts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  module_key           text not null references public.registry_modules(key) on delete restrict,
  schema_key           text not null,
  schema_version       integer not null,
  schema_scope         text not null default 'module' check (schema_scope = 'module'),
  base_version_id      uuid,
  base_version         integer not null default 0 check (base_version >= 0),
  config               jsonb not null check (jsonb_typeof(config) = 'object'),
  revision             integer not null default 1 check (revision >= 1),
  status               text not null default 'open'
                         check (status in ('open', 'published', 'discarded', 'superseded')),
  published_version_id uuid,
  origin               jsonb not null default '{}'::jsonb,
  created_by           uuid,
  updated_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  closed_at            timestamptz,

  unique (id, tenant_id),
  unique (id, tenant_id, module_key),
  foreign key (schema_key, schema_version, schema_scope)
    references public.registry_config_schemas (key, version, scope),
  foreign key (base_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),
  foreign key (published_version_id, tenant_id, module_key)
    references public.module_config_versions (id, tenant_id, module_key),

  constraint module_config_drafts_base check ((base_version = 0) = (base_version_id is null)),
  constraint module_config_drafts_published check ((status = 'published') = (published_version_id is not null)),
  constraint module_config_drafts_closed check ((status = 'open') = (closed_at is null)),
  constraint module_config_drafts_no_secrets check (
    config::text !~* '(service_role|sk_live|sk_test|api[_-]?key|auth[_-]?token|"secret"|private[_-]?key|bearer )'
  )
);

-- one open draft per scope. a second writer starts from the first one or waits.
create unique index if not exists tenant_config_drafts_one_open
  on public.tenant_config_drafts (tenant_id) where status = 'open';
create unique index if not exists module_config_drafts_one_open
  on public.module_config_drafts (tenant_id, module_key) where status = 'open';

-- a version records the draft it came from, structurally.
alter table public.tenant_config_versions
  drop constraint if exists tenant_config_versions_draft_fk;
alter table public.tenant_config_versions
  add constraint tenant_config_versions_draft_fk
  foreign key (published_from_draft_id, tenant_id)
  references public.tenant_config_drafts (id, tenant_id);

alter table public.module_config_versions
  drop constraint if exists module_config_versions_draft_fk;
alter table public.module_config_versions
  add constraint module_config_versions_draft_fk
  foreign key (published_from_draft_id, tenant_id, module_key)
  references public.module_config_drafts (id, tenant_id, module_key);

-- A draft is born open, on the current head, at revision 1. While open, only its
-- content, its editor and its status move, and every write bumps the revision —
-- so a caller that read revision R and writes `where revision = R` either wins
-- or touches nothing. Once closed it is frozen, and it is never deleted: a
-- discarded draft is evidence of what somebody considered.
create or replace function public.config_drafts_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_head_id      uuid;
  v_head_version integer;
  v_module       text := case when tg_table_name = 'module_config_drafts' then (to_jsonb(coalesce(new, old)) ->> 'module_key') end;
begin
  if tg_op = 'DELETE' then
    raise exception 'arc_config:forbidden: drafts are not deleted — discard them' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'arc_config:forbidden: a draft is created open' using errcode = 'P0001';
    end if;
    new.revision    := 1;
    new.closed_at   := null;
    new.published_version_id := null;
    new.created_at  := now();
    new.updated_at  := now();
    new.updated_by  := new.created_by;

    if v_module is null then
      select v.id, v.version into v_head_id, v_head_version
        from public.tenant_config_versions v
       where v.tenant_id = new.tenant_id
       order by v.version desc limit 1;
    else
      if not exists (
        select 1 from public.registry_module_versions mv
         where mv.module_key = v_module
           and mv.status in ('pilot', 'available')
           and mv.config_schema_key = new.schema_key
           and mv.config_schema_version = new.schema_version
      ) then
        raise exception 'arc_config:schema_not_supported: %@% is not the configuration schema of a selectable % version',
          new.schema_key, new.schema_version, v_module
          using errcode = 'P0001';
      end if;
      select v.id, v.version into v_head_id, v_head_version
        from public.module_config_versions v
       where v.tenant_id = new.tenant_id and v.module_key = v_module
       order by v.version desc limit 1;
    end if;

    -- a draft written against anything but the current configuration would be
    -- publishing over somebody else's work the moment it went out.
    if new.base_version <> coalesce(v_head_version, 0)
       or new.base_version_id is distinct from v_head_id then
      raise exception 'arc_config:stale_draft: a new draft must start from the current version (%)', coalesce(v_head_version, 0)
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status <> 'open' then
    raise exception 'arc_config:draft_closed: this draft is % and can no longer change', old.status
      using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'config' - 'revision' - 'status' - 'published_version_id' - 'updated_by' - 'updated_at' - 'closed_at')
     is distinct from
     (to_jsonb(old) - 'config' - 'revision' - 'status' - 'published_version_id' - 'updated_by' - 'updated_at' - 'closed_at') then
    raise exception 'arc_config:forbidden: a draft''s tenant, scope, schema, base and origin are fixed when it is created'
      using errcode = 'P0001';
  end if;
  if new.status <> 'open' and new.config is distinct from old.config then
    raise exception 'arc_config:forbidden: closing a draft cannot also change its content'
      using errcode = 'P0001';
  end if;
  if new.status = 'open' and new.published_version_id is not null then
    raise exception 'arc_config:forbidden: an open draft has no published version'
      using errcode = 'P0001';
  end if;

  new.revision   := old.revision + 1;
  new.updated_at := now();
  new.closed_at  := case when new.status = 'open' then null else now() end;
  return new;
end;
$fn$;

drop trigger if exists tenant_config_drafts_guard on public.tenant_config_drafts;
create trigger tenant_config_drafts_guard
  before insert or update or delete on public.tenant_config_drafts
  for each row execute function public.config_drafts_guard();

drop trigger if exists module_config_drafts_guard on public.module_config_drafts;
create trigger module_config_drafts_guard
  before insert or update or delete on public.module_config_drafts
  for each row execute function public.config_drafts_guard();

-- ---------------------------------------------------------------------------
-- 4. legacy configuration → quarantined drafts
-- ---------------------------------------------------------------------------

-- Copied, not published (see the header). Only the fields the registry assigns to
-- the tenant scope go into the tenant draft; the rest stay with the module. A
-- field missing from the legacy row is missing from the draft — nothing is
-- defaulted here, so the validator is the one that says it is required.
-- Re-runnable: a tenant that already has drafts or versions is left alone.

insert into public.tenant_config_drafts (tenant_id, schema_key, schema_version, base_version, config, origin)
select mc.tenant_id,
       'tenant_settings',
       1,
       0,
       jsonb_strip_nulls(jsonb_build_object(
         'company_name', mc.config -> 'company_name',
         'timezone',     mc.config -> 'timezone'
       )),
       jsonb_build_object('legacy', jsonb_build_object(
         'table',            'module_configs',
         'module_config_id', mc.id,
         'module_key',       mc.module_key,
         'config_version',   mc.config_version,
         'schema_version',   mc.schema_version,
         'updated_at',       mc.updated_at,
         'migration',        '0014'
       ))
  from public.module_configs mc
 where mc.module_key = 'lead_recovery'
   and mc.config <> '{}'::jsonb
   and not exists (select 1 from public.tenant_config_drafts d where d.tenant_id = mc.tenant_id)
   and not exists (select 1 from public.tenant_config_versions v where v.tenant_id = mc.tenant_id);

insert into public.module_config_drafts (tenant_id, module_key, schema_key, schema_version, base_version, config, origin)
select mc.tenant_id,
       mc.module_key,
       'lead_recovery_config',
       1,
       0,
       mc.config - 'company_name' - 'timezone',
       jsonb_build_object('legacy', jsonb_build_object(
         'table',            'module_configs',
         'module_config_id', mc.id,
         'module_key',       mc.module_key,
         'config_version',   mc.config_version,
         'schema_version',   mc.schema_version,
         'updated_at',       mc.updated_at,
         'migration',        '0014'
       ))
  from public.module_configs mc
 where mc.module_key = 'lead_recovery'
   and mc.config <> '{}'::jsonb
   and not exists (select 1 from public.module_config_drafts d where d.tenant_id = mc.tenant_id and d.module_key = mc.module_key)
   and not exists (select 1 from public.module_config_versions v where v.tenant_id = mc.tenant_id and v.module_key = mc.module_key);

-- ---------------------------------------------------------------------------
-- 5. snapshots name the versions they were resolved from
-- ---------------------------------------------------------------------------

-- ARC-015's snapshot stays the thing a run and every action is pinned to (0013).
-- ARC-110 adds where its content came from: the tenant settings version and the
-- module version it was composed from. Null on every snapshot written before
-- this migration — that provenance cannot be proven, so it is not invented.
alter table public.lead_recovery_config_snapshots
  add column if not exists tenant_config_version_id uuid,
  add column if not exists module_config_version_id uuid;

alter table public.lead_recovery_config_snapshots
  drop constraint if exists lead_recovery_config_snapshots_tenant_version_fk;
alter table public.lead_recovery_config_snapshots
  add constraint lead_recovery_config_snapshots_tenant_version_fk
  foreign key (tenant_config_version_id, tenant_id)
  references public.tenant_config_versions (id, tenant_id)
  on delete restrict;

alter table public.lead_recovery_config_snapshots
  drop constraint if exists lead_recovery_config_snapshots_module_version_fk;
alter table public.lead_recovery_config_snapshots
  add constraint lead_recovery_config_snapshots_module_version_fk
  foreign key (module_config_version_id, tenant_id, module_key)
  references public.module_config_versions (id, tenant_id, module_key)
  on delete restrict;

alter table public.lead_recovery_config_snapshots
  drop constraint if exists lead_recovery_config_snapshots_sources_paired;
alter table public.lead_recovery_config_snapshots
  add constraint lead_recovery_config_snapshots_sources_paired
  check ((tenant_config_version_id is null) = (module_config_version_id is null));

-- One snapshot per distinct configuration was the right identity when content was
-- all there was. With versions, identity is the version pair: a rollback
-- republishes older content as a NEW version, and the runs under it must record
-- that version, not borrow the snapshot of the one it copied. Legacy snapshots
-- keep their one-per-hash rule; versioned ones are one per version pair.
alter table public.lead_recovery_config_snapshots
  drop constraint if exists lead_recovery_config_snapshots_tenant_id_config_hash_key;
create unique index if not exists lead_recovery_config_snapshots_legacy_hash_key
  on public.lead_recovery_config_snapshots (tenant_id, config_hash)
  where module_config_version_id is null;
create unique index if not exists lead_recovery_config_snapshots_sources_key
  on public.lead_recovery_config_snapshots (tenant_id, tenant_config_version_id, module_config_version_id)
  where module_config_version_id is not null;

create or replace function public.lead_recovery_config_snapshots_guard_sources()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_version integer;
  v_schema  integer;
begin
  if new.module_config_version_id is null then
    -- a tenant whose configuration is versioned must snapshot from its versions.
    -- the only unversioned snapshots allowed are for a tenant that has none yet,
    -- which is the window between applying this migration and importing.
    if exists (
      select 1 from public.module_config_versions m
       where m.tenant_id = new.tenant_id and m.module_key = new.module_key
    ) then
      raise exception 'arc_config:forbidden: % configuration for this tenant is versioned, so a snapshot must name the versions it was resolved from',
        new.module_key
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  select m.version, m.schema_version into v_version, v_schema
    from public.module_config_versions m
   where m.id = new.module_config_version_id
     and m.tenant_id = new.tenant_id
     and m.module_key = new.module_key;
  if not found then
    raise exception 'arc_config:tenant_mismatch: module version % is not a % version of this tenant',
      new.module_config_version_id, new.module_key
      using errcode = 'P0001';
  end if;
  if new.config_version <> v_version or new.schema_version <> v_schema then
    raise exception 'arc_config:validation_failed: a snapshot records its module version''s number and schema (% / %), not % / %',
      v_version, v_schema, new.config_version, new.schema_version
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists lead_recovery_config_snapshots_guard_sources on public.lead_recovery_config_snapshots;
create trigger lead_recovery_config_snapshots_guard_sources
  before insert on public.lead_recovery_config_snapshots
  for each row execute function public.lead_recovery_config_snapshots_guard_sources();

-- ---------------------------------------------------------------------------
-- 6. runs: 0013's guard, plus "versioned tenants start versioned runs"
-- ---------------------------------------------------------------------------

-- 0013's body, unchanged except for the marked block. A run pinned to a legacy
-- unversioned snapshot — say one reused by content hash — would carry no record
-- of the published versions it ran under, so once a tenant has any, a new run
-- must be pinned to a snapshot that names them.
create or replace function public.automation_runs_guard_snapshot()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_module  text;
  v_schema  integer;
  v_sources uuid;
begin
  if tg_op = 'INSERT' then
    if new.config_snapshot_id is null then
      raise exception 'automation_runs: a new run must be pinned to a configuration snapshot'
        using errcode = 'P0001';
    end if;

    select s.module_key, s.schema_version, s.module_config_version_id
      into v_module, v_schema, v_sources
      from public.lead_recovery_config_snapshots s
     where s.id = new.config_snapshot_id
       and s.tenant_id = new.tenant_id;
    if not found then
      raise exception 'automation_runs: snapshot % does not belong to tenant %',
        new.config_snapshot_id, new.tenant_id
        using errcode = 'P0001';
    end if;

    if v_module <> new.module_key then
      raise exception 'automation_runs: snapshot is for module %, not %', v_module, new.module_key
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
        from public.registry_module_versions mv
       where mv.module_key = new.module_key
         and mv.status in ('pilot', 'available')
         and mv.config_schema_key is not null
         and mv.config_schema_version = v_schema
    ) then
      raise exception 'automation_runs: schema version % is not a registered configuration schema for %',
        v_schema, new.module_key
        using errcode = 'P0001';
    end if;

    -- ── ARC-110 ──
    if v_sources is null and exists (
      select 1 from public.module_config_versions m
       where m.tenant_id = new.tenant_id and m.module_key = new.module_key
    ) then
      raise exception 'automation_runs: % configuration for this tenant is versioned, so a new run must be pinned to a snapshot that names its versions',
        new.module_key
        using errcode = 'P0001';
    end if;
    -- ── end ARC-110 ──

    return new;
  end if;

  if new.config_snapshot_id is distinct from old.config_snapshot_id then
    raise exception 'automation_runs: a run''s configuration snapshot is fixed when it is created'
      using errcode = 'P0001';
  end if;
  if new.tenant_id <> old.tenant_id
     or new.lead_id <> old.lead_id
     or new.module_key <> old.module_key then
    raise exception 'automation_runs: tenant, lead and module are fixed when a run is created'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. module_configs.config is no longer written
-- ---------------------------------------------------------------------------

-- The row stays: `enabled` is the module switch (ARC-120 will replace it) and the
-- publish function creates the row a tenant's first module version needs. Its
-- `config` is frozen at whatever it held when this migration ran, so there is
-- one write path for configuration and no second mutable copy to read by
-- mistake. A new row may only be created empty.
create or replace function public.module_configs_config_is_versioned()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.config is distinct from '{}'::jsonb then
      raise exception 'arc_config:forbidden: module_configs.config is no longer written — configuration is published as versions (0014)'
        using errcode = 'P0001';
    end if;
  elsif new.config is distinct from old.config then
    raise exception 'arc_config:forbidden: module_configs.config is no longer written — configuration is published as versions (0014)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists module_configs_config_versioned on public.module_configs;
create trigger module_configs_config_versioned
  before insert or update on public.module_configs
  for each row execute function public.module_configs_config_is_versioned();

-- ---------------------------------------------------------------------------
-- 8. shared checks for the two operator functions
-- ---------------------------------------------------------------------------

-- The actor is passed by the `ops` function, which took it from the caller's
-- verified JWT after `is_arc_admin()` said yes. It is checked again here, against
-- the same table, so a service-role caller with a bug cannot publish as somebody
-- who is not an operator — and a caller carrying a user JWT cannot name anyone
-- but itself.
create or replace function public.config_require_operator(p_actor uuid)
returns void
language plpgsql
stable
set search_path = public
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    raise exception 'arc_config:forbidden: publishing configuration is an operator action'
      using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_config:forbidden: the actor must be the signed-in caller'
      using errcode = 'P0001';
  end if;
end;
$fn$;

create or replace function public.config_require_scope(p_scope text, p_module_key text)
returns void
language plpgsql
stable
set search_path = public
as $fn$
begin
  if p_scope = 'tenant' then
    if p_module_key is not null then
      raise exception 'arc_config:validation_failed: tenant settings have no module' using errcode = 'P0001';
    end if;
    return;
  end if;
  if p_scope <> 'module' or p_module_key is null then
    raise exception 'arc_config:validation_failed: scope must be tenant, or module with a module key' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.registry_module_versions mv
     where mv.module_key = p_module_key and mv.status in ('pilot', 'available')
  ) then
    raise exception 'arc_config:module_not_found: % is not a module a tenant can be configured for', p_module_key
      using errcode = 'P0001';
  end if;
end;
$fn$;

-- One writer per scope at a time, for the length of the transaction. The unique
-- (scope, version) index would catch a race on its own; the lock turns the loser's
-- outcome from a constraint violation into the sentence it deserves.
create or replace function public.config_lock_scope(p_tenant uuid, p_module_key text)
returns void
language sql
set search_path = public
as $fn$
  select pg_advisory_xact_lock(hashtextextended('arc_config:' || p_tenant::text || ':' || coalesce(p_module_key, '@tenant'), 0));
$fn$;

-- G-P5 (ADR-010 §36): a Twilio number routes to exactly one tenant. The number
-- lives in the validated Lead Recovery document, so the rule is checked where
-- that document is published, under a lock on the number itself so two tenants
-- publishing it at once cannot both succeed.
create or replace function public.config_require_unclaimed_number(p_tenant uuid, p_module_key text, p_config jsonb)
returns void
language plpgsql
set search_path = public
as $fn$
declare
  v_number text := p_config #>> '{twilio,phone_number}';
begin
  if p_module_key <> 'lead_recovery' or v_number is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('arc_config:number:' || v_number, 0));
  if exists (
    select 1 from public.module_config_heads h
     where h.module_key = 'lead_recovery'
       and h.tenant_id <> p_tenant
       and h.config #>> '{twilio,phone_number}' = v_number
  ) then
    raise exception 'arc_config:number_claimed: % already routes to another tenant', v_number
      using errcode = 'P0001';
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. publish and roll back — each one transaction
-- ---------------------------------------------------------------------------

-- Publishes exactly what the draft holds at the revision the caller validated.
-- The engine validated that content against the registered schema, computed its
-- hash and the audit-safe impact summary; this function proves nothing changed
-- since (the revision), that nobody published in between (the expected version,
-- under the scope lock), and that the draft was written against the version it
-- is about to replace (the base).
create or replace function public.publish_config_draft(
  p_scope                   text,
  p_tenant                  uuid,
  p_module_key              text,
  p_draft_id                uuid,
  p_expected_draft_revision integer,
  p_expected_version        integer,
  p_config_hash             text,
  p_change_impact           jsonb,
  p_actor                   uuid,
  p_note                    text default null
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_status       text;
  v_revision     integer;
  v_base_version integer;
  v_config       jsonb;
  v_schema_key   text;
  v_schema_ver   integer;
  v_origin       jsonb;
  v_created_by   uuid;
  v_head_id      uuid;
  v_head_version integer;
  v_tenant_row   public.tenant_config_versions;
  v_module_row   public.module_config_versions;
  v_result       jsonb;
begin
  perform public.config_require_operator(p_actor);
  perform public.config_require_scope(p_scope, p_module_key);
  perform public.config_lock_scope(p_tenant, p_module_key);

  if p_scope = 'tenant' then
    select d.status, d.revision, d.base_version, d.config, d.schema_key, d.schema_version, d.origin, d.created_by
      into v_status, v_revision, v_base_version, v_config, v_schema_key, v_schema_ver, v_origin, v_created_by
      from public.tenant_config_drafts d
     where d.id = p_draft_id and d.tenant_id = p_tenant
       for update;
    if not found then
      raise exception 'arc_config:draft_not_found: no such tenant settings draft for this tenant' using errcode = 'P0001';
    end if;
    select v.id, v.version into v_head_id, v_head_version
      from public.tenant_config_versions v
     where v.tenant_id = p_tenant
     order by v.version desc limit 1;
  else
    select d.status, d.revision, d.base_version, d.config, d.schema_key, d.schema_version, d.origin, d.created_by
      into v_status, v_revision, v_base_version, v_config, v_schema_key, v_schema_ver, v_origin, v_created_by
      from public.module_config_drafts d
     where d.id = p_draft_id and d.tenant_id = p_tenant and d.module_key = p_module_key
       for update;
    if not found then
      raise exception 'arc_config:draft_not_found: no such % draft for this tenant', p_module_key using errcode = 'P0001';
    end if;
    select v.id, v.version into v_head_id, v_head_version
      from public.module_config_versions v
     where v.tenant_id = p_tenant and v.module_key = p_module_key
     order by v.version desc limit 1;
  end if;
  v_head_version := coalesce(v_head_version, 0);

  if v_status <> 'open' then
    raise exception 'arc_config:draft_closed: this draft is %', v_status using errcode = 'P0001';
  end if;
  if v_revision <> p_expected_draft_revision then
    raise exception 'arc_config:draft_conflict: the draft is at revision %, not %', v_revision, p_expected_draft_revision
      using errcode = 'P0001';
  end if;
  if v_head_version <> p_expected_version then
    raise exception 'arc_config:publication_conflict: the current version is %, not %', v_head_version, p_expected_version
      using errcode = 'P0001';
  end if;
  if v_base_version <> v_head_version then
    raise exception 'arc_config:stale_draft: this draft was written against version %, and version % has been published since',
      v_base_version, v_head_version
      using errcode = 'P0001';
  end if;
  if p_config_hash is null or p_config_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'arc_config:validation_failed: a content hash is required' using errcode = 'P0001';
  end if;

  if p_scope = 'tenant' then
    insert into public.tenant_config_versions (
      tenant_id, version, schema_key, schema_version, config, config_hash,
      parent_version_id, source, published_from_draft_id, provenance, change_impact,
      created_by, published_by, note
    ) values (
      p_tenant, v_head_version + 1, v_schema_key, v_schema_ver, v_config, p_config_hash,
      v_head_id, 'draft', p_draft_id, v_origin || jsonb_build_object('draft_revision', v_revision),
      coalesce(p_change_impact, '{}'::jsonb), v_created_by, p_actor, p_note
    )
    returning * into v_tenant_row;

    update public.tenant_config_drafts
       set status = 'published', published_version_id = v_tenant_row.id, updated_by = p_actor
     where id = p_draft_id;

    v_result := to_jsonb(v_tenant_row) || jsonb_build_object('scope', 'tenant', 'module_key', null);
  else
    perform public.config_require_unclaimed_number(p_tenant, p_module_key, v_config);

    insert into public.module_config_versions (
      tenant_id, module_key, version, schema_key, schema_version, config, config_hash,
      parent_version_id, source, published_from_draft_id, provenance, change_impact,
      created_by, published_by, note
    ) values (
      p_tenant, p_module_key, v_head_version + 1, v_schema_key, v_schema_ver, v_config, p_config_hash,
      v_head_id, 'draft', p_draft_id, v_origin || jsonb_build_object('draft_revision', v_revision),
      coalesce(p_change_impact, '{}'::jsonb), v_created_by, p_actor, p_note
    )
    returning * into v_module_row;

    update public.module_config_drafts
       set status = 'published', published_version_id = v_module_row.id, updated_by = p_actor
     where id = p_draft_id;

    -- the switch row. created switched off: publishing configuration never
    -- activates anything (ARC-120 owns activation).
    insert into public.module_configs (tenant_id, module_key)
    values (p_tenant, p_module_key)
    on conflict (tenant_id, module_key) do nothing;

    v_result := to_jsonb(v_module_row) || jsonb_build_object('scope', 'module');
  end if;

  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (
    p_actor, 'config.published', 'tenant', p_tenant::text,
    jsonb_build_object(
      'scope', p_scope,
      'module_key', p_module_key,
      'version', v_result -> 'version',
      'version_id', v_result -> 'id',
      'parent_version_id', v_head_id,
      'schema', v_schema_key || '@' || v_schema_ver,
      'draft_id', p_draft_id,
      'draft_revision', v_revision,
      'impact', coalesce(p_change_impact, '{}'::jsonb)
    )
  );

  return v_result;
end;
$fn$;

-- Rollback is publication of older content as the NEXT version. The historical
-- row is read, never touched; the new row records it as `rollback_of_version_id`
-- and the head it replaced as its parent. The engine has already re-validated
-- that content against today's schema — a version whose schema is no longer
-- selectable is refused by the version guard regardless.
create or replace function public.rollback_config_version(
  p_scope             text,
  p_tenant            uuid,
  p_module_key        text,
  p_source_version_id uuid,
  p_expected_version  integer,
  p_change_impact     jsonb,
  p_actor             uuid,
  p_note              text default null
)
returns jsonb
language plpgsql
set search_path = public
as $fn$
declare
  v_source_version integer;
  v_config         jsonb;
  v_hash           text;
  v_schema_key     text;
  v_schema_ver     integer;
  v_head_id        uuid;
  v_head_version   integer;
  v_tenant_row     public.tenant_config_versions;
  v_module_row     public.module_config_versions;
  v_result         jsonb;
begin
  perform public.config_require_operator(p_actor);
  perform public.config_require_scope(p_scope, p_module_key);
  perform public.config_lock_scope(p_tenant, p_module_key);

  if p_scope = 'tenant' then
    select v.version, v.config, v.config_hash, v.schema_key, v.schema_version
      into v_source_version, v_config, v_hash, v_schema_key, v_schema_ver
      from public.tenant_config_versions v
     where v.id = p_source_version_id and v.tenant_id = p_tenant;
    if not found then
      raise exception 'arc_config:version_not_found: no such tenant settings version for this tenant' using errcode = 'P0001';
    end if;
    select v.id, v.version into v_head_id, v_head_version
      from public.tenant_config_versions v
     where v.tenant_id = p_tenant
     order by v.version desc limit 1;
  else
    select v.version, v.config, v.config_hash, v.schema_key, v.schema_version
      into v_source_version, v_config, v_hash, v_schema_key, v_schema_ver
      from public.module_config_versions v
     where v.id = p_source_version_id and v.tenant_id = p_tenant and v.module_key = p_module_key;
    if not found then
      raise exception 'arc_config:version_not_found: no such % version for this tenant', p_module_key using errcode = 'P0001';
    end if;
    select v.id, v.version into v_head_id, v_head_version
      from public.module_config_versions v
     where v.tenant_id = p_tenant and v.module_key = p_module_key
     order by v.version desc limit 1;
  end if;

  if v_head_version <> p_expected_version then
    raise exception 'arc_config:publication_conflict: the current version is %, not %', v_head_version, p_expected_version
      using errcode = 'P0001';
  end if;
  if v_head_id = p_source_version_id then
    raise exception 'arc_config:no_change: version % is already the current version', v_source_version
      using errcode = 'P0001';
  end if;

  if p_scope = 'tenant' then
    insert into public.tenant_config_versions (
      tenant_id, version, schema_key, schema_version, config, config_hash,
      parent_version_id, rollback_of_version_id, source, provenance, change_impact,
      created_by, published_by, note
    ) values (
      p_tenant, v_head_version + 1, v_schema_key, v_schema_ver, v_config, v_hash,
      v_head_id, p_source_version_id, 'rollback', jsonb_build_object('rollback_of_version', v_source_version),
      coalesce(p_change_impact, '{}'::jsonb), p_actor, p_actor, p_note
    )
    returning * into v_tenant_row;
    v_result := to_jsonb(v_tenant_row) || jsonb_build_object('scope', 'tenant', 'module_key', null);
  else
    perform public.config_require_unclaimed_number(p_tenant, p_module_key, v_config);
    insert into public.module_config_versions (
      tenant_id, module_key, version, schema_key, schema_version, config, config_hash,
      parent_version_id, rollback_of_version_id, source, provenance, change_impact,
      created_by, published_by, note
    ) values (
      p_tenant, p_module_key, v_head_version + 1, v_schema_key, v_schema_ver, v_config, v_hash,
      v_head_id, p_source_version_id, 'rollback', jsonb_build_object('rollback_of_version', v_source_version),
      coalesce(p_change_impact, '{}'::jsonb), p_actor, p_actor, p_note
    )
    returning * into v_module_row;
    v_result := to_jsonb(v_module_row) || jsonb_build_object('scope', 'module');
  end if;

  insert into public.admin_actions (actor_user_id, action, target_type, target_id, metadata)
  values (
    p_actor, 'config.rolled_back', 'tenant', p_tenant::text,
    jsonb_build_object(
      'scope', p_scope,
      'module_key', p_module_key,
      'version', v_result -> 'version',
      'version_id', v_result -> 'id',
      'parent_version_id', v_head_id,
      'rollback_of_version_id', p_source_version_id,
      'rollback_of_version', v_source_version,
      'schema', v_schema_key || '@' || v_schema_ver,
      'impact', coalesce(p_change_impact, '{}'::jsonb)
    )
  );

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. RLS — operator-readable, nobody writes from a browser
-- ---------------------------------------------------------------------------

-- Configuration is operator material, exactly as module_configs was in 0010:
-- staff phone numbers, alert recipients, provider references. No client policy
-- exists on any of these tables; whether a client ever reads or edits its own
-- settings is ARC-310's decision, and the registry's `clientEditable: false`
-- on every field is the same answer in code.

alter table public.registry_config_schemas enable row level security;
alter table public.tenant_config_versions  enable row level security;
alter table public.module_config_versions  enable row level security;
alter table public.tenant_config_drafts    enable row level security;
alter table public.module_config_drafts    enable row level security;

drop policy if exists registry_config_schemas_read on public.registry_config_schemas;
create policy registry_config_schemas_read on public.registry_config_schemas
  for select to authenticated using (true);

drop policy if exists tenant_config_versions_admin_read on public.tenant_config_versions;
create policy tenant_config_versions_admin_read on public.tenant_config_versions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists module_config_versions_admin_read on public.module_config_versions;
create policy module_config_versions_admin_read on public.module_config_versions
  for select to authenticated using (public.is_arc_admin());

drop policy if exists tenant_config_drafts_admin_read on public.tenant_config_drafts;
create policy tenant_config_drafts_admin_read on public.tenant_config_drafts
  for select to authenticated using (public.is_arc_admin());

drop policy if exists module_config_drafts_admin_read on public.module_config_drafts;
create policy module_config_drafts_admin_read on public.module_config_drafts
  for select to authenticated using (public.is_arc_admin());

-- No insert, update or delete policy on any table in this migration, for any
-- role. The absence is the write protection, as in 0004, 0010, 0011 and 0012;
-- the triggers above bind the service role as well.

-- ---------------------------------------------------------------------------
-- 11. privileges
-- ---------------------------------------------------------------------------

-- `create or replace` keeps existing grants; restated so this file is correct on
-- its own. Publication and rollback are service-role only: the `ops` function is
-- the one caller, after it has checked the JWT and validated the content.
revoke all on function public.publish_config_draft(text, uuid, text, uuid, integer, integer, text, jsonb, uuid, text)
  from public, anon, authenticated;
revoke all on function public.rollback_config_version(text, uuid, text, uuid, integer, jsonb, uuid, text)
  from public, anon, authenticated;
revoke all on function public.config_require_operator(uuid) from public, anon, authenticated;
revoke all on function public.config_require_scope(text, text) from public, anon, authenticated;
revoke all on function public.config_lock_scope(uuid, text) from public, anon, authenticated;
revoke all on function public.config_require_unclaimed_number(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.tenant_config_versions_guard() from public, anon, authenticated;
revoke all on function public.module_config_versions_guard() from public, anon, authenticated;
revoke all on function public.config_drafts_guard() from public, anon, authenticated;
revoke all on function public.lead_recovery_config_snapshots_guard_sources() from public, anon, authenticated;
revoke all on function public.module_configs_config_is_versioned() from public, anon, authenticated;
revoke all on function public.registry_config_schemas_are_immutable() from public, anon, authenticated;
revoke all on function public.automation_runs_guard_snapshot() from public, anon, authenticated;

grant execute on function public.publish_config_draft(text, uuid, text, uuid, integer, integer, text, jsonb, uuid, text)
  to service_role;
grant execute on function public.rollback_config_version(text, uuid, text, uuid, integer, jsonb, uuid, text)
  to service_role;
grant execute on function public.config_require_operator(uuid) to service_role;
grant execute on function public.config_require_scope(text, text) to service_role;
grant execute on function public.config_lock_scope(uuid, text) to service_role;
grant execute on function public.config_require_unclaimed_number(uuid, text, jsonb) to service_role;
