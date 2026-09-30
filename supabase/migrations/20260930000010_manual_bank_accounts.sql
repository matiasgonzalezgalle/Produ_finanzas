-- Conciliación sin Fintoc: cuentas bancarias manuales (offline) en cualquier moneda, cuyos
-- movimientos se importan desde la cartola en Excel o CSV. Sirve para Chile y Perú.

alter table public.bank_feed_accounts
  alter column connection_id drop not null,
  add column source text not null default 'fintoc' check (source in ('fintoc', 'manual')),
  -- Banco de la cuenta manual (mismo catálogo de ids que Fintoc: cl_banco_santander, pe_bcp…).
  add column institution_id text,
  add column institution_name text,
  -- Última configuración de columnas usada al importar (se reutiliza en la siguiente cartola).
  add column import_mapping jsonb,
  add column created_by uuid references auth.users (id);
alter table public.bank_feed_accounts add constraint bank_feed_accounts_connection_check
  check ((source = 'fintoc') = (connection_id is not null));

create table public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  account_id uuid not null,
  file_name text,
  total_rows int not null default 0,
  inserted int not null default 0,
  duplicates int not null default 0,
  first_date date,
  last_date date,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references public.bank_feed_accounts (tenant_id, id) on delete cascade
);
create index bank_statement_imports_account_idx on public.bank_statement_imports (account_id, created_at desc);
alter table public.bank_statement_imports enable row level security;
create policy bank_statement_imports_select on public.bank_statement_imports for select to authenticated using ((select private.is_member(tenant_id)));
grant select on public.bank_statement_imports to authenticated;
revoke all on public.bank_statement_imports from anon;
revoke insert, update, delete on public.bank_statement_imports from authenticated;

alter table public.bank_movements
  add column source text not null default 'fintoc' check (source in ('fintoc', 'import')),
  add column import_id uuid,
  -- Saldo informado por la cartola después del movimiento (si viene).
  add column balance bigint,
  add foreign key (tenant_id, import_id) references public.bank_statement_imports (tenant_id, id) on delete set null (import_id);

-- ---------------------------------------------------------------------------
-- Cuentas manuales
-- ---------------------------------------------------------------------------
create or replace function public.save_bank_account(p_tenant_id uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text := nullif(trim(p_data ->> 'name'), '');
  v_institution text := nullif(trim(p_data ->> 'institution_name'), '');
  v_currency public.currency_code;
begin
  if not private.can_admin(p_tenant_id) then
    raise exception 'Solo un administrador crea o edita cuentas bancarias' using errcode = '42501';
  end if;
  if not private.has_module(p_tenant_id, 'conciliacion') then
    raise exception 'El módulo de conciliación bancaria no está activo' using errcode = '42501';
  end if;
  if v_institution is null then
    raise exception 'Indica el banco';
  end if;
  begin
    v_currency := (p_data ->> 'currency')::public.currency_code;
  exception when others then
    raise exception 'Moneda inválida';
  end;
  if v_currency is null or v_currency = 'UF' then
    raise exception 'Moneda inválida';
  end if;
  if p_id is null then
    insert into public.bank_feed_accounts (tenant_id, source, external_id, institution_id, institution_name, name, official_name, number, type, currency, holder_name, created_by)
    values (p_tenant_id, 'manual', 'manual:' || gen_random_uuid(), nullif(trim(p_data ->> 'institution_id'), ''), v_institution,
      coalesce(v_name, 'Cuenta corriente'), v_name, nullif(trim(p_data ->> 'number'), ''), nullif(trim(p_data ->> 'type'), ''), v_currency,
      nullif(trim(p_data ->> 'holder_name'), ''), auth.uid())
    returning id into v_id;
  else
    update public.bank_feed_accounts set
      institution_id = nullif(trim(p_data ->> 'institution_id'), ''), institution_name = v_institution,
      name = coalesce(v_name, 'Cuenta corriente'), official_name = v_name, number = nullif(trim(p_data ->> 'number'), ''),
      type = nullif(trim(p_data ->> 'type'), ''), holder_name = nullif(trim(p_data ->> 'holder_name'), ''),
      -- La moneda no cambia si ya tiene movimientos.
      currency = case when exists (select 1 from public.bank_movements m where m.account_id = p_id) then currency else v_currency end
    where id = p_id and tenant_id = p_tenant_id and source = 'manual'
    returning id into v_id;
    if v_id is null then
      raise exception 'Cuenta no encontrada (las cuentas conectadas con Fintoc no se editan)';
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_bank_account(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_bank_account(uuid, uuid, jsonb) to authenticated;

create or replace function public.delete_bank_account(p_tenant_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_admin(p_tenant_id) then
    raise exception 'Solo un administrador elimina cuentas bancarias' using errcode = '42501';
  end if;
  -- Los pagos y cobros conciliados se mantienen; solo se borran la cuenta y su cartola.
  delete from public.bank_feed_accounts where id = p_id and tenant_id = p_tenant_id and source = 'manual';
  if not found then
    raise exception 'Cuenta no encontrada (las cuentas de Fintoc se quitan desconectando el banco)';
  end if;
end;
$$;
revoke all on function public.delete_bank_account(uuid, uuid) from public, anon;
grant execute on function public.delete_bank_account(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Importar cartola
-- ---------------------------------------------------------------------------
-- p_rows: [{ key, post_date, amount, description, reference, balance, counterparty_tax_id }]
-- key identifica el movimiento dentro de la cuenta (fecha, monto, descripción, referencia y
-- su número de repetición): reimportar una cartola que se superpone no duplica movimientos.
create or replace function public.import_bank_movements(
  p_tenant_id uuid, p_account_id uuid, p_file_name text, p_rows jsonb, p_mapping jsonb default null,
  p_closing_balance bigint default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account public.bank_feed_accounts;
  v_import uuid;
  v_total int := jsonb_array_length(coalesce(p_rows, '[]'));
  v_inserted int;
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if not private.has_module(p_tenant_id, 'conciliacion') then
    raise exception 'El módulo de conciliación bancaria no está activo' using errcode = '42501';
  end if;
  select * into v_account from public.bank_feed_accounts where id = p_account_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Cuenta no encontrada';
  end if;
  if v_account.source <> 'manual' then
    raise exception 'Las cuentas conectadas con Fintoc se actualizan solas: importa cartolas en una cuenta manual';
  end if;
  if v_total = 0 then
    raise exception 'La cartola no tiene movimientos';
  end if;
  if v_total > 10000 then
    raise exception 'La cartola tiene demasiados movimientos (máximo 10.000 por archivo)';
  end if;

  insert into public.bank_statement_imports (tenant_id, account_id, file_name, total_rows)
  values (p_tenant_id, p_account_id, left(p_file_name, 200), v_total)
  returning id into v_import;

  insert into public.bank_movements (tenant_id, account_id, external_id, amount, currency, description, post_date, type, bank_status,
    reference_id, counterparty_tax_id, balance, source, import_id)
  select p_tenant_id, p_account_id, 'imp:' || p_account_id || ':' || left(r ->> 'key', 300), (r ->> 'amount')::bigint, v_account.currency,
    left(nullif(trim(r ->> 'description'), ''), 500), (r ->> 'post_date')::date, 'other', 'confirmed',
    left(nullif(trim(r ->> 'reference'), ''), 100), left(nullif(trim(r ->> 'counterparty_tax_id'), ''), 20),
    nullif(r ->> 'balance', '')::bigint, 'import', v_import
  from jsonb_array_elements(p_rows) r
  where coalesce((r ->> 'amount')::bigint, 0) <> 0
  on conflict (tenant_id, external_id) do nothing;
  get diagnostics v_inserted = row_count;

  update public.bank_statement_imports set
    inserted = v_inserted, duplicates = v_total - v_inserted,
    first_date = (select min((r ->> 'post_date')::date) from jsonb_array_elements(p_rows) r),
    last_date = (select max((r ->> 'post_date')::date) from jsonb_array_elements(p_rows) r)
  where id = v_import;
  update public.bank_feed_accounts set
    import_mapping = coalesce(p_mapping, import_mapping),
    balance_current = coalesce(p_closing_balance, balance_current),
    balance_available = coalesce(p_closing_balance, balance_available),
    refreshed_at = now()
  where id = p_account_id;
  return jsonb_build_object('import_id', v_import, 'inserted', v_inserted, 'duplicates', v_total - v_inserted);
end;
$$;
revoke all on function public.import_bank_movements(uuid, uuid, text, jsonb, jsonb, bigint) from public, anon;
grant execute on function public.import_bank_movements(uuid, uuid, text, jsonb, jsonb, bigint) to authenticated;

/** Deshace una importación: borra sus movimientos sin conciliar (los conciliados se mantienen). */
create or replace function public.delete_bank_import(p_tenant_id uuid, p_import_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deleted int;
  v_kept int;
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if not exists (select 1 from public.bank_statement_imports where id = p_import_id and tenant_id = p_tenant_id) then
    raise exception 'Importación no encontrada';
  end if;
  delete from public.bank_movements where import_id = p_import_id and tenant_id = p_tenant_id and reconciliation_status <> 'reconciled';
  get diagnostics v_deleted = row_count;
  select count(*) into v_kept from public.bank_movements where import_id = p_import_id;
  if v_kept = 0 then
    delete from public.bank_statement_imports where id = p_import_id;
  else
    update public.bank_statement_imports set inserted = v_kept where id = p_import_id;
  end if;
  return jsonb_build_object('deleted', v_deleted, 'kept', v_kept);
end;
$$;
revoke all on function public.delete_bank_import(uuid, uuid) from public, anon;
grant execute on function public.delete_bank_import(uuid, uuid) to authenticated;
