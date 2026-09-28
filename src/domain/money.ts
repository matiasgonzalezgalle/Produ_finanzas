// Montos: siempre enteros en la unidad mínima de cada moneda (sin floats).
// CLP no tiene decimales; PEN/USD/EUR usan centavos; UF se guarda con 4 decimales.

export const CURRENCIES = ['CLP', 'PEN', 'USD', 'EUR', 'UF'] as const
export type Currency = (typeof CURRENCIES)[number]

export const CURRENCY_DECIMALS: Record<Currency, number> = {
  CLP: 0,
  PEN: 2,
  USD: 2,
  EUR: 2,
  UF: 4,
}

// Decimales que se muestran (UF se muestra con 2 aunque se guarde con 4).
const DISPLAY_DECIMALS: Record<Currency, number> = {
  CLP: 0,
  PEN: 2,
  USD: 2,
  EUR: 2,
  UF: 2,
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

/** Convierte un monto decimal (número o string "1234.5") a unidades mínimas. */
export function toMinor(amount: number | string, currency: Currency): number {
  const decimals = CURRENCY_DECIMALS[currency]
  const text = typeof amount === 'number' ? amount.toFixed(decimals + 2) : amount.trim()
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error(`Monto inválido: "${amount}"`)
  const [, sign, int, frac = ''] = match
  // Redondeo half-up sobre la parte decimal sobrante, sin pasar por float.
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  const roundUp = frac.length > decimals && Number(frac[decimals]) >= 5
  let minor = Number(int + kept) + (roundUp ? 1 : 0)
  if (!Number.isSafeInteger(minor)) throw new Error(`Monto fuera de rango: "${amount}"`)
  if (sign && minor !== 0) minor = -minor
  return minor
}

/** Convierte unidades mínimas a número decimal (solo para mostrar o enviar a APIs). */
export function fromMinor(minor: number, currency: Currency): number {
  return minor / 10 ** CURRENCY_DECIMALS[currency]
}

export function formatMoney(minor: number, currency: Currency): string {
  // El signo va delante del símbolo ("-$1.000", no "$-1.000").
  if (minor < 0) return `-${formatMoney(-minor, currency)}`
  const value = fromMinor(minor, currency)
  const digits = DISPLAY_DECIMALS[currency]
  if (currency === 'UF') {
    return `UF ${value.toLocaleString('es-CL', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }
  if (currency === 'PEN') {
    return `S/ ${value.toLocaleString('es-PE', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** Totales agrupados por moneda: nunca se suman monedas distintas. */
export type CurrencyTotals = Partial<Record<Currency, number>>

export function sumByCurrency<T>(
  rows: readonly T[],
  pick: (row: T) => { currency: Currency; amount: number },
): CurrencyTotals {
  const totals: CurrencyTotals = {}
  for (const row of rows) {
    const { currency, amount } = pick(row)
    totals[currency] = (totals[currency] ?? 0) + amount
  }
  return totals
}

/**
 * Lee un monto escrito por una persona o exportado de Excel/CSV.
 * - "es": punto = miles, coma = decimal ("1.234.567,89").
 * - "en": coma = miles, punto = decimal ("1,234,567.89").
 * - "auto": decide por el último separador; si hay ambiguedad (un solo separador
 *   seguido de exactamente 3 dígitos) se usa `ambiguousAs`.
 * Devuelve un string decimal normalizado ("-1234.56") listo para `toMinor`, o null.
 */
export function parseAmountText(
  input: string,
  options: { locale?: 'es' | 'en' | 'auto'; ambiguousAs?: 'thousands' | 'decimal' } = {},
): string | null {
  const { locale = 'auto', ambiguousAs = 'thousands' } = options
  let text = input.trim()
  if (!text) return null
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  text = text.replace(/^(CLP|PEN|USD|EUR|UF|US\$|S\/|\$|€)\s*/i, '').replace(/\s+/g, '')
  if (text.startsWith('-')) {
    negative = !negative
    text = text.slice(1)
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return null

  let decimalSep: '.' | ',' | null = null
  if (locale === 'es') decimalSep = ','
  else if (locale === 'en') decimalSep = '.'
  else {
    const lastDot = text.lastIndexOf('.')
    const lastComma = text.lastIndexOf(',')
    if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? '.' : ','
    else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ','
      const parts = text.split(sep)
      const tail = parts[parts.length - 1]
      if (parts.length > 2) decimalSep = null // "1.234.567": solo miles
      else if (tail.length === 3) decimalSep = ambiguousAs === 'decimal' ? sep : null
      else decimalSep = sep
    }
  }

  const thousandsSep = decimalSep === ',' ? '.' : decimalSep === '.' ? ',' : null
  let intPart = text
  let fracPart = ''
  if (decimalSep) {
    const idx = text.lastIndexOf(decimalSep)
    if (idx >= 0) {
      intPart = text.slice(0, idx)
      fracPart = text.slice(idx + 1)
    }
    if (fracPart.includes('.') || fracPart.includes(',')) return null
  }
  if (thousandsSep) {
    if (intPart.includes(decimalSep ?? '\0')) return null
    const groups = intPart.split(thousandsSep)
    if (groups.length > 1 && (groups[0].length === 0 || groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))) {
      return null
    }
    intPart = groups.join('')
  } else {
    // Sin separador decimal: todos los separadores son de miles y deben ser grupos de 3.
    const groups = intPart.split(/[.,]/)
    if (groups.length > 1 && (groups[0].length === 0 || groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3))) {
      return null
    }
    intPart = groups.join('')
  }
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null
  const normalized = `${intPart.replace(/^0+(?=\d)/, '')}${fracPart ? `.${fracPart}` : ''}`
  return negative ? `-${normalized}` : normalized
}
