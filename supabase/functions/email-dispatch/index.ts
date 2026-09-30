// Correos del negocio.
//   action "dispatch"             (cualquier miembro): envía los avisos pendientes de la empresa.
//   action "send_purchase_order"  (owner/admin/finance): envía una OC al proveedor con su PDF adjunto.
//   action "preview_collection"   (owner/admin/finance): arma el correo de cobranza tal como se enviará (sin enviarlo).
//   action "preview_template"     (owner/admin/finance): vista previa de una plantilla en edición, con datos de ejemplo.
import { requireMember } from '../_shared/auth.ts'
import { buildCollectionEmail, collectionContent, date, dispatchOutbox, esc, money, renderEmail, sendWithResend } from '../_shared/emails.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PDF_BYTES = 5 * 1024 * 1024

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'dispatch') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance', 'viewer'])
    return json(req, 200, await dispatchOutbox(admin, tenantId))
  }

  if (action === 'preview_collection') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
    const counterpartyId = String(body.counterpartyId ?? '')
    const ruleId = body.ruleId ? String(body.ruleId) : null
    const documentId = body.documentId ? String(body.documentId) : null
    const { data: cp } = await admin.from('counterparties').select('id').eq('id', counterpartyId).eq('tenant_id', tenantId).maybeSingle()
    if (!cp) throw new HttpError(404, 'Cliente no encontrado')
    const { data: tenant } = await admin.from('tenants').select('name').eq('id', tenantId).single()
    const tenantName = tenant?.name ?? 'Produ Finanzas'
    const built = await buildCollectionEmail(admin, {
      tenant_id: tenantId,
      kind: ruleId ? 'collection_rule' : 'statement',
      payload: { counterparty_id: counterpartyId, ...(ruleId ? { rule_id: ruleId } : {}), ...(documentId ? { document_id: documentId } : {}), manual: 'true' },
    }, tenantName, { preview: true })
    if ('skip' in built) return json(req, 200, { skip: built.skip })
    return json(req, 200, { subject: built.content.subject, html: renderEmail(built.content, tenantName), to: built.to })
  }

  if (action === 'preview_template') {
    const { admin, tenantId } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
    const { data: tenant } = await admin.from('tenants').select('name, base_currency').eq('id', tenantId).single()
    const tenantName = tenant?.name ?? 'Tu empresa'
    const currency = tenant?.base_currency ?? 'CLP'
    const perDocument = String(body.trigger ?? 'manual') !== 'statement'
    const sample = (folio: string, pending: number, total: number, overdueDays: number, due: string) => ({
      id: folio, doc_type: 'factura', folio, currency, issue_date: '2026-07-26', due_date: due, pending_amount: pending, total_amount: total,
      days_overdue: overdueDays, counterparty_id: 'x', counterparty_name: 'Cliente de ejemplo S.A.',
    })
    const docs = [sample('1038', 2950000, 5950000, 35, '2026-08-25'), sample('1041', 4165000, 4165000, 5, '2026-09-24'), sample('1044', 1190000, 1190000, 0, '2026-10-13')]
    const focus = perDocument ? docs[0] : null
    const vars: Record<string, string> = {
      cliente: 'Cliente de ejemplo S.A.', empresa: tenantName, hoy: date(new Date().toISOString().slice(0, 10)),
      total_pendiente: money(8305000, currency), total_vencido: money(7115000, currency), documentos_pendientes: '3',
      link_portal: 'https://finanzas.produ.cl/portal', link_pago: 'https://www.mercadopago.cl/checkout',
      ...(focus ? { documento: `factura N° ${focus.folio}`, folio: focus.folio, saldo: money(focus.pending_amount, currency), total: money(focus.total_amount, currency), emision: date(focus.issue_date), vencimiento: date(focus.due_date), dias_atraso: String(focus.days_overdue) } : {}),
    }
    const rule = {
      subject: String(body.subject ?? '').slice(0, 200) || 'Sin asunto',
      body: '',
      include_documents: true,
      include_payment_link: body.includePaymentLink !== false,
      blocks: Array.isArray(body.blocks) ? body.blocks : [],
    }
    const content = collectionContent({ rule, vars, focus, docs, overdue: docs.filter((d) => d.days_overdue > 0), payUrl: '#', portal: '#', tenantName, counterpartyName: vars.cliente })
    return json(req, 200, { subject: content.subject, html: renderEmail(content, tenantName) })
  }

  if (action === 'send_purchase_order') {
    const { admin, tenantId, user } = await requireMember(req, body.tenantId, ['owner', 'admin', 'finance'])
    const to = [...new Set((Array.isArray(body.to) ? body.to : []).map((e: unknown) => String(e).trim().toLowerCase()))].filter((e) => EMAIL_RE.test(e)) as string[]
    if (!to.length || to.length > 5) throw new HttpError(400, 'Indica entre 1 y 5 correos válidos')
    const pdf = String(body.pdfBase64 ?? '')
    if (!pdf || pdf.length * 0.75 > MAX_PDF_BYTES || !/^[A-Za-z0-9+/=]+$/.test(pdf)) throw new HttpError(400, 'PDF inválido o de más de 5 MB')
    const message = String(body.message ?? '').slice(0, 2000).trim()

    const { data: po } = await admin.from('purchase_order_balances').select('*').eq('id', body.purchaseOrderId).eq('tenant_id', tenantId).maybeSingle()
    if (!po) throw new HttpError(404, 'Orden de compra no encontrada')
    if (po.direction !== 'payable' || !['approved', 'closed'].includes(po.status)) throw new HttpError(400, 'Solo se envían órdenes de compra aprobadas')
    const [{ data: tenant }, { data: settings }] = await Promise.all([
      admin.from('tenants').select('name').eq('id', tenantId).single(),
      admin.from('tenant_email_settings').select('reply_to').eq('tenant_id', tenantId).maybeSingle(),
    ])
    const tenantName = tenant?.name ?? 'Produ Finanzas'
    const replyTo = settings?.reply_to ?? user.email ?? null
    const subject = `Orden de compra N° ${po.number} de ${tenantName}`
    const html = renderEmail({
      subject,
      preheader: `Total ${money(po.total_amount, po.currency)}`,
      title: `Orden de compra N° ${po.number}`,
      body: `Hola ${esc(po.counterparty_name)},<br><b style="color:#1b1f2e">${esc(tenantName)}</b> te envía la orden de compra adjunta.${message ? `<br><br>${esc(message).replace(/\n/g, '<br>')}` : ''}<br><br>Al facturar, indica el número de la orden.`,
      rows: [
        ['Total', `<b>${money(po.total_amount, po.currency)}</b>`],
        ['Emisión', date(po.issue_date)],
        ...(po.delivery_date ? ([['Entrega', date(po.delivery_date)]] as [string, string][]) : []),
        ...(po.payment_terms_days != null ? ([['Plazo de pago', `${po.payment_terms_days} días`]] as [string, string][]) : []),
      ],
      footnote: replyTo ? `Puedes responder este correo para escribir a ${esc(tenantName)}.` : undefined,
    }, tenantName)

    const { data: logRow, error: logError } = await admin.from('email_outbox').insert({
      tenant_id: tenantId, kind: 'purchase_order', payload: { purchase_order_id: po.id }, status: 'sending', recipients: to, subject, created_by: user.id, attempts: 1, claimed_at: new Date().toISOString(),
    }).select('id').single()
    if (logError) throw logError
    try {
      const providerId = await sendWithResend({
        to, subject, html, replyTo, fromName: tenantName, idempotencyKey: logRow.id,
        attachments: [{ filename: `orden-de-compra-${String(po.number).replace(/[^\w-]+/g, '_')}.pdf`, content: pdf }],
      })
      await admin.from('email_outbox').update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() }).eq('id', logRow.id)
    } catch (err) {
      await admin.from('email_outbox').update({ status: 'failed', error: (err instanceof Error ? err.message : 'Error').slice(0, 300) }).eq('id', logRow.id)
      throw new HttpError(502, 'No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.')
    }
    await admin.from('purchase_orders').update({ sent_at: new Date().toISOString(), sent_to: to.join(', ') }).eq('id', po.id)
    return json(req, 200, { sent: true, to })
  }

  throw new HttpError(400, 'Acción inválida')
}))
