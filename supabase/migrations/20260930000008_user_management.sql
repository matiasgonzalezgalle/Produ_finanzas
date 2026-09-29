-- Gestión de usuarios: lista con estado de la cuenta (último acceso, invitación pendiente,
-- bloqueo) y en cuántas otras empresas está cada usuario. Crear usuarios, definir contraseñas,
-- editar nombres y eliminar cuentas lo hace la edge function tenant-users (service_role).

create or replace function public.tenant_user_list(p_tenant_id uuid)
returns table (
  user_id uuid, role public.member_role, full_name text, email text, created_at timestamptz,
  last_sign_in_at timestamptz, pending boolean, blocked boolean, other_tenants int, must_change_password boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_member(p_tenant_id) or private.is_platform_admin()) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  return query
  select m.user_id, m.role, p.full_name, coalesce(p.email, u.email::text), m.created_at,
    u.last_sign_in_at,
    u.last_sign_in_at is null,
    coalesce(u.banned_until > now(), false),
    (select count(*)::int from public.tenant_members o where o.user_id = m.user_id and o.tenant_id <> m.tenant_id),
    coalesce((u.raw_user_meta_data ->> 'must_change_password')::boolean, false)
  from public.tenant_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_tenant_id
  order by m.created_at;
end;
$$;
revoke all on function public.tenant_user_list(uuid) from public, anon;
grant execute on function public.tenant_user_list(uuid) to authenticated;
