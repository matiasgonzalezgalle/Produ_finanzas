import { describe, expect, it } from 'vitest'
import type { BankFeedAccount, BankMovement } from '../../data'
import { manualAccountBalance } from './balances'

const acc = (over: Partial<BankFeedAccount> = {}) => ({ id: 'a', source: 'manual', balance_current: null, opening_balance: null, opening_date: null, ...over }) as BankFeedAccount
const mov = (amount: number, post_date: string, bank_status = 'confirmed') => ({ account_id: 'a', amount, post_date, bank_status }) as BankMovement

describe('saldo de cuentas manuales', () => {
  const movs = [mov(-50000, '2026-08-31'), mov(200000, '2026-09-01'), mov(-30000, '2026-09-05'), mov(-999, '2026-09-06', 'reversed')]
  it('saldo inicial + movimientos desde esa fecha (sin reversados)', () => {
    const b = manualAccountBalance(acc({ opening_balance: 1000000, opening_date: '2026-09-01' }), movs)
    expect(b).toMatchObject({ balance: 1170000, computed: 1170000, difference: null, asOf: '2026-09-05' })
  })
  it('sin saldo inicial usa el de la cartola; si ambos existen muestra la diferencia', () => {
    expect(manualAccountBalance(acc({ balance_current: 500 }), movs).balance).toBe(500)
    expect(manualAccountBalance(acc({ balance_current: 1175000, opening_balance: 1000000, opening_date: '2026-09-01' }), movs).difference).toBe(5000)
  })
})
