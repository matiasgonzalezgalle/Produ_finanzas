// Conciliación bancaria: cartolas de la empresa vía Fintoc (producto Movements).
//   action "start"      (owner/admin): crea un link intent y devuelve el widget_token para el widget.
//   action "exchange"   (owner/admin): canjea el exchange_token del widget por el link_token y trae cuentas y movimientos.
//   action "sync"       (owner/admin/finance): actualiza saldos y movimientos de todas las conexiones activas.
//   action "disconnect" (owner/admin): elimina el link en Fintoc; los movimientos ya traídos se conservan.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { requireMember, requireModule } from '../_shared/auth.ts'
import { fintocFetch, fintocKeys, formatRut, rutKey } from '../_shared/fintoc.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const PER_PAGE = 300
const MAX_PAGES = 20
const FIRST_SYNC_DAYS = 90
const INVALID = 'La conexión con el banco ya no es válida: vuelve a conectarla'
const CURRENCIES = new Set(['CLP', 'PEN', 'USD', 'EUR'])

interface TransferAccount { holder_id: string | null; holder_name: string | null; number: string | null; institution: { id?: string; name?: string } | null }
interface FintocAccount {
  id: string
  name: string | null
  official_name: string | null
  number: string | null
  type: string | null
  currency: string
  holder_id: string | null
  holder_name: string | null
  balance: { available: number | null; current: number | null } | null
  refreshed_at: string | null
  removed_from_link?: boolean
}
interface FintocBankLink {
  id: string
  link_token?: string
  holder_id: string | null
  holder_name?: string | null
  mode: string
  institution?: { id: string; name?: string } | null
  accounts?: FintocAccount[]
}
interface FintocMovement {
  id: string
  amount: number
  currency: string
  description: string | null
  comment: string | null
  post_date: string
  transaction_date: string | null
  type: string | null
  status: string | null
  reference_id: string | null
  document_number: string | null
  pending: boolean
  sender_account: TransferAccount | null
  recipient_account: TransferAccount | null
}

async function upsertAccounts(admin: SupabaseClient, tenantId: string, connectionId: string, accounts: FintocAccount[]) {
  const rows = accounts
    .filter((a) => CURRENCIES.has(a.currency))
    .map((a) => ({
      tenant_id: tenantId,
      connection_id: connectionId,
      external_id: a.id,
      name: a.name,
      official_name: a.official_name,
      number: a.number,
      type: a.type,
      currency: a.currency,
      holder_id: a.holder_id ? formatRut(a.holder_id) : null,
      holder_name: a.holder_name,
      balance_available: a.balance?.available ?? null,
      balance_current: a.balance?.current ?? null,
      refreshed_at: a.refreshed_at,
      removed: !!a.removed_from_link,
    }))
  if (!rows.length) return [] as { id: string; external_id: string; removed: boolean }[]
  const { data, error } = await admin.from('bank_feed_accounts').upsert(rows, { onConflict: 'tenant_id,external_id' }).select('id, external_id, removed')
  if (error) throw error
  return data
}

function toMovementRow(tenantId: string, accountId: string, m: FintocMovement) {
  const other = m.amount > 0 ? m.sender_account : m.recipient_account
  return {
    tenant_id: tenantId,
    account_id: accountId,
    external_id: m.id,
    amount: m.amount,
    currency: m.currency,
    description: m.description,
    comment: m.comment,
    post_date: m.post_date.slice(0, 10),
    transaction_at: m.transaction_date,
    type: m.type,
    bank_status: m.status ?? 'confirmed',
    reference_id: m.reference_id,
    document_number: m.document_number,
    pending: !!m.pending,
    counterparty_tax_id: other?.holder_id ? formatRut(other.holder_id) : null,
    counterparty_name: other?.holder_name ?? null,
    counterparty_account: other?.number ?? null,
    counterparty_bank: other?.institution?.name ?? null,
    updated_at: new Date().toISOString(),
  }
}

/** Actualiza cuentas y movimientos de una conexión. Devuelve cuántos movimientos se trajeron. */
async function syncConnection(admin: SupabaseClient, tenantId: string, connection: { id: string; last_sync_at: string | null }, linkToken: string) {
  const startedAt = new Date().toISOString()
  try {
    const linkRes = await fintocFetch(`/v1/links/${encodeURIComponent(linkToken)}`, {}, INVALID)
    const link = (await linkRes.json()) as FintocBankLink
    const accounts = await upsertAccounts(admin, tenantId, connection.id, link.accounts ?? [])
    let fetched = 0
    for (const account of accounts.filter((a) => !a.removed)) {
      const params = new URLSearchParams({ link_token: linkToken, per_page: String(PER_PAGE) })
      if (connection.last_sync_at) {
        // Incremental, con margen: los movimientos en proceso pueden cambiar de estado.
        params.set('updated_since', new Date(new Date(connection.last_sync_at).getTime() - 2 * 86_400_000).toISOString())
      } else {
        params.set('since', new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000).toISOString().slice(0, 10))
      }
      for (let page = 1; page <= MAX_PAGES; page++) {
        params.set('page', String(page))
        const res = await fintocFetch(`/v1/accounts/${encodeURIComponent(account.external_id)}/movements?${params}`, {}, INVALID)
        const movements = ((await res.json()) as FintocMovement[]).filter((m) => m.amount !== 0 && CURRENCIES.has(m.currency))
        if (movements.length) {
          const { error } = await admin.from('bank_movements').upsert(movements.map((m) => toMovementRow(tenantId, account.id, m)), { onConflict: 'tenant_id,external_id' })
          if (error) throw error
          fetched += movements.length
        }
        if (movements.length < PER_PAGE) break
      }
    }
    await admin.from('bank_connections').update({
      status: 'active', last_error: null, last_sync_at: startedAt,
      institution_name: link.institution?.name ?? undefined, holder_name: link.holder_name ?? undefined,
    }).eq('id', connection.id)
    return fetched
  } catch (err) {
    await admin.from('bank_connections').update({
      status: err instanceof HttpError && err.status === 409 ? 'error' : 'active',
      last_error: err instanceof HttpError ? err.message : 'No se pudieron traer los movimientos del banco',
    }).eq('id', connection.id)
    throw err
  }
}

async function linkTokenOf(admin: SupabaseClient, connectionId: string) {
  const { data } = await admin.from('bank_connection_secrets').select('link_token').eq('connection_id', connectionId).maybeSingle()
  return (data?.link_token as string | undefined) ?? null
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'start') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const tenant = await requireModule(admin, tenantId, 'conciliacion')
    if (tenant.country !== 'CL') throw new HttpError(400, 'La conexión con bancos vía Fintoc está disponible para empresas de Chile')
    const { publicKey } = fintocKeys()
    const res = await fintocFetch('/v1/link_intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: 'movements', country: 'cl', holder_type: 'business' }),
    }, INVALID)
    const intent = (await res.json()) as { widget_token: string }
    return json(req, 200, { publicKey, widgetToken: intent.widget_token, holderId: tenant.tax_id })
  }

  if (action === 'exchange') {
    const { admin, tenantId, user } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const tenant = await requireModule(admin, tenantId, 'conciliacion')
    const exchangeToken = String(body.exchangeToken ?? '')
    if (!exchangeToken) throw new HttpError(400, 'Falta el exchange_token del widget')
    const res = await fintocFetch(`/v1/links/exchange?exchange_token=${encodeURIComponent(exchangeToken)}`, {}, 'La conexión expiró: vuelve a intentarlo')
    const link = (await res.json()) as FintocBankLink
    if (!link.link_token) throw new HttpError(502, 'Fintoc no devolvió el link')
    // En producción, la cuenta debe ser de la empresa (mismo RUT).
    if (link.mode === 'live' && tenant.tax_id && link.holder_id && rutKey(link.holder_id) !== rutKey(tenant.tax_id)) {
      await fintocFetch(`/v1/links/${encodeURIComponent(link.link_token)}`, { method: 'DELETE' }).catch(() => undefined)
      throw new HttpError(400, `Las cuentas conectadas son de otro RUT (${formatRut(link.holder_id)}). Conecta las cuentas de la empresa.`)
    }
    const { data: connection, error } = await admin.from('bank_connections').upsert({
      tenant_id: tenantId,
      external_id: link.id,
      institution_id: link.institution?.id ?? null,
      institution_name: link.institution?.name ?? null,
      holder_id: link.holder_id ? formatRut(link.holder_id) : null,
      holder_name: link.holder_name ?? null,
      mode: link.mode,
      status: 'active',
      last_error: null,
      created_by: user.id,
    }, { onConflict: 'tenant_id,external_id' }).select('id, last_sync_at').single()
    if (error) throw error
    const { error: secretError } = await admin.from('bank_connection_secrets').upsert({ connection_id: connection.id, link_token: link.link_token, updated_at: new Date().toISOString() })
    if (secretError) throw secretError
    await upsertAccounts(admin, tenantId, connection.id, link.accounts ?? [])
    const fetched = await syncConnection(admin, tenantId, connection, link.link_token)
    return json(req, 200, { connectionId: connection.id, fetched })
  }

  if (action === 'sync') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
    await requireModule(admin, tenantId, 'conciliacion')
    const { data: connections } = await admin.from('bank_connections').select('id, last_sync_at').eq('tenant_id', tenantId).neq('status', 'disconnected')
    let fetched = 0
    const errors: string[] = []
    for (const connection of connections ?? []) {
      const token = await linkTokenOf(admin, connection.id)
      if (!token) continue
      try {
        fetched += await syncConnection(admin, tenantId, connection, token)
      } catch (err) {
        errors.push(err instanceof HttpError ? err.message : 'Error al sincronizar')
      }
    }
    if (errors.length && errors.length === (connections ?? []).length) throw new HttpError(502, errors[0])
    return json(req, 200, { fetched, errors, syncedAt: new Date().toISOString() })
  }

  if (action === 'disconnect') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const connectionId = String(body.connectionId ?? '')
    const { data: connection } = await admin.from('bank_connections').select('id').eq('tenant_id', tenantId).eq('id', connectionId).maybeSingle()
    if (!connection) throw new HttpError(404, 'Conexión no encontrada')
    const token = await linkTokenOf(admin, connection.id)
    if (token) await fintocFetch(`/v1/links/${encodeURIComponent(token)}`, { method: 'DELETE' }, INVALID).catch((err) => console.error('No se pudo eliminar el link en Fintoc', err))
    await admin.from('bank_connection_secrets').delete().eq('connection_id', connection.id)
    await admin.from('bank_connections').update({ status: 'disconnected', last_error: null }).eq('id', connection.id)
    return json(req, 200, { ok: true })
  }

  throw new HttpError(400, 'Acción inválida')
}))
