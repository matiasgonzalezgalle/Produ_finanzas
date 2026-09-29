-- Acceso al portal con código (para usuarios sin correo).
-- La empresa genera un código por persona; solo se guarda su hash. El usuario externo
-- inicia una sesión anónima de Supabase y canjea el código en el link de la contraparte;
-- el servidor valida y crea una sesión temporal ligada a ese acceso.

alter table public.portal_access
  add column kind text not null default 'email' check (kind in ('email', 'code')),
  add column label text,
  add column code_hash text,
  add column code_hint text,
  add column expires_at timestamptz;

alter table public.portal_access alter column email drop not null;
alter table public.portal_access drop constraint if exists portal_access_email_check;
alter table public.portal_access add constraint portal_access_email_format
  check (email is null or (email = lower(trim(email)) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));
alter table public.portal_access add constraint portal_access_kind_fields check (
  (kind = 'email' and email is not null and code_hash is null)
  or (kind = 'code' and email is null and code_hash is not null and length(trim(coalesce(label, ''))) > 0)
);

-- El hash nunca sale del servidor: los usuarios internos no pueden leerlo.
revoke select on public.portal_access from authenticated;
grant select (id, tenant_id, counterparty_id, email, enabled, last_access_at, created_by, created_at, kind, label, code_hint, expires_at)
  on public.portal_access to authenticated;
-- Los códigos solo se crean/cambian vía RPC (el hash lo calcula el servidor).
revoke insert, update on public.portal_access from authenticated;
grant insert (tenant_id, counterparty_id, email) on public.portal_access to authenticated;
grant update (enabled) on public.portal_access to authenticated;

create table public.portal_code_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  access_id uuid not null references public.portal_access (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours'
);
create index portal_code_sessions_user_idx on public.portal_code_sessions (user_id, expires_at);
alter table public.portal_code_sessions enable row level security;
revoke all on public.portal_code_sessions from anon, authenticated;

create table public.portal_code_attempts (
  id bigint generated always as identity primary key,
  counterparty_id uuid not null,
  succeeded boolean not null,
  at timestamptz not null default now()
);
create index portal_code_attempts_idx on public.portal_code_attempts (counterparty_id, at desc);
alter table public.portal_code_attempts enable row level security;
revoke all on public.portal_code_attempts from anon, authenticated;

create or replace function private.portal_code_hash(p_access_id uuid, p_code text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_access_id::text || ':' || upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')), 'UTF8')), 'hex')
$$;

-- Código de 8 caracteres sin ambigüedades (sin 0/O, 1/I/L).
create or replace function private.new_portal_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  bytes bytea := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
  result text := '';
begin
  for i in 0..7 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return substr(result, 1, 4) || '-' || substr(result, 5, 4);
end;
$$;

-- Crear un acceso con código. Solo owner/admin. Devuelve el código en claro una única vez.
create or replace function public.create_portal_code(p_counterparty_id uuid, p_label text, p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_id uuid := gen_random_uuid();
  v_code text := private.new_portal_code();
  v_slug text;
begin
  select tenant_id into v_tenant from public.counterparties where id = p_counterparty_id;
  if v_tenant is null or not private.can_admin(v_tenant) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'Indica a quién corresponde el código';
  end if;
  insert into public.portal_access (id, tenant_id, counterparty_id, kind, label, code_hash, code_hint, expires_at)
  values (v_id, v_tenant, p_counterparty_id, 'code', trim(p_label), private.portal_code_hash(v_id, v_code), right(v_code, 2), p_expires_at);
  select portal_slug into v_slug from public.counterparties where id = p_counterparty_id;
  return jsonb_build_object('access_id', v_id, 'code', v_code, 'slug', v_slug);
end;
$$;

-- Generar un código nuevo para un acceso existente (invalida el anterior y sus sesiones).
create or replace function public.regenerate_portal_code(p_access_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_access public.portal_access;
  v_code text := private.new_portal_code();
  v_slug text;
begin
  select * into v_access from public.portal_access where id = p_access_id;
  if v_access.id is null or v_access.kind <> 'code' or not private.can_admin(v_access.tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  update public.portal_access set code_hash = private.portal_code_hash(id, v_code), code_hint = right(v_code, 2) where id = p_access_id;
  delete from public.portal_code_sessions where access_id = p_access_id;
  select portal_slug into v_slug from public.counterparties where id = v_access.counterparty_id;
  return jsonb_build_object('access_id', p_access_id, 'code', v_code, 'slug', v_slug);
end;
$$;

-- Canjear un código en el link de la contraparte. Lo llama una sesión (anónima o no) de Supabase.
-- No lanza excepción al fallar: así el intento fallido queda registrado para el límite.
create or replace function public.portal_redeem_code(p_slug text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cp public.counterparties;
  v_access public.portal_access;
  v_failures int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión no iniciada');
  end if;
  select c.* into v_cp from public.counterparties c
    join public.tenants t on t.id = c.tenant_id and t.portal_enabled
    where c.portal_slug = p_slug;
  if v_cp.id is null then
    return jsonb_build_object('ok', false, 'error', 'Este link no está disponible');
  end if;

  select count(*) into v_failures from public.portal_code_attempts
    where counterparty_id = v_cp.id and not succeeded and at > now() - interval '15 minutes';
  if v_failures >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  end if;

  select pa.* into v_access from public.portal_access pa
    where pa.counterparty_id = v_cp.id and pa.kind = 'code' and pa.enabled
      and (pa.expires_at is null or pa.expires_at > now())
      and pa.code_hash = private.portal_code_hash(pa.id, p_code)
    limit 1;

  insert into public.portal_code_attempts (counterparty_id, succeeded) values (v_cp.id, v_access.id is not null);
  if v_access.id is null then
    return jsonb_build_object('ok', false, 'error', 'Código inválido o vencido');
  end if;

  delete from public.portal_code_sessions where user_id = auth.uid() and expires_at < now();
  insert into public.portal_code_sessions (user_id, access_id) values (auth.uid(), v_access.id);
  update public.portal_access set last_access_at = now() where id = v_access.id;
  return jsonb_build_object('ok', true, 'label', v_access.label);
end;
$$;

revoke all on function public.create_portal_code(uuid, text, timestamptz), public.regenerate_portal_code(uuid), public.portal_redeem_code(text, text) from public, anon;
grant execute on function public.create_portal_code(uuid, text, timestamptz), public.regenerate_portal_code(uuid), public.portal_redeem_code(text, text) to authenticated;

-- Acceso vigente: por correo verificado o por sesión de código activa.
create or replace function private.portal_has_access(p_tenant uuid, p_counterparty uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.portal_access pa
    join public.tenants t on t.id = pa.tenant_id and t.portal_enabled
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
  where pa.enabled
    and (pa.expires_at is null or pa.expires_at > now())
    and (
      (pa.kind = 'email' and pa.email = private.session_email())
      or (pa.kind = 'code' and exists (
        select 1 from public.portal_code_sessions s
        where s.access_id = pa.id and s.user_id = (select auth.uid()) and s.expires_at > now()
      ))
    )
  order by t.name, c.name
$$;
revoke all on function public.portal_my_accounts() from public, anon;
grant execute on function public.portal_my_accounts() to authenticated;

-- El último acceso por correo se actualiza en portal_snapshot; con código, al canjear.
-- Comentarios del portal: el autor de una sesión con código es la etiqueta del acceso.
create or replace function public.portal_add_comment(p_document_id uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
  v_author text;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if v_doc.id is null or v_doc.status = 'draft' or not private.portal_has_access(v_doc.tenant_id, v_doc.counterparty_id) then
    raise exception 'Sin acceso a este documento' using errcode = '42501';
  end if;
  v_author := coalesce(private.session_email(), (
    select pa.label from public.portal_code_sessions s join public.portal_access pa on pa.id = s.access_id
    where s.user_id = auth.uid() and s.expires_at > now() and pa.counterparty_id = v_doc.counterparty_id
    order by s.created_at desc limit 1
  ));
  insert into public.document_comments (tenant_id, document_id, visibility, author_kind, author_id, author_name, body)
  values (v_doc.tenant_id, p_document_id, 'shared', 'counterparty', auth.uid(), v_author, trim(p_body));
end;
$$;

-- Las sesiones anónimas (portal con código) no pueden crear empresas.
create or replace function public.create_tenant(
  p_name text,
  p_country public.country_code,
  p_legal_name text default null,
  p_tax_id text default null
) returns public.tenants
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tenant public.tenants;
begin
  if v_uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'No autenticado' using errcode = '42501';
  end if;
  insert into public.tenants (name, legal_name, tax_id, country, base_currency, timezone)
  values (
    trim(p_name), p_legal_name, p_tax_id, p_country,
    case p_country when 'CL' then 'CLP'::public.currency_code else 'PEN'::public.currency_code end,
    case p_country when 'CL' then 'America/Santiago' else 'America/Lima' end
  )
  returning * into v_tenant;
  insert into public.tenant_members (tenant_id, user_id, role) values (v_tenant.id, v_uid, 'owner');
  return v_tenant;
end;
$$;
