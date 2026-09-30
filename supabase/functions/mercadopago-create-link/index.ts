// Crea (o reutiliza, si el saldo no cambió) el link de pago de MercadoPago de una cuenta por cobrar.
import { requireMember } from '../_shared/auth.ts'
import { handler, HttpError, json } from '../_shared/http.ts'
import { ensurePaymentLink } from '../_shared/paymentLinks.ts'

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
  const link = await ensurePaymentLink(admin, tenantId, String(body.documentId ?? ''))
  return json(req, 200, link)
}))
