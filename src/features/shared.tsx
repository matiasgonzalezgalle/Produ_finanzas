import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ApprovalStatus, PaymentManagement, PaymentStatusDb } from '../data'
import { formatDate } from '../domain/dates'
import { CURRENCY_DECIMALS, formatMoney, fromMinor, parseAmountText, toMinor, type Currency, type CurrencyTotals } from '../domain/money'
import { Badge, type Tone } from '../ui'

export function Money({ minor, currency, className }: { minor: number; currency: Currency; className?: string }) {
  return <span className={`tabular whitespace-nowrap ${className ?? ''}`}>{formatMoney(minor, currency)}</span>
}

/** Lista de totales por moneda, sin mezclarlas. */
export function MoneyTotals({ totals, empty = '—' }: { totals: CurrencyTotals; empty?: string }) {
  const entries = Object.entries(totals).filter(([, v]) => v) as [Currency, number][]
  if (!entries.length) return <span>{empty}</span>
  const [[firstCurrency, firstAmount], ...others] = entries
  // La primera moneda en grande; las demás, en una línea secundaria para no agrandar la tarjeta.
  return (
    <span className="flex flex-col">
      <Money minor={firstAmount} currency={firstCurrency} />
      {others.length > 0 && (
        <span className="text-[11px] font-medium text-muted">
          {others.map(([currency, amount], i) => (
            <span key={currency}>
              {i > 0 && ' · '}{amount < 0 ? '− ' : '+ '}<Money minor={Math.abs(amount)} currency={currency} />
            </span>
          ))}
        </span>
      )}
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

// ---------------------------------------------------------------------------
// Aprobación y gestión de pago (CxP)
// ---------------------------------------------------------------------------
export const APPROVAL_LABEL: Record<ApprovalStatus, string> = { pending: 'Por aprobar', approved: 'Aprobado', rejected: 'Rechazado' }

export const PAYMENT_MANAGEMENT_LABEL: Record<PaymentManagement, string> = {
  requested: 'Pago solicitado',
  scheduled: 'Pago programado',
  paid: 'Pago realizado',
}

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return <Badge tone={status === 'approved' ? 'solid' : status === 'rejected' ? 'bad' : 'warn'}>{APPROVAL_LABEL[status]}</Badge>
}

export function PaymentManagementBadge({ value, date }: { value: PaymentManagement | null; date?: string | null }) {
  if (!value) return <Badge>Sin gestionar</Badge>
  const tone: Tone = value === 'paid' ? 'ok' : value === 'scheduled' ? 'info' : 'warn'
  return (
    <Badge tone={tone}>
      {PAYMENT_MANAGEMENT_LABEL[value]}
      {value === 'scheduled' && date ? ` · ${formatDate(date)}` : ''}
    </Badge>
  )
}
