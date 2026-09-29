-- Portal financiero: clientes y proveedores ven sus documentos, pagos y archivos.
-- Acceso: el correo autorizado inicia sesión con código (Supabase Auth OTP). El servidor
-- entrega solo los datos de las contrapartes a las que ese correo tiene acceso.

alter table public.tenants add column if not exists portal_enabled boolean not null default false;
alter table public.tenants add column if not exists portal_message text;

create table public.portal_access (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  counterparty_id uuid not null,
  email text not null check (email = lower(trim(email)) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  enabled boolean not null default true,
  last_access_at timestamptz,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, counterparty_id, email),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id) on delete cascade
);
create index portal_access_email_idx on public.portal_access (email) where enabled;

alter table public.portal_access enable row level security;
create policy portal_access_select on public.portal_access for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy portal_access_insert on public.portal_access for insert to authenticated
  with check ((select private.can_admin(tenant_id)));
create policy portal_access_update on public.portal_access for update to authenticated
  using ((select private.can_admin(tenant_id))) with check ((select private.can_admin(tenant_id)));
create policy portal_access_delete on public.portal_access for delete to authenticated
  using ((select private.can_admin(tenant_id)));
grant select, insert, update, delete on public.portal_access to authenticated;
create trigger audit_portal_access after insert or update or delete on public.portal_access
  for each row execute function private.audit();

-- Correo verificado de la sesión actual (el OTP de Supabase lo verifica).
create or replace function private.session_email()
returns text language sql stable set search_path = '' as $$
  select lower(nullif(auth.jwt() ->> 'email', ''))
$$;

-- ¿La sesión actual tiene acceso vigente a esta contraparte?
create or replace function private.portal_has_access(p_tenant uuid, p_counterparty uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.portal_access pa
    join public.tenants t on t.id = pa.tenant_id and t.portal_enabled
    where pa.tenant_id = p_tenant
      and pa.counterparty_id = p_counterparty
      and pa.enabled
      and pa.email = private.session_email()
  )
$$;

-- Cuentas (empresa + contraparte) a las que el correo de la sesión tiene acceso.
create or replace function public.portal_my_accounts()
returns table (
  access_id uuid,
  tenant_id uuid,
  tenant_name text,
  counterparty_id uuid,
  counterparty_name text,
  is_supplier boolean,
  is_customer boolean
)
language sql stable security definer set search_path = '' as $$
  select pa.id, t.id, coalesce(t.legal_name, t.name), c.id, c.name, c.is_supplier, c.is_customer
  from public.portal_access pa
  join public.tenants t on t.id = pa.tenant_id and t.portal_enabled
  join public.counterparties c on c.id = pa.counterparty_id
  where pa.enabled and pa.email = private.session_email()
  order by t.name, c.name
$$;

-- Todo lo que ve una contraparte en el portal, en un solo llamado.
create or replace function public.portal_snapshot(p_tenant_id uuid, p_counterparty_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not private.portal_has_access(p_tenant_id, p_counterparty_id) then
    raise exception 'Sin acceso a este portal' using errcode = '42501';
  end if;

  update public.portal_access set last_access_at = now()
  where tenant_id = p_tenant_id and counterparty_id = p_counterparty_id and email = private.session_email();

  select jsonb_build_object(
    'tenant', (select jsonb_build_object('name', coalesce(t.legal_name, t.name), 'tax_id', t.tax_id, 'country', t.country, 'message', t.portal_message)
               from public.tenants t where t.id = p_tenant_id),
    'counterparty', (select jsonb_build_object('name', c.name, 'legal_name', c.legal_name, 'tax_id', c.tax_id, 'country', c.country,
                            'is_supplier', c.is_supplier, 'is_customer', c.is_customer, 'email', c.email, 'phone', c.phone, 'address', c.address)
                     from public.counterparties c where c.id = p_counterparty_id),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'direction', b.direction, 'doc_type', b.doc_type, 'folio', b.folio, 'currency', b.currency,
        'total_amount', b.total_amount, 'paid_amount', b.paid_amount, 'pending_amount', b.pending_amount,
        'issue_date', b.issue_date, 'due_date', b.due_date, 'scheduled_payment_date', b.scheduled_payment_date,
        'payment_status', b.payment_status, 'days_overdue', b.days_overdue,
        'detraction_amount', b.detraction_amount, 'detraction_status', b.detraction_status,
        'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'storage_path', a.storage_path, 'size_bytes', a.size_bytes))
                                  from public.document_attachments a where a.document_id = b.id), '[]'::jsonb),
        'payment_url', (select l.url from public.payment_links l
                        where l.document_id = b.id and l.status = 'active' and l.url is not null
                        order by l.created_at desc limit 1)
      ) order by b.due_date nulls last)
      from public.document_balances b
      where b.tenant_id = p_tenant_id and b.counterparty_id = p_counterparty_id and b.status <> 'draft'
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'direction', p.direction, 'currency', p.currency, 'amount', p.amount, 'paid_on', p.paid_on,
        'method', p.method, 'reference', p.reference,
        'folios', coalesce((select jsonb_agg(d.folio) from public.payment_allocations a join public.documents d on d.id = a.document_id where a.payment_id = p.id), '[]'::jsonb)
      ) order by p.paid_on desc)
      from public.payments p
      where p.tenant_id = p_tenant_id and p.counterparty_id = p_counterparty_id and p.status = 'confirmed'
    ), '[]'::jsonb),
    'bank_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('bank_name', ba.bank_name, 'account_type', ba.account_type, 'account_number', ba.account_number,
                                          'holder_name', ba.holder_name, 'holder_tax_id', ba.holder_tax_id, 'email', ba.email, 'currency', ba.currency))
      from public.bank_accounts ba where ba.tenant_id = p_tenant_id and ba.counterparty_id = p_counterparty_id
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.portal_my_accounts(), public.portal_snapshot(uuid, uuid) from public, anon;
grant execute on function public.portal_my_accounts(), public.portal_snapshot(uuid, uuid) to authenticated;
revoke all on function private.portal_has_access(uuid, uuid), private.session_email() from public, anon;
grant execute on function private.portal_has_access(uuid, uuid), private.session_email() to authenticated, service_role;

-- Archivos: quien tiene acceso al portal puede descargar los adjuntos de sus documentos.
create or replace function private.portal_can_read_file(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.document_attachments a
    join public.documents d on d.id = a.document_id
    where a.storage_path = p_path
      and d.status <> 'draft'
      and private.portal_has_access(d.tenant_id, d.counterparty_id)
  )
$$;
revoke all on function private.portal_can_read_file(text) from public, anon;
grant execute on function private.portal_can_read_file(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$
      create policy "documents_portal_read" on storage.objects for select to authenticated
      using (bucket_id = 'documents' and (select private.portal_can_read_file(name)))
    $p$;
  end if;
end;
$$;
