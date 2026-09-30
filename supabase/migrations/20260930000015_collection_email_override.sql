-- Correo de cobranza: asunto y contenido editados solo para un envío (la plantilla no cambia).
drop function if exists public.queue_collection_email(uuid, uuid, uuid, text[], text[]);
create or replace function public.queue_collection_email(
  p_counterparty_id uuid, p_rule_id uuid default null, p_document_id uuid default null,
  p_to text[] default null, p_cc text[] default null, p_subject text default null, p_blocks jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cp public.counterparties;
  v_to text[] := private.clean_emails(p_to);
  v_cc text[] := private.clean_emails(p_cc);
  v_subject text := nullif(trim(p_subject), '');
begin
  select * into v_cp from public.counterparties where id = p_counterparty_id;
  if v_cp.id is null or not private.can_write(v_cp.tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if p_rule_id is not null and not exists (select 1 from public.collection_rules where id = p_rule_id and tenant_id = v_cp.tenant_id) then
    raise exception 'Plantilla no encontrada';
  end if;
  if p_document_id is not null and not exists (select 1 from public.documents where id = p_document_id and counterparty_id = v_cp.id) then
    raise exception 'Documento no encontrado';
  end if;
  if p_to is not null and cardinality(v_to) = 0 then
    raise exception 'Indica al menos un correo válido en "Para"';
  end if;
  if cardinality(v_to) > 10 or cardinality(v_cc) > 10 then
    raise exception 'Máximo 10 correos en "Para" y 10 en copia';
  end if;
  if length(v_subject) > 200 then
    raise exception 'El asunto no puede superar 200 caracteres';
  end if;
  if p_blocks is not null and (jsonb_typeof(p_blocks) <> 'array' or length(p_blocks::text) > 40000) then
    raise exception 'Contenido del correo inválido o demasiado largo';
  end if;
  if exists (select 1 from public.email_outbox o where o.tenant_id = v_cp.tenant_id and o.counterparty_id = v_cp.id
             and o.payload ->> 'manual' = 'true' and o.created_by = auth.uid() and o.created_at > now() - interval '2 minutes') then
    raise exception 'Espera un par de minutos antes de enviar otro correo a este cliente';
  end if;
  insert into public.email_outbox (tenant_id, kind, payload, counterparty_id, rule_id)
  values (v_cp.tenant_id, case when p_rule_id is null then 'statement' else 'collection_rule' end,
          jsonb_strip_nulls(jsonb_build_object('rule_id', p_rule_id, 'counterparty_id', v_cp.id, 'document_id', p_document_id, 'manual', true,
            'to', case when p_to is null then null else to_jsonb(v_to) end,
            'cc', case when cardinality(v_cc) = 0 then null else to_jsonb(v_cc) end,
            'subject_override', v_subject,
            'blocks_override', p_blocks)),
          v_cp.id, p_rule_id);
end;
$$;
revoke all on function public.queue_collection_email(uuid, uuid, uuid, text[], text[], text, jsonb) from public, anon;
grant execute on function public.queue_collection_email(uuid, uuid, uuid, text[], text[], text, jsonb) to authenticated;
