-- Links de pago (MercadoPago):
--   * vencen (expires_at, 30 días) y se desactivan solos cuando el saldo del documento cambia
--     (abono, nota de crédito, anulación): así el cliente nunca paga un monto desactualizado;
--   * consulta pública mínima para las páginas de regreso (/pago/exito, /pago/pendiente, /pago/error);
--   * plantilla de cobranza "Cobro con link de pago".

alter table public.payment_links add column if not exists expires_at timestamptz;
create index if not exists payment_links_active_idx on public.payment_links (document_id) where status = 'active';

create or replace function private.expire_stale_payment_links(p_document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
  v_pending bigint;
begin
  if p_document_id is null then return; end if;
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null then return; end if;
  v_pending := coalesce(private.document_pending(p_document_id, null), 0);
  update public.payment_links set status = 'expired'
  where document_id = p_document_id and status = 'active'
    and (v_doc.status <> 'open' or v_pending <= 0 or amount <> v_pending);
end;
$$;
revoke all on function private.expire_stale_payment_links(uuid) from public, anon, authenticated;

create or replace function private.payment_links_on_allocation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.expire_stale_payment_links(coalesce(new.document_id, old.document_id));
  if tg_op = 'UPDATE' and new.document_id is distinct from old.document_id then
    perform private.expire_stale_payment_links(old.document_id);
  end if;
  return null;
end;
$$;
create trigger payment_allocations_expire_links after insert or update or delete on public.payment_allocations
  for each row execute function private.payment_links_on_allocation();

-- Anular un pago devuelve saldo: el link (si lo hubiera) ya no calza.
create or replace function private.payment_links_on_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_doc uuid;
begin
  for v_doc in select document_id from public.payment_allocations where payment_id = new.id loop
    perform private.expire_stale_payment_links(v_doc);
  end loop;
  return null;
end;
$$;
create trigger payments_expire_links after update of status on public.payments
  for each row execute function private.payment_links_on_payment();

-- Cambios del documento (monto, anulación) y notas de crédito que lo rebajan.
create or replace function private.payment_links_on_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'DELETE' then
    perform private.expire_stale_payment_links(new.id);
    perform private.expire_stale_payment_links(new.applies_to_id);
  end if;
  if tg_op <> 'INSERT' then
    perform private.expire_stale_payment_links(old.applies_to_id);
  end if;
  return null;
end;
$$;
create trigger documents_expire_links after insert or update or delete on public.documents
  for each row execute function private.payment_links_on_document();

-- ---------------------------------------------------------------------------
-- Páginas de regreso del pago (públicas): solo datos mínimos del link.
-- El id del link es un UUID que solo conoce quien recibió el link.
-- ---------------------------------------------------------------------------
create or replace function public.payment_link_public(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_name', t.name,
    'doc_type', d.doc_type,
    'folio', d.folio,
    'amount', l.amount,
    'currency', l.currency,
    'status', l.status
  )
  from public.payment_links l
  join public.documents d on d.id = l.document_id
  join public.tenants t on t.id = l.tenant_id
  where l.id = p_id
$$;
revoke all on function public.payment_link_public(uuid) from public;
grant execute on function public.payment_link_public(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Plantilla "Cobro con link de pago" (envío manual desde el documento o la ficha de cobranza)
-- ---------------------------------------------------------------------------
create or replace function private.seed_payment_link_rule(p_tenant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.collection_rules where tenant_id = p_tenant and name = 'Cobro con link de pago') then return; end if;
  insert into public.collection_rules (tenant_id, name, trigger, offset_days, weekday, send_hour, subject, body, include_documents, include_payment_link, active, created_by)
  values (p_tenant, 'Cobro con link de pago', 'manual', 0, null, 9,
    'Paga tu {{documento}} de {{empresa}} en línea',
    E'Hola {{cliente}},\n\nte enviamos el detalle de la {{documento}}, con un saldo pendiente de {{saldo}} (vence el {{vencimiento}}).\n\nPuedes pagarla en línea, de forma segura, con el botón de abajo.\n\nSaludos,\n{{empresa}}',
    true, true, true, null);
end;
$$;
revoke all on function private.seed_payment_link_rule(uuid) from public, anon, authenticated;
select private.seed_payment_link_rule(id) from public.tenants;

create or replace function private.seed_collection_rules_on_tenant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_collection_rules(new.id);
  perform private.seed_payment_link_rule(new.id);
  return new;
end;
$$;
