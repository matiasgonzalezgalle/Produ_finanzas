-- Registro atómico e idempotente de pagos confirmados por un proveedor (ej. MercadoPago).
-- Solo lo invoca service_role desde edge functions, después de verificar el pago con la API del proveedor.

create or replace function public.record_provider_payment(
  p_tenant_id uuid,
  p_payment_link_id uuid,
  p_provider text,
  p_external_id text,
  p_currency public.currency_code,
  p_amount bigint,
  p_paid_on date,
  p_method text default 'mercadopago',
  p_reference text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_link public.payment_links;
  v_doc public.documents;
  v_payment_id uuid;
  v_pending bigint;
begin
  select * into v_link from public.payment_links
    where id = p_payment_link_id and tenant_id = p_tenant_id and provider = p_provider
    for update;
  if v_link.id is null then
    raise exception 'Link de pago no encontrado';
  end if;
  if v_link.currency <> p_currency then
    raise exception 'Moneda del pago (%) no coincide con el link (%)', p_currency, v_link.currency;
  end if;

  -- Idempotencia: si ya se registró este pago, devolverlo.
  select id into v_payment_id from public.payments
    where tenant_id = p_tenant_id and source = p_provider and external_id = p_external_id;
  if v_payment_id is not null then
    return v_payment_id;
  end if;

  select * into v_doc from public.documents where id = v_link.document_id and tenant_id = p_tenant_id;

  insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on, method, reference, source, external_id, created_by)
  values (p_tenant_id, 'in', v_doc.counterparty_id, p_currency, p_amount, p_paid_on, p_method, p_reference, p_provider, p_external_id, null)
  returning id into v_payment_id;

  -- Se asigna hasta el saldo pendiente; un excedente queda como pago sin asignar para revisión.
  v_pending := private.document_pending(v_doc.id, null);
  if v_doc.status = 'open' and v_pending > 0 then
    insert into public.payment_allocations (tenant_id, payment_id, document_id, amount)
    values (p_tenant_id, v_payment_id, v_doc.id, least(v_pending, p_amount));
  end if;

  update public.payment_links set status = 'paid' where id = v_link.id;
  update public.integration_connections set last_event_at = now(), last_error = null
    where tenant_id = p_tenant_id and provider = p_provider;
  return v_payment_id;
end;
$$;

revoke all on function public.record_provider_payment(uuid, uuid, text, text, public.currency_code, bigint, date, text, text)
  from public, anon, authenticated;
grant execute on function public.record_provider_payment(uuid, uuid, text, text, public.currency_code, bigint, date, text, text)
  to service_role;
