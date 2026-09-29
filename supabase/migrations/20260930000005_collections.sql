-- Cobranza (cuentas por cobrar): ficha de cobranza por cliente, actividad (notas, llamadas,
-- promesas de pago), recordatorios programados con correos personalizados y ejecución periódica.

-- ---------------------------------------------------------------------------
-- Datos de cobranza del cliente
-- ---------------------------------------------------------------------------
alter table public.counterparties
  add column credit_limit bigint check (credit_limit is null or credit_limit >= 0),
  add column collection_owner uuid references auth.users (id),
  -- Pausa todos los recordatorios automáticos del cliente (ej. en negociación).
  add column collection_paused boolean not null default false;

alter table public.contacts add column is_collection_contact boolean not null default false;

-- ---------------------------------------------------------------------------
-- Reglas de recordatorio
-- ---------------------------------------------------------------------------
create table public.collection_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  -- before_due: N días antes · on_due: el día · after_due: N días después ·
  -- statement: resumen semanal de lo vencido · new_document: al emitir · manual: solo envío manual
  trigger text not null check (trigger in ('before_due', 'on_due', 'after_due', 'statement', 'new_document', 'manual')),
  offset_days int not null default 0 check (offset_days between 0 and 365),
  -- statement: día de la semana (0 = domingo … 6 = sábado)
  weekday int check (weekday between 0 and 6),
  send_hour int not null default 9 check (send_hour between 0 and 23),
  subject text not null check (length(trim(subject)) between 1 and 200),
  body text not null check (length(body) between 1 and 5000),
  include_documents boolean not null default true,
  include_payment_link boolean not null default true,
  -- all: todos los clientes · tags: clientes con alguna etiqueta · selected: clientes elegidos
  audience text not null default 'all' check (audience in ('all', 'tags', 'selected')),
  audience_tags text[] not null default '{}',
  audience_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint collection_rules_weekday check (trigger <> 'statement' or weekday is not null)
);

-- Activar o desactivar una regla para un cliente en particular.
create table public.counterparty_rule_settings (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  counterparty_id uuid not null,
  rule_id uuid not null,
  enabled boolean not null,
  primary key (counterparty_id, rule_id),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id) on delete cascade,
  foreign key (tenant_id, rule_id) references public.collection_rules (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Actividad de cobranza
-- ---------------------------------------------------------------------------
create table public.collection_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  counterparty_id uuid not null,
  document_id uuid,
  kind text not null check (kind in ('note', 'call', 'promise', 'dispute')),
  body text check (body is null or length(body) <= 4000),
  promised_date date,
  promised_amount bigint check (promised_amount is null or promised_amount > 0),
  currency public.currency_code,
  -- Promesas: pendiente, cumplida o incumplida.
  promise_status text check (promise_status in ('pending', 'kept', 'broken')),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, counterparty_id) references public.counterparties (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete set null (document_id),
  constraint collection_events_promise check (kind <> 'promise' or (promised_date is not null and promise_status is not null))
);
create index collection_events_cp_idx on public.collection_events (tenant_id, counterparty_id, created_at desc);

alter table public.collection_rules enable row level security;
alter table public.counterparty_rule_settings enable row level security;
alter table public.collection_events enable row level security;
do $$
declare t text;
begin
  foreach t in array array['collection_rules', 'counterparty_rule_settings', 'collection_events'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using ((select private.is_member(tenant_id)))', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select private.can_write(tenant_id))) with check ((select private.can_write(tenant_id)))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select private.can_write(tenant_id)))', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function private.audit()', t);
    execute format('revoke all on public.%1$s from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end;
$$;

-- Plantillas iniciales (desactivadas: la empresa las revisa y activa).
create or replace function private.seed_collection_rules(p_tenant uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.collection_rules where tenant_id = p_tenant) then return; end if;
  insert into public.collection_rules (tenant_id, name, trigger, offset_days, weekday, send_hour, subject, body, active, created_by) values
    (p_tenant, 'Aviso antes del vencimiento', 'before_due', 3, null, 9,
     'Tu {{documento}} vence el {{vencimiento}}',
     E'Hola {{cliente}},\n\nte recordamos que la {{documento}} por {{saldo}} vence el {{vencimiento}}.\n\nSi ya realizaste el pago, ignora este mensaje.\n\nSaludos,\n{{empresa}}', false, null),
    (p_tenant, 'Documento vencido', 'after_due', 1, null, 9,
     'Tu {{documento}} está vencida',
     E'Hola {{cliente}},\n\nla {{documento}} por {{saldo}} venció el {{vencimiento}} ({{dias_atraso}} días de atraso).\n\nTe agradecemos regularizar el pago a la brevedad.\n\nSaludos,\n{{empresa}}', false, null),
    (p_tenant, 'Estado de cuenta semanal', 'statement', 0, 2, 10,
     'Estado de cuenta de {{cliente}} con {{empresa}}',
     E'Hola {{cliente}},\n\nte compartimos los documentos con saldo pendiente al {{hoy}}. Total vencido: {{total_vencido}}.\n\nSaludos,\n{{empresa}}', false, null);
end;
$$;
revoke all on function private.seed_collection_rules(uuid) from public, anon, authenticated;
select private.seed_collection_rules(id) from public.tenants;
create or replace function private.seed_collection_rules_on_tenant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.seed_collection_rules(new.id);
  return new;
end;
$$;
create trigger tenants_seed_collection_rules after insert on public.tenants
  for each row execute function private.seed_collection_rules_on_tenant();

-- ---------------------------------------------------------------------------
-- Outbox: nuevos tipos y contraparte asociada (para la actividad del cliente)
-- ---------------------------------------------------------------------------
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check check (kind in (
  'payment_scheduled', 'payment_sent', 'document_rejected', 'payment_received',
  'portal_access_granted', 'member_added', 'purchase_order', 'collection_reminder',
  'collection_rule', 'statement'
));
alter table public.email_outbox
  add column counterparty_id uuid,
  add column rule_id uuid references public.collection_rules (id) on delete set null;
create index email_outbox_cp_idx on public.email_outbox (tenant_id, counterparty_id, created_at desc) where counterparty_id is not null;

-- ¿La regla aplica a este cliente? (audiencia, pausa y ajuste por cliente)
create or replace function private.rule_applies(r public.collection_rules, c public.counterparties)
returns boolean language sql stable security definer set search_path = '' as $$
  select c.is_customer and not c.collection_paused
    and coalesce((select s.enabled from public.counterparty_rule_settings s where s.counterparty_id = c.id and s.rule_id = r.id), true)
    and case r.audience
      when 'all' then true
      when 'tags' then c.tags && r.audience_tags
      else c.id = any(r.audience_ids)
    end
$$;

-- Evalúa las reglas activas y anota los correos que corresponden (idempotente por día).
-- La ejecuta pg_cron cada 15 minutos; p_now permite probarla.
create or replace function private.run_collection_rules(p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count int := 0;
  v_rows int;
begin
  for r in
    select cr.*, t.timezone, (p_now at time zone t.timezone) as local_now
    from public.collection_rules cr
    join public.tenants t on t.id = cr.tenant_id
    where cr.active and cr.trigger in ('before_due', 'on_due', 'after_due', 'statement')
  loop
    continue when extract(hour from r.local_now) < r.send_hour;

    if r.trigger in ('before_due', 'on_due', 'after_due') then
      insert into public.email_outbox (tenant_id, kind, payload, dedupe_key, counterparty_id, rule_id, created_by)
      select r.tenant_id, 'collection_rule', jsonb_build_object('rule_id', r.id, 'document_id', b.id),
             format('rule:%s:%s:%s', r.id, b.id, b.due_date), b.counterparty_id, r.id, null
      from public.document_balances b
      join public.counterparties c on c.id = b.counterparty_id
      join public.collection_rules rr on rr.id = r.id
      where b.tenant_id = r.tenant_id and b.direction = 'receivable' and b.status = 'open'
        and b.pending_amount > 0 and b.doc_type <> 'nota_credito' and b.due_date is not null
        and b.due_date = case r.trigger
          when 'before_due' then r.local_now::date + r.offset_days
          when 'on_due' then r.local_now::date
          else r.local_now::date - r.offset_days end
        and private.rule_applies(rr, c)
      on conflict (tenant_id, dedupe_key) do nothing;
    else
      continue when extract(dow from r.local_now) <> r.weekday;
      insert into public.email_outbox (tenant_id, kind, payload, dedupe_key, counterparty_id, rule_id, created_by)
      select r.tenant_id, 'collection_rule', jsonb_build_object('rule_id', r.id, 'counterparty_id', c.id),
             format('rule:%s:%s:%s', r.id, c.id, r.local_now::date), c.id, r.id, null
      from public.counterparties c
      join public.collection_rules rr on rr.id = r.id
      where c.tenant_id = r.tenant_id and private.rule_applies(rr, c)
        and exists (select 1 from public.document_balances b where b.counterparty_id = c.id and b.direction = 'receivable'
                    and b.status = 'open' and b.pending_amount > 0 and b.days_overdue > 0)
      on conflict (tenant_id, dedupe_key) do nothing;
    end if;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end;
$$;
revoke all on function private.run_collection_rules(timestamptz) from public, anon, authenticated;

-- Regla "al emitir": al registrar un documento por cobrar.
create or replace function private.collection_new_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.direction = 'receivable' and new.status = 'open' and new.doc_type <> 'nota_credito'
     and (tg_op = 'INSERT' or old.status <> 'open') then
    insert into public.email_outbox (tenant_id, kind, payload, dedupe_key, counterparty_id, rule_id)
    select new.tenant_id, 'collection_rule', jsonb_build_object('rule_id', r.id, 'document_id', new.id),
           format('rule:%s:%s', r.id, new.id), new.counterparty_id, r.id
    from public.collection_rules r
    join public.counterparties c on c.id = new.counterparty_id
    where r.tenant_id = new.tenant_id and r.active and r.trigger = 'new_document' and private.rule_applies(r, c)
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;
create trigger documents_collection_new_document after insert or update of status on public.documents
  for each row execute function private.collection_new_document();

-- Envío manual: una regla (plantilla) a un cliente, o el estado de cuenta.
create or replace function public.queue_collection_email(p_counterparty_id uuid, p_rule_id uuid default null, p_document_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cp public.counterparties;
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
  if exists (select 1 from public.email_outbox o where o.tenant_id = v_cp.tenant_id and o.counterparty_id = v_cp.id
             and o.payload ->> 'manual' = 'true' and o.created_by = auth.uid() and o.created_at > now() - interval '2 minutes') then
    raise exception 'Espera un par de minutos antes de enviar otro correo a este cliente';
  end if;
  insert into public.email_outbox (tenant_id, kind, payload, counterparty_id, rule_id)
  values (v_cp.tenant_id, case when p_rule_id is null then 'statement' else 'collection_rule' end,
          jsonb_strip_nulls(jsonb_build_object('rule_id', p_rule_id, 'counterparty_id', v_cp.id, 'document_id', p_document_id, 'manual', true)),
          v_cp.id, p_rule_id);
end;
$$;
revoke all on function public.queue_collection_email(uuid, uuid, uuid) from public, anon;
grant execute on function public.queue_collection_email(uuid, uuid, uuid) to authenticated;

-- Promesas vencidas sin pago: se marcan como incumplidas (lo corre pg_cron).
create or replace function private.close_broken_promises(p_now timestamptz default now())
returns void language sql security definer set search_path = '' as $$
  update public.collection_events e set promise_status = 'broken'
  from public.tenants t
  where t.id = e.tenant_id and e.kind = 'promise' and e.promise_status = 'pending'
    and e.promised_date < (p_now at time zone t.timezone)::date
$$;
revoke all on function private.close_broken_promises(timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ejecución periódica (solo donde existen pg_cron y pg_net, es decir en Supabase)
-- ---------------------------------------------------------------------------
create table private.app_settings (
  key text primary key,
  value text not null
);
revoke all on private.app_settings from public, anon, authenticated;

-- La edge function valida el secreto con esta función (solo service_role).
create or replace function public.verify_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.app_settings where key = 'cron_secret' and value = p_secret)
$$;
revoke all on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net no disponibles: los recordatorios programados no se agendan aquí';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
  -- Secreto aleatorio generado en el servidor (no está en el repositorio).
  insert into private.app_settings (key, value)
  values ('cron_secret', encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text || random()::text, 'UTF8')), 'hex')),
         ('functions_url', 'https://crcudxjqirceotausfuz.supabase.co/functions/v1')
  on conflict (key) do nothing;

  create or replace function private.collections_tick()
  returns void language plpgsql security definer set search_path = '' as $fn$
  begin
    perform private.close_broken_promises();
    perform private.run_collection_rules();
    if exists (select 1 from public.email_outbox where status = 'pending' and attempts < 5) then
      perform net.http_post(
        url := (select value from private.app_settings where key = 'functions_url') || '/email-cron',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'x-cron-secret', (select value from private.app_settings where key = 'cron_secret')),
        body := jsonb_build_object('action', 'cron')
      );
    end if;
  end;
  $fn$;
  revoke all on function private.collections_tick() from public, anon, authenticated;

  perform cron.unschedule(jobid) from cron.job where jobname = 'produ-collections';
  perform cron.schedule('produ-collections', '*/15 * * * *', 'select private.collections_tick()');
end;
$$;
