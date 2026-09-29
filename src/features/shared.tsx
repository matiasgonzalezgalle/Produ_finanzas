import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PaymentStatusDb } from '../data'
import { CURRENCY_DECIMALS, formatMoney, fromMinor, parseAmountText, toMinor, type Currency, type CurrencyTotals } from '../domain/money'
import { Badge, type Tone } from '../ui'

export function Money({ minor, currency, className }: { minor: number; currency: Currency; className?: string }) {
  return <span className={`tabular whitespace-nowrap ${className ?? ''}`}>{formatMoney(minor, currency)}</span>
}

/** Lista de totales por moneda, sin mezclarlas. */
export function MoneyTotals({ totals, empty = '—' }: { totals: CurrencyTotals; empty?: string }) {
  const entries = Object.entries(totals).filter(([, v]) => v) as [Currency, number][]
  if (!entries.length) return <span>{empty}</span>
  return (
    <span className="flex flex-col">
      {entries.map(([currency, amount]) => (
        <Money key={currency} minor={amount} currency={currency} />
      ))}
    </span>
  )
}

/** Texto de un input de monto -> unidades mínimas. null si no es válido. */
export function parseMoneyInput(text: string, currency: Currency): number | null {
  const normalized = parseAmountText(text, { ambiguousAs: CURRENCY_DECIMALS[currency] >= 3 ? 'decimal' : 'thousands' })
  if (normalized === null) return null
  try {
    return toMinor(normalized, currency)
  } catch {
    return null
  }
}

/** Unidades mínimas -> texto editable ("1234,56"). */
export function minorToInput(minor: number, currency: Currency): string {
  if (!minor) return ''
  const decimals = CURRENCY_DECIMALS[currency]
  let text = fromMinor(minor, currency).toFixed(decimals)
  if (decimals > 0) text = text.replace(/\.?0+$/, '')
  return text.replace('.', ',')
}

const STATUS_TONE: Record<PaymentStatusDb, Tone> = {
  pagado: 'ok',
  parcial: 'info',
  pendiente: 'neutral',
  vencido: 'bad',
  anulado: 'neutral',
  borrador: 'warn',
  aplicada: 'info',
}

const STATUS_LABEL: Record<PaymentStatusDb, string> = {
  pagado: 'Pagado',
  parcial: 'Parcial',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
  anulado: 'Anulado',
  borrador: 'Borrador',
  aplicada: 'Aplicada',
}

export function StatusBadge({ status, daysOverdue }: { status: PaymentStatusDb; daysOverdue?: number }) {
  return (
    <Badge tone={STATUS_TONE[status]}>
      {STATUS_LABEL[status]}
      {status === 'vencido' && daysOverdue ? ` · ${daysOverdue} d` : ''}
    </Badge>
  )
}

/** Abre formularios vía ?nuevo=1 (lo usa el menú "Crear nuevo"). */
export function useNewParam(): [boolean, (open: boolean) => void] {
  const [params, setParams] = useSearchParams()
  const open = params.get('nuevo') === '1'
  const setOpen = useCallback(
    (value: boolean) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set('nuevo', '1')
          else next.delete('nuevo')
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )
  return [open, setOpen]
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado'
}
