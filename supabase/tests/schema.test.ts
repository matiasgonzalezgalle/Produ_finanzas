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
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', last_sign_in_at timestamptz, banned_until timestamptz);
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
  // Las pruebas usan todos los módulos (una empresa nueva parte con los básicos).
  await db.exec(`update public.tenants set modules = private.known_modules()`)
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

describe('gestión de pagos (CxP)', () => {
  it('solicitar y programar exige aprobación; programar exige fecha; realizado se deriva del pago', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { folio: 'GP-1', total_amount: 50000 })
    const state = async () => (await as(U1, () => q('select approval_status, payment_management, payment_stage_at from public.document_balances where id = $1', [doc]))).rows[0]
    expect((await state()).payment_management).toBeNull()
    await as(U1, () => q(`update public.documents set payment_stage = 'requested' where id = $1`, [doc]))
    // Sin aprobar, la gestión no queda registrada.
    expect((await state()).payment_management).toBeNull()
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set payment_stage = 'requested' where id = $1`, [doc]))
    expect((await state())).toMatchObject({ payment_management: 'requested' })
    expect((await state()).payment_stage_at).toBeTruthy()
    await expect(as(U1, () => q(`update public.documents set payment_stage = 'scheduled', scheduled_payment_date = null where id = $1`, [doc]))).rejects.toThrow(/fecha/)
    await as(U1, () => q(`update public.documents set payment_stage = 'scheduled', scheduled_payment_date = '2026-10-10' where id = $1`, [doc]))
    expect((await state()).payment_management).toBe('scheduled')
    await as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', 50000, '2026-10-10', 'transferencia', null, null, $3::jsonb)`,
      [tenantA, cp, JSON.stringify([{ document_id: doc, amount: 50000 }])]))
    expect((await state()).payment_management).toBe('paid')
  })

  it('volver a pendiente de aprobación o anular reinicia la gestión', async () => {
    const { doc } = await makeDoc(U1, tenantA, { folio: 'GP-2' })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set payment_stage = 'requested' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set approval_status = 'pending' where id = $1`, [doc]))
    expect((await as(U1, () => q('select payment_stage from public.documents where id = $1', [doc]))).rows[0].payment_stage).toBeNull()
    await as(U1, () => q(`update public.documents set approval_status = 'approved', payment_stage = 'requested' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set status = 'void' where id = $1`, [doc]))
    expect((await as(U1, () => q('select payment_stage from public.documents where id = $1', [doc]))).rows[0].payment_stage).toBeNull()
  })

  it('no aplica a cuentas por cobrar', async () => {
    const { doc } = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'GP-3' })
    await expect(as(U1, () => q(`update public.documents set payment_stage = 'requested' where id = $1`, [doc]))).rejects.toThrow(/solo a cuentas por pagar/)
  })

  it('el proveedor ve aprobación, gestión y fecha programada en su portal', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { folio: 'GP-4' })
    await as(U1, () => q(`insert into public.portal_access (tenant_id, counterparty_id, email) values ($1, $2, 'pagos@cliente.cl')`, [tenantA, cp]))
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set payment_stage = 'scheduled', scheduled_payment_date = '2026-11-05' where id = $1`, [doc]))
    const snap = (await as(U4, () => q('select public.portal_snapshot($1, $2) as s', [tenantA, cp]))).rows[0].s
    const d = snap.documents.find((x: { folio: string }) => x.folio === 'GP-4')
    expect(d).toMatchObject({ approval_status: 'approved', payment_management: 'scheduled', scheduled_payment_date: '2026-11-05' })
  })
})

describe('administradores de CxP / CxC', () => {
  it('cada empresa trae preferencias y formas de pago; solo un admin las cambia', async () => {
    const settings = (await as(U1, () => q('select direction, require_approval from public.module_settings where tenant_id = $1 order by direction', [tenantA]))).rows
    expect(settings).toEqual([{ direction: 'payable', require_approval: true }, { direction: 'receivable', require_approval: false }])
    const methods = (await as(U1, () => q(`select name from public.payment_methods where tenant_id = $1 and direction = 'in' and is_default`, [tenantA]))).rows
    expect(methods).toEqual([{ name: 'Transferencia' }])
    await as(U3, () => q(`update public.module_settings set default_due_days = 5 where tenant_id = $1`, [tenantA]))
    expect((await as(U1, () => q(`select default_due_days from public.module_settings where tenant_id = $1 and direction = 'payable'`, [tenantA]))).rows[0].default_due_days).toBeNull()
  })

  it('solo una forma de pago predeterminada por módulo', async () => {
    const id = (await as(U1, () => q(`insert into public.payment_methods (tenant_id, direction, name, is_default) values ($1, 'in', 'Webpay', true) returning id`, [tenantA]))).rows[0].id
    const defaults = (await as(U1, () => q(`select name from public.payment_methods where tenant_id = $1 and direction = 'in' and is_default`, [tenantA]))).rows
    expect(defaults).toEqual([{ name: 'Webpay' }])
    await expect(as(U1, () => q(`update public.payment_methods set active = false where id = $1`, [id]))).rejects.toThrow(/inactiva/)
    await as(U1, () => q(`update public.payment_methods set is_default = true where tenant_id = $1 and direction = 'in' and name = 'Transferencia'`, [tenantA]))
  })

  it('un tipo deshabilitado no se puede crear ni pagar', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { doc_type: 'boleta', folio: 'TD-1', total_amount: 10000 })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    await as(U1, () => q(`insert into public.document_type_settings (tenant_id, direction, doc_type, can_create, can_pay) values ($1, 'payable', 'boleta', false, false)`, [tenantA]))
    await expect(makeDoc(U1, tenantA, { doc_type: 'boleta', folio: 'TD-2' })).rejects.toThrow(/no está habilitado/)
    await expect(as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', 10000, '2026-10-01', 'transferencia', null, null, $3::jsonb)`,
      [tenantA, cp, JSON.stringify([{ document_id: doc, amount: 10000 }])]))).rejects.toThrow(/no se paga desde el módulo/)
    await as(U1, () => q(`delete from public.document_type_settings where tenant_id = $1`, [tenantA]))
  })

  it('forma de pago inactiva, pagos parciales, aprobación automática y distribución exigida', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { folio: 'PR-1', total_amount: 20000 })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    const pay = (method: string, amount: number) => as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', $3, '2026-10-01', $4, null, null, $5::jsonb)`,
      [tenantA, cp, amount, method, JSON.stringify([{ document_id: doc, amount }])]))
    await expect(pay('Bitcoin', 20000)).rejects.toThrow(/no está habilitada/)
    await as(U1, () => q(`update public.module_settings set allow_partial_payments = false where tenant_id = $1 and direction = 'payable'`, [tenantA]))
    await expect(pay('Cheque', 5000)).rejects.toThrow(/pagos parciales/)
    await pay('cheque', 20000)
    await as(U1, () => q(`update public.module_settings set allow_partial_payments = true, require_approval = false, require_allocation = true where tenant_id = $1 and direction = 'payable'`, [tenantA]))
    const auto = await makeDoc(U1, tenantA, { folio: 'PR-2' })
    expect((await as(U1, () => q('select approval_status from public.documents where id = $1', [auto.doc]))).rows[0].approval_status).toBe('approved')
    const manual = await makeDoc(U1, tenantA, { folio: 'PR-3' })
    await as(U1, () => q(`update public.module_settings set require_approval = true where tenant_id = $1 and direction = 'payable'`, [tenantA]))
    await as(U1, () => q(`update public.documents set approval_status = 'pending' where id = $1`, [manual.doc]))
    await expect(as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [manual.doc]))).rejects.toThrow(/distribución contable/)
    await as(U1, () => q(`update public.module_settings set require_allocation = false where tenant_id = $1 and direction = 'payable'`, [tenantA]))
  })
})

describe('órdenes de compra', () => {
  const save = (user: string, data: Record<string, unknown>, lines: unknown[] = [], id: string | null = null) =>
    as(user, () => q('select public.save_purchase_order($1, $2, $3::jsonb, $4::jsonb) as id', [tenantA, id, JSON.stringify(data), JSON.stringify(lines)])).then((r) => r.rows[0].id as string)
  const po = (id: string) => as(U1, () => q('select * from public.purchase_order_balances where id = $1', [id])).then((r) => r.rows[0])

  it('CxP: numeración correlativa, neto desde las líneas y aprobación solo por admin', async () => {
    const { cp } = await makeDoc(U1, tenantA, { folio: 'OC-BASE' })
    await db.exec(`insert into public.tenant_members values ('${tenantA}', '${U2}', 'finance', now()) on conflict do nothing`)
    const base = { direction: 'payable', counterparty_id: cp, currency: 'CLP', issue_date: '2026-09-29', tax_amount: 19000 }
    const a = await save(U2, base, [{ description: 'Arriendo cámara', quantity: 2, unit_price: 50000, discount: 0 }])
    const b = await save(U2, base, [{ description: 'Luces', quantity: 1, unit_price: 100000, discount: 0 }])
    const [pa, pb] = [await po(a), await po(b)]
    expect(pa).toMatchObject({ status: 'draft', net_amount: 100000, total_amount: 119000, line_count: 1 })
    expect(Number(pb.number.slice(3))).toBe(Number(pa.number.slice(3)) + 1)
    await expect(as(U2, () => q(`update public.purchase_orders set status = 'approved' where id = $1`, [a]))).rejects.toThrow(/Solo un administrador/)
    await as(U1, () => q(`update public.purchase_orders set status = 'approved' where id = $1`, [a]))
    // Aprobada: el detalle y los montos quedan fijos.
    await expect(as(U1, () => q(`update public.purchase_orders set tax_amount = 0, total_amount = 100000 where id = $1`, [a]))).rejects.toThrow(/aprobada/)
    await save(U1, { ...base, notes: 'Entregar en bodega' }, [], a)
    expect(await po(a)).toMatchObject({ notes: 'Entregar en bodega', total_amount: 119000, line_count: 1 })
    await db.exec(`delete from public.tenant_members where tenant_id = '${tenantA}' and user_id = '${U2}'`)
  })

  it('documentos: misma contraparte y moneda, OC aprobada, sin superar el saldo; facturado y saldo', async () => {
    const { cp } = await makeDoc(U1, tenantA, { folio: 'OC-BASE-2' })
    const id = await save(U1, { direction: 'payable', counterparty_id: cp, currency: 'CLP', issue_date: '2026-09-29', net_amount: 100000, status: 'pending' })
    const link = (folio: string, total: number, extra: Record<string, unknown> = {}) => as(U1, () => q(
      `insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date, purchase_order_id)
       values ($1, 'payable', $2, 'factura', $3, $4, $5, '2026-09-30', $6) returning id`, [tenantA, extra.cp ?? cp, folio, extra.currency ?? 'CLP', total, id]))
    await expect(link('F-1', 40000)).rejects.toThrow(/no está aprobada/)
    await as(U1, () => q(`update public.purchase_orders set status = 'approved' where id = $1`, [id]))
    await expect(link('F-1', 40000, { currency: 'USD' })).rejects.toThrow(/misma contraparte y moneda/)
    const f1 = (await link('F-1', 60000)).rows[0].id
    await expect(link('F-2', 50000)).rejects.toThrow(/supera el saldo/)
    await link('F-2', 40000)
    expect(await po(id)).toMatchObject({ invoiced_amount: 100000, remaining_amount: 0, billing_status: 'completa', document_count: 2 })
    // Una nota de crédito libera saldo.
    await as(U1, () => q(`insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date, applies_to_id)
      values ($1, 'payable', $2, 'nota_credito', 'NC-1', 'CLP', 10000, '2026-10-01', $3)`, [tenantA, cp, f1]))
    expect(await po(id)).toMatchObject({ invoiced_amount: 90000, remaining_amount: 10000, billing_status: 'parcial' })
    // Con documentos asociados no se anula ni se elimina: se cierra.
    await expect(as(U1, () => q(`update public.purchase_orders set status = 'void' where id = $1`, [id]))).rejects.toThrow(/ciérrala/)
    await expect(as(U1, () => q('delete from public.purchase_orders where id = $1', [id]))).rejects.toThrow(/anúlala/)
    await as(U1, () => q(`update public.purchase_orders set status = 'closed' where id = $1`, [id]))
    await expect(link('F-3', 1000)).rejects.toThrow(/no está aprobada/)
  })

  it('CxC: el número lo pone el cliente; exigir OC al emitir; rechazo con motivo; portal', async () => {
    const cp = (await as(U1, () => q(`insert into public.counterparties (tenant_id, name, is_customer, tax_id) values ($1, 'Cliente OC', true, 'OC-CL') returning id`, [tenantA]))).rows[0].id
    const base = { direction: 'receivable', counterparty_id: cp, currency: 'CLP', issue_date: '2026-09-29', net_amount: 500000 }
    await expect(save(U1, base)).rejects.toThrow(/número de la orden de compra del cliente/)
    const id = await save(U1, { ...base, number: '4500012345', status: 'pending' })
    await expect(as(U1, () => q(`update public.purchase_orders set status = 'rejected' where id = $1`, [id]))).rejects.toThrow(/motivo/)
    await as(U1, () => q(`update public.purchase_orders set status = 'approved' where id = $1`, [id]))
    await as(U1, () => q(`update public.module_settings set require_purchase_order = true where tenant_id = $1 and direction = 'receivable'`, [tenantA]))
    const insert = (folio: string, poId: string | null) => as(U1, () => q(
      `insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date, purchase_order_id)
       values ($1, 'receivable', $2, 'factura', $3, 'CLP', 200000, '2026-09-30', $4)`, [tenantA, cp, folio, poId]))
    await expect(insert('V-1', null)).rejects.toThrow(/orden de compra del cliente/)
    await insert('V-1', id)
    await as(U1, () => q(`update public.module_settings set require_purchase_order = false where tenant_id = $1 and direction = 'receivable'`, [tenantA]))
    await as(U1, () => q(`insert into public.portal_access (tenant_id, counterparty_id, email) values ($1, $2, 'pagos@cliente.cl')`, [tenantA, cp]))
    const snap = (await as(U4, () => q('select public.portal_snapshot($1, $2) as s', [tenantA, cp]))).rows[0].s
    expect(snap.purchase_orders).toHaveLength(1)
    expect(snap.purchase_orders[0]).toMatchObject({ number: '4500012345', invoiced_amount: 200000, remaining_amount: 300000 })
    expect(snap.documents.find((d: { folio: string }) => d.folio === 'V-1').purchase_order_number).toBe('4500012345')
  })

  it('otra empresa no ve ni usa las OC', async () => {
    expect((await as(U2, () => q('select * from public.purchase_order_balances'))).rows).toHaveLength(0)
    await expect(as(null, () => q('select * from public.purchase_orders'))).rejects.toThrow(/permission denied/)
  })
})

describe('documentos del SII (Fintoc)', () => {
  // Las filas las escribe la edge function con service_role; aquí se insertan como superusuario.
  const addSii = async (fields: Record<string, unknown>) => {
    const row = { tenant_id: tenantA, external_id: `inv_${Math.random()}`, direction: 'payable', sii_type: 33, issue_date: '2026-09-10',
      counterparty_tax_id: '76.123.456-0', counterparty_name: 'Proveedor SII SpA', net_amount: 100000, tax_amount: 19000, total_amount: 119000, ...fields }
    const keys = Object.keys(row)
    return (await q(`insert into public.sii_documents (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(row))).rows[0].id as string
  }
  const importIds = (ids: string[], user = U1) => as(user, () => q('select public.import_sii_documents($1, $2::uuid[]) as r', [tenantA, ids])).then((r) => r.rows[0].r)

  it('importa una factura recibida y crea el proveedor; la segunda vez solo la reconoce', async () => {
    const id = await addSii({ folio: 'S-100' })
    const res = await importIds([id])
    expect(res).toMatchObject({ imported: 1, linked: 0, skipped: [] })
    const doc = (await as(U1, () => q(`select d.*, c.name, c.is_supplier from public.documents d join public.counterparties c on c.id = d.counterparty_id where d.external_id = (select external_id from public.sii_documents where id = $1)`, [id]))).rows[0]
    expect(doc).toMatchObject({ direction: 'payable', doc_type: 'factura', folio: 'S-100', total_amount: 119000, tax_amount: 19000, name: 'Proveedor SII SpA', is_supplier: true, approval_status: 'pending' })
    const status = (await as(U1, () => q('select matched_document_id from public.sii_document_status where id = $1', [id]))).rows[0]
    expect(status.matched_document_id).toBe(doc.id)
    // Otro registro del SII con el mismo folio y RUT (sin puntos) se reconoce como ya registrado.
    const dup = await addSii({ folio: 'S-100', counterparty_tax_id: '761234560' })
    expect(await importIds([dup])).toMatchObject({ imported: 0, linked: 1 })
  })

  it('nota de crédito exige el documento de referencia; reclamados y boletas resumidas no se importan', async () => {
    const nc = await addSii({ sii_type: 61, folio: 'NC-9', reference_type: 33, reference_folio: 'S-404', total_amount: 11900, net_amount: 10000, tax_amount: 1900 })
    const claimed = await addSii({ folio: 'S-500', confirmation_status: 'R' })
    const summary = await addSii({ sii_type: 39, folio: null, is_summary: true })
    const res = await importIds([nc, claimed, summary])
    expect(res.imported).toBe(0)
    expect(res.skipped.map((s: { reason: string }) => s.reason).join(' | ')).toMatch(/S-404.*|.*reclamado.*|.*no se importa/)
    const base = await addSii({ folio: 'S-404' })
    expect(await importIds([base, nc])).toMatchObject({ imported: 2 })
    const credit = (await as(U1, () => q(`select applies_to_id from public.documents where doc_type = 'nota_credito' and folio = 'NC-9'`))).rows[0]
    expect(credit.applies_to_id).toBeTruthy()
  })

  it('honorarios se registran por el líquido; un lector no importa; otra empresa no ve los documentos', async () => {
    const fee = await addSii({ sii_type: null, is_fee_receipt: true, folio: 'H-7', net_amount: 0, tax_amount: 0, total_amount: 100000, withheld_amount: 13750, counterparty_tax_id: '12.345.678-5' })
    await expect(importIds([fee], U3)).rejects.toThrow(/permisos/)
    expect(await importIds([fee])).toMatchObject({ imported: 1 })
    expect((await as(U1, () => q(`select total_amount, doc_type from public.documents where folio = 'H-7'`))).rows[0]).toEqual({ total_amount: 86250, doc_type: 'honorarios' })
    expect((await as(U2, () => q('select * from public.sii_documents'))).rows).toHaveLength(0)
    await expect(as(null, () => q('select * from public.sii_documents'))).rejects.toThrow(/permission denied/)
    await expect(as(U1, () => q('select * from public.fintoc_connect_states'))).rejects.toThrow(/permission denied/)
  })
})

describe('correos del negocio (outbox)', () => {
  const outbox = (kind: string) => q(`select * from public.email_outbox where tenant_id = $1 and kind = $2 order by created_at`, [tenantA, kind]).then((r) => r.rows)

  it('programar un pago, rechazar un documento y registrar un pago anotan avisos al proveedor (sin duplicar)', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { folio: 'EM-1', total_amount: 30000 })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set payment_stage = 'scheduled', scheduled_payment_date = '2026-10-20' where id = $1`, [doc]))
    await as(U1, () => q(`update public.documents set description = 'x' where id = $1`, [doc]))
    expect((await outbox('payment_scheduled')).filter((o) => o.payload.document_id === doc)).toHaveLength(1)
    await as(U1, () => q(`update public.documents set scheduled_payment_date = '2026-10-25' where id = $1`, [doc]))
    expect((await outbox('payment_scheduled')).filter((o) => o.payload.document_id === doc)).toHaveLength(2)
    await as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', 30000, '2026-10-25', 'transferencia', null, null, $3::jsonb)`,
      [tenantA, cp, JSON.stringify([{ document_id: doc, amount: 30000 }])]))
    expect((await outbox('payment_sent')).length).toBeGreaterThan(0)
    const other = await makeDoc(U1, tenantA, { folio: 'EM-2' })
    await as(U1, () => q(`update public.documents set approval_status = 'rejected', rejection_reason = 'Monto incorrecto' where id = $1`, [other.doc]))
    expect((await outbox('document_rejected')).some((o) => o.payload.document_id === other.doc)).toBe(true)
  })

  it('respeta los avisos desactivados; el comprobante de cobro parte apagado; recordatorio con límite', async () => {
    await as(U1, () => q(`insert into public.tenant_email_settings (tenant_id, notifications) values ($1, '{"payment_scheduled": false}')`, [tenantA]))
    const { doc } = await makeDoc(U1, tenantA, { folio: 'EM-3' })
    const before = (await outbox('payment_scheduled')).length
    await as(U1, () => q(`update public.documents set approval_status = 'approved', payment_stage = 'scheduled', scheduled_payment_date = '2026-11-01' where id = $1`, [doc]))
    expect((await outbox('payment_scheduled')).length).toBe(before)
    const rec = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'EM-4' })
    await as(U1, () => q(`select public.create_payment($1, 'in', $2, 'CLP', 1000, '2026-10-01', 'transferencia', null, null, $3::jsonb)`,
      [tenantA, rec.cp, JSON.stringify([{ document_id: rec.doc, amount: 1000 }])]))
    expect(await outbox('payment_received')).toHaveLength(0)
    await as(U1, () => q('select public.queue_collection_reminder($1)', [rec.doc]))
    await expect(as(U1, () => q('select public.queue_collection_reminder($1)', [rec.doc]))).rejects.toThrow(/12 horas/)
    await expect(as(U3, () => q('select public.queue_collection_reminder($1)', [rec.doc]))).rejects.toThrow(/permisos/)
    await as(U1, () => q(`update public.tenant_email_settings set notifications = '{}' where tenant_id = $1`, [tenantA]))
  })

  it('el outbox solo se lee; nadie de la app lo escribe ni toma pendientes', async () => {
    expect((await as(U2, () => q('select * from public.email_outbox'))).rows.every((o) => o.tenant_id !== tenantA)).toBe(true)
    await expect(as(U1, () => q(`insert into public.email_outbox (tenant_id, kind) values ($1, 'member_added')`, [tenantA]))).rejects.toThrow(/permission denied/)
    await expect(as(U1, () => q('select * from public.claim_email_outbox($1)', [tenantA]))).rejects.toThrow(/permission denied/)
    await expect(as(null, () => q('select * from public.email_outbox'))).rejects.toThrow(/permission denied/)
  })
})

describe('cobranza', () => {
  const rule = async (fields: Record<string, unknown>) => {
    const row = { tenant_id: tenantA, name: 'Regla', trigger: 'after_due', offset_days: 1, send_hour: 9, subject: 'Asunto', body: 'Hola {{cliente}}', active: true, ...fields }
    const keys = Object.keys(row)
    return (await as(U1, () => q(`insert into public.collection_rules (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(row)))).rows[0].id as string
  }
  const ruleEmails = (ruleId: string) => q(`select * from public.email_outbox where rule_id = $1`, [ruleId]).then((r) => r.rows)
  // Hora de Santiago: 2026-10-06 13:00 UTC = 10:00 local (martes).
  const at = (iso: string) => q('select private.run_collection_rules($1::timestamptz) as n', [iso]).then((r) => r.rows[0].n as number)

  it('cada empresa trae plantillas de recordatorio desactivadas', async () => {
    const rows = (await as(U1, () => q('select trigger, active from public.collection_rules where tenant_id = $1 and created_by is null', [tenantA]))).rows
    expect(rows.map((r) => r.trigger).sort()).toEqual(['after_due', 'before_due', 'statement'])
    expect(rows.every((r) => !r.active)).toBe(true)
  })

  it('después del vencimiento: una vez por documento, respeta la hora, la pausa y el ajuste por cliente', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'CB-1', due_date: '2026-10-05', issue_date: '2026-09-05' })
    await as(U1, () => q(`update public.counterparties set is_customer = true where id = $1`, [cp]))
    const r = await rule({ trigger: 'after_due', offset_days: 1, send_hour: 9 })
    await at('2026-10-06T11:00:00Z') // 08:00 local: aún no
    expect(await ruleEmails(r)).toHaveLength(0)
    await at('2026-10-06T13:00:00Z')
    await at('2026-10-06T14:00:00Z')
    const sent = await ruleEmails(r)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ counterparty_id: cp, kind: 'collection_rule' })
    expect(sent[0].payload.document_id).toBe(doc)

    const r2 = await rule({ trigger: 'after_due', offset_days: 1, send_hour: 9 })
    await as(U1, () => q(`insert into public.counterparty_rule_settings (tenant_id, counterparty_id, rule_id, enabled) values ($1, $2, $3, false)`, [tenantA, cp, r2]))
    const r3 = await rule({ trigger: 'after_due', offset_days: 1, send_hour: 9, audience: 'tags', audience_tags: ['VIP'] })
    await at('2026-10-06T13:00:00Z')
    expect(await ruleEmails(r2)).toHaveLength(0)
    expect(await ruleEmails(r3)).toHaveLength(0)
    await as(U1, () => q(`update public.counterparties set collection_paused = true where id = $1`, [cp]))
    const r4 = await rule({ trigger: 'after_due', offset_days: 1 })
    await at('2026-10-06T13:00:00Z')
    expect(await ruleEmails(r4)).toHaveLength(0)
    await as(U1, () => q(`update public.counterparties set collection_paused = false where id = $1`, [cp]))
    for (const id of [r, r2, r3, r4]) await as(U1, () => q('update public.collection_rules set active = false where id = $1', [id]))
  })

  it('estado de cuenta semanal: solo el día elegido y a clientes con deuda vencida', async () => {
    const { cp } = await makeDoc(U1, tenantA, { direction: 'receivable', folio: 'CB-2', due_date: '2026-09-20', issue_date: '2026-09-01' })
    await as(U1, () => q(`update public.counterparties set is_customer = true where id = $1`, [cp]))
    const r = await rule({ trigger: 'statement', weekday: 2, send_hour: 10 })
    await at('2026-10-05T14:00:00Z') // lunes
    expect((await ruleEmails(r)).filter((o) => o.counterparty_id === cp)).toHaveLength(0)
    await at('2026-10-06T14:00:00Z') // martes 11:00
    expect((await ruleEmails(r)).filter((o) => o.counterparty_id === cp)).toHaveLength(1)
    await as(U1, () => q('update public.collection_rules set active = false where id = $1', [r]))
  })

  it('al emitir un documento; envío manual con límite; promesas incumplidas', async () => {
    const r = await rule({ trigger: 'new_document' })
    const cp = (await as(U1, () => q(`insert into public.counterparties (tenant_id, name, is_customer, tax_id) values ($1, 'Cliente CB', true, 'CB-3') returning id`, [tenantA]))).rows[0].id
    const doc = (await as(U1, () => q(`insert into public.documents (tenant_id, direction, counterparty_id, doc_type, folio, currency, total_amount, issue_date, due_date)
      values ($1, 'receivable', $2, 'factura', 'CB-3', 'CLP', 10000, '2026-09-01', '2026-10-01') returning id`, [tenantA, cp]))).rows[0].id
    expect((await ruleEmails(r)).some((o) => o.payload.document_id === doc)).toBe(true)
    await as(U1, () => q('update public.collection_rules set active = false where id = $1', [r]))

    await as(U1, () => q('select public.queue_collection_email($1)', [cp]))
    await expect(as(U1, () => q('select public.queue_collection_email($1)', [cp]))).rejects.toThrow(/par de minutos/)
    await expect(as(U3, () => q('select public.queue_collection_email($1)', [cp]))).rejects.toThrow(/permisos/)
    expect((await q(`select kind from public.email_outbox where counterparty_id = $1 and kind = 'statement'`, [cp])).rows).toHaveLength(1)

    const ev = (await as(U1, () => q(`insert into public.collection_events (tenant_id, counterparty_id, kind, promised_date, promise_status, promised_amount, currency)
      values ($1, $2, 'promise', '2026-10-01', 'pending', 50000, 'CLP') returning id`, [tenantA, cp]))).rows[0].id
    await q(`select private.close_broken_promises('2026-10-03T15:00:00Z')`)
    expect((await q('select promise_status from public.collection_events where id = $1', [ev])).rows[0].promise_status).toBe('broken')
    await expect(as(U3, () => q(`insert into public.collection_events (tenant_id, counterparty_id, kind, body) values ($1, $2, 'note', 'x')`, [tenantA, cp]))).rejects.toThrow()
  })
})

describe('plataforma: superadministrador y módulos', () => {
  it('una empresa nueva parte con los módulos básicos; sin el módulo no se registra', async () => {
    const t = (await as(U2, () => q(`select id, modules from public.create_tenant('Empresa C', 'CL')`))).rows[0]
    expect(t.modules).toEqual(['cuentas_por_pagar', 'cuentas_por_cobrar', 'tesoreria'])
    const cp = (await as(U2, () => q(`insert into public.counterparties (tenant_id, name, is_customer, tax_id) values ($1, 'Cli', true, 'MOD-1') returning id`, [t.id]))).rows[0].id
    await expect(as(U2, () => q(`insert into public.collection_rules (tenant_id, name, trigger, subject, body) values ($1, 'R', 'manual', 'a', 'b')`, [t.id]))).rejects.toThrow(/row-level security/)
    await expect(as(U2, () => q(`select public.save_purchase_order($1, null, $2::jsonb, '[]'::jsonb)`, [t.id, JSON.stringify({ direction: 'receivable', counterparty_id: cp, number: 'X1', currency: 'CLP', issue_date: '2026-09-29', net_amount: 1000 })]))).rejects.toThrow(/row-level security/)
  })

  it('solo un superadministrador cambia módulos y estado; una empresa suspendida queda en solo lectura', async () => {
    await expect(as(U1, () => q(`update public.tenants set modules = '{}' where id = $1`, [tenantA]))).rejects.toThrow(/administrador de la plataforma/)
    await expect(as(U1, () => q('select * from public.admin_list_tenants()'))).rejects.toThrow(/permisos/)
    await db.exec(`insert into private.platform_admins (user_id) values ('${U2}')`)
    expect((await as(U2, () => q('select public.am_i_platform_admin() as ok'))).rows[0].ok).toBe(true)
    const all = (await as(U2, () => q('select * from public.admin_list_tenants()'))).rows
    expect(all.some((t) => t.id === tenantA)).toBe(true)
    const a = all.find((t) => t.id === tenantA)
    await as(U2, () => q('select public.admin_update_tenant($1, $2, null, null, $3::text[], $4, null)', [tenantA, a.name, a.modules, 'suspended']))
    await expect(makeDoc(U1, tenantA, { folio: 'SUSP-1' })).rejects.toThrow()
    expect((await as(U1, () => q('select count(*)::int as n from public.documents where tenant_id = $1', [tenantA]))).rows[0].n).toBeGreaterThan(0)
    await as(U2, () => q('select public.admin_update_tenant($1, $2, null, null, $3::text[], $4, null)', [tenantA, a.name, a.modules, 'active']))
    await expect(as(U2, () => q(`select public.admin_update_tenant($1, 'X', null, null, '{inventado}'::text[], 'active', null)`, [tenantA]))).rejects.toThrow(/desconocido|known_modules/)
    await expect(as(U2, () => q(`select public.admin_set_platform_admin('b@b.cl', false)`))).rejects.toThrow(/ti mismo/)
    await db.exec(`delete from private.platform_admins where user_id = '${U2}'`)
  })
})

describe('conciliación bancaria', () => {
  let account = ''
  const movement = async (amount: number, extra: Record<string, unknown> = {}) => {
    const fields = { tenant_id: tenantA, account_id: account, external_id: `mov_${Math.random()}`, amount, currency: 'CLP', post_date: '2026-09-20', description: 'Transferencia', ...extra }
    const keys = Object.keys(fields)
    return (await q(`insert into public.bank_movements (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(fields))).rows[0].id as string
  }
  beforeAll(async () => {
    const conn = (await q(`insert into public.bank_connections (tenant_id, external_id, institution_name) values ($1, 'link_1', 'Banco Demo') returning id`, [tenantA])).rows[0].id
    await q(`insert into public.bank_connection_secrets (connection_id, link_token) values ($1, 'link_1_token_secreto')`, [conn])
    account = (await q(`insert into public.bank_feed_accounts (tenant_id, connection_id, external_id, currency, number) values ($1, $2, 'acc_1', 'CLP', '123') returning id`, [tenantA, conn])).rows[0].id
  })

  it('los movimientos se leen pero no se escriben desde la app; el link_token no se lee', async () => {
    const id = await movement(-5000)
    expect((await as(U3, () => q('select count(*)::int as n from public.bank_movements where id = $1', [id]))).rows[0].n).toBe(1)
    expect((await as(U2, () => q('select count(*)::int as n from public.bank_movements where id = $1', [id]))).rows[0].n).toBe(0)
    await expect(as(U1, () => q(`update public.bank_movements set reconciliation_status = 'ignored' where id = $1`, [id]))).rejects.toThrow(/permission denied/)
    await expect(as(U1, () => q('select * from public.bank_connection_secrets'))).rejects.toThrow(/permission denied/)
    await expect(as(U3, () => q(`select public.set_bank_movement_status($1, $2, 'ignored')`, [tenantA, id]))).rejects.toThrow(/permisos/)
  })

  it('registra el pago desde un cargo, con documentos, y lo concilia; anular el pago lo devuelve a por conciliar', async () => {
    const { cp, doc } = await makeDoc(U1, tenantA, { total_amount: 30000 })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc])).catch(() => undefined)
    const id = await movement(-30000, { reference_id: 'OP-77' })
    const pay = (await as(U1, () => q(`select public.create_payment_from_movement($1, $2, $3, 'Transferencia', null, $4::jsonb) as id`,
      [tenantA, id, cp, JSON.stringify([{ document_id: doc, amount: 30000 }])]))).rows[0].id
    const p = (await q('select direction, amount, paid_on::text, reference, source from public.payments where id = $1', [pay])).rows[0]
    expect(p).toMatchObject({ direction: 'out', reference: 'OP-77', source: 'bank', paid_on: '2026-09-20' })
    expect(Number(p.amount)).toBe(30000)
    const m = (await q('select reconciliation_status, payment_id from public.bank_movements where id = $1', [id])).rows[0]
    expect(m).toMatchObject({ reconciliation_status: 'reconciled', payment_id: pay })
    expect(Number((await q('select pending_amount from public.document_balances where id = $1', [doc])).rows[0].pending_amount)).toBe(0)
    await expect(as(U1, () => q(`select public.create_payment_from_movement($1, $2, $3, 'Transferencia', null)`, [tenantA, id, cp]))).rejects.toThrow(/ya está conciliado/)
    await as(U1, () => q(`update public.payments set status = 'void' where id = $1`, [pay]))
    expect((await q('select reconciliation_status, payment_id from public.bank_movements where id = $1', [id])).rows[0]).toMatchObject({ reconciliation_status: 'pending', payment_id: null })
  })

  it('vincula un cobro existente solo si coinciden sentido, moneda y monto; ignorar y deshacer', async () => {
    const cp = (await as(U1, () => q(`insert into public.counterparties (tenant_id, name, is_customer, tax_id) values ($1, 'Cliente banco', true, 'BANK-1') returning id`, [tenantA]))).rows[0].id
    const cobro = (await as(U1, () => q(`select public.create_payment($1, 'in', $2, 'CLP', 12000, '2026-09-19', 'Transferencia', null, null) as id`, [tenantA, cp]))).rows[0].id
    const abono = await movement(12000)
    const cargo = await movement(-12000)
    const otro = await movement(12500)
    await expect(as(U1, () => q('select public.reconcile_bank_movement($1, $2, $3)', [tenantA, cargo, cobro]))).rejects.toThrow(/abono se concilia con un cobro/)
    await expect(as(U1, () => q('select public.reconcile_bank_movement($1, $2, $3)', [tenantA, otro, cobro]))).rejects.toThrow(/no coinciden/)
    await as(U1, () => q('select public.reconcile_bank_movement($1, $2, $3)', [tenantA, abono, cobro]))
    await expect(as(U1, () => q('select public.reconcile_bank_movement($1, $2, $3)', [tenantA, otro, cobro]))).rejects.toThrow(/no coinciden|otro movimiento/)
    await as(U1, () => q(`select public.set_bank_movement_status($1, $2, 'pending')`, [tenantA, abono]))
    expect((await q('select status from public.payments where id = $1', [cobro])).rows[0].status).toBe('confirmed')
    await as(U1, () => q(`select public.set_bank_movement_status($1, $2, 'ignored', 'Traspaso entre cuentas propias')`, [tenantA, cargo]))
    expect((await q('select reconciliation_status, ignored_reason from public.bank_movements where id = $1', [cargo])).rows[0]).toMatchObject({ reconciliation_status: 'ignored', ignored_reason: 'Traspaso entre cuentas propias' })
  })

  it('sin el módulo activo no se concilia', async () => {
    const id = await movement(-1000)
    await db.exec(`update public.tenants set modules = array_remove(modules, 'conciliacion') where id = '${tenantA}'`)
    await expect(as(U1, () => q(`select public.set_bank_movement_status($1, $2, 'ignored')`, [tenantA, id]))).rejects.toThrow(/no está activo/)
    await db.exec(`update public.tenants set modules = private.known_modules() where id = '${tenantA}'`)
  })
})

describe('gestión de usuarios', () => {
  it('lista usuarios con estado; solo miembros o superadministradores', async () => {
    await db.exec(`update auth.users set last_sign_in_at = now() where id = '${U1}'`)
    const rows = (await as(U3, () => q('select * from public.tenant_user_list($1)', [tenantA]))).rows
    const me = rows.find((r) => r.user_id === U1)
    expect(me).toMatchObject({ role: 'owner', pending: false, blocked: false })
    expect(rows.find((r) => r.user_id === U3)).toMatchObject({ role: 'viewer', pending: true })
    await expect(as(U2, () => q('select * from public.tenant_user_list($1)', [tenantA]))).rejects.toThrow(/permisos/)
  })
})

describe('eliminar empresa', () => {
  it('borra la empresa con todos sus datos (documentos, pagos, OC, cobranza, banco) sin afectar a otras', async () => {
    const t = (await as(U1, () => q(`select id from public.create_tenant('Empresa a borrar', 'CL')`))).rows[0].id
    await db.exec(`update public.tenants set modules = private.known_modules() where id = '${t}'`)
    const { cp, doc } = await makeDoc(U1, t, { total_amount: 50000 })
    await as(U1, () => q(`update public.documents set approval_status = 'approved' where id = $1`, [doc])).catch(() => undefined)
    await as(U1, () => q(`select public.create_payment($1, 'out', $2, 'CLP', 20000, '2026-09-10', 'Transferencia', null, null, $3::jsonb)`, [t, cp, JSON.stringify([{ document_id: doc, amount: 20000 }])]))
    await as(U1, () => q(`select public.save_purchase_order($1, null, $2::jsonb, '[]'::jsonb)`, [t, JSON.stringify({ direction: 'payable', counterparty_id: cp, currency: 'CLP', issue_date: '2026-09-01', net_amount: 1000 })]))
    const conn = (await q(`insert into public.bank_connections (tenant_id, external_id) values ($1, 'link_del') returning id`, [t])).rows[0].id
    const acc = (await q(`insert into public.bank_feed_accounts (tenant_id, connection_id, external_id, currency) values ($1, $2, 'acc_del', 'CLP') returning id`, [t, conn])).rows[0].id
    await q(`insert into public.bank_movements (tenant_id, account_id, external_id, amount, currency, post_date) values ($1, $2, 'mov_del', -20000, 'CLP', '2026-09-10')`, [t, acc])
    const docsBefore = (await q('select count(*)::int as n from public.documents where tenant_id <> $1', [t])).rows[0].n
    await expect(as(U1, () => q('select public.delete_tenant($1)', [t]))).rejects.toThrow(/permission denied/)
    await q('select public.delete_tenant($1)', [t])
    for (const table of ['documents', 'payments', 'purchase_orders', 'counterparties', 'bank_movements', 'tenant_members', 'collection_rules']) {
      expect((await q(`select count(*)::int as n from public.${table} where tenant_id = $1`, [t])).rows[0].n).toBe(0)
    }
    expect((await q('select count(*)::int as n from public.documents where tenant_id <> $1', [t])).rows[0].n).toBe(docsBefore)
  })
})
