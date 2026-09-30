// Saldo de una cuenta manual: saldo inicial (al inicio de opening_date) + movimientos desde esa fecha.
import type { BankFeedAccount, BankMovement } from '../../data'

export interface AccountBalance {
  /** Saldo a mostrar (calculado si hay saldo inicial; si no, el de la última cartola). */
  balance: number | null
  /** Saldo calculado con el saldo inicial y los movimientos. */
  computed: number | null
  /** Saldo final informado por la última cartola importada. */
  statement: number | null
  /** Diferencia cartola − calculado (si ambos existen y no calzan). */
  difference: number | null
  /** Fecha del último movimiento considerado. */
  asOf: string | null
}

const counts = (m: BankMovement) => m.bank_status !== 'reversed' && m.bank_status !== 'duplicated'

export function manualAccountBalance(account: BankFeedAccount, movements: BankMovement[]): AccountBalance {
  const own = movements.filter((m) => m.account_id === account.id && counts(m))
  const statement = account.balance_current ?? null
  if (account.opening_balance == null || !account.opening_date) {
    const asOf = own.reduce<string | null>((d, m) => (!d || m.post_date > d ? m.post_date : d), null)
    return { balance: statement, computed: null, statement, difference: null, asOf }
  }
  const since = own.filter((m) => m.post_date >= account.opening_date!)
  const computed = account.opening_balance + since.reduce((s, m) => s + m.amount, 0)
  const asOf = since.reduce<string | null>((d, m) => (!d || m.post_date > d ? m.post_date : d), account.opening_date)
  const difference = statement !== null && statement !== computed ? statement - computed : null
  return { balance: computed, computed, statement, difference, asOf }
}
