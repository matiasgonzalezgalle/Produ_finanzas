// Crea un link de pago de MercadoPago para una cuenta por cobrar.
// El monto y la descripción se toman del documento en la base de datos, nunca del cliente.
import { requireMember } from '../_shared/auth.ts'
import { handler, HttpError, json } from '../_shared/http.ts'
import { loadConnection, mpFetch, toMajor } from '../_shared/mercadopago.ts'

interface MpPreference {
  id: string
  init_point: string
  sandbox_init_point: string
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])

  const documentId = String(body.documentId ?? '')
  const { data: doc } = await admin
    .from('document_balances')
    .select('id, tenant_id, direction, doc_type, folio, currency, pending_amount, status, counterparty_name')
    .eq('id', documentId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!doc) throw new HttpError(404, 'Documento no encontrado')
  if (doc.direction !== 'receivable') throw new HttpError(400, 'Solo se cobran cuentas por cobrar')
  if (doc.status !== 'open' || Number(doc.pending_amount) <= 0) throw new HttpError(400, 'El documento no tiene saldo pendiente')

  const mp = await loadConnection(admin, tenantId)
  if (!mp) throw new HttpError(400, 'MercadoPago no está conectado')
  const accountCurrency = mp.connection.public_config?.currency
  if (doc.currency !== accountCurrency) {
    throw new HttpError(400, `La cuenta de MercadoPago cobra en ${accountCurrency} y el documento está en ${doc.currency}`)
  }

  const amount = Number(doc.pending_amount)
  const { data: link, error } = await admin
    .from('payment_links')
    .insert({ tenant_id: tenantId, document_id: doc.id, provider: 'mercadopago', currency: doc.currency, amount, created_by: null })
    .select('id')
    .single()
  if (error) throw error

  const appUrl = Deno.env.get('APP_URL') ?? ''
  const preference = await mpFetch<MpPreference>('/checkout/preferences', mp.secrets.accessToken, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': link.id },
    body: JSON.stringify({
      items: [{
        id: doc.id,
        title: `Documento ${doc.folio}`,
        quantity: 1,
        currency_id: doc.currency,
        unit_price: toMajor(amount, doc.currency),
      }],
      external_reference: link.id,
      notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago-webhook?tenant=${tenantId}`,
      back_urls: appUrl ? { success: `${appUrl}/pago/exito`, failure: `${appUrl}/pago/error`, pending: `${appUrl}/pago/pendiente` } : undefined,
      auto_return: appUrl ? 'approved' : undefined,
    }),
  })

  const url = mp.connection.public_config?.sandbox ? preference.sandbox_init_point : preference.init_point
  await admin.from('payment_links').update({ url, external_id: preference.id }).eq('id', link.id)
  return json(req, 200, { id: link.id, url })
}))
