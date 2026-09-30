// Catálogo de bancos para cuentas manuales. Los de Chile usan los mismos ids que Fintoc,
// así una cuenta manual y una conectada se reconocen igual (y muestran el mismo logo).
import type { Country } from './taxId'

export interface BankInfo {
  id: string
  name: string
  country: Country
  /** Fintoc puede conectarlo automáticamente (cuentas de empresa). */
  fintoc?: boolean
}

export const BANKS: BankInfo[] = [
  { id: 'cl_banco_de_chile', name: 'Banco de Chile', country: 'CL', fintoc: true },
  { id: 'cl_banco_estado', name: 'BancoEstado', country: 'CL', fintoc: true },
  { id: 'cl_banco_santander', name: 'Banco Santander', country: 'CL', fintoc: true },
  { id: 'cl_banco_bci', name: 'Banco BCI', country: 'CL', fintoc: true },
  { id: 'cl_banco_bci360', name: 'Banco BCI 360', country: 'CL', fintoc: true },
  { id: 'cl_banco_itau', name: 'Banco Itaú', country: 'CL', fintoc: true },
  { id: 'cl_banco_scotiabank', name: 'Banco Scotiabank', country: 'CL', fintoc: true },
  { id: 'cl_banco_bice', name: 'Banco BICE', country: 'CL', fintoc: true },
  { id: 'cl_banco_security', name: 'Banco Security', country: 'CL', fintoc: true },
  { id: 'cl_banco_falabella', name: 'Banco Falabella', country: 'CL' },
  { id: 'cl_banco_ripley', name: 'Banco Ripley', country: 'CL' },
  { id: 'cl_banco_consorcio', name: 'Banco Consorcio', country: 'CL' },
  { id: 'cl_banco_internacional', name: 'Banco Internacional', country: 'CL' },
  { id: 'cl_banco_btg', name: 'Banco BTG Pactual', country: 'CL' },
  { id: 'cl_coopeuch', name: 'Coopeuch', country: 'CL' },
  { id: 'pe_bcp', name: 'BCP (Banco de Crédito del Perú)', country: 'PE' },
  { id: 'pe_interbank', name: 'Interbank', country: 'PE' },
  { id: 'pe_bbva', name: 'BBVA Perú', country: 'PE' },
  { id: 'pe_scotiabank', name: 'Scotiabank Perú', country: 'PE' },
  { id: 'pe_banbif', name: 'BanBif', country: 'PE' },
  { id: 'pe_pichincha', name: 'Banco Pichincha', country: 'PE' },
  { id: 'pe_banco_nacion', name: 'Banco de la Nación', country: 'PE' },
  { id: 'pe_mibanco', name: 'Mibanco', country: 'PE' },
  { id: 'pe_gnb', name: 'Banco GNB', country: 'PE' },
  { id: 'pe_falabella', name: 'Banco Falabella Perú', country: 'PE' },
  { id: 'pe_citibank', name: 'Citibank Perú', country: 'PE' },
]

export const ACCOUNT_TYPES = ['Cuenta corriente', 'Cuenta de ahorro', 'Cuenta vista', 'Cuenta RUT', 'Cuenta maestra', 'Línea de crédito', 'Tarjeta de crédito']

export const bankById = (id: string | null | undefined) => BANKS.find((b) => b.id === id) ?? null
