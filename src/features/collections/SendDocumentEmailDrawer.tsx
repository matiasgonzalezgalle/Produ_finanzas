// Enviar un correo de cobranza de un documento: plantilla (por defecto "Cobro con link de pago"),
// vista previa con los datos reales y botón de pago de MercadoPago si está conectado.
import clsx from 'clsx'
import { Check, CreditCard, Mail } from 'lucide-react'
import { useState } from 'react'
import { useCollectionMutations, useCollectionRules, useIntegration } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentRow } from '../../data'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { formatMoney } from '../../domain/money'
import { Button, Drawer, FormError } from '../../ui'
import { errorMessage } from '../shared'
import { fillSample } from './collectionData'

export const PAYMENT_LINK_TEMPLATE = 'Cobro con link de pago'

export function SendDocumentEmailDrawer({ document: d, onClose }: { document: DocumentRow; onClose: () => void }) {
  const { tenant, today, hasModule } = useCurrentTenant()
  const rules = useCollectionRules()
  const mp = useIntegration('mercadopago')
  const { sendEmail } = useCollectionMutations()
  // Plantillas de un documento (el estado de cuenta es por cliente).
  const templates = (rules.data ?? []).filter((r) => r.trigger !== 'statement')
  const preferred = templates.find((r) => r.name === PAYMENT_LINK_TEMPLATE) ?? templates.find((r) => r.include_payment_link) ?? templates[0]
  const [choice, setChoice] = useState<string | null>(null)
  const rule = templates.find((r) => r.id === (choice ?? preferred?.id)) ?? null
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const payReady = hasModule('mercadopago') && mp.data?.status === 'active' && rule?.include_payment_link

  const label = `${documentTypeLabel(d.doc_type).toLowerCase()} N° ${d.folio}`
  const vars: Record<string, string> = {
    cliente: d.counterparty_name, empresa: tenant.name, documento: label, folio: d.folio,
    saldo: formatMoney(d.pending_amount, d.currency), total: formatMoney(d.total_amount, d.currency),
    emision: formatDate(d.issue_date), vencimiento: formatDate(d.due_date), dias_atraso: String(Math.max(0, d.days_overdue)),
    hoy: formatDate(today), link_pago: payReady ? '(link de pago)' : '(link del portal)', link_portal: '(link del portal)',
  }

  const send = async () => {
    if (!rule) return setError('Elige una plantilla.')
    setError(null)
    try {
      await sendEmail.mutateAsync({ counterpartyId: d.counterparty_id, ruleId: rule.id, documentId: d.id })
      setSent(true)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer
      open onClose={onClose} width="lg" title="Enviar cobro por correo" subtitle={`${d.counterparty_name} · ${documentTypeLabel(d.doc_type)} N° ${d.folio}`}
      footer={sent
        ? <Button variant="primary" onClick={onClose}>Listo</Button>
        : <><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={send} disabled={sendEmail.isPending || !rule}><Mail size={15} /> {sendEmail.isPending ? 'Enviando…' : 'Enviar ahora'}</Button></>}
    >
      {sent ? (
        <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-4 text-sm text-ok">
          <Check size={18} className="shrink-0" /> Correo enviado a los contactos de cobranza de {d.counterparty_name.replace(/\.$/, '')}. Lo verás en la actividad del cliente y en Configuración › Notificaciones.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <FormError error={error} />
          {rules.isLoading && <p className="text-sm text-faint">Cargando plantillas…</p>}
          {!rules.isLoading && !templates.length && <p className="text-sm text-muted">No hay plantillas. Créalas en Cobranza › Recordatorios.</p>}
          <div className="flex flex-col gap-2">
            {templates.map((r) => (
              <label key={r.id} className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', rule?.id === r.id ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
                <input type="radio" checked={rule?.id === r.id} onChange={() => setChoice(r.id)} className="mt-0.5 accent-navy-900" />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">{r.name}{r.include_payment_link && <CreditCard size={14} className="text-brand-600" aria-label="Incluye link de pago" />}</span>
                  <span className="block truncate text-[12px] text-muted">{r.subject}</span>
                </span>
              </label>
            ))}
          </div>

          {rule && (
            <section className="overflow-hidden rounded-lg border border-line">
              <div className="border-b border-line bg-subtle px-4 py-2 text-xs text-faint">Vista previa</div>
              <div className="flex flex-col gap-3 px-4 py-4">
                <p className="text-[15px] font-semibold text-ink">{fillSample(rule.subject, vars)}</p>
                <p className="text-sm whitespace-pre-line text-muted">{fillSample(rule.body, vars)}</p>
                {rule.include_documents && (
                  <dl className="divide-y divide-line rounded-md border border-line text-sm">
                    <Row k="Documento" v={`${documentTypeLabel(d.doc_type)} N° ${d.folio}`} />
                    <Row k="Emisión" v={formatDate(d.issue_date)} />
                    <Row k="Vencimiento" v={`${formatDate(d.due_date)}${d.days_overdue > 0 ? ` (${d.days_overdue} días de atraso)` : ''}`} />
                    {d.total_amount !== d.pending_amount && <Row k="Total" v={formatMoney(d.total_amount, d.currency)} />}
                    <Row k="Saldo por pagar" v={formatMoney(d.pending_amount, d.currency)} strong />
                  </dl>
                )}
                {payReady ? (
                  <div>
                    <span className="inline-flex items-center gap-2 rounded-lg bg-[#16181d] px-5 py-2.5 text-sm font-semibold text-white">Pagar {formatMoney(d.pending_amount, d.currency)}</span>
                    <p className="mt-1.5 text-xs text-faint">Pago seguro con MercadoPago. El link se genera (o se reutiliza) al enviar.</p>
                  </div>
                ) : (
                  <p className="text-xs text-faint">
                    {rule.include_payment_link
                      ? 'MercadoPago no está conectado: el botón llevará al portal financiero del cliente (si tiene acceso).'
                      : 'Esta plantilla no incluye link de pago.'}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between px-3 py-2">
      <dt className="text-muted">{k}</dt>
      <dd className={clsx('text-ink', strong && 'font-semibold')}>{v}</dd>
    </div>
  )
}
