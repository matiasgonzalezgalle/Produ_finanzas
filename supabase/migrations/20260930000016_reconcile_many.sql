-- Conciliación manual de varios movimientos contra uno o más documentos (misma contraparte).
-- Cada movimiento genera su pago/cobro (1 movimiento ↔ 1 pago, como siempre) y lo asignado a los
-- documentos se reparte entre esos pagos en orden: el primer movimiento cubre el primer documento, etc.
-- Todo en una transacción: si algo no cuadra, no se registra nada.

create or replace function public.reconcile_movements_to_documents(
  p_tenant_id uuid, p_movement_ids uuid[], p_counterparty_id uuid, p_method text, p_allocations jsonb default '[]'
) returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  v_movements public.bank_movements[];
  v public.bank_movements;
  v_sign int;
  v_currency public.currency_code;
  v_direction public.payment_direction;
  v_total bigint := 0;
  v_allocated bigint := 0;
  v_queue jsonb := '[]';
  v_item jsonb;
  v_payment uuid;
  v_payments uuid[] := '{}';
  v_left bigint;
  v_take bigint;
  v_doc_left bigint;
  i int;
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if not private.has_module(p_tenant_id, 'conciliacion') then
    raise exception 'El módulo de conciliación bancaria no está activo' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_movement_ids), 0) = 0 then
    raise exception 'Elige al menos un movimiento';
  end if;
  if cardinality(p_movement_ids) > 100 then
    raise exception 'Máximo 100 movimientos a la vez';
  end if;
  if not exists (select 1 from public.counterparties where id = p_counterparty_id and tenant_id = p_tenant_id) then
    raise exception 'Elige la contraparte';
  end if;

  -- Se bloquean los movimientos (evita conciliarlos dos veces en paralelo) y luego se leen en orden.
  perform 1 from public.bank_movements m where m.tenant_id = p_tenant_id and m.id = any (p_movement_ids) for update;
  select array_agg(m order by m.post_date, m.created_at, m.id) into v_movements
  from public.bank_movements m
  where m.tenant_id = p_tenant_id and m.id = any (p_movement_ids);
  if coalesce(cardinality(v_movements), 0) <> cardinality(p_movement_ids) then
    raise exception 'Algún movimiento no existe';
  end if;

  foreach v in array v_movements loop
    if v.reconciliation_status = 'reconciled' then
      raise exception 'El movimiento del % por % ya está conciliado', v.post_date, abs(v.amount);
    end if;
    if v_sign is null then
      v_sign := sign(v.amount);
      v_currency := v.currency;
    elsif sign(v.amount) <> v_sign then
      raise exception 'No se pueden mezclar abonos y cargos en una misma conciliación';
    elsif v.currency <> v_currency then
      raise exception 'Los movimientos deben ser de la misma moneda';
    end if;
    v_total := v_total + abs(v.amount);
  end loop;
  v_direction := case when v_sign > 0 then 'in' else 'out' end;
  if not private.has_module(p_tenant_id, case v_direction when 'out' then 'cuentas_por_pagar' else 'cuentas_por_cobrar' end) then
    raise exception 'El módulo de % no está activo', case v_direction when 'out' then 'cuentas por pagar' else 'cuentas por cobrar' end using errcode = '42501';
  end if;

  -- Cola de asignaciones (en el orden recibido), sin montos no positivos.
  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]')) loop
    if coalesce((v_item ->> 'amount')::bigint, 0) > 0 then
      v_queue := v_queue || jsonb_build_array(jsonb_build_object('document_id', v_item ->> 'document_id', 'left', (v_item ->> 'amount')::bigint));
      v_allocated := v_allocated + (v_item ->> 'amount')::bigint;
    end if;
  end loop;
  if v_allocated > v_total then
    raise exception 'Lo asignado a documentos (%) supera el total de los movimientos (%)', v_allocated, v_total;
  end if;

  i := 0;
  foreach v in array v_movements loop
    insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on, method, reference, notes, source, external_id, created_by)
    values (p_tenant_id, v_direction, p_counterparty_id, v.currency, abs(v.amount), v.post_date, coalesce(nullif(trim(p_method), ''), 'Transferencia'),
      coalesce(v.reference_id, v.document_number), v.description, 'bank', v.id::text, auth.uid())
    returning id into v_payment;
    v_payments := v_payments || v_payment;

    v_left := abs(v.amount);
    while v_left > 0 and i < jsonb_array_length(v_queue) loop
      v_doc_left := (v_queue -> i ->> 'left')::bigint;
      v_take := least(v_left, v_doc_left);
      insert into public.payment_allocations (tenant_id, payment_id, document_id, amount)
      values (p_tenant_id, v_payment, (v_queue -> i ->> 'document_id')::uuid, v_take);
      v_left := v_left - v_take;
      if v_take = v_doc_left then
        i := i + 1;
      else
        v_queue := jsonb_set(v_queue, array[i::text, 'left'], to_jsonb(v_doc_left - v_take));
      end if;
    end loop;

    update public.bank_movements set payment_id = v_payment, reconciliation_status = 'reconciled', ignored_reason = null,
      reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
    where id = v.id;
  end loop;
  return v_payments;
end;
$$;
revoke all on function public.reconcile_movements_to_documents(uuid, uuid[], uuid, text, jsonb) from public, anon;
grant execute on function public.reconcile_movements_to_documents(uuid, uuid[], uuid, text, jsonb) to authenticated;
