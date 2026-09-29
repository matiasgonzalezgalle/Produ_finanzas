-- Documentos tributarios del SII (Chile) vía la API Fiscal de Fintoc.
-- Produ Finanzas usa una cuenta de Fintoc; cada empresa conecta su SII con el widget.
-- El link_token de cada empresa vive en integration_secrets (solo service_role).
-- Los documentos se guardan en sii_documents (los escribe la edge function) y se
-- importan a cuentas por pagar / por cobrar con import_sii_documents.

alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('mercadopago', 'fintoc_sii'));

-- Estados de un solo uso para asociar el link que crea el widget a la empresa que lo pidió.
create table public.fintoc_connect_states (
  state_hash text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz
);
alter table public.fintoc_connect_states enable row level security;
revoke all on public.fintoc_connect_states from anon, authenticated;

create table public.sii_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- id del documento en Fintoc (inv_…)
  external_id text not null,
  -- received (compra) -> payable; issued (venta) -> receivable
  direction public.document_direction not null,
  sii_type int,
  is_fee_receipt boolean not null default false,
  is_summary boolean not null default false,
  folio text,
  counterparty_tax_id text,
  counterparty_name text,
  issue_date date not null,
  tax_period text,
  net_amount bigint not null default 0,
  exempt_amount bigint not null default 0,
  tax_amount bigint not null default 0,
  other_taxes_amount bigint not null default 0,
  total_amount bigint not null default 0,
  -- Honorarios: retención del receptor.
  withheld_amount bigint not null default 0,
  -- registered | pending | cancelled (reclamados) | rejected (no incluir)
  registry_status text,
  -- C, A, P, G, R o null (acuse de recibo)
  confirmation_status text,
  fee_status text,
  accepted_at timestamptz,
  rejected_at timestamptz,
  reference_type int,
  reference_folio text,
  transaction_category text,
  document_id uuid,
  ignored boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete set null (document_id)
);
create index sii_documents_tenant_idx on public.sii_documents (tenant_id, direction, issue_date desc);

alter table public.sii_documents enable row level security;
create policy sii_documents_select on public.sii_documents for select to authenticated using ((select private.is_member(tenant_id)));
create policy sii_documents_update on public.sii_documents for update to authenticated
  using ((select private.can_write(tenant_id))) with check ((select private.can_write(tenant_id)));
grant select on public.sii_documents to authenticated;
-- Desde el cliente solo se marca "ignorar"; la vinculación la hace import_sii_documents.
grant update (ignored, document_id) on public.sii_documents to authenticated;
revoke all on public.sii_documents from anon;

-- Tipo SII -> tipo de documento de la app (null = no se importa: boletas resumidas, guías, liquidaciones…).
create or replace function private.sii_doc_type(p_sii_type int, p_is_fee boolean)
returns public.document_type language sql immutable set search_path = '' as $$
  select case
    when p_is_fee then 'honorarios'::public.document_type
    when p_sii_type in (30, 33) then 'factura'
    when p_sii_type in (32, 34) then 'factura_exenta'
    when p_sii_type in (55, 56, 111) then 'nota_debito'
    when p_sii_type in (60, 61, 112) then 'nota_credito'
    when p_sii_type = 110 then 'invoice'
    else null
  end
$$;
grant execute on function private.sii_doc_type(int, boolean) to authenticated, service_role;

create or replace function private.rut_key(p_rut text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(p_rut, ''), '[^0-9kK]', '', 'g')), '')
$$;
grant execute on function private.rut_key(text) to authenticated, service_role;

-- Estado de cada documento del SII frente a los documentos registrados en la app.
create view public.sii_document_status with (security_invoker = true) as
select
  s.*,
  private.sii_doc_type(s.sii_type, s.is_fee_receipt) as doc_type,
  coalesce(s.document_id, m.id) as matched_document_id,
  (private.sii_doc_type(s.sii_type, s.is_fee_receipt) is not null and s.folio is not null and not s.is_summary
    and s.counterparty_tax_id is not null) as importable,
  (s.confirmation_status = 'R' or s.registry_status in ('cancelled', 'rejected') or s.fee_status = 'ANUL') as claimed
from public.sii_documents s
left join lateral (
  select d.id
  from public.documents d
  join public.counterparties c on c.id = d.counterparty_id
  where d.tenant_id = s.tenant_id
    and d.direction = s.direction
    and d.doc_type = private.sii_doc_type(s.sii_type, s.is_fee_receipt)
    and d.folio = s.folio
    and d.status <> 'void'
    and private.rut_key(c.tax_id) = private.rut_key(s.counterparty_tax_id)
  limit 1
) m on true;
grant select on public.sii_document_status to authenticated;
revoke all on public.sii_document_status from anon;

-- Importa documentos del SII a cuentas por pagar / por cobrar (SECURITY INVOKER: aplica RLS y reglas).
-- Crea la contraparte si no existe. Cada documento se procesa por separado: si uno falla, se informa y sigue.
create or replace function public.import_sii_documents(p_tenant_id uuid, p_ids uuid[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r record;
  v_cp uuid;
  v_terms int;
  v_default_days int;
  v_target uuid;
  v_doc uuid;
  v_total bigint;
  v_imported int := 0;
  v_linked int := 0;
  v_skipped jsonb := '[]';
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;

  for r in
    select * from public.sii_document_status
    where tenant_id = p_tenant_id and id = any(p_ids)
    order by (doc_type = 'nota_credito'), issue_date
  loop
    begin
      if r.matched_document_id is not null then
        update public.sii_documents set document_id = r.matched_document_id where id = r.id and document_id is null;
        v_linked := v_linked + 1;
        continue;
      end if;
      if not r.importable then
        raise exception 'Este tipo de documento del SII no se importa';
      end if;
      if r.claimed then
        raise exception 'El documento está reclamado o anulado en el SII';
      end if;

      select c.id, c.payment_terms_days into v_cp, v_terms
      from public.counterparties c
      where c.tenant_id = p_tenant_id and private.rut_key(c.tax_id) = private.rut_key(r.counterparty_tax_id)
      order by c.created_at limit 1;
      if v_cp is null then
        insert into public.counterparties (tenant_id, name, legal_name, country, tax_id, is_supplier, is_customer)
        values (p_tenant_id, coalesce(nullif(trim(r.counterparty_name), ''), r.counterparty_tax_id), nullif(trim(r.counterparty_name), ''), 'CL',
                r.counterparty_tax_id, r.direction = 'payable', r.direction = 'receivable')
        returning id into v_cp;
      elsif r.direction = 'payable' then
        update public.counterparties set is_supplier = true where id = v_cp and not is_supplier;
      else
        update public.counterparties set is_customer = true where id = v_cp and not is_customer;
      end if;

      v_target := null;
      if r.doc_type = 'nota_credito' then
        select d.id into v_target from public.documents d
        where d.tenant_id = p_tenant_id and d.direction = r.direction and d.counterparty_id = v_cp
          and d.folio = r.reference_folio and d.doc_type <> 'nota_credito' and d.status <> 'void'
          and (r.reference_type is null or private.sii_doc_type(r.reference_type, false) is null
               or d.doc_type = private.sii_doc_type(r.reference_type, false))
        order by d.issue_date desc limit 1;
        if v_target is null then
          raise exception 'Registra primero el documento N° % al que aplica la nota de crédito', coalesce(r.reference_folio, '?');
        end if;
      end if;

      select default_due_days into v_default_days from public.module_settings
      where tenant_id = p_tenant_id and direction = r.direction;
      -- Honorarios: se registra el líquido (bruto menos la retención que se entera al SII).
      v_total := case when r.is_fee_receipt then greatest(0, r.total_amount - r.withheld_amount) else r.total_amount end;

      insert into public.documents (
        tenant_id, direction, counterparty_id, doc_type, folio, currency,
        net_amount, exempt_amount, tax_amount, total_amount, issue_date, due_date, status, applies_to_id,
        description, external_source, external_id
      ) values (
        p_tenant_id, r.direction, v_cp, r.doc_type, r.folio, 'CLP',
        case when r.is_fee_receipt then v_total else r.net_amount end,
        case when r.is_fee_receipt then 0 else r.exempt_amount end,
        case when r.is_fee_receipt then 0 else r.tax_amount end,
        v_total, r.issue_date,
        case when r.doc_type = 'nota_credito' then null
             when coalesce(v_terms, v_default_days) is null then null
             else r.issue_date + coalesce(v_terms, v_default_days) end,
        'open', v_target,
        case when r.is_fee_receipt and r.withheld_amount > 0
          then format('Importado del SII. Bruto %s, retención %s.', r.total_amount, r.withheld_amount)
          else 'Importado del SII.' end,
        'sii', r.external_id
      ) returning id into v_doc;

      update public.sii_documents set document_id = v_doc where id = r.id;
      v_imported := v_imported + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('id', r.id, 'folio', r.folio, 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('imported', v_imported, 'linked', v_linked, 'skipped', v_skipped);
end;
$$;
revoke all on function public.import_sii_documents(uuid, uuid[]) from public, anon;
grant execute on function public.import_sii_documents(uuid, uuid[]) to authenticated;
