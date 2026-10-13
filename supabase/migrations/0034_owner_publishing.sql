-- An owner may publish their own wording (decided 2026-10-13). Nothing else.
--
-- Publishing configuration stays an operator action (0014). This adds one exception with a
-- closed edge: the tenant's own owner may publish a Lead Recovery version that differs from
-- the current one only in three templates and in whether and when the one follow-up goes.
-- The rule is `_shared/config/owner-wording.ts`; the engine asks it before writing and this
-- migration asks it again, so a caller that skipped the engine is refused here.
--
-- An owner can only publish ONTO a version an operator published: an account ARC has not
-- configured has no number, no destination and no compliance status, and an owner's words
-- create none of them. Rollback is unchanged and still an operator's.
--
-- It does not activate anything. A wording version records `requires_retest: false` with the
-- waiver written beside it (`owner_authored`), so the lifecycle carries a live module's
-- authorisation forward (0015) instead of holding new leads for a retest whose purpose —
-- the client reading and approving the words — is met by the client having written them.
--
-- Also records which saved campaign an owner's live wording came from. That is a note for
-- the owner's screen; what is sent is the published configuration and nothing else.
--
-- Requires 0014, 0015 and 0029.

-- ── 1. what an owner's version may differ in ─────────────────────────────────────────────

-- Null when the change is wording and only wording; otherwise what else it touched.
-- Mirrors ownerWordingViolations() in _shared/config/owner-wording.ts; a test compares them.
create function public.config_owner_wording_violation(p_before jsonb, p_after jsonb)
returns text language plpgsql immutable set search_path = public as $fn$
declare
  v_allowed constant text[] := array['first_response', 'first_response_form', 'followup'];
begin
  if p_before is null or p_after is null or jsonb_typeof(p_before) <> 'object' or jsonb_typeof(p_after) <> 'object' then
    return 'not a configuration document';
  end if;
  if (p_after - 'templates' - 'followup') is distinct from (p_before - 'templates' - 'followup') then
    return 'a setting other than wording';
  end if;
  if (coalesce(p_after -> 'templates', '{}'::jsonb) - v_allowed)
     is distinct from (coalesce(p_before -> 'templates', '{}'::jsonb) - v_allowed) then
    return 'a template an owner may not change';
  end if;
  return null;
end $fn$;

-- Who may publish this draft. Called first by publish_config_draft, in its transaction.
create function public.config_require_publisher(
  p_actor uuid, p_scope text, p_tenant uuid, p_module_key text, p_draft_id uuid, p_change_impact jsonb
) returns void language plpgsql set search_path = public as $fn$
declare
  v_head jsonb; v_draft jsonb; v_violation text;
begin
  if p_actor is not null and exists (select 1 from public.arc_admins a where a.user_id = p_actor) then
    perform public.config_require_operator(p_actor);
    return;
  end if;

  -- the same refusal a stranger got before this migration, in the same words.
  if p_actor is null or p_scope is distinct from 'module' or p_module_key is distinct from 'lead_recovery'
     or not exists (select 1 from public.tenant_members m
                     where m.tenant_id = p_tenant and m.user_id = p_actor and m.role = 'owner') then
    raise exception 'arc_config:forbidden: publishing configuration is an operator action' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() <> p_actor then
    raise exception 'arc_config:forbidden: the actor must be the signed-in caller' using errcode = 'P0001';
  end if;

  -- under the scope's lock and the draft's row lock, so what is checked is what is published.
  perform public.config_lock_scope(p_tenant, p_module_key);
  select d.config into v_draft from public.module_config_drafts d
   where d.id = p_draft_id and d.tenant_id = p_tenant and d.module_key = p_module_key
     for update;
  if not found then
    raise exception 'arc_config:draft_not_found: no such % draft for this tenant', p_module_key using errcode = 'P0001';
  end if;
  select v.config into v_head from public.module_config_versions v
   where v.tenant_id = p_tenant and v.module_key = p_module_key
   order by v.version desc limit 1;
  if v_head is null then
    raise exception 'arc_config:missing_published_configuration: ARC has not set this account up yet' using errcode = 'P0001';
  end if;

  v_violation := public.config_owner_wording_violation(v_head, v_draft);
  if v_violation is not null then
    raise exception 'arc_config:edit_permission_denied: an owner may publish wording only (%)', v_violation using errcode = 'P0001';
  end if;
  if coalesce((p_change_impact ->> 'requires_shadow')::boolean, true)
     or coalesce((p_change_impact ->> 'requires_reactivation')::boolean, true) then
    raise exception 'arc_config:edit_permission_denied: an owner may publish wording only' using errcode = 'P0001';
  end if;
end $fn$;

revoke all on function public.config_owner_wording_violation(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.config_require_publisher(uuid, text, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.config_owner_wording_violation(jsonb, jsonb) to service_role;
grant execute on function public.config_require_publisher(uuid, text, uuid, text, uuid, jsonb) to service_role;

-- ── 2. publish_config_draft, as 0014 wrote it except the marked clause ───────────────────
-- tests/owner-publishing.test.js reads both files and fails if anything else differs.

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
  -- 0034: the one clause that differs from 0014. an operator passes exactly as before; an
  -- owner passes only for wording, checked against the head under this scope's lock.
  perform public.config_require_publisher(p_actor, p_scope, p_tenant, p_module_key, p_draft_id, p_change_impact);
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

-- ── 3. which saved campaign the live wording came from ───────────────────────────────────

alter table public.customer_campaign_drafts
  add column published_revision integer check (published_revision is null or published_revision > 0),
  add column published_version  integer check (published_version is null or published_version > 0),
  add column published_at       timestamptz,
  add column published_by       uuid references auth.users(id) on delete set null,
  add constraint customer_campaign_drafts_published_together
    check ((published_revision is null) = (published_at is null) and (published_revision is null) = (published_version is null));

-- Called by the trusted server after the configuration version exists. One campaign of each
-- kind is the published one: marking it clears the mark on its siblings. Idempotent.
create function public.self_service_mark_campaign_published(
  p_tenant uuid, p_campaign uuid, p_revision integer, p_version integer, p_actor uuid
) returns void language plpgsql security definer set search_path = public as $fn$
declare v_kind text; v_revision integer;
begin
  if p_actor is null or not exists (select 1 from public.tenant_members m
      where m.tenant_id = p_tenant and m.user_id = p_actor and m.role = 'owner') then
    raise exception 'arc_account:forbidden: owner access required' using errcode = 'P0001';
  end if;
  select d.kind, d.revision into v_kind, v_revision from public.customer_campaign_drafts d
    where d.id = p_campaign and d.tenant_id = p_tenant for update;
  if not found then raise exception 'arc_account:not_found: campaign not found' using errcode = 'P0001'; end if;
  if p_revision is null or p_revision < 1 or p_revision > v_revision or p_version is null or p_version < 1 then
    raise exception 'arc_account:invalid: unknown campaign revision' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.module_config_versions v
      where v.tenant_id = p_tenant and v.module_key = 'lead_recovery' and v.version = p_version) then
    raise exception 'arc_account:invalid: unknown configuration version' using errcode = 'P0001';
  end if;
  update public.customer_campaign_drafts
     set published_revision = null, published_version = null, published_at = null, published_by = null
   where tenant_id = p_tenant and kind = v_kind and id <> p_campaign and published_revision is not null;
  update public.customer_campaign_drafts
     set published_revision = p_revision, published_version = p_version, published_at = now(), published_by = p_actor
   where id = p_campaign and tenant_id = p_tenant;
end $fn$;
revoke all on function public.self_service_mark_campaign_published(uuid, uuid, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.self_service_mark_campaign_published(uuid, uuid, integer, integer, uuid) to service_role;
