import { describe, expect, it } from 'vitest'
import { bankLogoFile } from './BankLogo'

describe('logo del banco', () => {
  it('reconoce por id de Fintoc o por nombre', () => {
    expect(bankLogoFile({ id: 'cl_banco_santander' })).toBe('santander')
    expect(bankLogoFile({ id: 'cl_banco_estado', name: 'BancoEstado' })).toBe('estado')
    expect(bankLogoFile({ name: 'Banco de Chile' })).toBe('banco-de-chile')
    expect(bankLogoFile({ name: 'Banco Santander Chile' })).toBe('santander')
    expect(bankLogoFile({ name: 'Banco BCI 360' })).toBe('bci')
    expect(bankLogoFile({ name: 'Banco Itaú' })).toBe('itau')
    expect(bankLogoFile({ id: 'cl_banco_bice' })).toBe('bice')
    expect(bankLogoFile({ name: 'Banco Falabella' })).toBeNull()
    expect(bankLogoFile({})).toBeNull()
  })
})
