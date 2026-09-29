// Recibe el aviso de Fintoc cuando una empresa termina de conectar su SII en el widget (evento link.created).
// Público (verify_jwt = false) pero:
//   1. Exige un "state" de un solo uso, vigente 30 minutos, que la app emitió para esa empresa.
//   2. No confía en el cuerpo: consulta el link en la API de Fintoc con la clave secreta.
//   3. El RUT conectado debe ser el de la empresa (si la empresa tiene RUT registrado).
import { adminClient } from '../_shared/auth.ts'
import { fintocFetch, rutKey, sha256Hex, type FintocLink } from '../_shared/fintoc.ts'
import { handler, json } from '../_shared/http.ts'

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') return json(req, 405, { error: 'Método no permitido' })
  const state = new URL(req.url).searchParams.get('state') ?? ''
  if (state.length < 20) return json(req, 400, { error: 'Solicitud inválida' })
  const body = await req.json().catch(() => ({}))
  const data = body?.data ?? body
  const linkToken = String(data?.link_token ?? '')
  if (!/^link_[A-Za-z0-9]+_token_[A-Za-z0-9_-]+$/.test(linkToken)) return json(req, 400, { error: 'Solicitud inválida' })

  const admin = adminClient()
  const { data: pending } = await admin
    .from('fintoc_connect_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state_hash', await sha256Hex(state))
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('tenant_id')
    .maybeSingle()
  if (!pending) return json(req, 404, { error: 'Solicitud vencida o ya usada' })
  const tenantId = pending.tenant_id as string

  const link = (await (await fintocFetch(`/v1/links/${encodeURIComponent(linkToken)}`)).json()) as FintocLink
  const { data: tenant } = await admin.from('tenants').select('tax_id').eq('id', tenantId).single()
  const mismatch = tenant?.tax_id && link.holder_id && rutKey(tenant.tax_id) !== rutKey(link.holder_id)

  const { data: connection, error } = await admin
    .from('integration_connections')
    .upsert(
      {
        tenant_id: tenantId,
        provider: 'fintoc_sii',
        status: mismatch ? 'error' : 'active',
        last_error: mismatch ? `El RUT conectado (${link.holder_id}) no es el de la empresa (${tenant?.tax_id}). Conecta el SII de la empresa.` : null,
        public_config: { holder_id: link.holder_id, holder_type: link.holder_type, link_id: link.id, mode: link.mode, connected_at: new Date().toISOString() },
      },
      { onConflict: 'tenant_id,provider' },
    )
    .select('id')
    .single()
  if (error) throw error

  if (mismatch) {
    await admin.from('integration_secrets').delete().eq('connection_id', connection.id)
    await fintocFetch(`/v1/links/${encodeURIComponent(linkToken)}`, { method: 'DELETE' }).catch(() => undefined)
    return json(req, 200, { received: true })
  }
  const { error: secretError } = await admin
    .from('integration_secrets')
    .upsert({ connection_id: connection.id, secrets: { linkToken }, updated_at: new Date().toISOString() })
  if (secretError) throw secretError
  return json(req, 200, { received: true })
}))
