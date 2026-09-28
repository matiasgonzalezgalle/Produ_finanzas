-- Produ Finanzas: esquema base multi-tenant.
-- Principios:
--   * Toda tabla de negocio tiene tenant_id y RLS por membresía.
--   * Montos en bigint, en la unidad mínima de su moneda (CLP=0, PEN/USD/EUR=2, UF=4 decimales).
--   * Pagos se asignan a documentos por ID (payment_allocations), nunca por referencia de texto.
--   * Secretos de integraciones viven en tablas sin acceso para anon/authenticated.


create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.country_code as enum ('CL', 'PE');
create type public.currency_code as enum ('CLP', 'PEN', 'USD', 'EUR', 'UF');
create type public.member_role as enum ('owner', 'admin', 'finance', 'viewer');
create type public.document_direction as enum ('payable', 'receivable');
create type public.document_status as enum ('draft', 'open', 'void');
create type public.document_type as enum (
  'factura', 'factura_exenta', 'boleta', 'nota_credito', 'nota_debito', 'honorarios', 'invoice', 'otro'
);
create type public.payment_direction as enum ('in', 'out');
create type public.detraction_status as enum ('no_aplica', 'pendiente', 'depositada', 'observada');

create or replace function private.currency_decimals(c public.currency_code)
returns int language sql immutable as $$
  select case c when 'CLP' then 0 when 'UF' then 4 else 2 end
$$;

-- ---------------------------------------------------------------------------
-- Tenants y membresías
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  legal_name text,
  tax_id text,
  country public.country_code not null,
  base_currency public.currency_code not null,
  timezone text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- Helpers de autorización. SECURITY DEFINER para evitar recursión de RLS en tenant_members.
create or replace function private.is_member(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = t and m.user_id = (select auth.uid())
  )
$$;

create or replace function private.has_role(t uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = any (roles)
  )
$$;

create or replace function private.can_write(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(t, array['owner', 'admin', 'finance']::public.member_role[])
$$;

create or replace function private.can_admin(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(t, array['owner', 'admin']::public.member_role[])
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.has_role(uuid, public.member_role[]),
  private.can_write(uuid), private.can_admin(uuid), private.currency_decimals(public.currency_code)
  to authenticated;

-- Crear empresa: el usuario autenticado queda como owner.
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
  if v_uid is null then
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
revoke all on function public.create_tenant(text, public.country_code, text, text) from public, anon;
grant execute on function public.create_tenant(text, public.country_code, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Contrapartes (proveedores y clientes)
-- ---------------------------------------------------------------------------
create table public.counterparties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  legal_name text,
  country text not null default 'CL' check (country ~ '^[A-Z]{2}$'),
  tax_id text,
  is_supplier boolean not null default false,
  is_customer boolean not null default false,
  tags text[] not null default '{}',
  email text,
  phone text,
  address text,
  default_currency public.currency_code,
  payment_terms_days int check (payment_terms_days between 0 and 365),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint counterparty_has_role check (is_supplier or is_customer),
  -- id duplicado para FKs compuestas que garantizan mismo tenant
  unique (tenant_id, id)
);
-- Un tax_id (normalizado por la app) no se repite dentro del tenant y país.
create unique index counterparties_tax_id_uniq on public.counterparties (tenant_id, country, tax_id)
  where tax_id is not null and tax_id <> '';
create index counterparties_tenant_name_idx on public.counterparties (tenant_id, name);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  counterparty_id uuid not null,
  name text not null,
  position text,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id) on delete cascade
);
create index contacts_counterparty_idx on public.contacts (tenant_id, counterparty_id);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  counterparty_id uuid not null,
  bank_name text not null,
  account_type text,
  account_number text not null,
  holder_name text,
  holder_tax_id text,
  email text,
  currency public.currency_code,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Documentos (CxP y CxC)
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.document_direction not null,
  counterparty_id uuid not null,
  doc_type public.document_type not null,
  folio text not null check (length(trim(folio)) between 1 and 60),
  currency public.currency_code not null,
  net_amount bigint not null default 0 check (net_amount >= 0),
  exempt_amount bigint not null default 0 check (exempt_amount >= 0),
  tax_amount bigint not null default 0 check (tax_amount >= 0),
  total_amount bigint not null check (total_amount >= 0),
  issue_date date not null,
  due_date date,
  status public.document_status not null default 'open',
  -- Nota de crédito: documento al que resta.
  applies_to_id uuid,
  detraction_rate numeric(5, 2) not null default 0 check (detraction_rate between 0 and 100),
  detraction_amount bigint not null default 0 check (detraction_amount >= 0),
  detraction_status public.detraction_status not null default 'no_aplica',
  detraction_ref text,
  description text,
  external_source text,
  external_id text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id),
  foreign key (tenant_id, applies_to_id) references public.documents (tenant_id, id),
  constraint documents_due_after_issue check (due_date is null or due_date >= issue_date),
  constraint documents_detraction_le_total check (detraction_amount <= total_amount),
  constraint documents_credit_note_target check ((doc_type = 'nota_credito') = (applies_to_id is not null))
);
-- Un mismo folio no se repite para la misma contraparte y tipo.
create unique index documents_folio_uniq on public.documents (tenant_id, direction, counterparty_id, doc_type, folio)
  where status <> 'void';
create unique index documents_external_uniq on public.documents (tenant_id, external_source, external_id)
  where external_id is not null;
create index documents_tenant_due_idx on public.documents (tenant_id, direction, due_date);
create index documents_counterparty_idx on public.documents (tenant_id, counterparty_id);

-- La nota de crédito debe ser de la misma dirección, contraparte y moneda.
create or replace function private.check_credit_note()
returns trigger language plpgsql set search_path = '' as $$
declare
  target public.documents;
begin
  if new.applies_to_id is null then return new; end if;
  select * into target from public.documents where id = new.applies_to_id and tenant_id = new.tenant_id;
  if target.id is null then
    raise exception 'Documento de referencia no existe';
  end if;
  if target.doc_type = 'nota_credito' then
    raise exception 'Una nota de crédito no puede aplicarse a otra nota de crédito';
  end if;
  if target.direction <> new.direction or target.counterparty_id <> new.counterparty_id or target.currency <> new.currency then
    raise exception 'La nota de crédito debe tener la misma dirección, contraparte y moneda que el documento';
  end if;
  return new;
end;
$$;
create trigger documents_check_credit_note before insert or update on public.documents
  for each row execute function private.check_credit_note();

-- ---------------------------------------------------------------------------
-- Pagos, cobros y asignaciones
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.payment_direction not null,
  counterparty_id uuid,
  currency public.currency_code not null,
  amount bigint not null check (amount > 0),
  paid_on date not null,
  method text not null default 'transferencia',
  reference text,
  notes text,
  source text not null default 'manual',
  external_id text,
  status text not null default 'confirmed' check (status in ('confirmed', 'void')),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id)
);
-- Idempotencia de pagos que llegan desde integraciones (webhooks reintentados).
create unique index payments_external_uniq on public.payments (tenant_id, source, external_id)
  where external_id is not null;
create index payments_tenant_date_idx on public.payments (tenant_id, direction, paid_on desc);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  payment_id uuid not null,
  document_id uuid not null,
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, document_id),
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id)
);
create index payment_allocations_document_idx on public.payment_allocations (document_id);

-- Saldo directo pendiente de un documento (sin la asignación que se está editando).
create or replace function private.document_pending(p_document_id uuid, p_exclude_allocation uuid default null)
returns bigint language sql stable set search_path = '' as $$
  select greatest(0,
    d.total_amount
    - coalesce((select sum(c.total_amount) from public.documents c
                where c.applies_to_id = d.id and c.status = 'open'), 0)
    - d.detraction_amount
    - coalesce((select sum(a.amount) from public.payment_allocations a
                join public.payments p on p.id = a.payment_id and p.status = 'confirmed'
                where a.document_id = d.id and a.id is distinct from p_exclude_allocation), 0)
  )
  from public.documents d where d.id = p_document_id
$$;

-- Reglas de asignación: misma moneda, dirección compatible, sin sobrepago.
create or replace function private.check_allocation()
returns trigger language plpgsql set search_path = '' as $$
declare
  pay public.payments;
  doc public.documents;
  allocated bigint;
begin
  select * into pay from public.payments where id = new.payment_id and tenant_id = new.tenant_id for update;
  select * into doc from public.documents where id = new.document_id and tenant_id = new.tenant_id for update;
  if pay.id is null or doc.id is null then
    raise exception 'Pago o documento no existe en esta empresa';
  end if;
  if doc.status <> 'open' then
    raise exception 'Solo se pueden pagar documentos abiertos';
  end if;
  if doc.doc_type = 'nota_credito' then
    raise exception 'Una nota de crédito no se paga: se aplica al documento';
  end if;
  if pay.currency <> doc.currency then
    raise exception 'La moneda del pago (%) no coincide con la del documento (%)', pay.currency, doc.currency;
  end if;
  if (pay.direction = 'out') <> (doc.direction = 'payable') then
    raise exception 'Un pago debe ir a una cuenta por pagar y un cobro a una cuenta por cobrar';
  end if;
  if pay.counterparty_id is not null and pay.counterparty_id <> doc.counterparty_id then
    raise exception 'El pago y el documento son de contrapartes distintas';
  end if;
  select coalesce(sum(amount), 0) into allocated from public.payment_allocations
    where payment_id = new.payment_id and id is distinct from new.id;
  if allocated + new.amount > pay.amount then
    raise exception 'La asignación supera el monto del pago';
  end if;
  if new.amount > private.document_pending(new.document_id, new.id) then
    raise exception 'La asignación supera el saldo pendiente del documento';
  end if;
  return new;
end;
$$;
create trigger payment_allocations_check before insert or update on public.payment_allocations
  for each row execute function private.check_allocation();

-- ---------------------------------------------------------------------------
-- Vista de saldos (respeta RLS del usuario que consulta)
-- ---------------------------------------------------------------------------
create or replace view public.document_balances with (security_invoker = true) as
with credits as (
  select applies_to_id as document_id, sum(total_amount) as amount
  from public.documents where applies_to_id is not null and status = 'open'
  group by applies_to_id
),
paid as (
  select a.document_id, sum(a.amount) as amount
  from public.payment_allocations a
  join public.payments p on p.id = a.payment_id and p.status = 'confirmed'
  group by a.document_id
),
base as (
  select
    d.*,
    c.name as counterparty_name,
    c.tax_id as counterparty_tax_id,
    coalesce(cr.amount, 0) as credits_amount,
    coalesce(pd.amount, 0) as paid_amount,
    greatest(0, d.total_amount - coalesce(cr.amount, 0)) as net_total,
    (now() at time zone t.timezone)::date as today
  from public.documents d
  join public.tenants t on t.id = d.tenant_id
  join public.counterparties c on c.id = d.counterparty_id
  left join credits cr on cr.document_id = d.id
  left join paid pd on pd.document_id = d.id
)
select
  b.*,
  case when b.status = 'open' and b.doc_type <> 'nota_credito'
    then greatest(0, b.net_total - b.detraction_amount - b.paid_amount) else 0 end as pending_amount,
  case
    when b.status = 'void' then 'anulado'
    when b.status = 'draft' then 'borrador'
    when b.doc_type = 'nota_credito' then 'aplicada'
    when greatest(0, b.net_total - b.detraction_amount - b.paid_amount) = 0 then 'pagado'
    when b.due_date is not null and b.due_date < b.today then 'vencido'
    when b.paid_amount > 0 then 'parcial'
    else 'pendiente'
  end as payment_status,
  case when b.status = 'open' and b.due_date is not null and b.due_date < b.today
    and greatest(0, b.net_total - b.detraction_amount - b.paid_amount) > 0
    then b.today - b.due_date else 0 end as days_overdue
from base b;

-- ---------------------------------------------------------------------------
-- Integraciones
-- ---------------------------------------------------------------------------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('mercadopago')),
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  -- Solo datos NO secretos (ej. user_id de la cuenta, país, últimos 4 del token).
  public_config jsonb not null default '{}',
  last_event_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);

-- Secretos: sin políticas RLS y sin grants para anon/authenticated. Solo service_role (edge functions).
create table public.integration_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  secrets jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document_id uuid not null,
  provider text not null,
  currency public.currency_code not null,
  amount bigint not null check (amount > 0),
  url text,
  external_id text,
  status text not null default 'active' check (status in ('active', 'paid', 'expired', 'cancelled')),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade
);
create index payment_links_document_idx on public.payment_links (tenant_id, document_id);

-- Bandeja de webhooks: idempotencia y trazabilidad. Solo service_role.
create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  tenant_id uuid references public.tenants (id) on delete set null,
  event_key text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (provider, event_key)
);

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  -- Sin FK: el log sobrevive (y no bloquea) el borrado de la empresa.
  tenant_id uuid not null,
  actor uuid default auth.uid(),
  action text not null,
  entity text not null,
  entity_id uuid,
  data jsonb,
  at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, at desc);

create or replace function private.audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log (tenant_id, action, entity, entity_id, data)
  values (
    (row_data ->> 'tenant_id')::uuid,
    lower(tg_op),
    tg_table_name,
    (row_data ->> 'id')::uuid,
    case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else row_data end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_documents after insert or update or delete on public.documents
  for each row execute function private.audit();
create trigger audit_payments after insert or update or delete on public.payments
  for each row execute function private.audit();
create trigger audit_payment_allocations after insert or update or delete on public.payment_allocations
  for each row execute function private.audit();
create trigger audit_counterparties after insert or update or delete on public.counterparties
  for each row execute function private.audit();
create trigger audit_tenant_members after insert or update or delete on public.tenant_members
  for each row execute function private.audit();

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger touch_counterparties before update on public.counterparties
  for each row execute function private.touch_updated_at();
create trigger touch_documents before update on public.documents
  for each row execute function private.touch_updated_at();
create trigger touch_integration_connections before update on public.integration_connections
  for each row execute function private.touch_updated_at();

-- Perfil automático al registrarse.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.tenant_members enable row level security;
alter table public.counterparties enable row level security;
alter table public.contacts enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.documents enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.integration_connections enable row level security;
alter table public.payment_links enable row level security;
alter table public.audit_log enable row level security;
alter table public.integration_secrets enable row level security;
alter table public.webhook_events enable row level security;

-- tenants
create policy tenants_select on public.tenants for select to authenticated
  using ((select private.is_member(id)));
create policy tenants_update on public.tenants for update to authenticated
  using ((select private.can_admin(id))) with check ((select private.can_admin(id)));

-- profiles: el propio y los de compañeros de empresa
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.tenant_members mine
      join public.tenant_members theirs on theirs.tenant_id = mine.tenant_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id
    )
  );
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- tenant_members
create policy members_select on public.tenant_members for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy members_insert on public.tenant_members for insert to authenticated
  with check ((select private.can_admin(tenant_id)) and role <> 'owner');
create policy members_update on public.tenant_members for update to authenticated
  using ((select private.can_admin(tenant_id)) and role <> 'owner')
  with check ((select private.can_admin(tenant_id)) and role <> 'owner');
create policy members_delete on public.tenant_members for delete to authenticated
  using ((select private.can_admin(tenant_id)) and role <> 'owner');

-- Tablas de negocio: leer = miembro; escribir = owner/admin/finance.
do $$
declare
  t text;
begin
  foreach t in array array['counterparties', 'contacts', 'bank_accounts', 'documents', 'payments', 'payment_allocations', 'payment_links']
  loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using ((select private.is_member(tenant_id)))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select private.can_write(tenant_id))) with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select private.can_write(tenant_id)))', t);
  end loop;
end;
$$;

-- Integraciones: todos los miembros ven el estado; solo admins cambian (la conexión se crea vía edge function).
create policy integration_connections_select on public.integration_connections for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy integration_connections_update on public.integration_connections for update to authenticated
  using ((select private.can_admin(tenant_id))) with check ((select private.can_admin(tenant_id)));
create policy integration_connections_delete on public.integration_connections for delete to authenticated
  using ((select private.can_admin(tenant_id)));

-- Auditoría: solo lectura para admins; se escribe por trigger.
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.can_admin(tenant_id)));

-- Grants explícitos: anon no toca nada; authenticated solo lo que necesita (RLS filtra filas).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema private from anon, public;
grant execute on function private.is_member(uuid), private.has_role(uuid, public.member_role[]),
  private.can_write(uuid), private.can_admin(uuid), private.currency_decimals(public.currency_code),
  private.document_pending(uuid, uuid)
  to authenticated, service_role;
grant select, insert, update, delete on public.counterparties, public.contacts, public.bank_accounts,
  public.documents, public.payments, public.payment_allocations, public.payment_links to authenticated;
grant select, update on public.tenants, public.profiles to authenticated;
grant select, insert, update, delete on public.tenant_members to authenticated;
grant select, update, delete on public.integration_connections to authenticated;
grant select on public.audit_log, public.document_balances to authenticated;
-- integration_secrets y webhook_events: RLS activo, sin políticas y sin grants -> solo service_role.
grant usage on schema private to service_role;
