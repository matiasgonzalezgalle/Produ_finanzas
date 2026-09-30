-- Importar documentos tributarios desde su XML (Chile: DTE del SII; Perú: UBL 2.1 de SUNAT).
-- El navegador lee el XML y envía los datos; aquí se verifica que la empresa sea emisora o
-- receptora (define si es venta o compra), se crea la contraparte si no existe y se registra el
-- documento. Si ya existe (mismo tipo, folio y RUT/RUC), no se duplica. SECURITY INVOKER: aplica
-- RLS y todas las reglas de documentos. Cada documento se procesa por separado.

create or replace function public.import_xml_documents(p_tenant_id uuid, p_docs jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  d jsonb;
  v_tenant public.tenants;
  v_key text;
  v_direction public.document_direction;
  v_type public.document_type;
  v_issuer text;
  v_receiver text;
  v_other_tax text;
  v_other_name text;
  v_cp uuid;
  v_terms int;
  v_default_days int;
  v_target uuid;
  v_doc uuid;
  v_existing uuid;
  v_issue date;
  v_due date;
  v_currency public.currency_code;
  v_results jsonb := '[]';
begin
  if not private.can_write(p_tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  if private.rut_key(v_tenant.tax_id) is null then
    raise exception 'Registra el % de tu empresa (Configuración › Empresa) para importar XML', case v_tenant.country when 'PE' then 'RUC' else 'RUT' end;
  end if;
  if jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 200 then
    raise exception 'Máximo 200 documentos por importación';
  end if;

  -- Primero los documentos, después las notas de crédito (que se aplican a ellos).
  for d in select value from jsonb_array_elements(p_docs) order by (value ->> 'doc_type') = 'nota_credito', value ->> 'issue_date' loop
    v_key := d ->> 'key';
    begin
      v_issuer := private.rut_key(d ->> 'issuer_tax_id');
      v_receiver := private.rut_key(d ->> 'receiver_tax_id');
      v_type := (d ->> 'doc_type')::public.document_type;
      -- Factura de compra (DTE 46): la emite el comprador; para la empresa emisora es una compra.
      if coalesce((d ->> 'buyer_issued')::boolean, false) then
        if v_issuer = private.rut_key(v_tenant.tax_id) then
          v_direction := 'payable'; v_other_tax := d ->> 'receiver_tax_id'; v_other_name := d ->> 'receiver_name';
        else
          v_direction := 'receivable'; v_other_tax := d ->> 'issuer_tax_id'; v_other_name := d ->> 'issuer_name';
        end if;
      elsif v_issuer = private.rut_key(v_tenant.tax_id) then
        v_direction := 'receivable'; v_other_tax := d ->> 'receiver_tax_id'; v_other_name := d ->> 'receiver_name';
      elsif v_receiver = private.rut_key(v_tenant.tax_id) then
        v_direction := 'payable'; v_other_tax := d ->> 'issuer_tax_id'; v_other_name := d ->> 'issuer_name';
      else
        raise exception 'El documento no es de tu empresa: ni el emisor ni el receptor tienen tu %', case v_tenant.country when 'PE' then 'RUC' else 'RUT' end;
      end if;
      if private.rut_key(v_other_tax) is null then
        raise exception 'El XML no trae el RUT/RUC de la contraparte';
      end if;
      if not private.has_module(p_tenant_id, case v_direction when 'payable' then 'cuentas_por_pagar' else 'cuentas_por_cobrar' end) then
        raise exception 'El módulo de % no está activo', case v_direction when 'payable' then 'cuentas por pagar' else 'cuentas por cobrar' end;
      end if;
      v_issue := (d ->> 'issue_date')::date;
      v_due := nullif(d ->> 'due_date', '')::date;
      v_currency := coalesce(nullif(d ->> 'currency', ''), v_tenant.base_currency::text)::public.currency_code;

      -- ¿Ya existe? (mismo sentido, tipo, folio y RUT/RUC de la contraparte)
      select doc.id into v_existing
      from public.documents doc join public.counterparties c on c.id = doc.counterparty_id
      where doc.tenant_id = p_tenant_id and doc.direction = v_direction and doc.doc_type = v_type
        and doc.folio = d ->> 'folio' and doc.status <> 'void' and private.rut_key(c.tax_id) = private.rut_key(v_other_tax)
      limit 1;
      if v_existing is not null then
        v_results := v_results || jsonb_build_object('key', v_key, 'status', 'exists', 'document_id', v_existing, 'direction', v_direction);
        continue;
      end if;

      select c.id, c.payment_terms_days into v_cp, v_terms
      from public.counterparties c
      where c.tenant_id = p_tenant_id and private.rut_key(c.tax_id) = private.rut_key(v_other_tax)
      order by c.created_at limit 1;
      if v_cp is null then
        insert into public.counterparties (tenant_id, name, legal_name, country, tax_id, is_supplier, is_customer)
        values (p_tenant_id, coalesce(nullif(trim(v_other_name), ''), v_other_tax), nullif(trim(v_other_name), ''), v_tenant.country,
                v_other_tax, v_direction = 'payable', v_direction = 'receivable')
        returning id into v_cp;
      elsif v_direction = 'payable' then
        update public.counterparties set is_supplier = true where id = v_cp and not is_supplier;
      else
        update public.counterparties set is_customer = true where id = v_cp and not is_customer;
      end if;

      v_target := null;
      if v_type = 'nota_credito' then
        select doc.id into v_target from public.documents doc
        where doc.tenant_id = p_tenant_id and doc.direction = v_direction and doc.counterparty_id = v_cp
          and doc.folio = d ->> 'reference_folio' and doc.doc_type <> 'nota_credito' and doc.status <> 'void'
        order by doc.issue_date desc limit 1;
        if v_target is null then
          raise exception 'Registra primero el documento N° % al que aplica la nota de crédito', coalesce(d ->> 'reference_folio', '?');
        end if;
      end if;

      if v_due is null and v_type <> 'nota_credito' then
        select default_due_days into v_default_days from public.module_settings where tenant_id = p_tenant_id and direction = v_direction;
        if coalesce(v_terms, v_default_days) is not null then
          v_due := v_issue + coalesce(v_terms, v_default_days);
        end if;
      end if;

      insert into public.documents (
        tenant_id, direction, counterparty_id, doc_type, folio, currency,
        net_amount, exempt_amount, tax_amount, total_amount, issue_date, due_date, status, applies_to_id,
        detraction_rate, detraction_amount, detraction_status, description, external_source, external_id
      ) values (
        p_tenant_id, v_direction, v_cp, v_type, d ->> 'folio', v_currency,
        coalesce((d ->> 'net_amount')::bigint, 0), coalesce((d ->> 'exempt_amount')::bigint, 0), coalesce((d ->> 'tax_amount')::bigint, 0),
        (d ->> 'total_amount')::bigint, v_issue, case when v_type = 'nota_credito' then null else v_due end, 'open', v_target,
        coalesce((d ->> 'detraction_rate')::numeric, 0), coalesce((d ->> 'detraction_amount')::bigint, 0),
        case when coalesce((d ->> 'detraction_amount')::bigint, 0) > 0 then 'pendiente' else 'no_aplica' end::public.detraction_status,
        left(coalesce(nullif(trim(d ->> 'description'), ''), 'Importado desde XML.'), 500),
        'xml', left(concat_ws(':', private.rut_key(d ->> 'issuer_tax_id'), d ->> 'type_code', d ->> 'folio'), 200)
      ) returning id into v_doc;
      v_results := v_results || jsonb_build_object('key', v_key, 'status', 'imported', 'document_id', v_doc, 'direction', v_direction);
    exception when others then
      v_results := v_results || jsonb_build_object('key', v_key, 'status', 'error', 'reason', sqlerrm);
    end;
  end loop;
  return v_results;
end;
$$;
revoke all on function public.import_xml_documents(uuid, jsonb) from public, anon;
grant execute on function public.import_xml_documents(uuid, jsonb) to authenticated;
