// Vínculo pago/cobro ↔ movimiento del banco, para mostrarlo fuera de la pantalla de conciliación.
import { Landmark } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useBankConnections, useBankFeedAccounts, useBankMovements } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { BankConnection, BankFeedAccount, BankMovement } from '../../data'
import { daysBetween, formatDate } from '../../domain/dates'
import { Badge } from '../../ui'
import { BankLogo } from './BankLogo'
import { counterpartyFor, DATE_WINDOW, rutKey } from './matching'
import type { Counterparty } from '../../data'

export interface BankLink {
  movement: BankMovement
  account: BankFeedAccount | undefined
  connection: Pick<BankConnection, 'institution_id' | 'institution_name'> | undefined
}

export const accountLabel = (a: BankFeedAccount | undefined) => (a ? `${a.name ?? 'Cuenta'} ···${(a.number ?? '').slice(-4)}` : 'Cuenta bancaria')

/** Movimientos del banco de la empresa (solo si tiene el módulo de conciliación). */
export function useBankData() {
  const { hasModule } = useCurrentTenant()
  const enabled = hasModule('conciliacion')
  const movements = useBankMovements(enabled)
  const accounts = useBankFeedAccounts(enabled)
  const connections = useBankConnections(enabled)
  return useMemo(() => {
    const accountById = new Map((accounts.data ?? []).map((a) => [a.id, a]))
    const connectionById = new Map((connections.data ?? []).map((c) => [c.id, c]))
    // Banco de la cuenta (de la conexión de Fintoc o el elegido en la cuenta manual).
    const connectionOf = (accountId: string) => {
      const account = accountById.get(accountId)
      if (account?.source === 'manual') return { institution_id: account.institution_id, institution_name: account.institution_name }
      const c = connectionById.get(account?.connection_id ?? '')
      return c ? { institution_id: c.institution_id, institution_name: c.institution_name } : undefined
    }
    const byPayment = new Map<string, BankLink>()
    for (const m of movements.data ?? []) if (m.payment_id) byPayment.set(m.payment_id, { movement: m, account: accountById.get(m.account_id), connection: connectionOf(m.account_id) })
    return { enabled, movements: movements.data ?? [], accountById, connectionOf, byPayment }
  }, [enabled, movements.data, accounts.data, connections.data])
}

/**
 * Movimientos por conciliar que podrían corresponder al pago que se está registrando:
 * mismo sentido y moneda, fecha cercana; primero el mismo monto y el mismo RUT.
 */
export function movementCandidates(params: {
  movements: BankMovement[]
  direction: 'in' | 'out'
  currency: string
  amount: number | null
  date: string
  counterparty: Counterparty | null
  counterparties: Counterparty[]
}) {
  const { movements, direction, currency, amount, date, counterparty, counterparties } = params
  const cpKey = rutKey(counterparty?.tax_id)
  return movements
    .filter((m) => m.reconciliation_status === 'pending' && (direction === 'in' ? m.amount > 0 : m.amount < 0) && m.currency === currency)
    .map((m) => {
      const sameAmount = amount != null && amount > 0 && Math.abs(m.amount) === amount
      const sameCounterparty = !!cpKey && rutKey(m.counterparty_tax_id) === cpKey
      const otherCounterparty = !!cpKey && !!m.counterparty_tax_id && !sameCounterparty && !!counterpartyFor(m, counterparties)
      return { movement: m, sameAmount, sameCounterparty, otherCounterparty, dayDiff: Math.abs(daysBetween(m.post_date, date)) }
    })
    // Sin monto ingresado se muestran los de la contraparte; con monto, solo los que calzan.
    .filter((c) => (amount ? c.sameAmount : c.sameCounterparty) && !c.otherCounterparty && c.dayDiff <= DATE_WINDOW * 3)
    .sort((a, b) => Number(b.sameCounterparty) - Number(a.sameCounterparty) || a.dayDiff - b.dayDiff)
    .slice(0, 5)
}

export function ReconciledBadge({ link }: { link: BankLink | undefined }) {
  return link ? <Badge tone="ok">Conciliado</Badge> : <Badge tone="warn">Sin conciliar</Badge>
}

/** Detalle del movimiento conciliado (o aviso de que falta conciliar). */
export function BankLinkDetail({ link, direction }: { link: BankLink | undefined; direction: 'in' | 'out' }) {
  if (!link) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2.5 text-sm text-muted">
        <Landmark size={15} className="text-faint" />
        Aún no se concilia con la cartola.{' '}
        <Link to="/conciliacion" className="font-medium text-brand-600 hover:underline">Ir a conciliación</Link>
      </p>
    )
  }
  const m = link.movement
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
      <BankLogo id={link.connection?.institution_id} name={link.connection?.institution_name} size={28} />
      <div className="min-w-0">
        <div className="text-ink">{direction === 'in' ? 'Abono' : 'Cargo'} del {formatDate(m.post_date)} · {accountLabel(link.account)}</div>
        <div className="truncate text-xs text-faint">{m.description}{m.reference_id && ` · Ref. ${m.reference_id}`}</div>
      </div>
    </div>
  )
}
