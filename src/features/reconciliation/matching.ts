// Sugerencias de conciliación: para cada movimiento de la cartola busca el pago/cobro ya registrado
// o los documentos abiertos que calzan (por monto, RUT de la contraparte y fecha).
import type { BankMovement, Counterparty, DocumentRow, Payment } from '../../data'
import { daysBetween } from '../../domain/dates'

/** Días de diferencia aceptados entre la fecha del pago registrado y la del banco. */
export const DATE_WINDOW = 10

export const rutKey = (rut: string | null | undefined) => (rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase()
export const movementDirection = (m: Pick<BankMovement, 'amount'>): 'in' | 'out' => (m.amount > 0 ? 'in' : 'out')

export interface PaymentCandidate {
  payment: Payment
  sameCounterparty: boolean
  dayDiff: number
}

export type Suggestion =
  | { kind: 'payment'; candidate: PaymentCandidate; others: number }
  | { kind: 'documents'; counterparty: Counterparty; documents: DocumentRow[]; exact: boolean }
  | { kind: 'counterparty'; counterparty: Counterparty }
  | { kind: 'none' }

export interface MatchContext {
  counterparties: Counterparty[]
  payments: Payment[]
  documents: DocumentRow[]
  /** Pagos ya conciliados con otro movimiento. */
  linkedPaymentIds: Set<string>
}

export function counterpartyFor(m: BankMovement, counterparties: Counterparty[]): Counterparty | null {
  const key = rutKey(m.counterparty_tax_id)
  if (!key) return null
  const wantCustomer = m.amount > 0
  const matches = counterparties.filter((c) => rutKey(c.tax_id) === key)
  return matches.find((c) => (wantCustomer ? c.is_customer : c.is_supplier)) ?? matches[0] ?? null
}

export function paymentCandidates(m: BankMovement, ctx: MatchContext): PaymentCandidate[] {
  const direction = movementDirection(m)
  const cp = counterpartyFor(m, ctx.counterparties)
  return ctx.payments
    .filter((p) => p.direction === direction && p.status === 'confirmed' && p.currency === m.currency && p.amount === Math.abs(m.amount))
    .filter((p) => !ctx.linkedPaymentIds.has(p.id))
    .map((p) => ({ payment: p, sameCounterparty: !!cp && p.counterparty_id === cp.id, dayDiff: Math.abs(daysBetween(p.paid_on, m.post_date)) }))
    .filter((c) => c.dayDiff <= DATE_WINDOW)
    .sort((a, b) => Number(b.sameCounterparty) - Number(a.sameCounterparty) || a.dayDiff - b.dayDiff)
}

/** Documentos abiertos de la contraparte, en la moneda del movimiento, por vencimiento. */
export function openDocumentsFor(m: BankMovement, counterpartyId: string, documents: DocumentRow[]) {
  const direction = m.amount > 0 ? 'receivable' : 'payable'
  return documents
    .filter((d) => d.direction === direction && d.counterparty_id === counterpartyId && d.currency === m.currency)
    .filter((d) => d.pending_amount > 0 && d.status !== 'void' && d.status !== 'draft' && d.doc_type !== 'nota_credito' && d.approval_status !== 'rejected')
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.issue_date.localeCompare(b.issue_date))
}

/** Reparte el monto sobre los documentos (primero el que vence antes). */
export function allocateFifo(amount: number, documents: DocumentRow[]): Record<string, number> {
  let left = amount
  const out: Record<string, number> = {}
  for (const d of documents) {
    if (left <= 0) break
    const take = Math.min(left, d.pending_amount)
    out[d.id] = take
    left -= take
  }
  return out
}

export function suggest(m: BankMovement, ctx: MatchContext): Suggestion {
  const candidates = paymentCandidates(m, ctx)
  const best = candidates[0]
  // Un pago registrado calza si es de la misma contraparte o si es el único con ese monto.
  if (best && (best.sameCounterparty || candidates.length === 1)) return { kind: 'payment', candidate: best, others: candidates.length - 1 }
  const cp = counterpartyFor(m, ctx.counterparties)
  if (!cp) return { kind: 'none' }
  const open = openDocumentsFor(m, cp.id, ctx.documents)
  const amount = Math.abs(m.amount)
  const single = open.find((d) => d.pending_amount === amount)
  if (single) return { kind: 'documents', counterparty: cp, documents: [single], exact: true }
  const total = open.reduce((s, d) => s + d.pending_amount, 0)
  if (open.length > 1 && total === amount) return { kind: 'documents', counterparty: cp, documents: open, exact: true }
  if (open.length) return { kind: 'documents', counterparty: cp, documents: open, exact: false }
  return { kind: 'counterparty', counterparty: cp }
}

/** ¿Se puede conciliar sin revisión? (pago registrado de la misma contraparte o documentos que calzan exacto) */
export const isAutomatic = (s: Suggestion) =>
  (s.kind === 'payment' && s.candidate.sameCounterparty && s.others === 0) || (s.kind === 'documents' && s.exact)
