// Catálogo de módulos que el administrador de la plataforma activa por empresa.
import type { ModuleKey } from '../data'

export interface ModuleInfo {
  key: ModuleKey
  label: string
  description: string
  group: 'Operación' | 'Complementos' | 'Integraciones'
  /** Módulos que necesita para funcionar. */
  requires?: ModuleKey[]
  /** Solo para empresas de este país. */
  country?: 'CL'
}

export const MODULES: ModuleInfo[] = [
  { key: 'cuentas_por_pagar', label: 'Cuentas por pagar', description: 'Documentos de proveedores, aprobación, gestión de pagos y pagos.', group: 'Operación' },
  { key: 'cuentas_por_cobrar', label: 'Cuentas por cobrar', description: 'Documentos a clientes y cobros.', group: 'Operación' },
  { key: 'tesoreria', label: 'Tesorería', description: 'Posición neta, antigüedad y vencimientos de CxP y CxC.', group: 'Operación' },
  { key: 'ordenes_compra', label: 'Órdenes de compra', description: 'OC emitidas a proveedores y recibidas de clientes, con saldo por facturar.', group: 'Complementos' },
  { key: 'cobranza', label: 'Cobranza', description: 'Cartera, ficha de cobranza, promesas de pago y recordatorios programados.', group: 'Complementos', requires: ['cuentas_por_cobrar'] },
  { key: 'portal', label: 'Portal financiero', description: 'Portal para que clientes y proveedores vean sus documentos y pagos.', group: 'Complementos' },
  { key: 'conciliacion', label: 'Conciliación bancaria', description: 'Cartolas con Fintoc (Chile) o importadas en Excel/CSV (Chile y Perú), conciliadas contra pagos y cobros.', group: 'Integraciones' },
  { key: 'sii', label: 'Documentos del SII', description: 'Compras y ventas del Registro de Compras y Ventas vía Fintoc.', group: 'Integraciones', country: 'CL' },
  { key: 'mercadopago', label: 'MercadoPago', description: 'Links de pago y cobros automáticos.', group: 'Integraciones', requires: ['cuentas_por_cobrar'] },
]

export const moduleLabel = (key: ModuleKey) => MODULES.find((m) => m.key === key)?.label ?? key

// Módulos de la empresa seleccionada (lo actualiza TenantProvider) para helpers sin hooks.
let active: ModuleKey[] = MODULES.map((m) => m.key)
export function setActiveModules(modules: ModuleKey[]) {
  active = modules
}
export function isModuleActive(key: ModuleKey) {
  return active.includes(key)
}
