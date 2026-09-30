// Link de pago de MercadoPago para una cuenta por cobrar. Reutiliza el link vigente si el saldo
// no cambió; si cambió, el anterior ya quedó "expired" (trigger en la base) y se crea uno nuevo.
// El monto siempre sale del saldo del documento en la base de datos.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'
import { loadConnection, mpFetch, toMajor } from './mercadopago.ts'

const VALID_DAYS = 30

interface MpPreference {
  id: string
  init_point: string
  sandbox_init_point: string
}

const DOC_LABEL: Record<string, string> = {
  factura: 'Factura', factura_exenta: 'Factura exenta', boleta: 'Boleta', nota_debito: 'Nota de débito', invoice: 'Invoice', honorarios: 'Boleta de honorarios', otro: 'Documento',
}

export async function ensurePaymentLink(admin: SupabaseClient, tenantId: string, documentId: string): Promise<{ id: string; url: string; reused: boolean }> {
  const { data: doc } = await admin
    .from('document_balances')
    .select('id, tenant_id, direction, doc_type, folio, currency, pending_amount, status')
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

  // Link vigente por el mismo saldo y con al menos un día de vigencia: se reutiliza.
  const soon = new Date(Date.now() + 86_400_000).toISOString()
  const { data: current } = await admin
    .from('payment_links')
    .select('id, url, expires_at')
    .eq('tenant_id', tenantId).eq('document_id', doc.id).eq('provider', 'mercadopago').eq('status', 'active').eq('amount', amount)
    .not('url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (current?.url && (!current.expires_at || current.expires_at > soon)) return { id: current.id, url: current.url, reused: true }

  // Cualquier otro link activo del documento queda reemplazado.
  await admin.from('payment_links').update({ status: 'expired' }).eq('document_id', doc.id).eq('status', 'active')

  const expiresAt = new Date(Date.now() + VALID_DAYS * 86_400_000)
  const { data: link, error } = await admin
    .from('payment_links')
    .insert({ tenant_id: tenantId, document_id: doc.id, provider: 'mercadopago', currency: doc.currency, amount, created_by: null, expires_at: expiresAt.toISOString() })
    .select('id')
    .single()
  if (error) throw error

  const appUrl = Deno.env.get('APP_URL') ?? ''
  const preference = await mpFetch<MpPreference>('/checkout/preferences', mp.secrets.accessToken, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': link.id },
    body: JSON.stringify({
      items: [{ id: doc.id, title: `${DOC_LABEL[doc.doc_type] ?? 'Documento'} N° ${doc.folio}`, quantity: 1, currency_id: doc.currency, unit_price: toMajor(amount, doc.currency) }],
      external_reference: link.id,
      notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago-webhook?tenant=${tenantId}`,
      back_urls: appUrl ? { success: `${appUrl}/pago/exito`, failure: `${appUrl}/pago/error`, pending: `${appUrl}/pago/pendiente` } : undefined,
      auto_return: appUrl ? 'approved' : undefined,
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: expiresAt.toISOString(),
    }),
  })

  const url = mp.connection.public_config?.sandbox ? preference.sandbox_init_point : preference.init_point
  await admin.from('payment_links').update({ url, external_id: preference.id }).eq('id', link.id)
  return { id: link.id, url, reused: false }
}
