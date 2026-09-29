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
  /** Cobranza: límite de crédito (moneda base), responsable y pausa de recordatorios. */
  credit_limit?: number | null
  collection_owner?: string | null
  collection_paused?: boolean
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
  /** Recibe los correos de cobranza. */
  is_collection_contact?: boolean
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
  payment_stage: 'requested' | 'scheduled' | null
  payment_stage_at: string | null
  /** Gestión de pago (solo CxP): sin gestionar (null), solicitado, programado o realizado. */
  payment_management: PaymentManagement | null
  purchase_order_id: string | null
  purchase_order_number: string | null
  /** Origen: 'sii' si se importó del SII; null si se registró a mano. */
  external_source?: string | null
}

export type PaymentManagement = 'requested' | 'scheduled' | 'paid'

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
  purchase_order_id: string | null
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

export type IntegrationProvider = 'mercadopago' | 'fintoc_sii'

export interface IntegrationConnection {
  id: string
  provider: IntegrationProvider
  status: 'active' | 'disabled' | 'error'
  public_config: {
    nickname?: string
    site_id?: string
    currency?: Currency
    token_last4?: string
    sandbox?: boolean
    /** SII (Fintoc): RUT conectado y última sincronización. */
    holder_id?: string | null
    mode?: string
    connected_at?: string
    last_sync_at?: string
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
  approval_status: ApprovalStatus
  rejection_reason: string | null
  payment_management: PaymentManagement | null
  purchase_order_number: string | null
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
  purchase_orders: PortalPurchaseOrder[]
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

// ---------------------------------------------------------------------------
// Administradores de cuentas por pagar / por cobrar
// ---------------------------------------------------------------------------
export interface ModuleSettings {
  direction: 'payable' | 'receivable'
  /** CxP: si es false, los documentos nuevos quedan aprobados. */
  require_approval: boolean
  /** CxP: exigir distribución contable completa para aprobar. */
  require_allocation: boolean
  /** CxP: exigir OC para aprobar. CxC: exigir OC del cliente para emitir. */
  require_purchase_order: boolean
  allow_partial_payments: boolean
  default_due_days: number | null
  /** OC emitidas (CxP): prefijo y próximo correlativo. */
  po_prefix: string
  po_next_number: number
  /** CxP: solo owner/admin aprueban órdenes de compra. */
  po_approval_admin_only: boolean
}

export type ModuleSettingsInput = Omit<ModuleSettings, 'direction'>

export interface DocumentTypeSetting {
  doc_type: DocumentTypeCode
  can_create: boolean
  can_pay: boolean
}

export interface PaymentMethod {
  id: string
  direction: 'in' | 'out'
  name: string
  active: boolean
  is_default: boolean
  position: number
}

export type PaymentMethodInput = Omit<PaymentMethod, 'id'>

// ---------------------------------------------------------------------------
// Órdenes de compra (CxP: emitidas a proveedores · CxC: recibidas de clientes)
// ---------------------------------------------------------------------------
export type PurchaseOrderStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'closed' | 'void'
export type PurchaseOrderBilling = 'sin_documentos' | 'parcial' | 'completa'

export interface PurchaseOrderLine {
  description: string
  quantity: number
  unit_price: number
  discount: number
  amount: number
}

/** Fila de public.purchase_order_balances */
export interface PurchaseOrderRow {
  id: string
  direction: 'payable' | 'receivable'
  counterparty_id: string
  counterparty_name: string
  counterparty_tax_id: string | null
  number: string
  status: PurchaseOrderStatus
  currency: Currency
  issue_date: string
  delivery_date: string | null
  net_amount: number
  exempt_amount: number
  tax_amount: number
  total_amount: number
  category_id: string | null
  category_name: string | null
  cost_center_id: string | null
  cost_center_name: string | null
  requester: string | null
  payment_method: string | null
  payment_terms_days: number | null
  description: string | null
  notes: string | null
  rejection_reason: string | null
  approved_by: string | null
  approved_at: string | null
  sent_at: string | null
  sent_to: string | null
  created_at: string
  document_count: number
  invoiced_amount: number
  remaining_amount: number
  paid_amount: number
  documents_pending_amount: number
  line_count: number
  attachment_count: number
  billing_status: PurchaseOrderBilling
}

export interface PurchaseOrderInput {
  direction: 'payable' | 'receivable'
  counterparty_id: string
  /** Vacío en CxP: se asigna el correlativo. */
  number: string | null
  currency: Currency
  issue_date: string
  delivery_date: string | null
  /** Se ignora si hay líneas (el neto es la suma de las líneas). */
  net_amount: number
  exempt_amount: number
  tax_amount: number
  category_id: string | null
  cost_center_id: string | null
  requester: string | null
  payment_method: string | null
  payment_terms_days: number | null
  description: string | null
  notes: string | null
  /** Solo al crear. */
  status?: 'draft' | 'pending' | 'approved'
}

export interface PurchaseOrderAttachment {
  id: string
  purchase_order_id: string
  storage_path: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export interface PortalPurchaseOrder {
  id: string
  direction: 'payable' | 'receivable'
  number: string
  status: PurchaseOrderStatus
  currency: Currency
  issue_date: string
  delivery_date: string | null
  net_amount: number
  exempt_amount: number
  tax_amount: number
  total_amount: number
  invoiced_amount: number
  remaining_amount: number
  billing_status: PurchaseOrderBilling
  payment_terms_days: number | null
  notes: string | null
  lines: PurchaseOrderLine[]
}

// ---------------------------------------------------------------------------
// Documentos del SII (Chile, vía Fintoc)
// ---------------------------------------------------------------------------
/** Fila de public.sii_document_status */
export interface SiiDocument {
  id: string
  direction: 'payable' | 'receivable'
  sii_type: number | null
  is_fee_receipt: boolean
  is_summary: boolean
  folio: string | null
  counterparty_tax_id: string | null
  counterparty_name: string | null
  issue_date: string
  tax_period: string | null
  net_amount: number
  exempt_amount: number
  tax_amount: number
  other_taxes_amount: number
  total_amount: number
  withheld_amount: number
  /** registered | pending | cancelled | rejected */
  registry_status: string | null
  /** C, A, P, G, R o null */
  confirmation_status: string | null
  fee_status: string | null
  accepted_at: string | null
  rejected_at: string | null
  reference_type: number | null
  reference_folio: string | null
  transaction_category: string | null
  document_id: string | null
  ignored: boolean
  doc_type: DocumentTypeCode | null
  matched_document_id: string | null
  importable: boolean
  claimed: boolean
  updated_at: string
}

export interface SiiImportResult {
  imported: number
  linked: number
  skipped: { id: string; folio: string | null; reason: string }[]
}

// ---------------------------------------------------------------------------
// Correos del negocio
// ---------------------------------------------------------------------------
export type EmailKind =
  | 'payment_scheduled' | 'payment_sent' | 'document_rejected' | 'payment_received'
  | 'portal_access_granted' | 'member_added' | 'purchase_order' | 'collection_reminder'
  | 'collection_rule' | 'statement'

export interface EmailSettings {
  reply_to: string | null
  /** kind -> activo. Si falta, se usa el valor por defecto del tipo. */
  notifications: Partial<Record<EmailKind, boolean>>
}

export interface EmailLogRow {
  id: string
  kind: EmailKind
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'
  recipients: string[]
  subject: string | null
  error: string | null
  created_at: string
  sent_at: string | null
  counterparty_id?: string | null
  rule_id?: string | null
}

// ---------------------------------------------------------------------------
// Cobranza
// ---------------------------------------------------------------------------
export type CollectionTrigger = 'before_due' | 'on_due' | 'after_due' | 'statement' | 'new_document' | 'manual'

export interface CollectionRule {
  id: string
  name: string
  trigger: CollectionTrigger
  offset_days: number
  /** statement: 0 = domingo … 6 = sábado */
  weekday: number | null
  send_hour: number
  subject: string
  body: string
  include_documents: boolean
  include_payment_link: boolean
  audience: 'all' | 'tags' | 'selected'
  audience_tags: string[]
  audience_ids: string[]
  active: boolean
  created_at: string
}

export type CollectionRuleInput = Omit<CollectionRule, 'id' | 'created_at'>

export interface CounterpartyRuleSetting {
  rule_id: string
  enabled: boolean
}

export type CollectionEventKind = 'note' | 'call' | 'promise' | 'dispute'

export interface CollectionEvent {
  id: string
  counterparty_id: string
  document_id: string | null
  kind: CollectionEventKind
  body: string | null
  promised_date: string | null
  promised_amount: number | null
  currency: Currency | null
  promise_status: 'pending' | 'kept' | 'broken' | null
  created_by: string | null
  created_at: string
}

export type CollectionEventInput = Omit<CollectionEvent, 'id' | 'created_by' | 'created_at'>
