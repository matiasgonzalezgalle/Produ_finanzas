-- Usuarios por empresa, adjuntos de documentos, pago agendado y reglas de edición/borrado.

-- ---------------------------------------------------------------------------
-- Perfiles con correo (para listar miembros de la empresa)
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

-- Miembros con nombre y correo. security_invoker: respeta RLS (solo miembros de la misma empresa).
create or replace view public.tenant_member_list with (security_invoker = true) as
select m.tenant_id, m.user_id, m.role, m.created_at, p.full_name, p.email
from public.tenant_members m
left join public.profiles p on p.id = m.user_id;
grant select on public.tenant_member_list to authenticated;

-- El owner no puede quedar sin reemplazo: no se borra ni se degrada vía RLS (ya cubierto),
-- y un usuario puede salir de una empresa salvo que sea owner.
create policy members_leave on public.tenant_members for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'owner');

-- ---------------------------------------------------------------------------
-- Documentos: pago agendado y reglas de edición
-- ---------------------------------------------------------------------------
alter table public.documents add column if not exists scheduled_payment_date date;
create index if not exists documents_scheduled_idx on public.documents (tenant_id, direction, scheduled_payment_date)
  where scheduled_payment_date is not null;

-- Al editar un documento, su saldo no puede quedar negativo respecto de lo ya pagado,
-- y no se puede cambiar contraparte/moneda/dirección si ya tiene pagos asignados.
create or replace function private.check_document_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  paid bigint;
  credits bigint;
begin
  select coalesce(sum(a.amount), 0) into paid
  from public.payment_allocations a
  join public.payments p on p.id = a.payment_id and p.status = 'confirmed'
  where a.document_id = new.id;

  if paid > 0 and (new.counterparty_id <> old.counterparty_id or new.currency <> old.currency or new.direction <> old.direction) then
    raise exception 'El documento tiene pagos asignados: no se puede cambiar contraparte, moneda ni dirección';
  end if;

  if new.status = 'open' then
    select coalesce(sum(total_amount), 0) into credits from public.documents
      where applies_to_id = new.id and status = 'open';
    if new.total_amount - credits - new.detraction_amount < paid then
      raise exception 'El nuevo total queda por debajo de lo ya pagado (%)', paid;
    end if;
  end if;
  return new;
end;
$$;
create trigger documents_check_update before update on public.documents
  for each row execute function private.check_document_update();

-- Borrar solo documentos sin pagos ni notas de crédito asociadas (si no, se anulan).
create or replace function private.check_document_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.payment_allocations a where a.document_id = old.id) then
    raise exception 'El documento tiene pagos asociados: anúlalo en vez de eliminarlo';
  end if;
  if exists (select 1 from public.documents c where c.applies_to_id = old.id) then
    raise exception 'El documento tiene notas de crédito asociadas: anúlalo en vez de eliminarlo';
  end if;
  return old;
end;
$$;
create trigger documents_check_delete before delete on public.documents
  for each row execute function private.check_document_delete();

-- ---------------------------------------------------------------------------
-- Adjuntos de documentos (archivos en Supabase Storage, bucket privado "documents")
-- Ruta del objeto: {tenant_id}/{document_id}/{uuid}-{nombre}
-- ---------------------------------------------------------------------------
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  document_id uuid not null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0 and size_bytes <= 20971520),
  uploaded_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade,
  -- La ruta debe empezar con el tenant y el documento: impide apuntar a archivos de otra empresa.
  constraint attachment_path_scoped check (storage_path like tenant_id::text || '/' || document_id::text || '/%')
);
create index document_attachments_document_idx on public.document_attachments (tenant_id, document_id);
alter table public.document_attachments enable row level security;
create policy document_attachments_select on public.document_attachments for select to authenticated
  using ((select private.is_member(tenant_id)));
create policy document_attachments_insert on public.document_attachments for insert to authenticated
  with check ((select private.can_write(tenant_id)));
create policy document_attachments_delete on public.document_attachments for delete to authenticated
  using ((select private.can_write(tenant_id)));
grant select, insert, delete on public.document_attachments to authenticated;
create trigger audit_document_attachments after insert or update or delete on public.document_attachments
  for each row execute function private.audit();

-- Storage: bucket privado y políticas por empresa (primera carpeta = tenant_id).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('documents', 'documents', false, 20971520)
    on conflict (id) do nothing;

    execute $p$
      create policy "documents_read" on storage.objects for select to authenticated
      using (bucket_id = 'documents' and (select private.is_member(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy "documents_insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'documents' and (select private.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
    execute $p$
      create policy "documents_delete" on storage.objects for delete to authenticated
      using (bucket_id = 'documents' and (select private.can_write(((storage.foldername(name))[1])::uuid)))
    $p$;
  end if;
end;
$$;

-- La vista de saldos cambia de columnas: se elimina y se recrea.
drop view public.document_balances;
create view public.document_balances with (security_invoker = true) as
with credits as (
  select applies_to_id as document_id, sum(total_amount) as amount
  from public.documents where applies_to_id is not null and status = 'open'
  group by applies_to_id
),
paid as (
  select a.document_id, sum(a.amount) as amount
  from public.payment_allocations a
  join public.payments p on p.id = a.payment_id and p.status = 'confirmed'
  group by a.document_id
),
files as (
  select document_id, count(*) as n from public.document_attachments group by document_id
),
base as (
  select
    d.*,
    c.name as counterparty_name,
    c.tax_id as counterparty_tax_id,
    coalesce(cr.amount, 0) as credits_amount,
    coalesce(pd.amount, 0) as paid_amount,
    greatest(0, d.total_amount - coalesce(cr.amount, 0)) as net_total,
    (now() at time zone t.timezone)::date as today,
    coalesce(f.n, 0)::int as attachment_count
  from public.documents d
  join public.tenants t on t.id = d.tenant_id
  join public.counterparties c on c.id = d.counterparty_id
  left join credits cr on cr.document_id = d.id
  left join paid pd on pd.document_id = d.id
  left join files f on f.document_id = d.id
)
select
  b.*,
  case when b.status = 'open' and b.doc_type <> 'nota_credito'
    then greatest(0, b.net_total - b.detraction_amount - b.paid_amount) else 0 end as pending_amount,
  case
    when b.status = 'void' then 'anulado'
    when b.status = 'draft' then 'borrador'
    when b.doc_type = 'nota_credito' then 'aplicada'
    when greatest(0, b.net_total - b.detraction_amount - b.paid_amount) = 0 then 'pagado'
    when b.due_date is not null and b.due_date < b.today then 'vencido'
    when b.paid_amount > 0 then 'parcial'
    else 'pendiente'
  end as payment_status,
  case when b.status = 'open' and b.due_date is not null and b.due_date < b.today
    and greatest(0, b.net_total - b.detraction_amount - b.paid_amount) > 0
    then b.today - b.due_date else 0 end as days_overdue
from base b;

grant select on public.document_balances to authenticated;
