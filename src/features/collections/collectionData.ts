// Cartera de cobranza: agrupa los documentos por cobrar por cliente.
import type { CollectionEvent, CollectionRule, Counterparty, DocumentRow, EmailLogRow } from '../../data'
import { sumByCurrency, type Currency, type CurrencyTotals } from '../../domain/money'

export type AgeBucket = 'por_vencer' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90'
export const AGE_BUCKETS: { key: AgeBucket; label: string; color: string }[] = [
  { key: 'por_vencer', label: 'Por vencer', color: '#3b82f6' },
  { key: 'd1_30', label: '1–30 días', color: '#f59e0b' },
  { key: 'd31_60', label: '31–60 días', color: '#f97316' },
  { key: 'd61_90', label: '61–90 días', color: '#ef4444' },
  { key: 'd90', label: '+90 días', color: '#991b1b' },
]

export function ageBucket(d: Pick<DocumentRow, 'days_overdue'>): AgeBucket {
  if (d.days_overdue <= 0) return 'por_vencer'
  if (d.days_overdue <= 30) return 'd1_30'
  if (d.days_overdue <= 60) return 'd31_60'
  if (d.days_overdue <= 90) return 'd61_90'
  return 'd90'
}

export type AccountStatus = 'al_dia' | 'vencido' | 'promesa' | 'promesa_incumplida' | 'pausado' | 'sin_deuda'
export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  al_dia: { label: 'Al día', tone: 'ok' },
  vencido: { label: 'Vencido', tone: 'bad' },
  promesa: { label: 'Promesa de pago', tone: 'info' },
  promesa_incumplida: { label: 'Promesa incumplida', tone: 'warn' },
  pausado: { label: 'Cobranza pausada', tone: 'neutral' },
  sin_deuda: { label: 'Sin deuda', tone: 'neutral' },
}

export interface CollectionAccount {
  counterparty: Counterparty
  documents: DocumentRow[]
  open: DocumentRow[]
  pending: CurrencyTotals
  overdue: CurrencyTotals
  notDue: CurrencyTotals
  /** Tramos en la moneda base de la empresa (los documentos en otras monedas se muestran aparte). */
  buckets: Record<AgeBucket, number>
  maxDaysOverdue: number
  overdueCount: number
  nextPromise: CollectionEvent | null
  lastPromiseBroken: boolean
  lastActivityAt: string | null
  status: AccountStatus
}

const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })

export function buildAccounts(params: {
  counterparties: Counterparty[]
  documents: DocumentRow[]
  events: CollectionEvent[]
  emails: EmailLogRow[]
  baseCurrency: Currency
}): CollectionAccount[] {
  const { counterparties, documents, events, emails, baseCurrency } = params
  const byCp = new Map<string, DocumentRow[]>()
  for (const d of documents) {
    if (d.status === 'void' || d.status === 'draft') continue
    byCp.set(d.counterparty_id, [...(byCp.get(d.counterparty_id) ?? []), d])
  }
  const eventsByCp = new Map<string, CollectionEvent[]>()
  for (const e of events) eventsByCp.set(e.counterparty_id, [...(eventsByCp.get(e.counterparty_id) ?? []), e])
  const lastEmail = new Map<string, string>()
  for (const m of emails) {
    if (!m.counterparty_id || m.status !== 'sent') continue
    const at = m.sent_at ?? m.created_at
    if (!lastEmail.has(m.counterparty_id) || at > lastEmail.get(m.counterparty_id)!) lastEmail.set(m.counterparty_id, at)
  }

  return counterparties
    .filter((c) => c.is_customer || byCp.has(c.id))
    .map((c) => {
      const docs = byCp.get(c.id) ?? []
      const open = docs.filter((d) => d.pending_amount > 0 && d.doc_type !== 'nota_credito')
      const overdueDocs = open.filter((d) => d.days_overdue > 0)
      const buckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0])) as Record<AgeBucket, number>
      for (const d of open) if (d.currency === baseCurrency) buckets[ageBucket(d)] += d.pending_amount
      const evs = eventsByCp.get(c.id) ?? []
      const promises = evs.filter((e) => e.kind === 'promise')
      const nextPromise = promises.filter((e) => e.promise_status === 'pending').sort((a, b) => (a.promised_date ?? '').localeCompare(b.promised_date ?? ''))[0] ?? null
      const latestPromise = [...promises].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
      const lastPromiseBroken = latestPromise?.promise_status === 'broken'
      const lastEvent = evs.reduce<string | null>((m, e) => (!m || e.created_at > m ? e.created_at : m), null)
      const mail = lastEmail.get(c.id) ?? null
      const lastActivityAt = [lastEvent, mail].filter(Boolean).sort().pop() ?? null
      const status: AccountStatus = !open.length
        ? 'sin_deuda'
        : c.collection_paused
          ? 'pausado'
          : nextPromise
            ? 'promesa'
            : overdueDocs.length && lastPromiseBroken
              ? 'promesa_incumplida'
              : overdueDocs.length
                ? 'vencido'
                : 'al_dia'
      return {
        counterparty: c,
        documents: docs,
        open,
        pending: sumByCurrency(open, pick),
        overdue: sumByCurrency(overdueDocs, pick),
        notDue: sumByCurrency(open.filter((d) => d.days_overdue <= 0), pick),
        buckets,
        maxDaysOverdue: overdueDocs.reduce((m, d) => Math.max(m, d.days_overdue), 0),
        overdueCount: overdueDocs.length,
        nextPromise,
        lastPromiseBroken,
        lastActivityAt,
        status,
      }
    })
}

/** ¿La regla aplica al cliente? (misma lógica que private.rule_applies) */
export function ruleAppliesTo(rule: CollectionRule, c: Counterparty, override: boolean | undefined): boolean {
  if (!c.is_customer || c.collection_paused) return false
  if (override !== undefined) return override
  if (rule.audience === 'all') return true
  if (rule.audience === 'tags') return c.tags.some((t) => rule.audience_tags.includes(t))
  return rule.audience_ids.includes(c.id)
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
export const WEEKDAY_LABEL = WEEKDAYS

export function ruleWhen(r: Pick<CollectionRule, 'trigger' | 'offset_days' | 'weekday' | 'send_hour'>): string {
  const hour = `${String(r.send_hour).padStart(2, '0')}:00`
  switch (r.trigger) {
    case 'before_due':
      return `${r.offset_days} ${r.offset_days === 1 ? 'día' : 'días'} antes del vencimiento · ${hour}`
    case 'on_due':
      return `El día del vencimiento · ${hour}`
    case 'after_due':
      return `${r.offset_days} ${r.offset_days === 1 ? 'día' : 'días'} después del vencimiento · ${hour}`
    case 'statement':
      return `Todos los ${WEEKDAYS[r.weekday ?? 1]} · ${hour}`
    case 'new_document':
      return 'Al emitir el documento'
    default:
      return 'Solo envío manual'
  }
}

/** Variables disponibles en asunto y mensaje (se reemplazan al enviar). */
export const TEMPLATE_VARIABLES: { key: string; label: string; sample: string; docOnly?: boolean }[] = [
  { key: 'cliente', label: 'Cliente', sample: 'Canal Uno Televisión S.A.' },
  { key: 'empresa', label: 'Tu empresa', sample: 'Nube Films SpA' },
  { key: 'documento', label: 'Documento', sample: 'factura N° 1038', docOnly: true },
  { key: 'folio', label: 'Folio', sample: '1038', docOnly: true },
  { key: 'saldo', label: 'Saldo', sample: '$2.950.000', docOnly: true },
  { key: 'total', label: 'Total', sample: '$5.950.000', docOnly: true },
  { key: 'emision', label: 'Emisión', sample: '26/07/2026', docOnly: true },
  { key: 'vencimiento', label: 'Vencimiento', sample: '25/08/2026', docOnly: true },
  { key: 'dias_atraso', label: 'Días de atraso', sample: '35', docOnly: true },
  { key: 'total_pendiente', label: 'Total pendiente', sample: '$20.205.000' },
  { key: 'total_vencido', label: 'Total vencido', sample: '$7.115.000' },
  { key: 'documentos_pendientes', label: 'N° documentos', sample: '5' },
  { key: 'hoy', label: 'Fecha de hoy', sample: '29/09/2026' },
  { key: 'link_pago', label: 'Link de pago', sample: 'https://mpago.la/…' },
  { key: 'link_portal', label: 'Link del portal', sample: 'https://finanzas.produ.cl/portal/…' },
]

export function fillSample(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => vars[key] ?? m)
}

export function unknownVariables(text: string) {
  const known = new Set(TEMPLATE_VARIABLES.map((v) => v.key))
  return [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !known.has(k)))]
}
