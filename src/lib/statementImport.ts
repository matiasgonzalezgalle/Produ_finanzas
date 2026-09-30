// Lectura de cartolas bancarias (Excel o CSV) de cualquier banco de Chile o Perú.
// Detecta la fila de encabezados y las columnas (fecha, descripción, cargo/abono o monto, saldo,
// referencia); el usuario puede corregir la asignación antes de importar.
import { CURRENCY_DECIMALS, type Currency } from '../domain/money'
import { isValidRuc, isValidRut, type Country } from '../domain/taxId'

export type Cell = string | number | boolean | Date | null | undefined
export type Grid = Cell[][]

export interface ColumnMapping {
  headerRow: number
  date: number | null
  description: number | null
  reference: number | null
  /** Una sola columna con signo (o con cargos positivos si invertSign). */
  amount: number | null
  /** Cargo y abono en columnas separadas. */
  debit: number | null
  credit: number | null
  balance: number | null
  dateOrder: 'dmy' | 'mdy' | 'ymd'
  invertSign: boolean
}

export interface StatementRow {
  key: string
  post_date: string
  /** Unidad mínima de la moneda; positivo = abono, negativo = cargo. */
  amount: number
  description: string
  reference: string | null
  balance: number | null
  counterparty_tax_id: string | null
  /** Fila del archivo (1 = primera), para mostrar errores. */
  line: number
}

export interface ParseResult {
  rows: StatementRow[]
  skipped: { line: number; reason: string }[]
  closingBalance: number | null
  firstDate: string | null
  lastDate: string | null
}

export const normalizeText = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

const cellText = (c: Cell) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c)).trim()

// ---------------------------------------------------------------------------
// Detección de encabezados y columnas
// ---------------------------------------------------------------------------
const KEYWORDS = {
  date: ['fecha', 'fec.', 'f. operacion', 'f.operacion', 'fec operacion', 'date', 'dia'],
  balance: ['saldo', 'balance'],
  debit: ['cargo', 'debito', 'retiro', 'giro', 'egreso', 'salida', 'debe', 'cheques y otros cargos'],
  credit: ['abono', 'credito', 'deposito', 'ingreso', 'entrada', 'haber', 'depositos y otros abonos'],
  amount: ['monto', 'importe', 'valor', 'amount', 'cargo/abono', 'cargo / abono'],
  description: ['descripcion', 'detalle', 'concepto', 'glosa', 'movimiento', 'transaccion', 'narrativa', 'beneficiario'],
  reference: ['n° operacion', 'nro operacion', 'nro. operacion', 'numero de operacion', 'num. operacion', 'n° de operacion', 'referencia', 'n° documento', 'nro documento', 'nro. documento', 'documento', 'n° doc', 'serie', 'codigo', 'operacion', 'numero', 'n°', 'nro'],
} as const

type Field = keyof typeof KEYWORDS

function headerMatches(header: string, field: Field) {
  const h = normalizeText(header)
  if (!h) return false
  if (field === 'amount' && h.includes('cargo') && h.includes('abono')) return true
  if (field === 'debit' || field === 'credit') {
    // "Cargo/Abono" es una sola columna con signo.
    if (h.includes('cargo') && h.includes('abono')) return false
  }
  if (field === 'date') return h.startsWith('fecha') || h.startsWith('fec') || h === 'date' || h === 'dia'
  // "Fecha valor", "Fecha proceso"… son fechas, nunca montos ni descripciones.
  if (h.startsWith('fec')) return false
  return KEYWORDS[field].some((k) => h === k || h.includes(k))
}

function scoreHeaderRow(row: Cell[]) {
  const fields = new Set<Field>()
  for (const c of row) {
    const text = cellText(c)
    if (!text || text.length > 60) continue
    for (const f of Object.keys(KEYWORDS) as Field[]) if (headerMatches(text, f)) fields.add(f)
  }
  const hasAmount = fields.has('amount') || fields.has('debit') || fields.has('credit')
  return fields.has('date') && hasAmount ? fields.size + 2 : fields.size
}

/** Primera fila con aspecto de encabezado (fecha + monto) dentro de las primeras 40. */
export function detectHeaderRow(grid: Grid): number {
  let best = -1
  let bestScore = 1
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const s = scoreHeaderRow(grid[i] ?? [])
    if (s > bestScore) {
      best = i
      bestScore = s
    }
  }
  return best
}

export function detectMapping(grid: Grid): ColumnMapping {
  const headerRow = detectHeaderRow(grid)
  const headers = (grid[headerRow] ?? []).map(cellText)
  const used = new Set<number>()
  const find = (field: Field, prefer?: (h: string) => boolean): number | null => {
    const candidates = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => !used.has(i) && headerMatches(h, field))
    const pick = (prefer && candidates.find(({ h }) => prefer(normalizeText(h)))) || candidates[0]
    if (!pick) return null
    used.add(pick.i)
    return pick.i
  }
  const date = find('date', (h) => h.includes('operacion') || h === 'fecha')
  // "Fecha valor" y similares no se usan como fecha principal si hay otra.
  const balance = find('balance', (h) => h.includes('contable') || h === 'saldo')
  const amount = find('amount')
  const debit = amount === null ? find('debit') : null
  const credit = amount === null ? find('credit') : null
  const description = find('description', (h) => h.includes('descripcion') || h.includes('detalle') || h.includes('glosa'))
  const reference = find('reference')
  const mapping: ColumnMapping = { headerRow, date, description, reference, amount, debit, credit, balance, dateOrder: 'dmy', invertSign: false }
  mapping.dateOrder = detectDateOrder(grid, mapping)
  return mapping
}

function detectDateOrder(grid: Grid, m: ColumnMapping): ColumnMapping['dateOrder'] {
  if (m.date === null) return 'dmy'
  let dmy = 0
  let mdy = 0
  for (const row of grid.slice(m.headerRow + 1, m.headerRow + 200)) {
    const text = cellText(row?.[m.date])
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(text)) return 'ymd'
    const parts = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/)
    if (!parts) continue
    if (Number(parts[1]) > 12) dmy++
    if (Number(parts[2]) > 12) mdy++
  }
  return mdy > dmy ? 'mdy' : 'dmy'
}

// ---------------------------------------------------------------------------
// Fechas y montos
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
  jan: 1, apr: 4, aug: 8, dec: 12,
}

const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  if (y < 1990 || y > 2100) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parseDate(cell: Cell, order: ColumnMapping['dateOrder'] = 'dmy'): string | null {
  if (cell instanceof Date) return iso(cell.getFullYear(), cell.getMonth() + 1, cell.getDate())
  if (typeof cell === 'number') {
    // Número de serie de Excel (días desde 1899-12-30).
    if (cell < 20000 || cell > 80000) return null
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(cell) * 86_400_000)
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  const text = normalizeText(cellText(cell))
  if (!text) return null
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/)
  if (m) return order === 'mdy' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1])
  m = text.match(/^(\d{1,2})[-/. ]([a-z]{3})[a-z]*\.?[-/. ](\d{2,4})/)
  if (m && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1])
  return null
}

/** Monto de la cartola en la unidad mínima de la moneda ("1.234.567", "1,234.56", "(1.500)", "S/ -20,00"…). */
export function parseAmount(cell: Cell, currency: Currency): number | null {
  const decimals = CURRENCY_DECIMALS[currency]
  const factor = 10 ** decimals
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.round(cell * factor) : null
  let text = cellText(cell).replace(/ /g, ' ')
  if (!text) return null
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  if (/-\s*$/.test(text)) negative = true
  if (/^\s*-/.test(text) || /^[^\d]*-/.test(text)) negative = true
  text = text.replace(/[^\d.,]/g, '')
  if (!text || !/\d/.test(text)) return null
  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  let intPart = text
  let fracPart = ''
  if (lastDot >= 0 && lastComma >= 0) {
    const sep = lastDot > lastComma ? '.' : ','
    const idx = Math.max(lastDot, lastComma)
    intPart = text.slice(0, idx).replace(/[.,]/g, '')
    fracPart = text.slice(idx + 1)
    void sep
  } else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null
    if (sep) {
      const parts = text.split(sep)
      const tail = parts[parts.length - 1]
      // Un solo separador seguido de 1–2 dígitos (o de 3 en monedas con decimales raras) es decimal.
      const isDecimal = parts.length === 2 && (tail.length !== 3 || (decimals > 0 && parts[0] === '0'))
      if (isDecimal) {
        intPart = parts[0]
        fracPart = tail
      } else {
        intPart = parts.join('')
      }
    }
  }
  const value = Number(`${intPart || '0'}.${fracPart || '0'}`)
  if (!Number.isFinite(value)) return null
  const minor = Math.round(value * factor)
  return negative ? -minor : minor
}

// ---------------------------------------------------------------------------
// RUT / RUC en la descripción
// ---------------------------------------------------------------------------
export function extractTaxId(text: string, country: Country): string | null {
  const ruts = [...text.matchAll(/\b(\d{1,2}\.?\d{3}\.?\d{3})-?([\dkK])\b/g)].map((m) => `${m[1].replace(/\./g, '')}-${m[2].toUpperCase()}`).filter((r) => isValidRut(r))
  const rucs = [...text.matchAll(/\b((?:10|15|16|17|20)\d{9})\b/g)].map((m) => m[1]).filter((r) => isValidRuc(r))
  return (country === 'PE' ? rucs[0] ?? ruts[0] : ruts[0] ?? rucs[0]) ?? null
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------
/** Hash corto y estable (cyrb53) para identificar el movimiento sin guardar el texto completo. */
function hash(text: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function parseStatement(grid: Grid, m: ColumnMapping, currency: Currency, country: Country): ParseResult {
  const rows: StatementRow[] = []
  const skipped: ParseResult['skipped'] = []
  const seen = new Map<string, number>()
  if (m.date === null) return { rows, skipped: [{ line: 0, reason: 'Elige la columna de fecha' }], closingBalance: null, firstDate: null, lastDate: null }
  if (m.amount === null && m.debit === null && m.credit === null) {
    return { rows, skipped: [{ line: 0, reason: 'Elige la columna de monto o las de cargo y abono' }], closingBalance: null, firstDate: null, lastDate: null }
  }
  for (let i = m.headerRow + 1; i < grid.length; i++) {
    const row = grid[i] ?? []
    const line = i + 1
    if (row.every((c) => cellText(c) === '')) continue
    const date = parseDate(row[m.date], m.dateOrder)
    if (!date) {
      // Totales, saldos iniciales y notas al pie no tienen fecha.
      skipped.push({ line, reason: 'Sin fecha válida' })
      continue
    }
    let amount: number | null
    if (m.amount !== null) {
      amount = parseAmount(row[m.amount], currency)
      if (amount !== null && m.invertSign) amount = -amount
    } else {
      const debit = m.debit !== null ? parseAmount(row[m.debit], currency) : null
      const credit = m.credit !== null ? parseAmount(row[m.credit], currency) : null
      amount = debit === null && credit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0)
    }
    if (amount === null || amount === 0) {
      skipped.push({ line, reason: amount === 0 ? 'Monto cero' : 'Sin monto' })
      continue
    }
    const description = m.description !== null ? cellText(row[m.description]) : ''
    const reference = m.reference !== null ? cellText(row[m.reference]) || null : null
    const balance = m.balance !== null ? parseAmount(row[m.balance], currency) : null
    const base = `${date}|${amount}|${normalizeText(description)}|${reference ?? ''}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    rows.push({
      key: `${hash(base)}${n > 1 ? `#${n}` : ''}`,
      post_date: date,
      amount,
      description: description.slice(0, 500),
      reference,
      balance,
      counterparty_tax_id: extractTaxId(`${description} ${reference ?? ''}`, country),
      line,
    })
  }
  const dates = rows.map((r) => r.post_date).sort()
  const firstDate = dates[0] ?? null
  const lastDate = dates[dates.length - 1] ?? null
  // Saldo final: el del movimiento más reciente (la cartola puede venir en orden ascendente o descendente).
  const withBalance = rows.filter((r) => r.balance !== null)
  let closingBalance: number | null = null
  if (withBalance.length) {
    const descending = rows.length > 1 && rows[0].post_date > rows[rows.length - 1].post_date
    const latest = withBalance.filter((r) => r.post_date === lastDate)
    const pick = latest.length ? (descending ? latest[0] : latest[latest.length - 1]) : descending ? withBalance[0] : withBalance[withBalance.length - 1]
    closingBalance = pick.balance
  }
  return { rows, skipped, closingBalance, firstDate, lastDate }
}

/** Lee un archivo .xlsx, .xls o .csv y devuelve sus hojas como grillas de celdas. */
export async function readStatementFile(file: File): Promise<{ sheets: { name: string; grid: Grid }[] }> {
  const XLSX = await import('xlsx')
  const data = await file.arrayBuffer()
  const isCsv = /\.(csv|txt)$/i.test(file.name)
  const workbook = isCsv
    ? XLSX.read(new TextDecoder(detectEncoding(new Uint8Array(data))).decode(data), { type: 'string', raw: true })
    : XLSX.read(data, { type: 'array', cellDates: false })
  return {
    sheets: workbook.SheetNames.map((name) => ({
      name,
      grid: XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }),
    })),
  }
}

/** Los CSV de algunos bancos vienen en Latin-1 (tildes rotas si se leen como UTF-8). */
function detectEncoding(bytes: Uint8Array) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}
