-- Crear un pago/cobro con sus asignaciones en una sola transacción.
-- SECURITY INVOKER: se aplican las políticas RLS y los triggers de validación del usuario.
create or replace function public.create_payment(
  p_tenant_id uuid,
  p_direction public.payment_direction,
  p_counterparty_id uuid,
  p_currency public.currency_code,
  p_amount bigint,
  p_paid_on date,
  p_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb default '[]'
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_payment_id uuid;
  v_item jsonb;
begin
  insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on, method, reference, notes)
  values (p_tenant_id, p_direction, p_counterparty_id, p_currency, p_amount, p_paid_on, coalesce(p_method, 'transferencia'), p_reference, p_notes)
  returning id into v_payment_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'))
  loop
    insert into public.payment_allocations (tenant_id, payment_id, document_id, amount)
    values (p_tenant_id, v_payment_id, (v_item ->> 'document_id')::uuid, (v_item ->> 'amount')::bigint);
  end loop;
  return v_payment_id;
end;
$$;
revoke all on function public.create_payment(uuid, public.payment_direction, uuid, public.currency_code, bigint, date, text, text, text, jsonb) from public, anon;
grant execute on function public.create_payment(uuid, public.payment_direction, uuid, public.currency_code, bigint, date, text, text, text, jsonb) to authenticated;
