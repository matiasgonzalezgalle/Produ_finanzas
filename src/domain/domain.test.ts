import { describe, expect, it } from 'vitest'
import { formatMoney, parseAmountText, sumByCurrency, toMinor } from './money'
import { formatRut, isValidRuc, isValidRut, normalizeRut } from './taxId'
import { parseBusinessDate, todayIn } from './dates'
import { computeBalance, computeDetraction, computeTax } from './documents'

describe('money', () => {
  it('convierte a unidades mínimas sin floats', () => {
    expect(toMinor('1234.56', 'USD')).toBe(123456)
    expect(toMinor('0.1', 'USD') + toMinor('0.2', 'USD')).toBe(toMinor('0.3', 'USD'))
    expect(toMinor('35.1234', 'UF')).toBe(351234)
    expect(toMinor('1500', 'CLP')).toBe(1500)
    expect(toMinor('1500.5', 'CLP')).toBe(1501)
    expect(toMinor(19.99, 'PEN')).toBe(1999)
    expect(() => toMinor('abc', 'CLP')).toThrow()
  })

  it('formatea UF y PEN sin romper', () => {
    expect(formatMoney(351234, 'UF')).toBe('UF 35,12')
    expect(formatMoney(123456, 'PEN')).toBe('S/ 1,234.56')
    expect(formatMoney(1250000, 'CLP')).toMatch(/1\.250\.000/)
    expect(formatMoney(123456, 'USD')).toMatch(/1\.234,56/)
    expect(formatMoney(-450000, 'CLP')).toBe('-$450.000')
  })

  it('nunca suma monedas distintas', () => {
    const totals = sumByCurrency(
      [
        { c: 'CLP' as const, a: 1_000_000 },
        { c: 'USD' as const, a: 50_000 },
        { c: 'CLP' as const, a: 500 },
      ],
      (r) => ({ currency: r.c, amount: r.a }),
    )
    expect(totals).toEqual({ CLP: 1_000_500, USD: 50_000 })
  })

  it('lee montos en formato chileno y anglosajón', () => {
    expect(parseAmountText('1.234.567,89')).toBe('1234567.89')
    expect(parseAmountText('1,234,567.89')).toBe('1234567.89')
    expect(parseAmountText('1,234.56')).toBe('1234.56')
    expect(parseAmountText('USD 1,250.00')).toBe('1250.00')
    expect(parseAmountText('$ 450.000')).toBe('450000')
    expect(parseAmountText('1250,5')).toBe('1250.5')
    expect(parseAmountText('(1.234)')).toBe('-1234')
    expect(parseAmountText('-720.000')).toBe('-720000')
    // Ambiguo: "35.123" es miles por defecto; en UF se pide tratarlo como decimal.
    expect(parseAmountText('35.123')).toBe('35123')
    expect(parseAmountText('35.123', { ambiguousAs: 'decimal' })).toBe('35.123')
    expect(parseAmountText('35.123', { locale: 'en' })).toBe('35.123')
    expect(parseAmountText('1e3')).toBeNull()
    expect(parseAmountText('12.34.5')).toBeNull()
    expect(parseAmountText('')).toBeNull()
  })
})

describe('tax ids', () => {
  it('valida RUT con dígito verificador', () => {
    expect(isValidRut('76.526.480-4')).toBe(true)
    expect(isValidRut('76526480-4')).toBe(true)
    expect(isValidRut('76.526.480-5')).toBe(false)
    expect(isValidRut('1-1')).toBe(false)
    expect(isValidRut('12.156.264-2')).toBe(true)
    expect(normalizeRut('77.000.000-0')).toBe(normalizeRut('77000000-0'))
    expect(formatRut('765264804')).toBe('76.526.480-4')
  })

  it('valida RUC peruano', () => {
    expect(isValidRuc('20100070970')).toBe(true)
    expect(isValidRuc('20100070971')).toBe(false)
    expect(isValidRuc('2010007097')).toBe(false)
  })
})

describe('dates', () => {
  it('rechaza fechas imposibles', () => {
    expect(parseBusinessDate('31/02/2026')).toBeNull()
    expect(parseBusinessDate('2026-02-30')).toBeNull()
    expect(parseBusinessDate('29/02/2028')).toBe('2028-02-29')
    expect(parseBusinessDate('5/3/2026')).toBe('2026-03-05')
  })

  it('usa la zona horaria del tenant, no UTC', () => {
    // 23:30 del 28 en Santiago = 02:30 UTC del 29.
    const lateEvening = new Date('2026-09-29T02:30:00Z')
    expect(todayIn('America/Santiago', lateEvening)).toBe('2026-09-28')
    expect(todayIn('UTC', lateEvening)).toBe('2026-09-29')
  })
})

describe('balances', () => {
  const base = { status: 'open' as const, totalMinor: 100_000, creditsMinor: 0, detractionMinor: 0, allocatedMinor: 0, dueDate: '2026-09-30' }

  it('calcula pendiente, parcial y pagado', () => {
    expect(computeBalance(base, '2026-09-28').paymentStatus).toBe('pendiente')
    expect(computeBalance({ ...base, allocatedMinor: 40_000 }, '2026-09-28')).toMatchObject({ pendingMinor: 60_000, paymentStatus: 'parcial' })
    expect(computeBalance({ ...base, allocatedMinor: 100_000 }, '2026-09-28').paymentStatus).toBe('pagado')
  })

  it('vence al día siguiente, no el mismo día', () => {
    expect(computeBalance(base, '2026-09-30').paymentStatus).toBe('pendiente')
    expect(computeBalance(base, '2026-10-01')).toMatchObject({ paymentStatus: 'vencido', daysOverdue: 1, aging: '1_30' })
  })

  it('descuenta notas de crédito y detracción', () => {
    const b = computeBalance({ ...base, creditsMinor: 20_000, detractionMinor: 8_000 }, '2026-09-28')
    expect(b).toMatchObject({ netMinor: 80_000, directMinor: 72_000, pendingMinor: 72_000 })
  })

  it('un documento anulado no tiene saldo', () => {
    expect(computeBalance({ ...base, status: 'void' }, '2026-12-01')).toMatchObject({ pendingMinor: 0, paymentStatus: 'anulado' })
  })

  it('impuestos y detracción', () => {
    expect(computeTax(100_000, 'CL')).toBe(19_000)
    expect(computeTax(10_000, 'PE')).toBe(1_800)
    // S/ 1,180.00 al 12% = 141.60 -> se deposita S/ 142.00
    expect(computeDetraction(118_000, 12, 2)).toBe(14_200)
  })
})
