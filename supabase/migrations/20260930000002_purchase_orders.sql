-- Órdenes de compra.
--   * CxP (direction = payable): OC emitidas a proveedores, con numeración propia y aprobación.
--   * CxC (direction = receivable): OC recibidas de clientes (su número lo pone el cliente).
-- Los documentos (facturas, boletas, etc.) se asocian a una OC por ID. El monto facturado
-- de la OC es la suma de sus documentos vigentes menos las notas de crédito aplicadas.

create type public.purchase_order_status as enum ('draft', 'pending', 'approved', 'rejected', 'closed', 'void');

-- Preferencias de OC en el administrador del módulo.
alter table public.module_settings
  add column po_prefix text not null default 'OC-' check (length(po_prefix) <= 12),
  add column po_next_number int not null default 1 check (po_next_number > 0),
  add column po_approval_admin_only boolean not null default true;

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.document_direction not null,
  counterparty_id uuid not null,
  number text not null check (length(trim(number)) between 1 and 40),
  status public.purchase_order_status not null default 'draft',
  currency public.currency_code not null,
  issue_date date not null,
  delivery_date date,
  net_amount bigint not null default 0 check (net_amount >= 0),
  exempt_amount bigint not null default 0 check (exempt_amount >= 0),
  tax_amount bigint not null default 0 check (tax_amount >= 0),
  total_amount bigint not null default 0 check (total_amount >= 0),
  category_id uuid,
  cost_center_id uuid,
  requester text,
  payment_method text,
  payment_terms_days int check (payment_terms_days between 0 and 365),
  description text,
  notes text,
  rejection_reason text,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  sent_at timestamptz,
  sent_to text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id),
  foreign key (tenant_id, category_id) references public.accounting_categories (tenant_id, id),
  foreign key (tenant_id, cost_center_id) references public.cost_centers (tenant_id, id),
  constraint purchase_orders_delivery_after_issue check (delivery_date is null or delivery_date >= issue_date),
  constraint purchase_orders_total check (total_amount = net_amount + exempt_amount + tax_amount)
);
-- Número único por contraparte; en CxP (numeración propia) único en toda la empresa.
create unique index purchase_orders_number_uniq on public.purchase_orders (tenant_id, direction, counterparty_id, lower(number))
  where status <> 'void';
create unique index purchase_orders_own_number_uniq on public.purchase_orders (tenant_id, lower(number))
  where direction = 'payable' and status <> 'void';
create index purchase_orders_tenant_idx on public.purchase_orders (tenant_id, direction, issue_date desc);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  purchase_order_id uuid not null,
  position int not null default 0,
  description text not null check (length(trim(description)) between 1 and 300),
  quantity numeric(14, 4) not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  discount bigint not null default 0 check (discount >= 0),
  amount bigint not null check (amount >= 0),
  foreign key (tenant_id, purchase_order_id) references public.purchase_orders (tenant_id, id) on delete cascade,
  constraint purchase_order_lines_amount check (amount = round(quantity * unit_price)::bigint - discount)
);
create index purchase_order_lines_po_idx on public.purchase_order_lines (purchase_order_id, position);

create table public.purchase_order_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  purchase_order_id uuid not null,
  storage_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 200),
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, purchase_order_id) references public.purchase_orders (tenant_id, id) on delete cascade,
  constraint po_attachment_path_scoped check (storage_path like tenant_id::text || '/po/' || purchase_order_id::text || '/%')
);

alter table public.documents add column purchase_order_id uuid;
alter table public.documents add constraint documents_purchase_order_fk
  foreign key (tenant_id, purchase_order_id) references public.purchase_orders (tenant_id, id);
create index documents_purchase_order_idx on public.documents (purchase_order_id) where purchase_order_id is not null;

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_order_attachments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['purchase_orders', 'purchase_order_lines', 'purchase_order_attachments'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using ((select private.is_member(tenant_id)))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select private.can_write(tenant_id))) with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select private.can_write(tenant_id)))', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function private.audit()', t);
  end loop;
end;
$$;
grant select, insert, update, delete on public.purchase_orders, public.purchase_order_lines, public.purchase_order_attachments to authenticated;
revoke all on public.purchase_orders, public.purchase_order_lines, public.purchase_order_attachments from anon;

-- ---------------------------------------------------------------------------
-- Reglas de la OC
-- ---------------------------------------------------------------------------
-- Monto facturado de una OC (documentos vigentes menos sus notas de crédito), sin contar un documento.
create or replace function private.purchase_order_invoiced(p_po uuid, p_exclude_document uuid default null)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(greatest(0, d.total_amount - coalesce((
    select sum(c.total_amount) from public.documents c where c.applies_to_id = d.id and c.status = 'open'
  ), 0))), 0)::bigint
  from public.documents d
  where d.purchase_order_id = p_po and d.status = 'open' and d.id is distinct from p_exclude_document
$$;
revoke all on function private.purchase_order_invoiced(uuid, uuid) from public, anon;
grant execute on function private.purchase_order_invoiced(uuid, uuid) to authenticated, service_role;

create or replace function private.purchase_order_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_settings public.module_settings;
  v_has_docs boolean;
begin
  if tg_op = 'INSERT' then
    new.approved_by := null;
    new.approved_at := null;
    if new.status not in ('draft', 'pending', 'approved') then
      raise exception 'Una orden de compra nueva parte como borrador, por aprobar o aprobada';
    end if;
  else
    -- Quién creó y quién aprobó lo registra el servidor.
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
    if new.direction <> old.direction then
      raise exception 'No se puede cambiar el módulo de la orden de compra';
    end if;
    if old.status in ('approved', 'closed', 'void') and (
      new.counterparty_id <> old.counterparty_id or new.currency <> old.currency
      or new.net_amount <> old.net_amount or new.exempt_amount <> old.exempt_amount or new.tax_amount <> old.tax_amount
    ) then
      raise exception 'La orden de compra está %: no se pueden cambiar proveedor/cliente, moneda ni montos',
        case old.status when 'void' then 'anulada' else 'aprobada' end;
    end if;
    if new.status is distinct from old.status then
      if not (
        (old.status = 'draft' and new.status in ('pending', 'approved', 'void'))
        or (old.status = 'pending' and new.status in ('draft', 'approved', 'rejected', 'void'))
        or (old.status = 'approved' and new.status in ('closed', 'void', 'pending'))
        or (old.status = 'rejected' and new.status in ('draft', 'pending', 'void'))
        or (old.status = 'closed' and new.status = 'approved')
      ) then
        raise exception 'Cambio de estado no permitido para la orden de compra';
      end if;
      select exists (select 1 from public.documents d where d.purchase_order_id = new.id and d.status <> 'void') into v_has_docs;
      if old.status in ('approved', 'closed') and new.status not in ('approved', 'closed') and v_has_docs then
        raise exception 'La orden de compra tiene documentos asociados: ciérrala en vez de %',
          case new.status when 'void' then 'anularla' else 'cambiarla de estado' end;
      end if;
    end if;
  end if;

  if new.status = 'rejected' and (tg_op = 'INSERT' or old.status is distinct from 'rejected') and coalesce(trim(new.rejection_reason), '') = '' then
    raise exception 'Indica el motivo del rechazo';
  end if;
  if new.status <> 'rejected' then new.rejection_reason := null; end if;

  if new.status = 'approved' and (tg_op = 'INSERT' or old.status not in ('approved', 'closed')) then
    v_settings := private.module_setting(new.tenant_id, new.direction);
    if new.direction = 'payable' and coalesce(v_settings.po_approval_admin_only, true) and not private.can_admin(new.tenant_id) then
      raise exception 'Solo un administrador puede aprobar órdenes de compra' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif new.status in ('draft', 'pending', 'rejected') then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger purchase_orders_rules before insert or update on public.purchase_orders
  for each row execute function private.purchase_order_rules();

create or replace function private.purchase_order_before_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status not in ('draft', 'pending', 'rejected') then
    raise exception 'Solo se eliminan órdenes en borrador, por aprobar o rechazadas: anúlala';
  end if;
  return old;
end;
$$;
create trigger purchase_orders_before_delete before delete on public.purchase_orders
  for each row execute function private.purchase_order_before_delete();

-- Las líneas solo cambian mientras la OC no está aprobada.
create or replace function private.purchase_order_lines_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_status public.purchase_order_status;
begin
  select status into v_status from public.purchase_orders where id = coalesce(new.purchase_order_id, old.purchase_order_id);
  if v_status in ('approved', 'closed', 'void') then
    raise exception 'La orden de compra está aprobada: su detalle no se puede modificar';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger purchase_order_lines_rules before insert or update or delete on public.purchase_order_lines
  for each row execute function private.purchase_order_lines_rules();

-- Numeración correlativa de OC emitidas (CxP).
create or replace function private.next_po_number(p_tenant uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_n int;
  v_number text;
begin
  if not private.can_write(p_tenant) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  insert into public.module_settings (tenant_id, direction) values (p_tenant, 'payable') on conflict do nothing;
  loop
    update public.module_settings set po_next_number = po_next_number + 1
    where tenant_id = p_tenant and direction = 'payable'
    returning po_prefix, po_next_number - 1 into v_prefix, v_n;
    v_number := v_prefix || lpad(v_n::text, 5, '0');
    exit when not exists (
      select 1 from public.purchase_orders
      where tenant_id = p_tenant and direction = 'payable' and lower(number) = lower(v_number) and status <> 'void'
    );
  end loop;
  return v_number;
end;
$$;
revoke all on function private.next_po_number(uuid) from public, anon;
grant execute on function private.next_po_number(uuid) to authenticated;

-- Crear o editar una OC con su detalle en una transacción (SECURITY INVOKER: aplica RLS).
-- Si tiene líneas, el neto es la suma de las líneas. Con la OC aprobada solo cambian los datos internos.
create or replace function public.save_purchase_order(p_tenant_id uuid, p_id uuid, p_data jsonb, p_lines jsonb default '[]')
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_po public.purchase_orders;
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_lines jsonb := coalesce(p_lines, '[]');
  v_net bigint;
  v_exempt bigint := coalesce((p_data ->> 'exempt_amount')::bigint, 0);
  v_tax bigint := coalesce((p_data ->> 'tax_amount')::bigint, 0);
  v_number text := nullif(trim(p_data ->> 'number'), '');
  v_status public.purchase_order_status := coalesce(nullif(p_data ->> 'status', '')::public.purchase_order_status, 'draft');
  v_line jsonb;
  v_pos int := 0;
  v_qty numeric;
  v_price bigint;
  v_discount bigint;
begin
  if p_id is not null then
    select * into v_po from public.purchase_orders where id = p_id and tenant_id = p_tenant_id;
    if v_po.id is null then
      raise exception 'Orden de compra no encontrada';
    end if;
  end if;

  if jsonb_array_length(v_lines) > 0 then
    select coalesce(sum(round((l ->> 'quantity')::numeric * (l ->> 'unit_price')::bigint)::bigint - coalesce((l ->> 'discount')::bigint, 0)), 0)
      into v_net from jsonb_array_elements(v_lines) l;
  else
    v_net := coalesce((p_data ->> 'net_amount')::bigint, 0);
  end if;
  if v_net + v_exempt + v_tax <= 0 and (p_id is null or v_po.status not in ('approved', 'closed', 'void')) then
    raise exception 'El total de la orden de compra debe ser mayor a cero';
  end if;

  if p_id is null then
    if v_number is null then
      if (p_data ->> 'direction') = 'payable' then
        v_number := private.next_po_number(p_tenant_id);
      else
        raise exception 'Indica el número de la orden de compra del cliente';
      end if;
    end if;
    insert into public.purchase_orders (
      id, tenant_id, direction, counterparty_id, number, status, currency, issue_date, delivery_date,
      net_amount, exempt_amount, tax_amount, total_amount, category_id, cost_center_id, requester,
      payment_method, payment_terms_days, description, notes
    ) values (
      v_id, p_tenant_id, (p_data ->> 'direction')::public.document_direction, (p_data ->> 'counterparty_id')::uuid, v_number, 'draft',
      (p_data ->> 'currency')::public.currency_code, (p_data ->> 'issue_date')::date, nullif(p_data ->> 'delivery_date', '')::date,
      v_net, v_exempt, v_tax, v_net + v_exempt + v_tax,
      nullif(p_data ->> 'category_id', '')::uuid, nullif(p_data ->> 'cost_center_id', '')::uuid, nullif(trim(p_data ->> 'requester'), ''),
      nullif(trim(p_data ->> 'payment_method'), ''), nullif(p_data ->> 'payment_terms_days', '')::int,
      nullif(trim(p_data ->> 'description'), ''), nullif(trim(p_data ->> 'notes'), '')
    );
  elsif v_po.status in ('approved', 'closed', 'void') then
    update public.purchase_orders set
      delivery_date = nullif(p_data ->> 'delivery_date', '')::date,
      category_id = nullif(p_data ->> 'category_id', '')::uuid,
      cost_center_id = nullif(p_data ->> 'cost_center_id', '')::uuid,
      requester = nullif(trim(p_data ->> 'requester'), ''),
      payment_method = nullif(trim(p_data ->> 'payment_method'), ''),
      payment_terms_days = nullif(p_data ->> 'payment_terms_days', '')::int,
      description = nullif(trim(p_data ->> 'description'), ''),
      notes = nullif(trim(p_data ->> 'notes'), '')
    where id = p_id;
    return p_id;
  else
    update public.purchase_orders set
      counterparty_id = (p_data ->> 'counterparty_id')::uuid,
      number = coalesce(v_number, number),
      currency = (p_data ->> 'currency')::public.currency_code,
      issue_date = (p_data ->> 'issue_date')::date,
      delivery_date = nullif(p_data ->> 'delivery_date', '')::date,
      net_amount = v_net, exempt_amount = v_exempt, tax_amount = v_tax, total_amount = v_net + v_exempt + v_tax,
      category_id = nullif(p_data ->> 'category_id', '')::uuid,
      cost_center_id = nullif(p_data ->> 'cost_center_id', '')::uuid,
      requester = nullif(trim(p_data ->> 'requester'), ''),
      payment_method = nullif(trim(p_data ->> 'payment_method'), ''),
      payment_terms_days = nullif(p_data ->> 'payment_terms_days', '')::int,
      description = nullif(trim(p_data ->> 'description'), ''),
      notes = nullif(trim(p_data ->> 'notes'), '')
    where id = p_id;
    delete from public.purchase_order_lines where purchase_order_id = p_id;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    v_price := (v_line ->> 'unit_price')::bigint;
    v_discount := coalesce((v_line ->> 'discount')::bigint, 0);
    insert into public.purchase_order_lines (tenant_id, purchase_order_id, position, description, quantity, unit_price, discount, amount)
    values (p_tenant_id, v_id, v_pos, trim(v_line ->> 'description'), v_qty, v_price, v_discount, round(v_qty * v_price)::bigint - v_discount);
    v_pos := v_pos + 1;
  end loop;

  -- El estado inicial se aplica al final: así las líneas se guardan antes de aprobar.
  if p_id is null and v_status <> 'draft' then
    update public.purchase_orders set status = v_status where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_purchase_order(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_purchase_order(uuid, uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Documentos asociados a una OC
-- ---------------------------------------------------------------------------
create or replace function private.document_purchase_order_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_po public.purchase_orders;
  v_settings public.module_settings;
  v_credits bigint;
  v_linking boolean := new.purchase_order_id is not null
    and (tg_op = 'INSERT' or new.purchase_order_id is distinct from old.purchase_order_id);
begin
  if new.purchase_order_id is not null then
    if new.doc_type = 'nota_credito' then
      raise exception 'Una nota de crédito se asocia al documento, no a la orden de compra';
    end if;
    select * into v_po from public.purchase_orders where id = new.purchase_order_id and tenant_id = new.tenant_id;
    if v_po.direction <> new.direction or v_po.counterparty_id <> new.counterparty_id or v_po.currency <> new.currency then
      raise exception 'La orden de compra debe ser de la misma contraparte y moneda que el documento';
    end if;
    if v_linking and v_po.status <> 'approved' then
      raise exception 'La orden de compra % no está aprobada', v_po.number;
    end if;
    if new.status = 'open' and (v_linking or new.total_amount <> old.total_amount or old.status <> 'open') then
      select coalesce(sum(total_amount), 0) into v_credits from public.documents where applies_to_id = new.id and status = 'open';
      if private.purchase_order_invoiced(v_po.id, new.id) + greatest(0, new.total_amount - v_credits) > v_po.total_amount then
        raise exception 'El documento supera el saldo por facturar de la orden de compra % (%)',
          v_po.number, v_po.total_amount - private.purchase_order_invoiced(v_po.id, new.id);
      end if;
    end if;
  end if;

  v_settings := private.module_setting(new.tenant_id, new.direction);
  if coalesce(v_settings.require_purchase_order, false) and new.purchase_order_id is null and new.doc_type <> 'nota_credito' then
    if new.direction = 'payable' and new.approval_status = 'approved'
       and (tg_op = 'INSERT' or old.approval_status is distinct from 'approved' or old.purchase_order_id is not null) then
      raise exception 'Asocia el documento a una orden de compra antes de aprobarlo';
    end if;
    if new.direction = 'receivable' and new.status = 'open'
       and (tg_op = 'INSERT' or old.status <> 'open' or old.purchase_order_id is not null) then
      raise exception 'Asocia el documento a la orden de compra del cliente';
    end if;
  end if;
  return new;
end;
$$;
create trigger documents_purchase_order_rules before insert or update on public.documents
  for each row execute function private.document_purchase_order_rules();

-- ---------------------------------------------------------------------------
-- Vistas (document_balances se recrea para incluir purchase_order_id)
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
    coalesce(al.amount, 0) as allocated_amount,
    po.number as purchase_order_number
  from public.documents d
  join public.tenants t on t.id = d.tenant_id
  join public.counterparties c on c.id = d.counterparty_id
  left join public.purchase_orders po on po.id = d.purchase_order_id
  left join credits cr on cr.document_id = d.id
  left join paid pd on pd.document_id = d.id
  left join files f on f.document_id = d.id
  left join allocated al on al.document_id = d.id
),
computed as (
  select
    b.*,
    case when b.status = 'open' and b.doc_type <> 'nota_credito'
      then greatest(0, b.net_total - b.detraction_amount - b.paid_amount) else 0 end as pending_amount
  from base b
)
select
  x.*,
  case
    when x.status = 'void' then 'anulado'
    when x.status = 'draft' then 'borrador'
    when x.doc_type = 'nota_credito' then 'aplicada'
    when x.pending_amount = 0 then 'pagado'
    when x.due_date is not null and x.due_date < x.today then 'vencido'
    when x.paid_amount > 0 then 'parcial'
    else 'pendiente'
  end as payment_status,
  case when x.status = 'open' and x.due_date is not null and x.due_date < x.today and x.pending_amount > 0
    then x.today - x.due_date else 0 end as days_overdue,
  case
    when x.direction <> 'payable' or x.doc_type = 'nota_credito' or x.status = 'void' then null
    when x.status = 'open' and x.pending_amount = 0 then 'paid'
    when x.approval_status <> 'approved' then null
    else x.payment_stage::text
  end as payment_management
from computed x;
grant select on public.document_balances to authenticated;
revoke all on public.document_balances from anon;

create view public.purchase_order_balances with (security_invoker = true) as
with docs as (
  select b.purchase_order_id, count(*) as n, sum(b.net_total) as invoiced, sum(b.paid_amount) as paid, sum(b.pending_amount) as pending
  from public.document_balances b
  where b.purchase_order_id is not null and b.status = 'open'
  group by b.purchase_order_id
),
lines as (
  select purchase_order_id, count(*) as n from public.purchase_order_lines group by purchase_order_id
),
files as (
  select purchase_order_id, count(*) as n from public.purchase_order_attachments group by purchase_order_id
)
select
  po.*,
  c.name as counterparty_name,
  c.tax_id as counterparty_tax_id,
  cat.name as category_name,
  cc.name as cost_center_name,
  coalesce(d.n, 0)::int as document_count,
  coalesce(d.invoiced, 0)::bigint as invoiced_amount,
  greatest(0, po.total_amount - coalesce(d.invoiced, 0))::bigint as remaining_amount,
  coalesce(d.paid, 0)::bigint as paid_amount,
  coalesce(d.pending, 0)::bigint as documents_pending_amount,
  coalesce(l.n, 0)::int as line_count,
  coalesce(f.n, 0)::int as attachment_count,
  case
    when coalesce(d.invoiced, 0) = 0 then 'sin_documentos'
    when d.invoiced >= po.total_amount then 'completa'
    else 'parcial'
  end as billing_status
from public.purchase_orders po
join public.counterparties c on c.id = po.counterparty_id
left join public.accounting_categories cat on cat.id = po.category_id
left join public.cost_centers cc on cc.id = po.cost_center_id
left join docs d on d.purchase_order_id = po.id
left join lines l on l.purchase_order_id = po.id
left join files f on f.purchase_order_id = po.id;
grant select on public.purchase_order_balances to authenticated;
revoke all on public.purchase_order_balances from anon;

-- ---------------------------------------------------------------------------
-- Portal: la contraparte ve sus órdenes de compra y a qué OC corresponde cada documento.
-- ---------------------------------------------------------------------------
create or replace function public.portal_snapshot(p_tenant_id uuid, p_counterparty_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not private.portal_has_access(p_tenant_id, p_counterparty_id) then
    raise exception 'Sin acceso a este portal' using errcode = '42501';
  end if;

  update public.portal_access set last_access_at = now()
  where tenant_id = p_tenant_id and counterparty_id = p_counterparty_id and kind = 'email' and email = private.session_email();

  select jsonb_build_object(
    'tenant', (select jsonb_build_object('name', coalesce(t.legal_name, t.name), 'tax_id', t.tax_id, 'country', t.country, 'message', t.portal_message)
               from public.tenants t where t.id = p_tenant_id),
    'counterparty', (select jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'tax_id', c.tax_id, 'country', c.country,
                            'is_supplier', c.is_supplier, 'is_customer', c.is_customer, 'email', c.email, 'phone', c.phone, 'address', c.address)
                     from public.counterparties c where c.id = p_counterparty_id),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'direction', b.direction, 'doc_type', b.doc_type, 'folio', b.folio, 'currency', b.currency,
        'total_amount', b.total_amount, 'paid_amount', b.paid_amount, 'pending_amount', b.pending_amount,
        'issue_date', b.issue_date, 'due_date', b.due_date, 'scheduled_payment_date', b.scheduled_payment_date,
        'payment_status', b.payment_status, 'days_overdue', b.days_overdue,
        'detraction_amount', b.detraction_amount, 'detraction_status', b.detraction_status,
        'approval_status', b.approval_status, 'rejection_reason', b.rejection_reason,
        'payment_management', b.payment_management,
        'purchase_order_number', b.purchase_order_number,
        'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'storage_path', a.storage_path, 'size_bytes', a.size_bytes))
                                  from public.document_attachments a where a.document_id = b.id), '[]'::jsonb),
        'payment_url', (select l.url from public.payment_links l
                        where l.document_id = b.id and l.status = 'active' and l.url is not null
                        order by l.created_at desc limit 1)
      ) order by b.due_date nulls last)
      from public.document_balances b
      where b.tenant_id = p_tenant_id and b.counterparty_id = p_counterparty_id and b.status <> 'draft'
    ), '[]'::jsonb),
    'purchase_orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'direction', o.direction, 'number', o.number, 'status', o.status, 'currency', o.currency,
        'issue_date', o.issue_date, 'delivery_date', o.delivery_date,
        'net_amount', o.net_amount, 'exempt_amount', o.exempt_amount, 'tax_amount', o.tax_amount, 'total_amount', o.total_amount,
        'invoiced_amount', o.invoiced_amount, 'remaining_amount', o.remaining_amount, 'billing_status', o.billing_status,
        'payment_terms_days', o.payment_terms_days, 'notes', o.notes,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price,
                                                              'discount', l.discount, 'amount', l.amount) order by l.position)
                           from public.purchase_order_lines l where l.purchase_order_id = o.id), '[]'::jsonb)
      ) order by o.issue_date desc)
      from public.purchase_order_balances o
      where o.tenant_id = p_tenant_id and o.counterparty_id = p_counterparty_id
        and (case when o.direction = 'payable' then o.status in ('approved', 'closed') else o.status not in ('draft', 'void') end)
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'direction', p.direction, 'currency', p.currency, 'amount', p.amount, 'paid_on', p.paid_on,
        'method', p.method, 'reference', p.reference,
        'folios', coalesce((select jsonb_agg(d.folio) from public.payment_allocations a join public.documents d on d.id = a.document_id where a.payment_id = p.id), '[]'::jsonb)
      ) order by p.paid_on desc)
      from public.payments p
      where p.tenant_id = p_tenant_id and p.counterparty_id = p_counterparty_id and p.status = 'confirmed'
    ), '[]'::jsonb),
    'bank_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('bank_name', ba.bank_name, 'account_type', ba.account_type, 'account_number', ba.account_number,
                                          'holder_name', ba.holder_name, 'holder_tax_id', ba.holder_tax_id, 'email', ba.email, 'currency', ba.currency))
      from public.bank_accounts ba where ba.tenant_id = p_tenant_id and ba.counterparty_id = p_counterparty_id
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
