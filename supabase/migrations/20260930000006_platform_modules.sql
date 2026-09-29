-- Plataforma modular: superadministradores, módulos activos por empresa y estado de la empresa.
-- Los superadministradores administran las empresas desde /admin (separado de la configuración
-- de cada empresa) y deciden qué módulos tiene cada una.

create table private.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
revoke all on private.platform_admins from public, anon, authenticated;

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins where user_id = (select auth.uid()))
$$;
revoke all on function private.is_platform_admin() from public, anon;
grant execute on function private.is_platform_admin() to authenticated;

create or replace function public.am_i_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin()
$$;
revoke all on function public.am_i_platform_admin() from public, anon;
grant execute on function public.am_i_platform_admin() to authenticated;

-- La edge function platform-admin valida al usuario con esta función (solo service_role).
create or replace function public.is_platform_admin_user(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins where user_id = p_user)
$$;
revoke all on function public.is_platform_admin_user(uuid) from public, anon, authenticated;
grant execute on function public.is_platform_admin_user(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Módulos y estado de la empresa
-- ---------------------------------------------------------------------------
create or replace function private.known_modules()
returns text[] language sql immutable set search_path = '' as $$
  select array['cuentas_por_pagar', 'cuentas_por_cobrar', 'ordenes_compra', 'cobranza', 'tesoreria',
               'portal', 'sii', 'mercadopago', 'conciliacion']
$$;

alter table public.tenants
  add column modules text[] not null default array['cuentas_por_pagar', 'cuentas_por_cobrar', 'tesoreria'],
  add column status text not null default 'active' check (status in ('active', 'suspended')),
  add column admin_notes text;
alter table public.tenants add constraint tenants_known_modules check (modules <@ private.known_modules());

-- Las empresas existentes conservan todo lo que ya usaban (la conciliación se activa aparte).
update public.tenants set modules = array['cuentas_por_pagar', 'cuentas_por_cobrar', 'ordenes_compra', 'cobranza', 'tesoreria', 'portal', 'sii', 'mercadopago'];

create or replace function private.has_module(t uuid, p_module text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tenants where id = t and p_module = any (modules))
$$;
revoke all on function private.has_module(uuid, text) from public, anon;
grant execute on function private.has_module(uuid, text) to authenticated, service_role;

-- Solo un superadministrador cambia módulos, estado y notas internas.
create or replace function private.tenants_protect_platform_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.modules is distinct from old.modules or new.status is distinct from old.status or new.admin_notes is distinct from old.admin_notes)
     and current_user in ('authenticated', 'anon') and not private.is_platform_admin() then
    raise exception 'Solo el administrador de la plataforma puede cambiar los módulos o el estado de la empresa' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tenants_protect_platform_fields before update on public.tenants
  for each row execute function private.tenants_protect_platform_fields();

-- Empresa suspendida: sus usuarios pueden ver, pero no modificar nada.
create or replace function private.can_write(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(t, array['owner', 'admin', 'finance']::public.member_role[])
    and exists (select 1 from public.tenants where id = t and status = 'active')
$$;
create or replace function private.can_admin(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(t, array['owner', 'admin']::public.member_role[])
    and exists (select 1 from public.tenants where id = t and status = 'active')
$$;

-- Registrar requiere el módulo activo.
drop policy documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  (select private.can_write(tenant_id))
  and private.has_module(tenant_id, case direction when 'payable' then 'cuentas_por_pagar' else 'cuentas_por_cobrar' end)
);
drop policy payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated with check (
  (select private.can_write(tenant_id))
  and private.has_module(tenant_id, case direction when 'out' then 'cuentas_por_pagar' else 'cuentas_por_cobrar' end)
);
drop policy purchase_orders_insert on public.purchase_orders;
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated with check (
  (select private.can_write(tenant_id)) and private.has_module(tenant_id, 'ordenes_compra')
);
drop policy collection_rules_insert on public.collection_rules;
create policy collection_rules_insert on public.collection_rules for insert to authenticated with check (
  (select private.can_write(tenant_id)) and private.has_module(tenant_id, 'cobranza')
);
drop policy collection_events_insert on public.collection_events;
create policy collection_events_insert on public.collection_events for insert to authenticated with check (
  (select private.can_write(tenant_id)) and private.has_module(tenant_id, 'cobranza')
);

-- Recordatorios de cobranza: solo empresas con el módulo activo.
create or replace function private.rule_applies(r public.collection_rules, c public.counterparties)
returns boolean language sql stable security definer set search_path = '' as $$
  select c.is_customer and not c.collection_paused
    and private.has_module(r.tenant_id, 'cobranza')
    and exists (select 1 from public.tenants t where t.id = r.tenant_id and t.status = 'active')
    and coalesce((select s.enabled from public.counterparty_rule_settings s where s.counterparty_id = c.id and s.rule_id = r.id), true)
    and case r.audience
      when 'all' then true
      when 'tags' then c.tags && r.audience_tags
      else c.id = any(r.audience_ids)
    end
$$;

-- Portal financiero: requiere el módulo.
create or replace function private.portal_has_access(p_tenant uuid, p_counterparty uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.portal_access pa
    join public.tenants t on t.id = pa.tenant_id and t.portal_enabled and 'portal' = any (t.modules) and t.status = 'active'
    where pa.tenant_id = p_tenant
      and pa.counterparty_id = p_counterparty
      and pa.enabled
      and (pa.expires_at is null or pa.expires_at > now())
      and (
        (pa.kind = 'email' and pa.email = private.session_email())
        or (pa.kind = 'code' and exists (
          select 1 from public.portal_code_sessions s
          where s.access_id = pa.id and s.user_id = (select auth.uid()) and s.expires_at > now()
        ))
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- Consola del superadministrador
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_tenants()
returns table (
  id uuid, name text, legal_name text, tax_id text, country public.country_code, base_currency public.currency_code,
  modules text[], status text, admin_notes text, portal_enabled boolean, created_at timestamptz,
  member_count int, owner_email text, owner_name text, document_count int, last_document_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  return query
  select t.id, t.name, t.legal_name, t.tax_id, t.country, t.base_currency, t.modules, t.status, t.admin_notes, t.portal_enabled, t.created_at,
    (select count(*)::int from public.tenant_members m where m.tenant_id = t.id),
    (select p.email from public.tenant_members m join public.profiles p on p.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1),
    (select p.full_name from public.tenant_members m join public.profiles p on p.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1),
    (select count(*)::int from public.documents d where d.tenant_id = t.id),
    (select max(d.created_at) from public.documents d where d.tenant_id = t.id)
  from public.tenants t
  order by t.created_at desc;
end;
$$;
revoke all on function public.admin_list_tenants() from public, anon;
grant execute on function public.admin_list_tenants() to authenticated;

create or replace function public.admin_update_tenant(
  p_id uuid, p_name text, p_legal_name text, p_tax_id text, p_modules text[], p_status text, p_admin_notes text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'El nombre es obligatorio';
  end if;
  if not (p_modules <@ private.known_modules()) then
    raise exception 'Módulo desconocido';
  end if;
  update public.tenants set
    name = trim(p_name), legal_name = nullif(trim(p_legal_name), ''), tax_id = nullif(trim(p_tax_id), ''),
    modules = (select coalesce(array_agg(distinct m order by m), '{}') from unnest(p_modules) m),
    status = p_status, admin_notes = nullif(trim(p_admin_notes), '')
  where id = p_id;
  if not found then
    raise exception 'Empresa no encontrada';
  end if;
end;
$$;
revoke all on function public.admin_update_tenant(uuid, text, text, text, text[], text, text) from public, anon;
grant execute on function public.admin_update_tenant(uuid, text, text, text, text[], text, text) to authenticated;

create or replace function public.admin_tenant_members(p_id uuid)
returns table (user_id uuid, role public.member_role, email text, full_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  return query
  select m.user_id, m.role, p.email, p.full_name, m.created_at
  from public.tenant_members m left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_id order by m.created_at;
end;
$$;
revoke all on function public.admin_tenant_members(uuid) from public, anon;
grant execute on function public.admin_tenant_members(uuid) to authenticated;

create or replace function public.admin_list_platform_admins()
returns table (user_id uuid, email text, full_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  return query
  select a.user_id, p.email, p.full_name, a.created_at
  from private.platform_admins a left join public.profiles p on p.id = a.user_id order by a.created_at;
end;
$$;
revoke all on function public.admin_list_platform_admins() from public, anon;
grant execute on function public.admin_list_platform_admins() to authenticated;

create or replace function public.admin_set_platform_admin(p_email text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if not private.is_platform_admin() then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No existe un usuario con ese correo. Debe registrarse primero.';
  end if;
  if p_enabled then
    insert into private.platform_admins (user_id, created_by) values (v_user, auth.uid()) on conflict do nothing;
  else
    if v_user = auth.uid() then
      raise exception 'No puedes quitarte a ti mismo';
    end if;
    delete from private.platform_admins where user_id = v_user;
  end if;
end;
$$;
revoke all on function public.admin_set_platform_admin(text, boolean) from public, anon;
grant execute on function public.admin_set_platform_admin(text, boolean) to authenticated;
