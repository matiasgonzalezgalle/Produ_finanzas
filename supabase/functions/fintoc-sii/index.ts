// Documentos del SII vía Fintoc.
//   action "start"      (owner/admin): prepara el widget de Fintoc para conectar el SII de la empresa.
//   action "sync"       (owner/admin/finance): pide a Fintoc actualizar desde el SII (refresh intent, si el plan lo
//                       permite) y trae los documentos que Fintoc ya tiene, guardándolos en sii_documents.
//   action "disconnect" (owner/admin): elimina la conexión en Fintoc y en la app.
import { requireMember, requireModule } from '../_shared/auth.ts'
import { fintocFetch, fintocKeys, loadSiiConnection, sha256Hex, toSiiRow, type FintocInvoice } from '../_shared/fintoc.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const PER_PAGE = 300
const MAX_PAGES = 40
// Fintoc limita las actualizaciones a pedido; no se pide otra antes de este tiempo.
const REFRESH_EVERY_MS = 5 * 60 * 1000

type RefreshResult = 'requested' | 'too_soon' | 'not_allowed' | 'failed' | 'skipped'

/**
 * Pide a Fintoc que vuelva a consultar el SII (Refresh Intent). Es asíncrono: los documentos nuevos
 * quedan disponibles en unos minutos. Sin la política "on demand" del plan, Fintoc lo rechaza y solo
 * se actualiza con su frecuencia automática.
 */
async function requestRefresh(linkToken: string, config: Record<string, unknown>): Promise<RefreshResult> {
  const last = typeof config.last_refresh_requested_at === 'string' ? Date.parse(config.last_refresh_requested_at) : 0
  if (Date.now() - last < REFRESH_EVERY_MS) return 'too_soon'
  const { secretKey } = fintocKeys()
  const res = await fetch(`https://api.fintoc.com/v1/refresh_intents?link_token=${encodeURIComponent(linkToken)}`, {
    method: 'POST',
    headers: { Authorization: secretKey, Accept: 'application/json' },
  }).catch(() => null)
  if (!res) return 'failed'
  if (res.ok) return 'requested'
  const detail = await res.text().catch(() => '')
  console.error('Fintoc refresh intent', res.status, detail.slice(0, 300))
  if (res.status === 429) return 'too_soon'
  if (res.status === 403 || res.status === 400 || res.status === 422) return 'not_allowed'
  return 'failed'
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'start') {
    const { admin, tenantId, user } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const tenant = await requireModule(admin, tenantId, 'sii')
    if (tenant?.country !== 'CL') throw new HttpError(400, 'La conexión con el SII está disponible solo para empresas de Chile')
    const { publicKey } = fintocKeys()
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const { error } = await admin.from('fintoc_connect_states').insert({ state_hash: await sha256Hex(state), tenant_id: tenantId, created_by: user.id })
    if (error) throw error
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/fintoc-sii-webhook?state=${state}`
    return json(req, 200, { publicKey, webhookUrl, holderId: tenant.tax_id })
  }

  if (action === 'sync') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
    await requireModule(admin, tenantId, 'sii')
    const sii = await loadSiiConnection(admin, tenantId)
    if (!sii) throw new HttpError(409, 'Conecta el SII en Configuración › Integraciones')
    const config = (sii.connection.public_config ?? {}) as Record<string, unknown>
    const refresh: RefreshResult = body.refresh === false ? 'skipped' : await requestRefresh(sii.linkToken, config)
    if (refresh === 'requested' || refresh === 'not_allowed') {
      config.last_refresh_requested_at = new Date().toISOString()
      config.last_refresh_status = refresh
    }
    const params = new URLSearchParams({ link_token: sii.linkToken, per_page: String(PER_PAGE) })
    // Primera vez: últimos 12 meses. Luego, solo lo que cambió desde la última sincronización (con 1 día de margen).
    if (typeof config.last_sync_at === 'string') {
      params.set('updated_since', new Date(new Date(config.last_sync_at).getTime() - 86_400_000).toISOString())
    } else {
      const since = new Date()
      since.setUTCMonth(since.getUTCMonth() - 12)
      params.set('since', since.toISOString().slice(0, 10))
    }
    const startedAt = new Date().toISOString()
    let fetched = 0
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        params.set('page', String(page))
        const res = await fintocFetch(`/v1/invoices?${params}`)
        const invoices = (await res.json()) as FintocInvoice[]
        if (invoices.length) {
          const rows = invoices.map((inv) => toSiiRow(tenantId, inv))
          const { error } = await admin.from('sii_documents').upsert(rows, { onConflict: 'tenant_id,external_id' })
          if (error) throw error
          fetched += invoices.length
        }
        if (invoices.length < PER_PAGE) break
      }
    } catch (err) {
      await admin.from('integration_connections').update({
        last_error: err instanceof HttpError ? err.message : 'No se pudieron traer los documentos del SII',
        status: err instanceof HttpError && err.status === 409 ? 'error' : sii.connection.status,
      }).eq('id', sii.connection.id)
      throw err
    }
    await admin.from('integration_connections').update({
      status: 'active',
      last_error: null,
      last_event_at: startedAt,
      public_config: { ...config, last_sync_at: startedAt },
    }).eq('id', sii.connection.id)
    return json(req, 200, { fetched, syncedAt: startedAt, refresh })
  }

  if (action === 'disconnect') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const sii = await loadSiiConnection(admin, tenantId)
    if (sii) {
      await fintocFetch(`/v1/links/${encodeURIComponent(sii.linkToken)}`, { method: 'DELETE' }).catch((err) => console.error('No se pudo eliminar el link en Fintoc', err))
    }
    await admin.from('integration_connections').delete().eq('tenant_id', tenantId).eq('provider', 'fintoc_sii')
    return json(req, 200, { ok: true })
  }

  throw new HttpError(400, 'Acción inválida')
}))
