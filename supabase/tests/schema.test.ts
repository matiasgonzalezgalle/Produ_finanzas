// Prueba la migración sobre Postgres embebido (PGlite) con un stub mínimo de Supabase Auth.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const MIGRATIONS = join(__dirname, '..', 'migrations')
const db = new PGlite()
const EMAILS: Record<string, string> = {}

const U1 = '00000000-0000-0000-0000-000000000001'
const U2 = '00000000-0000-0000-0000-000000000002'
const U3 = '00000000-0000-0000-0000-000000000003'
const U4 = '00000000-0000-0000-0000-000000000004' // usuario externo del portal
Object.assign(EMAILS, { [U1]: 'a@a.cl', [U2]: 'b@b.cl', [U3]: 'viewer@a.cl', [U4]: 'pagos@cliente.cl' })

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  const claims = user ? JSON.stringify({ sub: user, email: EMAILS[user] ?? '', is_anonymous: !EMAILS[user] }) : '{}'
  await db.exec(user
    ? `set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false); select set_config('request.jwt.claims', '${claims}', false);`
    : `set role anon; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '{}', false);`)
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
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant execute on function auth.jwt() to anon, authenticated, service_role;
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
    ('${U1}', 'a@a.cl'), ('${U2}', 'b@b.cl'), ('${U3}', 'viewer@a.cl'), ('${U4}', 'pagos@cliente.cl');`)
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
  it('anon no tiene permisos sobre tablas nuevas', async () => {
    await expect(as(null, () => q('select * from public.document_attachments'))).rejects.toThrow(/permission denied/)
    await expect(as(null, () => q('select * from public.portal_access'))).rejects.toThrow(/permission denied/)
  })

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

describe('edición, borrado y usuarios', () => {
  it('no permite bajar el total por debajo de lo pagado ni cambiar la contraparte', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA)
    await as(U1, async () => {
      await q(`select public.create_payment($1, 'out', $2, 'CLP', 50000, '2026-09-10', 'transferencia', null, null, $3::jsonb)`,
        [tenantA, cp, JSON.stringify([{ document_id: doc, amount: 50000 }])])
      await expect(q(`update public.documents set total_amount = 40000 where id = $1`, [doc])).rejects.toThrow(/por debajo/)
      await q(`update public.documents set total_amount = 60000, scheduled_payment_date = '2026-10-15' where id = $1`, [doc])
      const other = (await q(`insert into public.counterparties (tenant_id, name, is_supplier) values ($1, 'Otro', true) returning id`, [tenantA])).rows[0].id
      await expect(q(`update public.documents set counterparty_id = $2 where id = $1`, [doc, other])).rejects.toThrow(/pagos asignados/)
      await expect(q(`delete from public.documents where id = $1`, [doc])).rejects.toThrow(/anúlalo/)
    })
    const row = (await as(U1, () => q('select pending_amount, scheduled_payment_date::text as scheduled_payment_date from public.document_balances where id = $1', [doc]))).rows[0]
    expect(Number(row.pending_amount)).toBe(10000)
    expect(row.scheduled_payment_date).toBe('2026-10-15')
  })

  it('borra documentos sin pagos', async () => {
    const { doc } = await makeDoc(U1, tenantA)
    await as(U1, () => q(`delete from public.documents where id = $1`, [doc]))
    expect((await q('select count(*)::int n from public.documents where id = $1', [doc])).rows[0].n).toBe(0)
  })

  it('lista miembros solo de la propia empresa, con correo', async () => {
    const a = (await as(U1, () => q('select email, role from public.tenant_member_list order by email'))).rows
    expect(a.map((r) => r.email)).toEqual(['a@a.cl', 'viewer@a.cl'])
    const b = (await as(U2, () => q('select email from public.tenant_member_list'))).rows
    expect(b.map((r) => r.email)).toEqual(['b@b.cl'])
  })

  it('adjuntos: la ruta debe pertenecer a la empresa y al documento', async () => {
    const { doc } = await makeDoc(U1, tenantA)
    await as(U1, () => q(`insert into public.document_attachments (tenant_id, document_id, storage_path, file_name) values ($1, $2, $3, 'f.pdf')`,
      [tenantA, doc, `${tenantA}/${doc}/x-f.pdf`]))
    await expect(as(U1, () => q(`insert into public.document_attachments (tenant_id, document_id, storage_path, file_name) values ($1, $2, $3, 'f.pdf')`,
      [tenantA, doc, `${tenantB}/${doc}/y-f.pdf`]))).rejects.toThrow(/attachment_path_scoped/)
    const n = (await as(U1, () => q('select attachment_count from public.document_balances where id = $1', [doc]))).rows[0].attachment_count
    expect(n).toBe(1)
  })
})

describe('portal financiero', () => {
  let cpId = ''
  let otherCp = ''
  beforeAll(async () => {
    const made = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'P-100' })
    cpId = made.cp
    otherCp = (await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'P-200' })).cp
  })

  it('sin acceso habilitado no ve nada', async () => {
    expect((await as(U4, () => q('select * from public.portal_my_accounts()'))).rows).toHaveLength(0)
    await expect(as(U4, () => q('select public.portal_snapshot($1, $2)', [tenantA, cpId]))).rejects.toThrow(/Sin acceso/)
    await expect(as(null, () => q('select * from public.portal_my_accounts()'))).rejects.toThrow(/permission denied/)
  })

  it('solo un admin configura accesos', async () => {
    await expect(as(U3, () => q(`insert into public.portal_access (tenant_id, counterparty_id, email) values ($1, $2, 'pagos@cliente.cl')`, [tenantA, cpId])))
      .rejects.toThrow(/row-level security/)
    await as(U1, () => q(`insert into public.portal_access (tenant_id, counterparty_id, email) values ($1, $2, 'pagos@cliente.cl')`, [tenantA, cpId]))
  })

  it('requiere que la empresa active el portal', async () => {
    expect((await as(U4, () => q('select * from public.portal_my_accounts()'))).rows).toHaveLength(0)
    await as(U1, () => q('update public.tenants set portal_enabled = true where id = $1', [tenantA]))
    const accounts = (await as(U4, () => q('select * from public.portal_my_accounts()'))).rows
    expect(accounts).toHaveLength(1)
    expect(accounts[0].counterparty_id).toBe(cpId)
  })

  it('ve solo los documentos de su contraparte y no los de otra', async () => {
    const snap = (await as(U4, () => q('select public.portal_snapshot($1, $2) as s', [tenantA, cpId]))).rows[0].s
    expect(snap.documents.map((d: { folio: string }) => d.folio)).toEqual(['P-100'])
    await expect(as(U4, () => q('select public.portal_snapshot($1, $2)', [tenantA, otherCp]))).rejects.toThrow(/Sin acceso/)
    // Otro usuario autenticado sin acceso tampoco puede.
    await expect(as(U2, () => q('select public.portal_snapshot($1, $2)', [tenantA, cpId]))).rejects.toThrow(/Sin acceso/)
    // El usuario del portal no ve las tablas internas.
    expect((await as(U4, () => q('select * from public.documents'))).rows).toHaveLength(0)
  })

  it('cada contraparte con acceso tiene su propio link', async () => {
    const slug = (await q('select portal_slug from public.counterparties where id = $1', [cpId])).rows[0].portal_slug
    expect(slug).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    // La pantalla de ingreso del link es pública, pero solo muestra nombres.
    const info = (await as(null, () => q('select * from public.portal_public_info($1)', [slug]))).rows
    expect(info).toHaveLength(1)
    expect(Object.keys(info[0]).sort()).toEqual(['counterparty_name', 'message', 'tenant_name'])
    expect((await as(null, () => q('select * from public.portal_public_info($1)', ['no-existe-12345678']))).rows).toHaveLength(0)
    const accounts = (await as(U4, () => q('select portal_slug from public.portal_my_accounts()'))).rows
    expect(accounts[0].portal_slug).toBe(slug)
  })

  it('regenerar el link invalida el anterior (solo admins)', async () => {
    const old = (await q('select portal_slug from public.counterparties where id = $1', [cpId])).rows[0].portal_slug
    await expect(as(U3, () => q('select public.regenerate_portal_slug($1)', [cpId]))).rejects.toThrow(/Sin permisos/)
    await expect(as(U2, () => q('select public.regenerate_portal_slug($1)', [cpId]))).rejects.toThrow(/Sin permisos/)
    const fresh = (await as(U1, () => q('select public.regenerate_portal_slug($1) as s', [cpId]))).rows[0].s
    expect(fresh).not.toBe(old)
    expect((await as(null, () => q('select * from public.portal_public_info($1)', [old]))).rows).toHaveLength(0)
    expect((await as(null, () => q('select * from public.portal_public_info($1)', [fresh]))).rows).toHaveLength(1)
  })

  it('desactivar el acceso lo corta de inmediato', async () => {
    await as(U1, () => q(`update public.portal_access set enabled = false where counterparty_id = $1`, [cpId]))
    await expect(as(U4, () => q('select public.portal_snapshot($1, $2)', [tenantA, cpId]))).rejects.toThrow(/Sin acceso/)
  })
})

describe('flujo del documento', () => {
  it('aprobar y rechazar (con motivo) registra quién y cuándo; rechazado no se paga', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA)
    await expect(as(U1, () => q(`update public.documents set approval_status = 'rejected' where id = $1`, [doc]))).rejects.toThrow(/motivo/)
    await as(U1, () => q(`update public.documents set approval_status = 'rejected', rejection_reason = 'Monto no corresponde' where id = $1`, [doc]))
    const row = (await as(U1, () => q('select approval_status, approved_by, approved_at, rejection_reason from public.document_balances where id = $1', [doc]))).rows[0]
    expect(row).toMatchObject({ approval_status: 'rejected', approved_by: U1, rejection_reason: 'Monto no corresponde' })
    expect(row.approved_at).toBeTruthy()
    await expect(as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', 1000, '2026-09-10', 'transferencia', null, null, $3::jsonb)`,
      [tenantA, cp, JSON.stringify([{ document_id: doc, amount: 1000 }])]))).rejects.toThrow(/rechazado/)
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    const after = (await as(U1, () => q('select approval_status, rejection_reason from public.documents where id = $1', [doc]))).rows[0]
    expect(after).toMatchObject({ approval_status: 'approved', rejection_reason: null })
  })

  it('las cuentas por cobrar nacen aprobadas', async () => {
    const { doc } = await makeDoc(U1, tenantA, { direction: 'receivable' })
    expect((await as(U1, () => q('select approval_status from public.documents where id = $1', [doc]))).rows[0].approval_status).toBe('approved')
  })

  it('cada empresa nueva trae su catálogo contable', async () => {
    const cats = (await as(U2, () => q('select count(*)::int n from public.accounting_categories'))).rows[0].n
    expect(cats).toBeGreaterThan(5)
    await expect(as(U3, () => q(`insert into public.accounting_categories (tenant_id, name) values ($1, 'X')`, [tenantA]))).rejects.toThrow(/row-level security/)
  })

  it('distribución contable: reemplaza líneas y no supera la base (neto si hay IVA)', async () => {
    const { doc } = await makeDoc(U1, tenantA, { net_amount: 84034, tax_amount: 15966, total_amount: 100000 })
    const [cat] = (await as(U1, () => q('select id from public.accounting_categories where tenant_id = $1 limit 1', [tenantA]))).rows
    const [cc] = (await as(U1, () => q('select id from public.cost_centers where tenant_id = $1 limit 1', [tenantA]))).rows
    const lines = (amounts: number[]) => JSON.stringify(amounts.map((amount) => ({ category_id: cat.id, cost_center_id: cc.id, amount })))
    await expect(as(U1, () => q('select public.set_document_allocations($1, $2::jsonb)', [doc, lines([90000])]))).rejects.toThrow(/supera/)
    await as(U1, () => q('select public.set_document_allocations($1, $2::jsonb)', [doc, lines([50000, 34034])]))
    await as(U1, () => q('select public.set_document_allocations($1, $2::jsonb)', [doc, lines([84034])]))
    const row = (await as(U1, () => q('select allocation_base, allocated_amount from public.document_balances where id = $1', [doc]))).rows[0]
    expect(Number(row.allocation_base)).toBe(84034)
    expect(Number(row.allocated_amount)).toBe(84034)
    // Otra empresa no puede usar categorías ajenas ni tocar la distribución.
    await expect(as(U2, () => q('select public.set_document_allocations($1, $2::jsonb)', [doc, lines([1])]))).rejects.toThrow(/no encontrado|row-level/)
  })

  it('notas internas no llegan al portal; los mensajes compartidos sí, y la contraparte puede responder', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'MSG-1' })
    await as(U1, () => q(`insert into public.portal_access (tenant_id, counterparty_id, email) values ($1, $2, 'pagos@cliente.cl')`, [tenantA, cp]))
    await as(U1, () => q(`insert into public.document_comments (tenant_id, document_id, visibility, author_kind, body) values ($1, $2, 'internal', 'member', 'Revisar con gerencia')`, [tenantA, doc]))
    await as(U1, () => q(`insert into public.document_comments (tenant_id, document_id, visibility, author_kind, body) values ($1, $2, 'shared', 'member', '¿Pueden enviar la OC?')`, [tenantA, doc]))
    // Un miembro no puede hacerse pasar por la contraparte.
    await expect(as(U1, () => q(`insert into public.document_comments (tenant_id, document_id, visibility, author_kind, body) values ($1, $2, 'shared', 'counterparty', 'x')`, [tenantA, doc])))
      .rejects.toThrow(/row-level security/)
    const seen = (await as(U4, () => q('select body from public.portal_document_comments($1)', [doc]))).rows.map((r) => r.body)
    expect(seen).toEqual(['¿Pueden enviar la OC?'])
    await as(U4, () => q('select public.portal_add_comment($1, $2)', [doc, 'Adjunta en el portal']))
    const internal = (await as(U1, () => q(`select author_kind, author_name from public.document_comments where document_id = $1 and body = 'Adjunta en el portal'`, [doc]))).rows[0]
    expect(internal).toMatchObject({ author_kind: 'counterparty', author_name: 'pagos@cliente.cl' })
    // Otro usuario sin acceso no lee ni escribe.
    await expect(as(U2, () => q('select * from public.portal_document_comments($1)', [doc]))).rejects.toThrow(/Sin acceso/)
    await expect(as(U2, () => q('select public.portal_add_comment($1, $2)', [doc, 'hola']))).rejects.toThrow(/Sin acceso/)
  })
})

describe('portal con código (sin correo)', () => {
  const U5 = '00000000-0000-0000-0000-000000000005' // sesión anónima del portal
  let cp = ''
  let slug = ''
  let code = ''
  let accessId = ''
  beforeAll(async () => {
    await db.exec(`insert into auth.users (id) values ('${U5}')`)
    cp = (await makeDoc(U1, tenantA, { direction: 'payable', folio: 'COD-1' })).cp
  })

  it('solo un admin genera códigos; el código se entrega una vez y no se puede leer su hash', async () => {
    await expect(as(U3, () => q(`select public.create_portal_code($1, 'Bodega')`, [cp]))).rejects.toThrow(/Sin permisos/)
    await expect(as(U1, () => q(`select public.create_portal_code($1, '')`, [cp]))).rejects.toThrow(/a quién/)
    const res = (await as(U1, () => q(`select public.create_portal_code($1, 'Juan · bodega') as r`, [cp]))).rows[0].r
    expect(res.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    expect(res.slug).toBeTruthy()
    ;({ code, slug, access_id: accessId } = res)
    await expect(as(U1, () => q('select code_hash from public.portal_access'))).rejects.toThrow(/permission denied/)
    const row = (await as(U1, () => q('select kind, label, code_hint from public.portal_access where id = $1', [accessId]))).rows[0]
    expect(row).toMatchObject({ kind: 'code', label: 'Juan · bodega', code_hint: code.slice(-2) })
    // No se puede crear un acceso con código a mano (sin pasar por el servidor).
    await expect(as(U1, () => q(`insert into public.portal_access (tenant_id, counterparty_id, kind, label, code_hash) values ($1, $2, 'code', 'x', 'abc')`, [tenantA, cp])))
      .rejects.toThrow(/permission denied/)
  })

  it('canjear el código da acceso solo a esa contraparte; un código malo no', async () => {
    const bad = (await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, 'AAAA-AAAA']))).rows[0].r
    expect(bad.ok).toBe(false)
    expect((await as(U5, () => q('select * from public.portal_my_accounts()'))).rows).toHaveLength(0)
    const good = (await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, code.toLowerCase().replace('-', ' ')]))).rows[0].r
    expect(good).toMatchObject({ ok: true, label: 'Juan · bodega' })
    const accounts = (await as(U5, () => q('select counterparty_id from public.portal_my_accounts()'))).rows
    expect(accounts.map((a) => a.counterparty_id)).toEqual([cp])
    const snap = (await as(U5, () => q('select public.portal_snapshot($1, $2) as s', [tenantA, cp]))).rows[0].s
    expect(snap.documents.map((d: { folio: string }) => d.folio)).toContain('COD-1')
    await expect(as(U5, () => q('select public.portal_snapshot($1, $2)', [tenantB, cp]))).rejects.toThrow(/Sin acceso/)
  })

  it('una sesión anónima no puede crear empresas', async () => {
    await expect(as(U5, () => q(`select public.create_tenant('Intrusa', 'CL')`))).rejects.toThrow(/No autenticado/)
  })

  it('regenerar invalida el código y las sesiones abiertas', async () => {
    const fresh = (await as(U1, () => q('select public.regenerate_portal_code($1) as r', [accessId]))).rows[0].r
    expect(fresh.code).not.toBe(code)
    await expect(as(U5, () => q('select public.portal_snapshot($1, $2)', [tenantA, cp]))).rejects.toThrow(/Sin acceso/)
    expect((await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, code]))).rows[0].r.ok).toBe(false)
    expect((await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, fresh.code]))).rows[0].r.ok).toBe(true)
    code = fresh.code
  })

  it('un código vencido no sirve', async () => {
    await db.exec(`update public.portal_access set expires_at = now() - interval '1 minute' where id = '${accessId}'`)
    await expect(as(U5, () => q('select public.portal_snapshot($1, $2)', [tenantA, cp]))).rejects.toThrow(/Sin acceso/)
    expect((await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, code]))).rows[0].r.ok).toBe(false)
    await db.exec(`update public.portal_access set expires_at = null where id = '${accessId}'`)
  })

  it('bloquea tras 10 intentos fallidos en 15 minutos', async () => {
    for (let i = 0; i < 10; i++) await as(U5, () => q('select public.portal_redeem_code($1, $2)', [slug, `ZZZZ-ZZ${String(i).padStart(2, '2')}`]))
    const locked = (await as(U5, () => q('select public.portal_redeem_code($1, $2) as r', [slug, code]))).rows[0].r
    expect(locked).toMatchObject({ ok: false })
    expect(locked.error).toMatch(/Demasiados intentos/)
  })
})
