-- Detalle de documento: aprobación (CxP), asignación contable, notas y mensajes con la contraparte.

-- ---------------------------------------------------------------------------
-- Aprobación
-- ---------------------------------------------------------------------------
create type public.approval_status as enum ('pending', 'approved', 'rejected');

alter table public.documents
  add column approval_status public.approval_status not null default 'pending',
  add column approved_by uuid references auth.users (id),
  add column approved_at timestamptz,
  add column rejection_reason text;

-- Las cuentas por cobrar no requieren aprobación; las por pagar ya pagadas se consideran aprobadas.
update public.documents set approval_status = 'approved' where direction = 'receivable';
update public.documents d set approval_status = 'approved'
where d.direction = 'payable' and exists (select 1 from public.payment_allocations a where a.document_id = d.id);

create or replace function private.document_approval_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.direction = 'receivable' then
    new.approval_status := 'approved';
  end if;
  if tg_op = 'UPDATE' and new.approval_status is distinct from old.approval_status then
    if new.approval_status = 'rejected' and coalesce(trim(new.rejection_reason), '') = '' then
      raise exception 'Indica el motivo del rechazo';
    end if;
    if new.approval_status = 'rejected' and exists (
      select 1 from public.payment_allocations a join public.payments p on p.id = a.payment_id and p.status = 'confirmed'
      where a.document_id = new.id
    ) then
      raise exception 'El documento ya tiene pagos: no se puede rechazar';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := case when new.approval_status = 'pending' then null else now() end;
    if new.approval_status <> 'rejected' then new.rejection_reason := null; end if;
  end if;
  return new;
end;
$$;
create trigger documents_approval_defaults before insert or update on public.documents
  for each row execute function private.document_approval_defaults();

-- No se paga un documento rechazado.
create or replace function private.check_allocation_approval()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.documents d where d.id = new.document_id and d.approval_status = 'rejected') then
    raise exception 'El documento está rechazado: no se le pueden asignar pagos';
  end if;
  return new;
end;
$$;
create trigger payment_allocations_check_approval before insert or update on public.payment_allocations
  for each row execute function private.check_allocation_approval();

-- ---------------------------------------------------------------------------
-- Catálogos contables por empresa
-- ---------------------------------------------------------------------------
create table public.accounting_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text,
  name text not null check (length(trim(name)) between 1 and 120),
  kind text not null default 'expense' check (kind in ('expense', 'income', 'both')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text,
  name text not null check (length(trim(name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.document_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document_id uuid not null,
  category_id uuid not null,
  cost_center_id uuid,
  description text,
  amount bigint not null check (amount > 0),
  position int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade,
  foreign key (tenant_id, category_id) references public.accounting_categories (tenant_id, id),
  foreign key (tenant_id, cost_center_id) references public.cost_centers (tenant_id, id)
);
create index document_allocations_document_idx on public.document_allocations (tenant_id, document_id);

alter table public.accounting_categories enable row level security;
alter table public.cost_centers enable row level security;
alter table public.document_allocations enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounting_categories', 'cost_centers'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using ((select private.is_member(tenant_id)))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check ((select private.can_admin(tenant_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select private.can_admin(tenant_id))) with check ((select private.can_admin(tenant_id)))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select private.can_admin(tenant_id)))', t);
  end loop;
end;
$$;
create policy document_allocations_select on public.document_allocations for select to authenticated using ((select private.is_member(tenant_id)));
create policy document_allocations_insert on public.document_allocations for insert to authenticated with check ((select private.can_write(tenant_id)));
create policy document_allocations_update on public.document_allocations for update to authenticated using ((select private.can_write(tenant_id))) with check ((select private.can_write(tenant_id)));
create policy document_allocations_delete on public.document_allocations for delete to authenticated using ((select private.can_write(tenant_id)));

grant select, insert, update, delete on public.accounting_categories, public.cost_centers, public.document_allocations to authenticated;
create trigger audit_document_allocations after insert or update or delete on public.document_allocations
  for each row execute function private.audit();

-- Base a distribuir: neto + exento si el documento tiene impuesto; si no, el total.
create or replace function private.allocation_base(d public.documents)
returns bigint language sql immutable set search_path = '' as $$
  select case when d.tax_amount > 0 then d.net_amount + d.exempt_amount else d.total_amount end
$$;

-- Reemplaza la distribución contable completa en una transacción (SECURITY INVOKER: aplica RLS).
create or replace function public.set_document_allocations(p_document_id uuid, p_lines jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_doc public.documents;
  v_total bigint;
  v_line jsonb;
  v_pos int := 0;
begin
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null then
    raise exception 'Documento no encontrado';
  end if;
  select coalesce(sum((l ->> 'amount')::bigint), 0) into v_total from jsonb_array_elements(coalesce(p_lines, '[]')) l;
  if v_total > private.allocation_base(v_doc) then
    raise exception 'La asignación (%) supera el monto a distribuir (%)', v_total, private.allocation_base(v_doc);
  end if;
  delete from public.document_allocations where document_id = p_document_id;
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    insert into public.document_allocations (tenant_id, document_id, category_id, cost_center_id, description, amount, position)
    values (v_doc.tenant_id, p_document_id, (v_line ->> 'category_id')::uuid, nullif(v_line ->> 'cost_center_id', '')::uuid,
            nullif(trim(v_line ->> 'description'), ''), (v_line ->> 'amount')::bigint, v_pos);
    v_pos := v_pos + 1;
  end loop;
end;
$$;
revoke all on function public.set_document_allocations(uuid, jsonb) from public, anon;
grant execute on function public.set_document_allocations(uuid, jsonb) to authenticated;

-- Catálogo inicial para empresas nuevas y existentes.
create or replace function private.seed_accounting(p_tenant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounting_categories (tenant_id, code, name, kind) values
    (p_tenant, '5101', 'Arriendos', 'expense'),
    (p_tenant, '5102', 'Servicios profesionales', 'expense'),
    (p_tenant, '5103', 'Producción', 'expense'),
    (p_tenant, '5104', 'Postproducción', 'expense'),
    (p_tenant, '5105', 'Viajes y viáticos', 'expense'),
    (p_tenant, '5106', 'Marketing y publicidad', 'expense'),
    (p_tenant, '5107', 'Software y suscripciones', 'expense'),
    (p_tenant, '5199', 'Gastos generales', 'expense'),
    (p_tenant, '4101', 'Venta de servicios', 'income'),
    (p_tenant, '4102', 'Auspicios', 'income'),
    (p_tenant, '4103', 'Licencias de contenido', 'income'),
    (p_tenant, '4199', 'Otros ingresos', 'income')
  on conflict (tenant_id, name) do nothing;
  insert into public.cost_centers (tenant_id, code, name) values
    (p_tenant, 'ADM', 'Administración'),
    (p_tenant, 'PRO', 'Producción'),
    (p_tenant, 'COM', 'Comercial')
  on conflict (tenant_id, name) do nothing;
end;
$$;
revoke all on function private.seed_accounting(uuid) from public, anon, authenticated;

select private.seed_accounting(id) from public.tenants;

create or replace function private.seed_accounting_on_tenant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_accounting(new.id);
  return new;
end;
$$;
create trigger tenants_seed_accounting after insert on public.tenants
  for each row execute function private.seed_accounting_on_tenant();

-- ---------------------------------------------------------------------------
-- Notas internas y mensajes con la contraparte
-- ---------------------------------------------------------------------------
create table public.document_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document_id uuid not null,
  -- internal: solo el equipo · shared: visible en el portal de la contraparte
  visibility text not null check (visibility in ('internal', 'shared')),
  author_kind text not null check (author_kind in ('member', 'counterparty')),
  author_id uuid references auth.users (id) default auth.uid(),
  author_name text,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade,
  constraint counterparty_comments_are_shared check (author_kind = 'member' or visibility = 'shared')
);
create index document_comments_document_idx on public.document_comments (tenant_id, document_id, created_at);
alter table public.document_comments enable row level security;

create policy document_comments_select on public.document_comments for select to authenticated
  using ((select private.is_member(tenant_id)));
-- Los miembros comentan como ellos mismos; nunca en nombre de la contraparte.
create policy document_comments_insert on public.document_comments for insert to authenticated
  with check ((select private.is_member(tenant_id)) and author_kind = 'member' and author_id = (select auth.uid()));
create policy document_comments_delete on public.document_comments for delete to authenticated
  using (author_kind = 'member' and author_id = (select auth.uid()));
grant select, insert, delete on public.document_comments to authenticated;

-- Portal: leer y escribir mensajes compartidos de sus documentos.
create or replace function public.portal_document_comments(p_document_id uuid)
returns table (id uuid, author_kind text, author_name text, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.documents;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if v_doc.id is null or v_doc.status = 'draft' or not private.portal_has_access(v_doc.tenant_id, v_doc.counterparty_id) then
    raise exception 'Sin acceso a este documento' using errcode = '42501';
  end if;
  return query
    select c.id, c.author_kind, c.author_name, c.body, c.created_at
    from public.document_comments c
    where c.document_id = p_document_id and c.visibility = 'shared'
    order by c.created_at;
end;
$$;

create or replace function public.portal_add_comment(p_document_id uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or v_doc.status = 'draft' or not private.portal_has_access(v_doc.tenant_id, v_doc.counterparty_id) then
    raise exception 'Sin acceso a este documento' using errcode = '42501';
  end if;
  insert into public.document_comments (tenant_id, document_id, visibility, author_kind, author_id, author_name, body)
  values (v_doc.tenant_id, p_document_id, 'shared', 'counterparty', auth.uid(), private.session_email(), trim(p_body));
end;
$$;
revoke all on function public.portal_document_comments(uuid), public.portal_add_comment(uuid, text) from public, anon;
grant execute on function public.portal_document_comments(uuid), public.portal_add_comment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- La vista de saldos se recrea para incluir las columnas nuevas de documents.
-- ---------------------------------------------------------------------------
drop view public.document_balances;
create view public.document_balances with (security_invoker = true) as
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
files as (
  select document_id, count(*) as n from public.document_attachments group by document_id
),
allocated as (
  select document_id, sum(amount) as amount from public.document_allocations group by document_id
),
base as (
  select
    d.*,
    c.name as counterparty_name,
    c.tax_id as counterparty_tax_id,
    coalesce(cr.amount, 0) as credits_amount,
    coalesce(pd.amount, 0) as paid_amount,
    greatest(0, d.total_amount - coalesce(cr.amount, 0)) as net_total,
    (now() at time zone t.timezone)::date as today,
    coalesce(f.n, 0)::int as attachment_count,
    private.allocation_base(d) as allocation_base,
    coalesce(al.amount, 0) as allocated_amount
  from public.documents d
  join public.tenants t on t.id = d.tenant_id
  join public.counterparties c on c.id = d.counterparty_id
  left join credits cr on cr.document_id = d.id
  left join paid pd on pd.document_id = d.id
  left join files f on f.document_id = d.id
  left join allocated al on al.document_id = d.id
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
grant select on public.document_balances to authenticated;
revoke all on public.document_balances from anon;
grant execute on function private.allocation_base(public.documents) to authenticated, service_role;
