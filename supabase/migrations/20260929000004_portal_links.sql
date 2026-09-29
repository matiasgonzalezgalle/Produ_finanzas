-- Link propio del portal por cliente/proveedor: /portal/{portal_slug}
-- El link solo personaliza la pantalla de ingreso; el acceso sigue siendo correo autorizado + código.

alter table public.counterparties add column if not exists portal_slug text;
create unique index if not exists counterparties_portal_slug_uniq on public.counterparties (portal_slug) where portal_slug is not null;

create or replace function private.slugify(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(left(trim(both '-' from regexp_replace(
    translate(lower(coalesce(p, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', '-', 'g')), 40), ''), 'portal')
$$;

-- Genera un slug nuevo: nombre + 8 caracteres aleatorios (no adivinable a partir del nombre).
create or replace function private.new_portal_slug(p_name text)
returns text language sql volatile set search_path = '' as $$
  select private.slugify(p_name) || '-' || substr(md5(gen_random_uuid()::text), 1, 8)
$$;

create or replace function private.assign_portal_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.counterparties
  set portal_slug = private.new_portal_slug(name)
  where id = new.counterparty_id and portal_slug is null;
  return new;
end;
$$;
create trigger portal_access_assign_slug after insert on public.portal_access
  for each row execute function private.assign_portal_slug();

-- Contrapartes que ya tenían acceso.
update public.counterparties c
set portal_slug = private.new_portal_slug(c.name)
where c.portal_slug is null and exists (select 1 from public.portal_access pa where pa.counterparty_id = c.id);

-- Regenerar el link (el anterior deja de funcionar). Solo owner/admin.
create or replace function public.regenerate_portal_slug(p_counterparty_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_slug text;
begin
  select tenant_id into v_tenant from public.counterparties where id = p_counterparty_id;
  if v_tenant is null or not private.can_admin(v_tenant) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  update public.counterparties set portal_slug = private.new_portal_slug(name)
  where id = p_counterparty_id returning portal_slug into v_slug;
  return v_slug;
end;
$$;
revoke all on function public.regenerate_portal_slug(uuid) from public, anon;
grant execute on function public.regenerate_portal_slug(uuid) to authenticated;

-- Información pública mínima para la pantalla de ingreso de un link.
-- Solo responde si el portal está activo y la contraparte tiene al menos un acceso vigente.
create or replace function public.portal_public_info(p_slug text)
returns table (tenant_name text, counterparty_name text, message text)
language sql stable security definer set search_path = '' as $$
  select coalesce(t.legal_name, t.name), c.name, t.portal_message
  from public.counterparties c
  join public.tenants t on t.id = c.tenant_id and t.portal_enabled
  where c.portal_slug = p_slug
    and exists (select 1 from public.portal_access pa where pa.counterparty_id = c.id and pa.enabled)
$$;
revoke all on function public.portal_public_info(text) from public;
grant execute on function public.portal_public_info(text) to anon, authenticated;

-- portal_my_accounts ahora incluye el slug (cambia el tipo de retorno: se recrea).
drop function public.portal_my_accounts();
create function public.portal_my_accounts()
returns table (
  access_id uuid,
  tenant_id uuid,
  tenant_name text,
  counterparty_id uuid,
  counterparty_name text,
  is_supplier boolean,
  is_customer boolean,
  portal_slug text
)
language sql stable security definer set search_path = '' as $$
  select pa.id, t.id, coalesce(t.legal_name, t.name), c.id, c.name, c.is_supplier, c.is_customer, c.portal_slug
  from public.portal_access pa
  join public.tenants t on t.id = pa.tenant_id and t.portal_enabled
  join public.counterparties c on c.id = pa.counterparty_id
  where pa.enabled and pa.email = private.session_email()
  order by t.name, c.name
$$;
revoke all on function public.portal_my_accounts() from public, anon;
grant execute on function public.portal_my_accounts() to authenticated;
