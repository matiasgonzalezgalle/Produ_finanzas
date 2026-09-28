// Webhook de MercadoPago. Público (verify_jwt = false) pero:
//   1. Exige firma x-signature válida con la clave secreta del tenant.
//   2. Nunca confía en el cuerpo: consulta el pago en la API de MercadoPago.
//   3. Registra el pago de forma idempotente (reintentos no duplican).
import { adminClient } from '../_shared/auth.ts'
import { handler, json } from '../_shared/http.ts'
import { loadConnection, mpFetch, toMinor, verifyMercadoPagoSignature } from '../_shared/mercadopago.ts'

interface MpPayment {
  id: number
  status: string
  currency_id: string
  transaction_amount: number
  external_reference: string | null
  date_approved: string | null
  payment_type_id: string
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') return json(req, 405, { error: 'Método no permitido' })
  const url = new URL(req.url)
  const tenantId = url.searchParams.get('tenant') ?? ''
  const body = await req.json().catch(() => ({}))
  const type = url.searchParams.get('type') ?? body.type ?? ''
  const dataId = String(url.searchParams.get('data.id') ?? body?.data?.id ?? '')

  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !dataId) return json(req, 400, { error: 'Solicitud inválida' })

  const admin = adminClient()
  const mp = await loadConnection(admin, tenantId)
  if (!mp) return json(req, 404, { error: 'Integración no encontrada' })

  const valid = await verifyMercadoPagoSignature({
    signatureHeader: req.headers.get('x-signature'),
    requestId: req.headers.get('x-request-id'),
    dataId,
    secret: mp.secrets.webhookSecret,
  })
  if (!valid) return json(req, 401, { error: 'Firma inválida' })

  const eventKey = `${type}:${dataId}:${req.headers.get('x-request-id') ?? ''}`
  await admin.from('webhook_events').upsert(
    { provider: 'mercadopago', tenant_id: tenantId, event_key: eventKey, payload: body },
    { onConflict: 'provider,event_key', ignoreDuplicates: true },
  )

  if (type !== 'payment') return json(req, 200, { ignored: true })

  try {
    const payment = await mpFetch<MpPayment>(`/v1/payments/${encodeURIComponent(dataId)}`, mp.secrets.accessToken)
    if (payment.status !== 'approved' || !payment.external_reference) {
      await markProcessed(admin, eventKey, null)
      return json(req, 200, { status: payment.status })
    }
    const { error } = await admin.rpc('record_provider_payment', {
      p_tenant_id: tenantId,
      p_payment_link_id: payment.external_reference,
      p_provider: 'mercadopago',
      p_external_id: String(payment.id),
      p_currency: payment.currency_id,
      p_amount: toMinor(payment.transaction_amount, payment.currency_id),
      p_paid_on: (payment.date_approved ?? new Date().toISOString()).slice(0, 10),
      p_method: `mercadopago:${payment.payment_type_id}`,
      p_reference: `MP ${payment.id}`,
    })
    if (error) throw error
    await markProcessed(admin, eventKey, null)
    return json(req, 200, { recorded: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markProcessed(admin, eventKey, message)
    await admin.from('integration_connections').update({ last_error: message }).eq('id', mp.connection.id)
    // 500 para que MercadoPago reintente.
    return json(req, 500, { error: 'No se pudo registrar el pago' })
  }
}))

async function markProcessed(admin: ReturnType<typeof adminClient>, eventKey: string, error: string | null) {
  await admin.from('webhook_events')
    .update({ processed_at: new Date().toISOString(), error })
    .eq('provider', 'mercadopago')
    .eq('event_key', eventKey)
}
