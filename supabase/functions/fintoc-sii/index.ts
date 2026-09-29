// Documentos del SII vía Fintoc.
//   action "start"      (owner/admin): prepara el widget de Fintoc para conectar el SII de la empresa.
//   action "sync"       (owner/admin/finance): trae los documentos del SII y los guarda en sii_documents.
//   action "disconnect" (owner/admin): elimina la conexión en Fintoc y en la app.
import { requireMember } from '../_shared/auth.ts'
import { fintocFetch, fintocKeys, loadSiiConnection, sha256Hex, toSiiRow, type FintocInvoice } from '../_shared/fintoc.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const PER_PAGE = 300
const MAX_PAGES = 40

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'start') {
    const { admin, tenantId, user } = await requireMember(req, body.tenantId, ['owner', 'admin'])
    const { data: tenant } = await admin.from('tenants').select('country, tax_id').eq('id', tenantId).single()
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
    const sii = await loadSiiConnection(admin, tenantId)
    if (!sii) throw new HttpError(409, 'Conecta el SII en Configuración › Integraciones')
    const config = (sii.connection.public_config ?? {}) as Record<string, unknown>
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
    return json(req, 200, { fetched, syncedAt: startedAt })
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
