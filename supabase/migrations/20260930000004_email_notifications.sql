-- Correos del negocio (enviados con Resend desde la edge function email-dispatch).
-- Los eventos se anotan en email_outbox dentro de la misma transacción (triggers), así no se pierden;
-- la función los envía después y registra el resultado. Cada empresa elige qué avisos se envían.

create table public.tenant_email_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  -- Respuestas de los correos (ej. finanzas@empresa.cl). Si es null, no se puede responder.
  reply_to text check (reply_to is null or reply_to ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  -- kind -> true/false. Si falta, se usa el valor por defecto del tipo.
  notifications jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.tenant_email_settings enable row level security;
create policy tenant_email_settings_select on public.tenant_email_settings for select to authenticated using ((select private.is_member(tenant_id)));
create policy tenant_email_settings_insert on public.tenant_email_settings for insert to authenticated with check ((select private.can_admin(tenant_id)));
create policy tenant_email_settings_update on public.tenant_email_settings for update to authenticated
  using ((select private.can_admin(tenant_id))) with check ((select private.can_admin(tenant_id)));
revoke all on public.tenant_email_settings from anon, authenticated;
grant select, insert, update on public.tenant_email_settings to authenticated;

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in (
    'payment_scheduled', 'payment_sent', 'document_rejected', 'payment_received',
    'portal_access_granted', 'member_added', 'purchase_order', 'collection_reminder'
  )),
  -- Ids del evento (documento, pago, acceso…). El contenido se arma al enviar, con datos vigentes.
  payload jsonb not null default '{}',
  -- Evita duplicados del mismo evento (ej. el mismo pago programado dos veces para la misma fecha).
  dedupe_key text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  recipients text[] not null default '{}',
  subject text,
  error text,
  attempts int not null default 0,
  provider_id text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (tenant_id, dedupe_key)
);
create index email_outbox_pending_idx on public.email_outbox (tenant_id, created_at) where status in ('pending', 'sending');
create index email_outbox_tenant_idx on public.email_outbox (tenant_id, created_at desc);
alter table public.email_outbox enable row level security;
create policy email_outbox_select on public.email_outbox for select to authenticated using ((select private.is_member(tenant_id)));
revoke all on public.email_outbox from anon, authenticated;
grant select on public.email_outbox to authenticated;

-- Anota un correo si el tipo está activo para la empresa. SECURITY DEFINER: el outbox no tiene grants de escritura.
create or replace function private.enqueue_email(p_tenant uuid, p_kind text, p_payload jsonb, p_dedupe text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_enabled boolean;
begin
  select (s.notifications ->> p_kind)::boolean into v_enabled from public.tenant_email_settings s where s.tenant_id = p_tenant;
  -- Por defecto: todos activos salvo el comprobante de cobro al cliente.
  if coalesce(v_enabled, p_kind <> 'payment_received') then
    insert into public.email_outbox (tenant_id, kind, payload, dedupe_key)
    values (p_tenant, p_kind, p_payload, p_dedupe)
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
end;
$$;
revoke all on function private.enqueue_email(uuid, text, jsonb, text) from public, anon;
grant execute on function private.enqueue_email(uuid, text, jsonb, text) to authenticated, service_role;

-- CxP: pago programado (o reprogramado) y documento rechazado -> aviso al proveedor.
create or replace function private.document_email_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.direction = 'payable' and new.status = 'open' then
    if new.payment_stage = 'scheduled' and new.scheduled_payment_date is not null
       and (old.payment_stage is distinct from 'scheduled' or old.scheduled_payment_date is distinct from new.scheduled_payment_date) then
      perform private.enqueue_email(new.tenant_id, 'payment_scheduled', jsonb_build_object('document_id', new.id),
        format('payment_scheduled:%s:%s', new.id, new.scheduled_payment_date));
    end if;
    if new.approval_status = 'rejected' and old.approval_status is distinct from 'rejected' then
      perform private.enqueue_email(new.tenant_id, 'document_rejected', jsonb_build_object('document_id', new.id),
        format('document_rejected:%s:%s', new.id, extract(epoch from now())::bigint));
    end if;
  end if;
  return new;
end;
$$;
create trigger documents_email_events after update on public.documents
  for each row execute function private.document_email_events();

-- Pagos: al confirmar la transacción (trigger diferido, ya con sus asignaciones).
create or replace function private.payment_email_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'confirmed' and new.counterparty_id is not null
     and exists (select 1 from public.payment_allocations a where a.payment_id = new.id) then
    perform private.enqueue_email(new.tenant_id, case new.direction when 'out' then 'payment_sent' else 'payment_received' end,
      jsonb_build_object('payment_id', new.id), format('payment:%s', new.id));
  end if;
  return null;
end;
$$;
create constraint trigger payments_email_events after insert on public.payments
  deferrable initially deferred for each row execute function private.payment_email_events();

-- Portal: acceso por correo -> invitación con el link de la contraparte.
create or replace function private.portal_access_email_events()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind = 'email' and new.enabled and new.email is not null then
    perform private.enqueue_email(new.tenant_id, 'portal_access_granted', jsonb_build_object('access_id', new.id), format('portal_access:%s', new.id));
  end if;
  return new;
end;
$$;
create trigger portal_access_email_events after insert on public.portal_access
  for each row execute function private.portal_access_email_events();

-- Recordatorio de cobro manual (CxC). Solo quien puede escribir; como máximo uno por documento cada 12 horas.
create or replace function public.queue_collection_reminder(p_document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc.id is null or not private.can_write(v_doc.tenant_id) then
    raise exception 'Sin permisos' using errcode = '42501';
  end if;
  if v_doc.direction <> 'receivable' or v_doc.status <> 'open' then
    raise exception 'El recordatorio aplica a documentos por cobrar abiertos';
  end if;
  if exists (select 1 from public.email_outbox o where o.tenant_id = v_doc.tenant_id and o.kind = 'collection_reminder'
             and o.payload ->> 'document_id' = p_document_id::text and o.created_at > now() - interval '12 hours'
             and o.status in ('pending', 'sending', 'sent')) then
    raise exception 'Ya se envió un recordatorio de este documento en las últimas 12 horas';
  end if;
  insert into public.email_outbox (tenant_id, kind, payload)
  values (v_doc.tenant_id, 'collection_reminder', jsonb_build_object('document_id', p_document_id));
end;
$$;
revoke all on function public.queue_collection_reminder(uuid) from public, anon;
grant execute on function public.queue_collection_reminder(uuid) to authenticated;

-- La edge function toma los pendientes de una empresa (evita envíos dobles si se llama en paralelo).
create or replace function public.claim_email_outbox(p_tenant uuid, p_limit int default 25)
returns setof public.email_outbox language sql security definer set search_path = '' as $$
  update public.email_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
  where o.id in (
    select id from public.email_outbox
    where tenant_id = p_tenant
      and (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
      and attempts < 5
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning o.*
$$;
revoke all on function public.claim_email_outbox(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(uuid, int) to service_role;
