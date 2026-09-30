import { describe, expect, it } from 'vitest'
import type { BankMovement, Counterparty, DocumentRow, Payment } from '../../data'
import { allocateFifo, coreName, isAutomatic, suggest, type MatchContext } from './matching'

const cp = (id: string, tax_id: string, customer = true): Counterparty =>
  ({ id, tax_id, name: id, is_customer: customer, is_supplier: !customer }) as Counterparty
const mov = (amount: number, extra: Partial<BankMovement> = {}): BankMovement =>
  ({ id: 'm', amount, currency: 'CLP', post_date: '2026-09-20', counterparty_tax_id: '76.086.428-5', ...extra }) as BankMovement
const pay = (id: string, amount: number, extra: Partial<Payment> = {}): Payment =>
  ({ id, amount, direction: 'in', status: 'confirmed', currency: 'CLP', paid_on: '2026-09-18', counterparty_id: 'c1', allocations: [], ...extra }) as Payment
const doc = (id: string, pending: number, extra: Partial<DocumentRow> = {}): DocumentRow =>
  ({ id, pending_amount: pending, direction: 'receivable', counterparty_id: 'c1', currency: 'CLP', status: 'open', doc_type: 'factura', approval_status: 'approved', issue_date: '2026-09-01', due_date: '2026-09-30', ...extra }) as DocumentRow

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  counterparties: [cp('c1', '76086428-5'), cp('c2', '11111111-1')],
  payments: [],
  documents: [],
  linkedPaymentIds: new Set(),
  ...over,
})

describe('sugerencias de conciliación', () => {
  it('prefiere el cobro registrado de la misma contraparte, dentro de la ventana de fechas', () => {
    const s = suggest(mov(5000), ctx({ payments: [pay('p-otro', 5000, { counterparty_id: 'c2' }), pay('p1', 5000), pay('lejos', 5000, { paid_on: '2026-08-01' })] }))
    expect(s.kind === 'payment' && s.candidate.payment.id).toBe('p1')
    expect(isAutomatic(s)).toBe(false) // hay otro cobro con el mismo monto
  })

  it('no sugiere pagos ya conciliados, de otro sentido o de otro monto', () => {
    const s = suggest(mov(5000), ctx({ payments: [pay('p1', 5000)], linkedPaymentIds: new Set(['p1']) }))
    expect(s.kind).toBe('counterparty')
    expect(suggest(mov(-5000), ctx({ payments: [pay('p1', 5000)] })).kind).toBe('counterparty')
  })

  it('documento que calza exacto, o el conjunto de documentos; si no, reparte por vencimiento', () => {
    const docs = [doc('d1', 3000, { due_date: '2026-09-10' }), doc('d2', 2000), doc('d3', 9000, { counterparty_id: 'c2' })]
    const exact = suggest(mov(2000), ctx({ documents: docs }))
    expect(exact.kind === 'documents' && exact.documents.map((d) => d.id)).toEqual(['d2'])
    expect(isAutomatic(exact)).toBe(true)
    const both = suggest(mov(5000), ctx({ documents: docs }))
    expect(both.kind === 'documents' && both.exact).toBe(true)
    const partial = suggest(mov(4000), ctx({ documents: docs }))
    expect(partial.kind === 'documents' && partial.exact).toBe(false)
    expect(allocateFifo(4000, docs.slice(0, 2))).toEqual({ d1: 3000, d2: 1000 })
  })

  it('sin RUT, reconoce a la contraparte por su nombre en la descripción (si es único)', () => {
    const cps = [cp('c1', '76086428-5'), { ...cp('c3', ''), name: 'Canal Uno Televisión S.A.' }, { ...cp('c4', ''), name: 'Uno SpA' }]
    const docs = [doc('d9', 7000, { counterparty_id: 'c3' })]
    const s = suggest(mov(7000, { counterparty_tax_id: null, description: 'TRANSF. CANAL UNO TELEVISION SA' }), ctx({ counterparties: cps, documents: docs }))
    expect(s.kind === 'documents' && s.counterparty.id).toBe('c3')
    expect(coreName('Nube Films SpA')).toBe('nube films')
    expect(coreName('Supermercados Peruanos S.A.C.')).toBe('supermercados peruanos')
    expect(coreName('Transportes Andinos Ltda.')).toBe('transportes andinos')
  })

  it('sin RUT conocido no hay sugerencia', () => {
    expect(suggest(mov(1000, { counterparty_tax_id: null }), ctx()).kind).toBe('none')
  })
})
