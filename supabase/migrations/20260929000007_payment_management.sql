-- Gestión de pagos de cuentas por pagar: pago solicitado → pago programado (con fecha) → pago realizado.
-- "Realizado" no se guarda: se deriva de que el documento quedó pagado por completo.

create type public.payment_stage as enum ('requested', 'scheduled');

alter table public.documents
  add column payment_stage public.payment_stage,
  add column payment_stage_at timestamptz,
  add column payment_stage_by uuid references auth.users (id);

create or replace function private.document_payment_stage_rules()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Si deja de estar aprobado o se anula, la gestión de pago se reinicia.
  if new.approval_status <> 'approved' or new.status <> 'open' then
    new.payment_stage := null;
  end if;
  if new.payment_stage is not null then
    if new.direction <> 'payable' then
      raise exception 'La gestión de pagos aplica solo a cuentas por pagar';
    end if;
    if new.payment_stage = 'scheduled' and new.scheduled_payment_date is null then
      raise exception 'Indica la fecha en que se programa el pago';
    end if;
  end if;
  if tg_op = 'INSERT' or new.payment_stage is distinct from old.payment_stage then
    new.payment_stage_at := case when new.payment_stage is null then null else now() end;
    new.payment_stage_by := case when new.payment_stage is null then null else auth.uid() end;
  end if;
  return new;
end;
$$;
create trigger documents_payment_stage_rules before insert or update on public.documents
  for each row execute function private.document_payment_stage_rules();

-- La vista de saldos se recrea para incluir la gestión de pago.
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
allocated as (
  select document_id, sum(amount) as amount from public.document_allocations group by document_id
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
    coalesce(f.n, 0)::int as attachment_count,
    private.allocation_base(d) as allocation_base,
    coalesce(al.amount, 0) as allocated_amount
  from public.documents d
  join public.tenants t on t.id = d.tenant_id
  join public.counterparties c on c.id = d.counterparty_id
  left join credits cr on cr.document_id = d.id
  left join paid pd on pd.document_id = d.id
  left join files f on f.document_id = d.id
  left join allocated al on al.document_id = d.id
),
computed as (
  select
    b.*,
    case when b.status = 'open' and b.doc_type <> 'nota_credito'
      then greatest(0, b.net_total - b.detraction_amount - b.paid_amount) else 0 end as pending_amount
  from base b
)
select
  x.*,
  case
    when x.status = 'void' then 'anulado'
    when x.status = 'draft' then 'borrador'
    when x.doc_type = 'nota_credito' then 'aplicada'
    when x.pending_amount = 0 then 'pagado'
    when x.due_date is not null and x.due_date < x.today then 'vencido'
    when x.paid_amount > 0 then 'parcial'
    else 'pendiente'
  end as payment_status,
  case when x.status = 'open' and x.due_date is not null and x.due_date < x.today and x.pending_amount > 0
    then x.today - x.due_date else 0 end as days_overdue,
  -- Gestión de pago (solo CxP): null = sin gestionar, requested, scheduled, paid.
  case
    when x.direction <> 'payable' or x.doc_type = 'nota_credito' or x.status = 'void' then null
    when x.status = 'open' and x.pending_amount = 0 then 'paid'
    when x.approval_status <> 'approved' then null
    else x.payment_stage::text
  end as payment_management
from computed x;
grant select on public.document_balances to authenticated;
revoke all on public.document_balances from anon;

-- Portal: el proveedor ve la aprobación, la gestión de pago y la fecha programada.
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
  where tenant_id = p_tenant_id and counterparty_id = p_counterparty_id and kind = 'email' and email = private.session_email();

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
        'approval_status', b.approval_status, 'rejection_reason', b.rejection_reason,
        'payment_management', b.payment_management,
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
