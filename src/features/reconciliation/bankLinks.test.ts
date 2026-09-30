import { describe, expect, it } from 'vitest'
import type { BankMovement, Counterparty } from '../../data'
import { movementCandidates } from './bankLinks'

const cp = (id: string, name: string, tax_id: string | null = null) => ({ id, name, tax_id, is_customer: true, is_supplier: false }) as Counterparty
const mov = (id: string, amount: number, post_date: string, extra: Partial<BankMovement> = {}) =>
  ({ id, amount, post_date, currency: 'CLP', reconciliation_status: 'pending', counterparty_tax_id: null, description: '', ...extra }) as BankMovement

describe('movimientos sugeridos al registrar un cobro', () => {
  const pacifico = cp('c1', 'Comercial Pacífico Ltda.', '77008883-6')
  const canal = cp('c2', 'Canal Uno Televisión S.A.', '78171372-4')
  const base = { direction: 'in' as const, currency: 'CLP', amount: 1190000, date: '2026-09-29', counterparty: pacifico, counterparties: [pacifico, canal] }

  it('muestra los del mismo cliente aunque el monto difiera (RUT o nombre), y los de igual monto sin otro dueño', () => {
    const r = movementCandidates({
      ...base,
      movements: [
        mov('exacto', 1190000, '2026-09-24', { counterparty_tax_id: '77.008.883-6' }),
        mov('parcial-nombre', 600000, '2026-08-15', { description: 'TRANSF COMERCIAL PACIFICO' }),
        mov('mismo-monto-sin-rut', 1190000, '2026-09-20'),
        mov('mismo-monto-otro-cliente', 1190000, '2026-09-20', { counterparty_tax_id: '78171372-4' }),
        mov('muy-antiguo', 600000, '2026-06-01', { counterparty_tax_id: '77008883-6' }),
        mov('cargo', -1190000, '2026-09-24'),
      ],
    })
    expect(r.map((c) => c.movement.id)).toEqual(['exacto', 'mismo-monto-sin-rut', 'parcial-nombre'])
    expect(r[2]).toMatchObject({ byName: true, sameAmount: false, difference: -590000 })
  })
})
