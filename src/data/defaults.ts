import type { ModuleSettingsInput } from './types'

/** Preferencias cuando la empresa aún no guardó las suyas (igual que los valores de la base de datos). */
export const DEFAULT_MODULE_SETTINGS: ModuleSettingsInput = {
  require_approval: true,
  require_allocation: false,
  require_purchase_order: false,
  allow_partial_payments: true,
  default_due_days: null,
  po_prefix: 'OC-',
  po_next_number: 1,
  po_approval_admin_only: true,
}
