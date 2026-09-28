// Identificadores tributarios: RUT (Chile) y RUC (Perú).

export const COUNTRIES = ['CL', 'PE'] as const
export type Country = (typeof COUNTRIES)[number]

export const TAX_ID_LABEL: Record<Country, string> = { CL: 'RUT', PE: 'RUC' }

/** "76.526.480-4" / "765264804" / "76526480-4" -> "76526480-4" */
export function normalizeRut(input: string): string {
  const clean = input.replace(/[^0-9kK]/g, '').toUpperCase()
  if (clean.length < 2) return clean
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`
}

export function rutCheckDigit(body: string): string {
  let sum = 0
  let factor = 2
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * factor
    factor = factor === 7 ? 2 : factor + 1
  }
  const rest = 11 - (sum % 11)
  if (rest === 11) return '0'
  if (rest === 10) return 'K'
  return String(rest)
}

export function isValidRut(input: string): boolean {
  const normalized = normalizeRut(input)
  const match = /^(\d{1,8})-([\dK])$/.exec(normalized)
  if (!match) return false
  const [, body, dv] = match
  if (Number(body) < 100000) return false
  return rutCheckDigit(body) === dv
}

/** "76526480-4" -> "76.526.480-4" */
export function formatRut(input: string): string {
  const normalized = normalizeRut(input)
  const [body, dv] = normalized.split('-')
  if (!body || dv === undefined) return input
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`
}

export function normalizeRuc(input: string): string {
  return input.replace(/\D/g, '')
}

const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]

export function isValidRuc(input: string): boolean {
  const ruc = normalizeRuc(input)
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false
  const sum = RUC_WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(ruc[i]), 0)
  const check = (11 - (sum % 11)) % 10
  return check === Number(ruc[10])
}

export function normalizeTaxId(input: string, country: Country): string {
  return country === 'CL' ? normalizeRut(input) : normalizeRuc(input)
}

export function isValidTaxId(input: string, country: Country): boolean {
  return country === 'CL' ? isValidRut(input) : isValidRuc(input)
}

export function formatTaxId(input: string, country: Country): string {
  return country === 'CL' ? formatRut(input) : normalizeRuc(input)
}
