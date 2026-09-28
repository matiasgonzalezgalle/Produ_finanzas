import type { Country } from './taxId'
import { daysBetween } from './dates'

export type DocumentDirection = 'payable' | 'receivable'
export type DocumentStatus = 'draft' | 'open' | 'void'

export type DocumentTypeCode =
  | 'factura'
  | 'factura_exenta'
  | 'boleta'
  | 'nota_credito'
  | 'nota_debito'
  | 'honorarios'
  | 'invoice'
  | 'otro'

export interface DocumentTypeInfo {
  code: DocumentTypeCode
  label: string
  /** Una nota de crédito resta del documento al que referencia. */
  isCredit: boolean
  countries: readonly Country[]
}

export const DOCUMENT_TYPES: readonly DocumentTypeInfo[] = [
  { code: 'factura', label: 'Factura', isCredit: false, countries: ['CL', 'PE'] },
  { code: 'factura_exenta', label: 'Factura exenta', isCredit: false, countries: ['CL'] },
  { code: 'boleta', label: 'Boleta', isCredit: false, countries: ['CL', 'PE'] },
  { code: 'nota_credito', label: 'Nota de crédito', isCredit: true, countries: ['CL', 'PE'] },
  { code: 'nota_debito', label: 'Nota de débito', isCredit: false, countries: ['CL', 'PE'] },
  { code: 'honorarios', label: 'Boleta / recibo de honorarios', isCredit: false, countries: ['CL', 'PE'] },
  { code: 'invoice', label: 'Invoice (extranjero)', isCredit: false, countries: ['CL', 'PE'] },
  { code: 'otro', label: 'Otro documento', isCredit: false, countries: ['CL', 'PE'] },
]

export function documentTypeLabel(code: string): string {
  return DOCUMENT_TYPES.find((t) => t.code === code)?.label ?? code
}

export const TAX_RATE: Record<Country, number> = { CL: 0.19, PE: 0.18 }
export const TAX_LABEL: Record<Country, string> = { CL: 'IVA', PE: 'IGV' }

/** Impuesto sobre el neto, en unidades mínimas, redondeado al entero. */
export function computeTax(netMinor: number, country: Country): number {
  return Math.round(netMinor * TAX_RATE[country])
}

/**
 * Detracción SUNAT (Perú): porcentaje del total que se deposita en Banco de la Nación.
 * El monto se deposita en soles enteros, sin céntimos.
 */
export function computeDetraction(totalMinor: number, ratePercent: number, currencyDecimals: number): number {
  if (!(ratePercent > 0)) return 0
  const unit = 10 ** currencyDecimals
  const raw = (totalMinor * ratePercent) / 100
  return Math.round(raw / unit) * unit
}

export type PaymentStatus = 'anulado' | 'borrador' | 'pagado' | 'parcial' | 'vencido' | 'pendiente'
export type AgingBucket = 'al_dia' | '1_30' | '31_60' | '61_90' | 'mas_90'

export interface BalanceInput {
  status: DocumentStatus
  totalMinor: number
  /** Suma de notas de crédito aplicadas a este documento. */
  creditsMinor: number
  detractionMinor: number
  /** Suma de pagos asignados a este documento (por ID, nunca por referencia). */
  allocatedMinor: number
  dueDate: string | null
}

export interface Balance {
  netMinor: number
  directMinor: number
  paidMinor: number
  pendingMinor: number
  paymentStatus: PaymentStatus
  daysOverdue: number
  aging: AgingBucket
}

export function computeBalance(input: BalanceInput, today: string): Balance {
  const netMinor = Math.max(0, input.totalMinor - input.creditsMinor)
  const directMinor = Math.max(0, netMinor - input.detractionMinor)
  const paidMinor = input.allocatedMinor
  const pendingMinor = input.status === 'open' ? Math.max(0, directMinor - paidMinor) : 0
  const daysOverdue = input.dueDate && pendingMinor > 0 ? Math.max(0, daysBetween(input.dueDate, today)) : 0

  let paymentStatus: PaymentStatus
  if (input.status === 'void') paymentStatus = 'anulado'
  else if (input.status === 'draft') paymentStatus = 'borrador'
  else if (pendingMinor === 0) paymentStatus = 'pagado'
  else if (daysOverdue > 0) paymentStatus = 'vencido'
  else if (paidMinor > 0) paymentStatus = 'parcial'
  else paymentStatus = 'pendiente'

  return { netMinor, directMinor, paidMinor, pendingMinor, paymentStatus, daysOverdue, aging: agingBucket(daysOverdue) }
}

export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'al_dia'
  if (daysOverdue <= 30) return '1_30'
  if (daysOverdue <= 60) return '31_60'
  if (daysOverdue <= 90) return '61_90'
  return 'mas_90'
}

export const AGING_LABEL: Record<AgingBucket, string> = {
  al_dia: 'Al día',
  '1_30': '1–30 días',
  '31_60': '31–60 días',
  '61_90': '61–90 días',
  mas_90: '+90 días',
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  anulado: 'Anulado',
  borrador: 'Borrador',
  pagado: 'Pagado',
  parcial: 'Parcial',
  vencido: 'Vencido',
  pendiente: 'Pendiente',
}
