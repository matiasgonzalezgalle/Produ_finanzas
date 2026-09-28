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
}

export type CounterpartyInput = Omit<Counterparty, 'id' | 'tenant_id'>

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
}

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
