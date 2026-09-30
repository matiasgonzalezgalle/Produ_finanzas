// Conecta la cuenta de MercadoPago de una empresa. Solo owner/admin.
// El access token se valida contra la API y se guarda en integration_secrets (inaccesible desde el cliente).
import { requireMember } from '../_shared/auth.ts'
import { handler, HttpError, json } from '../_shared/http.ts'
import { mpFetch, SITE_CURRENCY } from '../_shared/mercadopago.ts'

interface MpUser {
  id: number
  nickname: string
  site_id: string
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin'])

  const accessToken = String(body.accessToken ?? '').trim()
  const webhookSecret = String(body.webhookSecret ?? '').trim()
  if (!/^(APP_USR|TEST)-/.test(accessToken)) throw new HttpError(400, 'Access token inválido')
  if (webhookSecret.length < 16) throw new HttpError(400, 'Clave secreta de webhook inválida')

  const me = await mpFetch<MpUser>('/users/me', accessToken)
  const currency = SITE_CURRENCY[me.site_id]
  if (!currency) throw new HttpError(400, `País de MercadoPago no soportado (${me.site_id})`)
  // La cuenta de MercadoPago debe ser del país de la empresa (Chile → MLC en CLP, Perú → MPE en PEN).
  const { data: tenant } = await admin.from('tenants').select('country').eq('id', tenantId).single()
  const expected = tenant?.country === 'PE' ? 'MPE' : 'MLC'
  if (me.site_id !== expected) {
    throw new HttpError(400, `La cuenta de MercadoPago es de ${me.site_id === 'MPE' ? 'Perú' : me.site_id === 'MLC' ? 'Chile' : me.site_id} y la empresa es de ${tenant?.country === 'PE' ? 'Perú' : 'Chile'}. Usa una cuenta del mismo país.`)
  }

  const { data: connection, error } = await admin
    .from('integration_connections')
    .upsert(
      {
        tenant_id: tenantId,
        provider: 'mercadopago',
        status: 'active',
        last_error: null,
        public_config: {
          account_id: me.id,
          nickname: me.nickname,
          site_id: me.site_id,
          currency,
          token_last4: accessToken.slice(-4),
          sandbox: accessToken.startsWith('TEST-'),
        },
      },
      { onConflict: 'tenant_id,provider' },
    )
    .select('id, public_config')
    .single()
  if (error) throw error

  const { error: secretError } = await admin
    .from('integration_secrets')
    .upsert({ connection_id: connection.id, secrets: { accessToken, webhookSecret }, updated_at: new Date().toISOString() })
  if (secretError) throw secretError

  const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago-webhook?tenant=${tenantId}`
  return json(req, 200, { connection, webhookUrl })
}))
