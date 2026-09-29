-- Administradores de cuentas por pagar y por cobrar: preferencias del módulo,
-- tipos de documento habilitados (crear / pagar) y formas de pago.

-- ---------------------------------------------------------------------------
-- Preferencias por módulo
-- ---------------------------------------------------------------------------
create table public.module_settings (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.document_direction not null,
  -- CxP: si es false, los documentos nuevos quedan aprobados al registrarse.
  require_approval boolean not null default true,
  -- CxP: para aprobar, la distribución contable debe cubrir el monto a distribuir.
  require_allocation boolean not null default false,
  -- CxP: el documento debe estar asociado a una orden de compra para aprobarse.
  -- CxC: el documento debe estar asociado a la orden de compra del cliente para emitirse.
  require_purchase_order boolean not null default false,
  -- Si es false, cada pago/cobro debe saldar completo el documento al que se asigna.
  allow_partial_payments boolean not null default true,
  -- Plazo por defecto cuando la contraparte no tiene uno propio.
  default_due_days int check (default_due_days between 0 and 365),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  primary key (tenant_id, direction)
);

-- Tipos de documento: si no hay fila, el tipo está habilitado para crear y pagar.
create table public.document_type_settings (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.document_direction not null,
  doc_type public.document_type not null,
  can_create boolean not null default true,
  can_pay boolean not null default true,
  primary key (tenant_id, direction, doc_type)
);

-- Formas de pago (out = pagos a proveedores, in = cobros a clientes).
create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  direction public.payment_direction not null,
  name text not null check (length(trim(name)) between 1 and 60),
  active boolean not null default true,
  is_default boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index payment_methods_name_uniq on public.payment_methods (tenant_id, direction, lower(name));
create unique index payment_methods_default_uniq on public.payment_methods (tenant_id, direction) where is_default;

alter table public.module_settings enable row level security;
alter table public.document_type_settings enable row level security;
alter table public.payment_methods enable row level security;

do $$
declare t text;
begin
  foreach t in array array['module_settings', 'document_type_settings', 'payment_methods'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using ((select private.is_member(tenant_id)))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check ((select private.can_admin(tenant_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select private.can_admin(tenant_id))) with check ((select private.can_admin(tenant_id)))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select private.can_admin(tenant_id)))', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function private.audit()', t);
  end loop;
end;
$$;
grant select, insert, update, delete on public.module_settings, public.document_type_settings, public.payment_methods to authenticated;
revoke all on public.module_settings, public.document_type_settings, public.payment_methods from anon;

create or replace function private.touch_module_settings()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger module_settings_touch before update on public.module_settings
  for each row execute function private.touch_module_settings();

-- Valores iniciales para empresas nuevas y existentes.
create or replace function private.seed_module_settings(p_tenant uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_country public.country_code;
begin
  select country into v_country from public.tenants where id = p_tenant;
  insert into public.module_settings (tenant_id, direction, require_approval) values
    (p_tenant, 'payable', true), (p_tenant, 'receivable', false)
  on conflict do nothing;
  insert into public.payment_methods (tenant_id, direction, name, is_default, position)
  select p_tenant, d.dir::public.payment_direction, m.name, m.pos = 0, m.pos
  from (values ('out'), ('in')) d (dir)
  cross join (values ('Transferencia', 0), ('Cheque', 1), ('Efectivo', 2), ('Tarjeta', 3), ('Depósito', 4), ('Otro', 9)) m (name, pos)
  on conflict do nothing;
  if v_country = 'CL' then
    insert into public.payment_methods (tenant_id, direction, name, position)
    values (p_tenant, 'out', 'Vale vista', 5), (p_tenant, 'in', 'Vale vista', 5)
    on conflict do nothing;
  else
    insert into public.payment_methods (tenant_id, direction, name, position)
    values (p_tenant, 'out', 'Yape / Plin', 5), (p_tenant, 'in', 'Yape / Plin', 5)
    on conflict do nothing;
  end if;
end;
$$;
revoke all on function private.seed_module_settings(uuid) from public, anon, authenticated;
select private.seed_module_settings(id) from public.tenants;

create or replace function private.seed_module_settings_on_tenant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_module_settings(new.id);
  return new;
end;
$$;
create trigger tenants_seed_module_settings after insert on public.tenants
  for each row execute function private.seed_module_settings_on_tenant();

-- Solo una forma de pago por defecto: al marcar una, se desmarcan las demás.
create or replace function private.payment_methods_single_default()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_default then
    if not new.active then
      raise exception 'Una forma de pago inactiva no puede ser la predeterminada';
    end if;
    update public.payment_methods set is_default = false
    where tenant_id = new.tenant_id and direction = new.direction and id <> new.id and is_default;
  end if;
  return new;
end;
$$;
create trigger payment_methods_single_default before insert or update on public.payment_methods
  for each row execute function private.payment_methods_single_default();

-- ---------------------------------------------------------------------------
-- Reglas que aplican las preferencias
-- ---------------------------------------------------------------------------
create or replace function private.module_setting(p_tenant uuid, p_direction public.document_direction)
returns public.module_settings language sql stable security definer set search_path = '' as $$
  select * from public.module_settings where tenant_id = p_tenant and direction = p_direction
$$;
revoke all on function private.module_setting(uuid, public.document_direction) from public, anon;
grant execute on function private.module_setting(uuid, public.document_direction) to authenticated, service_role;

-- Documentos: tipo habilitado, aprobación automática y distribución contable exigida.
-- (El nombre ordena este trigger después de documents_approval_defaults y antes de payment_stage_rules.)
create or replace function private.document_module_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_settings public.module_settings := private.module_setting(new.tenant_id, new.direction);
  v_allocated bigint;
begin
  if tg_op = 'INSERT' or new.doc_type is distinct from old.doc_type or new.direction is distinct from old.direction then
    if exists (
      select 1 from public.document_type_settings s
      where s.tenant_id = new.tenant_id and s.direction = new.direction and s.doc_type = new.doc_type and not s.can_create
    ) then
      raise exception 'Este tipo de documento no está habilitado en %',
        case new.direction when 'payable' then 'cuentas por pagar' else 'cuentas por cobrar' end;
    end if;
  end if;

  if tg_op = 'INSERT' and new.direction = 'payable' and not coalesce(v_settings.require_approval, true) then
    new.approval_status := 'approved';
    new.approved_at := now();
    new.approved_by := auth.uid();
  end if;

  if tg_op = 'UPDATE' and new.direction = 'payable' and new.approval_status = 'approved'
     and old.approval_status is distinct from 'approved' and coalesce(v_settings.require_allocation, false) then
    select coalesce(sum(amount), 0) into v_allocated from public.document_allocations where document_id = new.id;
    if v_allocated < private.allocation_base(new) then
      raise exception 'Completa la distribución contable antes de aprobar el documento';
    end if;
  end if;
  return new;
end;
$$;
create trigger documents_module_rules before insert or update on public.documents
  for each row execute function private.document_module_rules();

-- Asignaciones de pago: tipo pagable desde el módulo y pagos parciales.
create or replace function private.allocation_module_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_doc public.documents;
  v_settings public.module_settings;
begin
  select * into v_doc from public.documents where id = new.document_id;
  if exists (
    select 1 from public.document_type_settings s
    where s.tenant_id = v_doc.tenant_id and s.direction = v_doc.direction and s.doc_type = v_doc.doc_type and not s.can_pay
  ) then
    raise exception 'Este tipo de documento no se % desde el módulo',
      case v_doc.direction when 'payable' then 'paga' else 'cobra' end;
  end if;
  v_settings := private.module_setting(v_doc.tenant_id, v_doc.direction);
  if not coalesce(v_settings.allow_partial_payments, true)
     and new.amount < private.document_pending(new.document_id, new.id) then
    raise exception 'No se permiten pagos parciales: asigna el saldo completo del documento %', v_doc.folio;
  end if;
  return new;
end;
$$;
create trigger payment_allocations_module_rules before insert or update on public.payment_allocations
  for each row execute function private.allocation_module_rules();

-- Pagos manuales: la forma de pago debe estar activa en la configuración.
create or replace function private.payment_method_rules()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source = 'manual' and (tg_op = 'INSERT' or new.method is distinct from old.method)
     and exists (select 1 from public.payment_methods m where m.tenant_id = new.tenant_id and m.direction = new.direction)
     and not exists (
       select 1 from public.payment_methods m
       where m.tenant_id = new.tenant_id and m.direction = new.direction and m.active and lower(m.name) = lower(new.method)
     ) then
    raise exception 'La forma de pago "%" no está habilitada', new.method;
  end if;
  return new;
end;
$$;
create trigger payments_method_rules before insert or update on public.payments
  for each row execute function private.payment_method_rules();
