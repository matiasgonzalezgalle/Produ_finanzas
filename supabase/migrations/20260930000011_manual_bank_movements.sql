-- Cuentas bancarias manuales: movimientos creados a mano y saldo inicial.
-- Saldo de la cuenta = saldo inicial (a una fecha) + movimientos desde esa fecha.

alter table public.bank_movements drop constraint if exists bank_movements_source_check;
alter table public.bank_movements add constraint bank_movements_source_check check (source in ('fintoc', 'import', 'manual'));
alter table public.bank_movements add column created_by uuid references auth.users (id);

alter table public.bank_feed_accounts
  add column opening_balance bigint,
  -- Saldo al inicio de este día: se le suman los movimientos desde esta fecha.
  add column opening_date date;

create or replace function private.manual_account(p_tenant_id uuid, p_account_id uuid)
returns public.bank_feed_accounts language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_feed_accounts;
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if not private.has_module(p_tenant_id, 'conciliacion') then
    raise exception 'El módulo de conciliación bancaria no está activo' using errcode = '42501';
  end if;
  select * into v from public.bank_feed_accounts where id = p_account_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Cuenta no encontrada';
  end if;
  if v.source <> 'manual' then
    raise exception 'Las cuentas conectadas con Fintoc se actualizan solas: los movimientos y el saldo vienen del banco';
  end if;
  return v;
end;
$$;
revoke all on function private.manual_account(uuid, uuid) from public, anon;

/** Crea (p_id null) o edita un movimiento manual. p_data: post_date, amount (con signo), description, reference, counterparty_tax_id, counterparty_name. */
create or replace function public.save_bank_movement(p_tenant_id uuid, p_account_id uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_account public.bank_feed_accounts;
  v_amount bigint;
  v_date date;
  v_id uuid;
begin
  v_account := private.manual_account(p_tenant_id, p_account_id);
  begin
    v_amount := (p_data ->> 'amount')::bigint;
    v_date := (p_data ->> 'post_date')::date;
  exception when others then
    raise exception 'Monto o fecha inválidos';
  end;
  if coalesce(v_amount, 0) = 0 then
    raise exception 'El monto no puede ser cero';
  end if;
  if v_date is null then
    raise exception 'Indica la fecha';
  end if;
  if nullif(trim(p_data ->> 'description'), '') is null then
    raise exception 'Indica una descripción';
  end if;
  if p_id is null then
    insert into public.bank_movements (tenant_id, account_id, external_id, amount, currency, description, post_date, type, bank_status,
      reference_id, counterparty_tax_id, counterparty_name, source, created_by)
    values (p_tenant_id, p_account_id, 'man:' || gen_random_uuid(), v_amount, v_account.currency, left(trim(p_data ->> 'description'), 500), v_date,
      'other', 'confirmed', left(nullif(trim(p_data ->> 'reference'), ''), 100), left(nullif(trim(p_data ->> 'counterparty_tax_id'), ''), 20),
      left(nullif(trim(p_data ->> 'counterparty_name'), ''), 200), 'manual', auth.uid())
    returning id into v_id;
  else
    update public.bank_movements set
      amount = v_amount, post_date = v_date, description = left(trim(p_data ->> 'description'), 500),
      reference_id = left(nullif(trim(p_data ->> 'reference'), ''), 100),
      counterparty_tax_id = left(nullif(trim(p_data ->> 'counterparty_tax_id'), ''), 20),
      counterparty_name = left(nullif(trim(p_data ->> 'counterparty_name'), ''), 200), updated_at = now()
    where id = p_id and tenant_id = p_tenant_id and account_id = p_account_id and source = 'manual' and reconciliation_status <> 'reconciled'
    returning id into v_id;
    if v_id is null then
      raise exception 'Solo se editan movimientos creados a mano y sin conciliar (deshaz la conciliación primero)';
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_bank_movement(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_bank_movement(uuid, uuid, uuid, jsonb) to authenticated;

/** Elimina un movimiento creado a mano o importado (no los de Fintoc), si no está conciliado. */
create or replace function public.delete_bank_movement(p_tenant_id uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.bank_movements;
begin
  select * into v from public.bank_movements where id = p_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Movimiento no encontrado';
  end if;
  perform private.manual_account(p_tenant_id, v.account_id);
  if v.reconciliation_status = 'reconciled' then
    raise exception 'El movimiento está conciliado: deshaz la conciliación antes de eliminarlo';
  end if;
  delete from public.bank_movements where id = p_id;
end;
$$;
revoke all on function public.delete_bank_movement(uuid, uuid) from public, anon;
grant execute on function public.delete_bank_movement(uuid, uuid) to authenticated;

/** Saldo de la cuenta manual al inicio de un día (null borra el saldo inicial). */
create or replace function public.set_bank_opening_balance(p_tenant_id uuid, p_account_id uuid, p_balance bigint, p_date date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.manual_account(p_tenant_id, p_account_id);
  if p_balance is not null and p_date is null then
    raise exception 'Indica la fecha del saldo';
  end if;
  update public.bank_feed_accounts set opening_balance = p_balance, opening_date = case when p_balance is null then null else p_date end
  where id = p_account_id;
end;
$$;
revoke all on function public.set_bank_opening_balance(uuid, uuid, bigint, date) from public, anon;
grant execute on function public.set_bank_opening_balance(uuid, uuid, bigint, date) to authenticated;
