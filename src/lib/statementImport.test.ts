import { describe, expect, it } from 'vitest'
import { detectMapping, extractTaxId, parseAmount, parseDate, parseStatement, type Grid } from './statementImport'

describe('lectura de cartolas', () => {
  it('montos en formato chileno, peruano y con signos', () => {
    expect(parseAmount('1.234.567', 'CLP')).toBe(1234567)
    expect(parseAmount('$ -12.490', 'CLP')).toBe(-12490)
    expect(parseAmount('1,234.56', 'PEN')).toBe(123456)
    expect(parseAmount('S/ -20,00', 'PEN')).toBe(-2000)
    expect(parseAmount('(1,500.00)', 'USD')).toBe(-150000)
    expect(parseAmount('1.500,75', 'USD')).toBe(150075)
    expect(parseAmount('2,500', 'PEN')).toBe(250000)
    expect(parseAmount('150-', 'CLP')).toBe(-150)
    expect(parseAmount(1234.5, 'PEN')).toBe(123450)
    expect(parseAmount('', 'CLP')).toBeNull()
  })

  it('fechas de texto, con mes en palabras y de Excel', () => {
    expect(parseDate('05/09/2026')).toBe('2026-09-05')
    expect(parseDate('05-09-26')).toBe('2026-09-05')
    expect(parseDate('2026-09-05')).toBe('2026-09-05')
    expect(parseDate('05-SET-2026')).toBe('2026-09-05')
    expect(parseDate('5 ene 2026')).toBe('2026-01-05')
    expect(parseDate(46270)).toBe('2026-09-05')
    expect(parseDate('09/25/2026', 'mdy')).toBe('2026-09-25')
    expect(parseDate('Saldo inicial')).toBeNull()
    expect(parseDate('31/02/2026')).toBeNull()
  })

  it('RUT o RUC válidos en la descripción', () => {
    expect(extractTaxId('TRANSF DE 76.086.428-5 NUBE FILMS', 'CL')).toBe('76086428-5')
    expect(extractTaxId('TRANSF 76.086.428-4 (dígito malo)', 'CL')).toBeNull()
    expect(extractTaxId('PAGO PROV 20100070970 SUPERMERCADOS', 'PE')).toBe('20100070970')
  })

  it('cartola tipo Chile: encabezado en la fila 4, cargos y abonos separados, orden descendente', () => {
    const grid: Grid = [
      ['Cartola histórica'], ['Cuenta corriente 123'], [],
      ['Fecha', 'Descripción', 'N° Documento', 'Cargos (CLP)', 'Abonos (CLP)', 'Saldo (CLP)'],
      ['28/09/2026', 'Transf. de 78.171.372-4 Canal Uno', '881', '', '2.950.000', '10.500.000'],
      ['27/09/2026', 'Pago proveedor', '880', '238.000', '', '7.550.000'],
      ['27/09/2026', 'Pago proveedor', '880', '238.000', '', '7.312.000'],
      ['', 'Total', '', '476.000', '2.950.000', ''],
    ]
    const m = detectMapping(grid)
    expect(m).toMatchObject({ headerRow: 3, date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5, amount: null })
    const r = parseStatement(grid, m, 'CLP', 'CL')
    expect(r.rows.map((x) => x.amount)).toEqual([2950000, -238000, -238000])
    expect(r.rows[0].counterparty_tax_id).toBe('78171372-4')
    expect(new Set(r.rows.map((x) => x.key)).size).toBe(3)
    expect(r.closingBalance).toBe(10500000)
    expect(r.skipped).toEqual([{ line: 8, reason: 'Sin fecha válida' }])
  })

  it('cartola tipo Perú: una columna de monto con signo y fecha valor', () => {
    const grid: Grid = [
      ['Fecha operación', 'Fecha valor', 'Descripción operación', 'Monto', 'Saldo', 'N° operación'],
      ['01/09/2026', '01/09/2026', 'PAGO 20100070970', '-1,180.00', '8,820.00', '000123'],
      ['02/09/2026', '02/09/2026', 'ABONO CLIENTE', '3,540.00', '12,360.00', '000124'],
    ]
    const m = detectMapping(grid)
    expect(m).toMatchObject({ date: 0, description: 2, amount: 3, balance: 4, reference: 5 })
    const r = parseStatement(grid, m, 'PEN', 'PE')
    expect(r.rows.map((x) => x.amount)).toEqual([-118000, 354000])
    expect(r.rows[0].counterparty_tax_id).toBe('20100070970')
    expect(r.closingBalance).toBe(1236000)
    expect(r.firstDate).toBe('2026-09-01')
  })
})

describe('archivos Excel reales', () => {
  it('lee .xlsx y .xls con fechas y números nativos de Excel', async () => {
    const XLSX = await import('xlsx')
    const { readStatementFile } = await import('./statementImport')
    const aoa = [
      ['BCP - Movimientos de cuenta'], [],
      ['Fecha', 'Fecha valuta', 'Descripción operación', 'Monto', 'Saldo', 'Operación - Número'],
      [new Date(2026, 8, 1), new Date(2026, 8, 1), 'PAGO PROV 20100070970', -1180, 8820, '0012'],
      [new Date(2026, 8, 2), new Date(2026, 8, 2), 'TRAN.CTAS.TERC.BM CLIENTE', 3540.5, 12360.5, '0013'],
    ]
    for (const bookType of ['xlsx', 'xls'] as const) {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Movimientos')
      const buf = XLSX.write(wb, { type: 'array', bookType: bookType === 'xls' ? 'biff8' : 'xlsx' })
      const file = new File([buf], `cartola.${bookType}`)
      const { sheets } = await readStatementFile(file)
      const m = detectMapping(sheets[0].grid)
      expect(m).toMatchObject({ headerRow: 2, date: 0, description: 2, amount: 3, balance: 4, reference: 5 })
      const r = parseStatement(sheets[0].grid, m, 'PEN', 'PE')
      expect(r.rows.map((x) => [x.post_date, x.amount])).toEqual([['2026-09-01', -118000], ['2026-09-02', 354050]])
      expect(r.closingBalance).toBe(1236050)
    }
  })

  it('lee CSV con punto y coma y tildes en Latin-1', async () => {
    const { readStatementFile } = await import('./statementImport')
    const text = 'Fecha;Descripción;Cargo;Abono;Saldo\n01-09-2026;Comisión mantención;12.490;;1.000.000\n02-09-2026;Transf. recibida;;250.000;1.250.000\n'
    const latin1 = Uint8Array.from([...text].map((c) => c.charCodeAt(0)))
    const { sheets } = await readStatementFile(new File([latin1], 'cartola.csv'))
    const m = detectMapping(sheets[0].grid)
    const r = parseStatement(sheets[0].grid, m, 'CLP', 'CL')
    expect(r.rows.map((x) => [x.description, x.amount])).toEqual([['Comisión mantención', -12490], ['Transf. recibida', 250000]])
  })
})
