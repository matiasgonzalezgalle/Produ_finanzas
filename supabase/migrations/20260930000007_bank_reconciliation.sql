-- Conciliación bancaria (módulo "conciliacion"): cartolas de las cuentas de la empresa vía
-- Fintoc (producto Movements) y conciliación de cada movimiento con un pago o un cobro.
--   * La edge function fintoc-bank conecta bancos (link intents + widget), guarda el link_token
--     en bank_connection_secrets (solo service_role) y sincroniza cuentas y movimientos.
--   * Desde la app solo se concilia, se deshace o se ignora, mediante RPCs.

create table public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- id del link en Fintoc (link_…)
  external_id text not null,
  institution_id text,
  institution_name text,
  holder_id text,
  holder_name text,
  mode text not null default 'live',
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  last_sync_at timestamptz,
  last_error text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, external_id)
);
alter table public.bank_connections enable row level security;
create policy bank_connections_select on public.bank_connections for select to authenticated using ((select private.is_member(tenant_id)));
grant select on public.bank_connections to authenticated;
revoke all on public.bank_connections from anon;
revoke insert, update, delete on public.bank_connections from authenticated;

create table public.bank_connection_secrets (
  connection_id uuid primary key references public.bank_connections (id) on delete cascade,
  link_token text not null,
  updated_at timestamptz not null default now()
);
alter table public.bank_connection_secrets enable row level security;
revoke all on public.bank_connection_secrets from anon, authenticated;

create table public.bank_feed_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null,
  -- id de la cuenta en Fintoc (acc_…)
  external_id text not null,
  name text,
  official_name text,
  number text,
  type text,
  currency public.currency_code not null,
  holder_id text,
  holder_name text,
  balance_available bigint,
  balance_current bigint,
  refreshed_at timestamptz,
  removed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, external_id),
  foreign key (tenant_id, connection_id) references public.bank_connections (tenant_id, id) on delete cascade
);
alter table public.bank_feed_accounts enable row level security;
create policy bank_feed_accounts_select on public.bank_feed_accounts for select to authenticated using ((select private.is_member(tenant_id)));
grant select on public.bank_feed_accounts to authenticated;
revoke all on public.bank_feed_accounts from anon;
revoke insert, update, delete on public.bank_feed_accounts from authenticated;

create table public.bank_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  account_id uuid not null,
  -- id del movimiento en Fintoc (mov_…)
  external_id text not null,
  -- Con signo, en la unidad mínima de la moneda: positivo = abono, negativo = cargo.
  amount bigint not null check (amount <> 0),
  currency public.currency_code not null,
  description text,
  comment text,
  post_date date not null,
  transaction_at timestamptz,
  type text,
  -- confirmed | processing | reversed | duplicated
  bank_status text not null default 'confirmed',
  reference_id text,
  document_number text,
  pending boolean not null default false,
  -- Contraparte: quien envió (abonos) o recibió (cargos) la transferencia.
  counterparty_tax_id text,
  counterparty_name text,
  counterparty_account text,
  counterparty_bank text,
  reconciliation_status text not null default 'pending' check (reconciliation_status in ('pending', 'reconciled', 'ignored')),
  payment_id uuid,
  ignored_reason text,
  reconciled_by uuid references auth.users (id),
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  foreign key (tenant_id, account_id) references public.bank_feed_accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, payment_id) references public.payments (tenant_id, id) on delete set null (payment_id),
  check ((reconciliation_status = 'reconciled') = (payment_id is not null))
);
-- Un pago o cobro se concilia con un solo movimiento.
create unique index bank_movements_payment_uniq on public.bank_movements (payment_id) where payment_id is not null;
create index bank_movements_tenant_idx on public.bank_movements (tenant_id, post_date desc);
alter table public.bank_movements enable row level security;
create policy bank_movements_select on public.bank_movements for select to authenticated using ((select private.is_member(tenant_id)));
grant select on public.bank_movements to authenticated;
revoke all on public.bank_movements from anon;
revoke insert, update, delete on public.bank_movements from authenticated;

-- Si el pago se elimina (cascade) queda payment_id null: el movimiento vuelve a "por conciliar".
-- Si el pago se anula, también.
create or replace function private.bank_movement_payment_gone()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'payments' then
    if new.status = 'void' and old.status <> 'void' then
      update public.bank_movements set payment_id = null, reconciliation_status = 'pending', reconciled_by = null, reconciled_at = null, updated_at = now()
      where payment_id = new.id;
    end if;
    return new;
  end if;
  -- bank_movements: on delete set null del pago
  if new.payment_id is null and new.reconciliation_status = 'reconciled' then
    new.reconciliation_status := 'pending';
    new.reconciled_by := null;
    new.reconciled_at := null;
  end if;
  return new;
end;
$$;
create trigger payments_void_unreconcile after update of status on public.payments
  for each row execute function private.bank_movement_payment_gone();
create trigger bank_movements_payment_gone before update of payment_id on public.bank_movements
  for each row execute function private.bank_movement_payment_gone();

-- ---------------------------------------------------------------------------
-- RPCs de conciliación
-- ---------------------------------------------------------------------------
create or replace function private.lock_bank_movement(p_tenant_id uuid, p_movement_id uuid)
returns public.bank_movements language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_movements;
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if not private.has_module(p_tenant_id, 'conciliacion') then
    raise exception 'El módulo de conciliación bancaria no está activo' using errcode = '42501';
  end if;
  select * into v from public.bank_movements where id = p_movement_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'Movimiento no encontrado';
  end if;
  return v;
end;
$$;
revoke all on function private.lock_bank_movement(uuid, uuid) from public, anon;

/** Concilia el movimiento con un pago o cobro ya registrado (mismo sentido, moneda y monto). */
create or replace function public.reconcile_bank_movement(p_tenant_id uuid, p_movement_id uuid, p_payment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_movements;
  p public.payments;
begin
  v := private.lock_bank_movement(p_tenant_id, p_movement_id);
  if v.reconciliation_status = 'reconciled' then
    raise exception 'El movimiento ya está conciliado';
  end if;
  select * into p from public.payments where id = p_payment_id and tenant_id = p_tenant_id;
  if not found or p.status <> 'confirmed' then
    raise exception 'El pago no existe o está anulado';
  end if;
  if p.direction <> (case when v.amount > 0 then 'in' else 'out' end)::public.payment_direction then
    raise exception 'Un abono se concilia con un cobro y un cargo con un pago';
  end if;
  if p.currency <> v.currency or p.amount <> abs(v.amount) then
    raise exception 'El monto o la moneda del pago no coinciden con el movimiento';
  end if;
  if exists (select 1 from public.bank_movements where payment_id = p_payment_id) then
    raise exception 'Ese pago ya está conciliado con otro movimiento';
  end if;
  update public.bank_movements set payment_id = p_payment_id, reconciliation_status = 'reconciled', ignored_reason = null,
    reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
  where id = v.id;
end;
$$;
revoke all on function public.reconcile_bank_movement(uuid, uuid, uuid) from public, anon;
grant execute on function public.reconcile_bank_movement(uuid, uuid, uuid) to authenticated;

/** Registra el pago o cobro a partir del movimiento (con sus documentos) y lo concilia. */
create or replace function public.create_payment_from_movement(
  p_tenant_id uuid, p_movement_id uuid, p_counterparty_id uuid, p_method text, p_notes text, p_allocations jsonb default '[]'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_movements;
  v_direction public.payment_direction;
  v_payment uuid;
  v_item jsonb;
begin
  v := private.lock_bank_movement(p_tenant_id, p_movement_id);
  if v.reconciliation_status = 'reconciled' then
    raise exception 'El movimiento ya está conciliado';
  end if;
  v_direction := case when v.amount > 0 then 'in' else 'out' end;
  if not private.has_module(p_tenant_id, case v_direction when 'out' then 'cuentas_por_pagar' else 'cuentas_por_cobrar' end) then
    raise exception 'El módulo de % no está activo', case v_direction when 'out' then 'cuentas por pagar' else 'cuentas por cobrar' end using errcode = '42501';
  end if;
  insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on, method, reference, notes, source, external_id, created_by)
  values (p_tenant_id, v_direction, p_counterparty_id, v.currency, abs(v.amount), v.post_date, coalesce(nullif(trim(p_method), ''), 'Transferencia'),
    coalesce(v.reference_id, v.document_number), coalesce(nullif(trim(p_notes), ''), v.description), 'bank', v.id::text, auth.uid())
  returning id into v_payment;
  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'))
  loop
    insert into public.payment_allocations (tenant_id, payment_id, document_id, amount)
    values (p_tenant_id, v_payment, (v_item ->> 'document_id')::uuid, (v_item ->> 'amount')::bigint);
  end loop;
  update public.bank_movements set payment_id = v_payment, reconciliation_status = 'reconciled', ignored_reason = null,
    reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
  where id = v.id;
  return v_payment;
end;
$$;
revoke all on function public.create_payment_from_movement(uuid, uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function public.create_payment_from_movement(uuid, uuid, uuid, text, text, jsonb) to authenticated;

/** Ignorar (comisiones, traspasos entre cuentas propias…) o volver a "por conciliar". */
create or replace function public.set_bank_movement_status(p_tenant_id uuid, p_movement_id uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_movements;
begin
  if p_status not in ('pending', 'ignored') then
    raise exception 'Estado inválido';
  end if;
  v := private.lock_bank_movement(p_tenant_id, p_movement_id);
  -- Deshacer una conciliación no elimina el pago: queda registrado sin conciliar.
  update public.bank_movements set
    reconciliation_status = p_status,
    payment_id = null,
    ignored_reason = case when p_status = 'ignored' then nullif(trim(p_reason), '') end,
    reconciled_by = case when p_status = 'ignored' then auth.uid() end,
    reconciled_at = case when p_status = 'ignored' then now() end,
    updated_at = now()
  where id = v.id;
end;
$$;
revoke all on function public.set_bank_movement_status(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_bank_movement_status(uuid, uuid, text, text) to authenticated;
