import type { Currency } from '../domain/money'
import type { Country } from '../domain/taxId'
import type { DocumentDirection, DocumentStatus, DocumentTypeCode } from '../domain/documents'

export type MemberRole = 'owner' | 'admin' | 'finance' | 'viewer'

export interface Tenant {
  id: string
  name: string
  legal_name: string | null
  tax_id: string | null
  country: Country
  base_currency: Currency
  timezone: string
  role: MemberRole
  portal_enabled: boolean
  portal_message: string | null
}

export interface Counterparty {
  id: string
  tenant_id: string
  name: string
  legal_name: string | null
  country: string
  tax_id: string | null
  is_supplier: boolean
  is_customer: boolean
  tags: string[]
  email: string | null
  phone: string | null
  address: string | null
  default_currency: Currency | null
  payment_terms_days: number | null
  notes: string | null
  /** Link propio del portal financiero (/portal/{slug}); lo asigna la base de datos. */
  portal_slug?: string | null
}

export type CounterpartyInput = Omit<Counterparty, 'id' | 'tenant_id' | 'portal_slug'>

export interface Contact {
  id: string
  tenant_id: string
  counterparty_id: string
  counterparty_name?: string
  name: string
  position: string | null
  email: string | null
  phone: string | null
}

export type ContactInput = Omit<Contact, 'id' | 'tenant_id' | 'counterparty_name'>

export type PaymentStatusDb = 'anulado' | 'borrador' | 'aplicada' | 'pagado' | 'parcial' | 'vencido' | 'pendiente'

/** Fila de public.document_balances */
export interface DocumentRow {
  id: string
  tenant_id: string
  direction: DocumentDirection
  counterparty_id: string
  counterparty_name: string
  counterparty_tax_id: string | null
  doc_type: DocumentTypeCode
  folio: string
  currency: Currency
  net_amount: number
  exempt_amount: number
  tax_amount: number
  total_amount: number
  issue_date: string
  due_date: string | null
  status: DocumentStatus
  applies_to_id: string | null
  detraction_rate: number
  detraction_amount: number
  detraction_status: 'no_aplica' | 'pendiente' | 'depositada' | 'observada'
  description: string | null
  credits_amount: number
  paid_amount: number
  net_total: number
  pending_amount: number
  payment_status: PaymentStatusDb
  days_overdue: number
  scheduled_payment_date: string | null
  attachment_count: number
  approval_status: ApprovalStatus
  approved_by: string | null
  approved_at: string | null
  rejection_reason: string | null
  /** Monto a distribuir contablemente (neto + exento si hay impuesto; si no, el total). */
  allocation_base: number
  allocated_amount: number
  created_at: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface DocumentInput {
  direction: DocumentDirection
  counterparty_id: string
  doc_type: DocumentTypeCode
  folio: string
  currency: Currency
  net_amount: number
  exempt_amount: number
  tax_amount: number
  total_amount: number
  issue_date: string
  due_date: string | null
  status: DocumentStatus
  applies_to_id: string | null
  detraction_rate: number
  detraction_amount: number
  detraction_status: DocumentRow['detraction_status']
  description: string | null
  scheduled_payment_date: string | null
}

export interface PaymentAllocation {
  document_id: string
  amount: number
  folio?: string
}

export interface Payment {
  id: string
  tenant_id: string
  direction: 'in' | 'out'
  counterparty_id: string | null
  counterparty_name: string | null
  currency: Currency
  amount: number
  paid_on: string
  method: string
  reference: string | null
  notes: string | null
  source: string
  status: 'confirmed' | 'void'
  allocations: PaymentAllocation[]
  /** Momento en que se registró (no la fecha del pago). */
  created_at?: string
}

export interface PaymentInput {
  direction: 'in' | 'out'
  counterparty_id: string | null
  currency: Currency
  amount: number
  paid_on: string
  method: string
  reference: string | null
  notes: string | null
  allocations: PaymentAllocation[]
}

export interface IntegrationConnection {
  id: string
  provider: 'mercadopago'
  status: 'active' | 'disabled' | 'error'
  public_config: {
    nickname?: string
    site_id?: string
    currency?: Currency
    token_last4?: string
    sandbox?: boolean
  }
  last_event_at: string | null
  last_error: string | null
}

export interface Attachment {
  id: string
  document_id: string
  storage_path: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export interface Member {
  user_id: string
  role: MemberRole
  full_name: string | null
  email: string | null
  created_at: string
}

export interface TenantInput {
  name: string
  legal_name: string | null
  tax_id: string | null
  portal_enabled: boolean
  portal_message: string | null
}

// ---------------------------------------------------------------------------
// Portal financiero
// ---------------------------------------------------------------------------
/** Correo autorizado para ver el portal de una contraparte (vista interna). */
export interface PortalAccess {
  id: string
  counterparty_id: string
  /** Acceso por correo (código OTP al correo) o por código entregado a mano. */
  kind: 'email' | 'code'
  email: string | null
  /** Para accesos con código: a quién corresponde (ej. "Juan · bodega"). */
  label: string | null
  /** Últimos 2 caracteres del código, para reconocerlo. */
  code_hint: string | null
  expires_at: string | null
  enabled: boolean
  last_access_at: string | null
  created_at: string
}

/** Empresa + contraparte a la que el usuario externo tiene acceso. */
export interface PortalAccount {
  access_id: string
  tenant_id: string
  tenant_name: string
  counterparty_id: string
  counterparty_name: string
  is_supplier: boolean
  is_customer: boolean
  portal_slug: string | null
}

export interface PortalPublicInfo {
  tenant_name: string
  counterparty_name: string
  message: string | null
}

export interface PortalDocument {
  id: string
  direction: 'payable' | 'receivable'
  doc_type: string
  folio: string
  currency: Currency
  total_amount: number
  paid_amount: number
  pending_amount: number
  issue_date: string
  due_date: string | null
  scheduled_payment_date: string | null
  payment_status: PaymentStatusDb
  days_overdue: number
  detraction_amount: number
  detraction_status: string
  attachments: { id: string; file_name: string; storage_path: string; size_bytes: number | null }[]
  payment_url: string | null
}

export interface PortalPayment {
  id: string
  direction: 'in' | 'out'
  currency: Currency
  amount: number
  paid_on: string
  method: string
  reference: string | null
  folios: string[]
}

export interface PortalSnapshot {
  tenant: { name: string; tax_id: string | null; country: Country; message: string | null }
  counterparty: { name: string; legal_name: string | null; tax_id: string | null; country: string; is_supplier: boolean; is_customer: boolean; email: string | null; phone: string | null; address: string | null }
  documents: PortalDocument[]
  payments: PortalPayment[]
  bank_accounts: { bank_name: string; account_type: string | null; account_number: string; holder_name: string | null; holder_tax_id: string | null; email: string | null; currency: Currency | null }[]
}

export interface BankAccount {
  id: string
  counterparty_id: string
  bank_name: string
  account_type: string | null
  account_number: string
  holder_name: string | null
  holder_tax_id: string | null
  email: string | null
  currency: Currency | null
}

export type BankAccountInput = Omit<BankAccount, 'id'>

export interface AccountingCategory {
  id: string
  code: string | null
  name: string
  kind: 'expense' | 'income' | 'both'
  active: boolean
}

export interface CostCenter {
  id: string
  code: string | null
  name: string
  active: boolean
}

export interface AllocationLine {
  category_id: string
  cost_center_id: string | null
  description: string | null
  amount: number
}

export interface DocumentComment {
  id: string
  visibility: 'internal' | 'shared'
  author_kind: 'member' | 'counterparty'
  author_id: string | null
  author_name: string | null
  body: string
  created_at: string
}

export interface PortalComment {
  id: string
  author_kind: 'member' | 'counterparty'
  author_name: string | null
  body: string
  created_at: string
}
