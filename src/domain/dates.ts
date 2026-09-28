// Fechas de negocio como strings ISO "YYYY-MM-DD", siempre en la zona horaria del tenant.

export const DEFAULT_TIMEZONE: Record<'CL' | 'PE', string> = {
  CL: 'America/Santiago',
  PE: 'America/Lima',
}

/** Fecha de hoy en la zona horaria indicada (no en UTC). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Acepta "YYYY-MM-DD", "DD/MM/YYYY" o "DD-MM-YYYY" (formato chileno/peruano).
 * Rechaza fechas imposibles como 31/02. Devuelve ISO o null.
 */
export function parseBusinessDate(input: string): string | null {
  const text = input.trim()
  let year: number
  let month: number
  let day: number
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (m) {
    ;[year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  } else {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text)
    if (!m) return null
    ;[day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  if (!isRealDate(year, month, day)) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Días entre dos fechas ISO (b - a). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (iso: string) => {
    const [y, mo, d] = iso.split('-').map(Number)
    return Date.UTC(y, mo - 1, d)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}
