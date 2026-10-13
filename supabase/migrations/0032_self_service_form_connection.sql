-- A self-service owner can publish one scoped, rotatable website-form key. The key is
-- intentionally public in the embed; an origin allowlist and 0030's atomic caps protect it.
create function public.self_service_form_status(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path=public as $fn$
declare v_key public.intake_keys%rowtype; v_module public.tenant_modules%rowtype;
begin
  if auth.uid() is null or not exists(select 1 from public.tenant_members m
    where m.tenant_id=p_tenant and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'arc_form:forbidden: owner access required' using errcode='P0001';
  end if;
  select * into v_key from public.intake_keys where tenant_id=p_tenant and revoked_at is null
    order by created_at desc limit 1;
  select * into v_module from public.tenant_modules
    where tenant_id=p_tenant and module_key='lead_recovery';
  return jsonb_build_object('public_key',v_key.public_key,'origins',coalesce(to_jsonb(v_key.allowed_origins),'[]'::jsonb),
    'last_used_at',v_key.last_used_at,'module_state',coalesce(v_module.state,'unselected'),
    'module_health',coalesce(v_module.health_status,'unverified'),
    'module_health_reason',v_module.health_reason);
end $fn$;

create function public.self_service_configure_form(p_tenant uuid,p_origin text) returns jsonb
language plpgsql security definer set search_path=public as $fn$
declare v_origin text := lower(btrim(coalesce(p_origin,''))); v_key public.intake_keys%rowtype;
begin
  if auth.uid() is null or not exists(select 1 from public.tenant_members m
    where m.tenant_id=p_tenant and m.user_id=auth.uid() and m.role='owner') then
    raise exception 'arc_form:forbidden: owner access required' using errcode='P0001';
  end if;
  if v_origin<>'' and v_origin !~ '^https://[a-z0-9][a-z0-9.-]{1,250}(:[0-9]{2,5})?$'
    and v_origin !~ '^http://localhost(:[0-9]{2,5})?$' then
    raise exception 'arc_form:invalid: enter the website origin without a path' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('arc_form:'||p_tenant::text,0));
  select * into v_key from public.intake_keys where tenant_id=p_tenant and revoked_at is null
    order by created_at desc limit 1 for update;
  if v_origin='' then
    update public.intake_keys set revoked_at=now() where tenant_id=p_tenant and revoked_at is null;
    return public.self_service_form_status(p_tenant);
  end if;
  if v_key.id is null then
    insert into public.intake_keys(tenant_id,public_key,label,allowed_origins)
      values(p_tenant,'arcw_'||encode(gen_random_bytes(24),'hex'),'Owner website form',array[v_origin]);
  else
    update public.intake_keys set allowed_origins=array[v_origin] where id=v_key.id;
  end if;
  return public.self_service_form_status(p_tenant);
end $fn$;

revoke all on function public.self_service_form_status(uuid) from public,anon;
revoke all on function public.self_service_configure_form(uuid,text) from public,anon;
grant execute on function public.self_service_form_status(uuid) to authenticated;
grant execute on function public.self_service_configure_form(uuid,text) to authenticated;
