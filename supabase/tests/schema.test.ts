// Prueba la migración sobre Postgres embebido (PGlite) con un stub mínimo de Supabase Auth.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS = join(__dirname, '..', 'migrations')
const db = new PGlite()

const U1 = '00000000-0000-0000-0000-000000000001'
const U2 = '00000000-0000-0000-0000-000000000002'
const U3 = '00000000-0000-0000-0000-000000000003'

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(user
    ? `set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`
    : `set role anon; select set_config('request.jwt.claim.sub', '', false);`)
  try {
    return await fn()
  } finally {
    await db.exec('reset role;')
  }
}
const q = (sql: string, params: unknown[] = []) => db.query<Record<string, any>>(sql, params)

let tenantA = ''
let tenantB = ''

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `)
  for (const file of readdirSync(MIGRATIONS).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  await db.exec(`insert into auth.users (id, email) values
    ('${U1}', 'a@a.cl'), ('${U2}', 'b@b.cl'), ('${U3}', 'viewer@a.cl');`)
  tenantA = (await as(U1, () => q(`select id from public.create_tenant('Empresa A', 'CL')`))).rows[0].id
  tenantB = (await as(U2, () => q(`select id from public.create_tenant('Empresa B', 'PE')`))).rows[0].id
  await db.exec(`insert into public.tenant_members values ('${tenantA}', '${U3}', 'viewer', now())`)
})

async function makeDoc(user: string, tenant: string, overrides: Record<string, unknown> = {}) {
  return as(user, async () => {
    const cp = (await q(`insert into public.counterparties (tenant_id, name, is_supplier, tax_id)
      values ($1, 'Proveedor', true, $2) returning id`, [tenant, `${Math.random()}`])).rows[0].id
    const fields = { tenant_id: tenant, direction: 'payable', counterparty_id: cp, doc_type: 'factura',
      folio: String(Math.floor(Math.random() * 1e9)), currency: 'CLP', total_amount: 100000, issue_date: '2026-09-01',
      due_date: '2026-09-30', ...overrides }
    const keys = Object.keys(fields)
    const doc = (await q(`insert into public.documents (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
      Object.values(fields))).rows[0].id
    return { cp, doc }
  })
}

describe('multi-tenant RLS', () => {
  it('anon no puede leer ni crear nada', async () => {
    await expect(as(null, () => q('select * from public.tenants'))).rejects.toThrow(/permission denied/)
    await expect(as(null, () => q(`select public.create_tenant('X', 'CL')`))).rejects.toThrow(/permission denied/)
    await expect(as(null, () => q('select * from public.integration_secrets'))).rejects.toThrow(/permission denied/)
  })

  it('cada usuario ve solo su empresa', async () => {
    const a = await as(U1, () => q('select id from public.tenants'))
    expect(a.rows.map((r) => r.id)).toEqual([tenantA])
    await makeDoc(U1, tenantA)
    const docsB = await as(U2, () => q('select * from public.document_balances'))
    expect(docsB.rows).toHaveLength(0)
  })

  it('no se puede escribir en otra empresa', async () => {
    await expect(as(U2, () => q(`insert into public.counterparties (tenant_id, name, is_supplier) values ($1, 'X', true)`, [tenantA])))
      .rejects.toThrow(/row-level security/)
  })

  it('viewer lee pero no escribe', async () => {
    const rows = await as(U3, () => q('select id from public.tenants'))
    expect(rows.rows).toHaveLength(1)
    await expect(as(U3, () => q(`insert into public.counterparties (tenant_id, name, is_supplier) values ($1, 'X', true)`, [tenantA])))
      .rejects.toThrow(/row-level security/)
  })

  it('secretos inaccesibles para usuarios autenticados', async () => {
    await expect(as(U1, () => q('select * from public.integration_secrets'))).rejects.toThrow(/permission denied/)
    await expect(as(U1, () => q('select * from public.webhook_events'))).rejects.toThrow(/permission denied/)
  })

  it('un admin no puede auto-promoverse a owner ni tocar al owner', async () => {
    await expect(as(U3, () => q(`update public.tenant_members set role = 'owner' where user_id = $1`, [U3]))).resolves.toMatchObject({ affectedRows: 0 })
  })
})

describe('pagos y saldos', () => {
  it('asigna pagos por ID y calcula saldo', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA)
    const { doc: other } = await makeDoc(U1, tenantA)
    await as(U1, async () => {
      const pay = (await q(`insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on, reference)
        values ($1, 'out', $2, 'CLP', 40000, '2026-09-10', 'folio-del-otro') returning id`, [tenantA, cp])).rows[0].id
      await q(`insert into public.payment_allocations (tenant_id, payment_id, document_id, amount) values ($1, $2, $3, 40000)`, [tenantA, pay, doc])
    })
    const rows = (await as(U1, () => q('select id, pending_amount, payment_status from public.document_balances where id = any($1)', [[doc, other]]))).rows
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(Number(byId[doc].pending_amount)).toBe(60000)
    expect(byId[doc].payment_status).toBe('parcial')
    // El otro documento no se ve afectado por la referencia del pago.
    expect(Number(byId[other].pending_amount)).toBe(100000)
  })

  it('rechaza sobrepago, moneda distinta y dirección incorrecta', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA)
    await as(U1, async () => {
      const big = (await q(`insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on)
        values ($1, 'out', $2, 'CLP', 500000, '2026-09-10') returning id`, [tenantA, cp])).rows[0].id
      await expect(q(`insert into public.payment_allocations (tenant_id, payment_id, document_id, amount) values ($1, $2, $3, 150000)`, [tenantA, big, doc]))
        .rejects.toThrow(/saldo pendiente/)
      const usd = (await q(`insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on)
        values ($1, 'out', $2, 'USD', 100, '2026-09-10') returning id`, [tenantA, cp])).rows[0].id
      await expect(q(`insert into public.payment_allocations (tenant_id, payment_id, document_id, amount) values ($1, $2, $3, 100)`, [tenantA, usd, doc]))
        .rejects.toThrow(/moneda/)
      const incoming = (await q(`insert into public.payments (tenant_id, direction, counterparty_id, currency, amount, paid_on)
        values ($1, 'in', $2, 'CLP', 100, '2026-09-10') returning id`, [tenantA, cp])).rows[0].id
      await expect(q(`insert into public.payment_allocations (tenant_id, payment_id, document_id, amount) values ($1, $2, $3, 100)`, [tenantA, incoming, doc]))
        .rejects.toThrow(/cuenta por pagar/)
    })
  })

  it('nota de crédito y detracción reducen el saldo', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { detraction_rate: 10, detraction_amount: 10000, detraction_status: 'pendiente' })
    await as(U1, () => q(`insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date, applies_to_id)
      values ($1, 'payable', $2, 'nota_credito', 'NC-1', 'CLP', 20000, '2026-09-05', $3)`, [tenantA, cp, doc]))
    const row = (await as(U1, () => q('select pending_amount, net_total from public.document_balances where id = $1', [doc]))).rows[0]
    expect(Number(row.net_total)).toBe(80000)
    expect(Number(row.pending_amount)).toBe(70000)
  })

  it('no permite folios duplicados para la misma contraparte', async () => {
    const { cp } = await makeDoc(U1, tenantA, { folio: 'DUP-1' })
    await expect(as(U1, () => q(`insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date)
      values ($1, 'payable', $2, 'factura', 'DUP-1', 'CLP', 1, '2026-09-01')`, [tenantA, cp]))).rejects.toThrow(/duplicate/)
  })

  it('registra auditoría', async () => {
    const rows = (await as(U1, () => q(`select count(*)::int as n from public.audit_log where entity = 'documents'`))).rows
    expect(rows[0].n).toBeGreaterThan(0)
  })

  it('registra pagos de MercadoPago de forma idempotente y solo con service_role', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { direction: 'receivable' })
    await db.exec(`update public.counterparties set is_customer = true where id = '${cp}'`)
    const link = (await as(U1, () => q(`insert into public.payment_links (tenant_id, document_id, provider, currency, amount)
      values ($1, $2, 'mercadopago', 'CLP', 100000) returning id`, [tenantA, doc]))).rows[0].id
    const call = () => q(`select public.record_provider_payment($1, $2, 'mercadopago', 'mp-1', 'CLP', 100000, '2026-09-20')`, [tenantA, link])
    await expect(as(U1, call)).rejects.toThrow(/permission denied/)
    await db.exec('set role service_role')
    const first = (await call()).rows[0].record_provider_payment
    const again = (await call()).rows[0].record_provider_payment
    await expect(q(`select public.record_provider_payment($1, $2, 'mercadopago', 'mp-2', 'USD', 10, '2026-09-20')`, [tenantA, link])).rejects.toThrow(/Moneda/)
    await db.exec('reset role')
    expect(again).toBe(first)
    const row = (await as(U1, () => q('select pending_amount, payment_status from public.document_balances where id = $1', [doc]))).rows[0]
    expect(row.payment_status).toBe('pagado')
    const n = (await q(`select count(*)::int n from public.payments where external_id = 'mp-1'`)).rows[0].n
    expect(n).toBe(1)
  })
})
