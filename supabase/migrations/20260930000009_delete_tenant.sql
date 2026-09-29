-- Eliminar una empresa completa (solo superadministrador, vía la edge function platform-admin).
-- Las reglas que impiden borrar documentos con pagos u OC aprobadas no aplican cuando se
-- elimina la empresa entera: se marca la transacción con app.deleting_tenant.

create or replace function private.tenant_being_deleted(t uuid)
returns boolean language sql stable set search_path = '' as $$
  select current_user not in ('authenticated', 'anon')
    and coalesce(current_setting('app.deleting_tenant', true), '') = t::text
$$;

create or replace function private.check_document_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if private.tenant_being_deleted(old.tenant_id) then
    return old;
  end if;
  if exists (select 1 from public.payment_allocations a where a.document_id = old.id) then
    raise exception 'El documento tiene pagos asociados: anúlalo en vez de eliminarlo';
  end if;
  if exists (select 1 from public.documents c where c.applies_to_id = old.id) then
    raise exception 'El documento tiene notas de crédito asociadas: anúlalo en vez de eliminarlo';
  end if;
  return old;
end;
$$;

create or replace function private.purchase_order_before_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not private.tenant_being_deleted(old.tenant_id) and old.status not in ('draft', 'pending', 'rejected') then
    raise exception 'Solo se eliminan órdenes en borrador, por aprobar o rechazadas: anúlala';
  end if;
  return old;
end;
$$;

create or replace function private.purchase_order_lines_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_status public.purchase_order_status;
begin
  if tg_op = 'DELETE' and private.tenant_being_deleted(old.tenant_id) then
    return old;
  end if;
  select status into v_status from public.purchase_orders where id = coalesce(new.purchase_order_id, old.purchase_order_id);
  if v_status in ('approved', 'closed', 'void') then
    raise exception 'La orden de compra está aprobada: su detalle no se puede modificar';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.delete_tenant(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.deleting_tenant', p_id::text, true);
  delete from public.tenants where id = p_id;
  if not found then
    raise exception 'Empresa no encontrada';
  end if;
  perform set_config('app.deleting_tenant', '', true);
end;
$$;
revoke all on function public.delete_tenant(uuid) from public, anon, authenticated;
grant execute on function public.delete_tenant(uuid) to service_role;
