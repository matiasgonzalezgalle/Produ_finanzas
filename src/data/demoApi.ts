// Backend de demostración en memoria (persistido en localStorage del navegador).
// Sirve para ver y probar la app sin un proyecto Supabase. Replica las reglas clave del SQL.
import type { DataApi, Session } from './api'
import type { AccountingCategory, AllocationLine, ApprovalStatus, CostCenter, DocumentComment, Attachment, BankAccount, Contact, Counterparty, DocumentInput, DocumentRow, IntegrationConnection, Member, Payment, PortalAccess, PortalSnapshot, Tenant, ModuleSettings, DocumentTypeSetting, PaymentMethod, PurchaseOrderAttachment, PurchaseOrderInput, PurchaseOrderLine, PurchaseOrderRow, PurchaseOrderStatus } from './types'
import { DEFAULT_MODULE_SETTINGS } from './defaults'
import type { Country } from '../domain/taxId'
import { computeBalance } from '../domain/documents'
import { todayIn } from '../domain/dates'

interface StoredDocument extends DocumentInput {
  id: string
  tenant_id: string
  approval_status?: ApprovalStatus
  approved_by?: string | null
  approved_at?: string | null
  rejection_reason?: string | null
  created_at?: string
  payment_stage?: 'requested' | 'scheduled' | null
  payment_stage_at?: string | null
}

interface State {
  session: Session | null
  tenants: Tenant[]
  counterparties: Counterparty[]
  contacts: Contact[]
  documents: StoredDocument[]
  payments: Omit<Payment, 'counterparty_name'>[]
  integrations: (IntegrationConnection & { tenant_id: string })[]
  members: (Member & { tenant_id: string })[]
  attachments: (Attachment & { tenant_id: string; data_url: string })[]
  portalAccess: (PortalAccess & { tenant_id: string; code?: string })[]
  /** Acceso con código canjeado en esta sesión del portal (demo). */
  portalCodeAccessId?: string | null
  bankAccounts: (BankAccount & { tenant_id: string })[]
  categories: (AccountingCategory & { tenant_id: string })[]
  costCenters: (CostCenter & { tenant_id: string })[]
  allocations: (AllocationLine & { tenant_id: string; document_id: string })[]
  comments: (DocumentComment & { tenant_id: string; document_id: string })[]
  /** Correo con sesión en el portal (demo). */
  portalEmail: string | null
  moduleSettings: (ModuleSettings & { tenant_id: string })[]
  docTypeSettings: (DocumentTypeSetting & { tenant_id: string; direction: 'payable' | 'receivable' })[]
  paymentMethods: (PaymentMethod & { tenant_id: string })[]
  /** Próximo correlativo de OC por empresa (demo: una sola secuencia). */
  nextPoNumber: number
  purchaseOrders: StoredPurchaseOrder[]
  poLines: (PurchaseOrderLine & { tenant_id: string; purchase_order_id: string })[]
  poAttachments: (PurchaseOrderAttachment & { tenant_id: string; data_url: string })[]
}

type StoredPurchaseOrder = Omit<PurchaseOrderInput, 'status'> & {
  id: string
  tenant_id: string
  number: string
  status: PurchaseOrderStatus
  total_amount: number
  rejection_reason: string | null
  approved_by: string | null
  approved_at: string | null
  sent_at: string | null
  sent_to: string | null
  created_at: string
}

const KEY = 'produ-finanzas:demo:v9'
/** En modo demo el código del portal es siempre este. */
export const DEMO_PORTAL_CODE = '123456'
const uid = () => crypto.randomUUID()
const slugFor = (name: string) =>
  `${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'portal'}-${uid().replace(/-/g, '').slice(0, 8)}`

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function seedCatalogs(tenantId: string) {
  const cat = (code: string, name: string, kind: AccountingCategory['kind']) => ({ id: uid(), tenant_id: tenantId, code, name, kind, active: true })
  return {
    categories: [
      cat('5101', 'Arriendos', 'expense'), cat('5102', 'Servicios profesionales', 'expense'), cat('5103', 'Producción', 'expense'),
      cat('5104', 'Postproducción', 'expense'), cat('5105', 'Viajes y viáticos', 'expense'), cat('5106', 'Marketing y publicidad', 'expense'),
      cat('5107', 'Software y suscripciones', 'expense'), cat('5199', 'Gastos generales', 'expense'),
      cat('4101', 'Venta de servicios', 'income'), cat('4102', 'Auspicios', 'income'), cat('4103', 'Licencias de contenido', 'income'), cat('4199', 'Otros ingresos', 'income'),
    ],
    costCenters: [
      { id: uid(), tenant_id: tenantId, code: 'ADM', name: 'Administración', active: true },
      { id: uid(), tenant_id: tenantId, code: 'PRO', name: 'Producción', active: true },
      { id: uid(), tenant_id: tenantId, code: 'COM', name: 'Comercial', active: true },
    ],
  }
}

function seedModule(tenantId: string, country: Country) {
  const names = ['Transferencia', 'Cheque', 'Efectivo', 'Tarjeta', 'Depósito', country === 'CL' ? 'Vale vista' : 'Yape / Plin', 'Otro']
  return {
    moduleSettings: [
      { ...DEFAULT_MODULE_SETTINGS, tenant_id: tenantId, direction: 'payable' as const },
      { ...DEFAULT_MODULE_SETTINGS, tenant_id: tenantId, direction: 'receivable' as const, require_approval: false },
    ],
    paymentMethods: (['out', 'in'] as const).flatMap((direction) =>
      names.map((name, position) => ({ id: uid(), tenant_id: tenantId, direction, name, active: true, is_default: position === 0, position })),
    ),
  }
}

function seedPurchaseOrders(tenantId: string, today: string, ids: { hotel: string; atacama: string; canal: string; bebidas: string }) {
  const po = (p: Partial<StoredPurchaseOrder> & Pick<StoredPurchaseOrder, 'direction' | 'counterparty_id' | 'number' | 'net_amount' | 'status'>): StoredPurchaseOrder => ({
    id: uid(), tenant_id: tenantId, currency: 'CLP', issue_date: addDays(today, -15), delivery_date: null, exempt_amount: 0,
    tax_amount: Math.round(p.net_amount * 0.19), total_amount: p.net_amount + Math.round(p.net_amount * 0.19), category_id: null, cost_center_id: null,
    requester: null, payment_method: null, payment_terms_days: 30, description: null, notes: null, rejection_reason: null,
    approved_by: p.status === 'approved' ? 'demo-user' : null, approved_at: p.status === 'approved' ? new Date().toISOString() : null,
    sent_at: null, sent_to: null, created_at: new Date().toISOString(), ...p,
  })
  const purchaseOrders = [
    po({ direction: 'payable', counterparty_id: ids.atacama, number: 'OC-00001', net_amount: 4_000_000, status: 'approved', requester: 'Producción · Serie Norte', description: 'Locaciones rodaje norte', sent_at: new Date().toISOString(), sent_to: 'reservas@atacama.example' }),
    po({ direction: 'payable', counterparty_id: ids.hotel, number: 'OC-00002', net_amount: 1_200_000, status: 'pending', requester: 'Producción · Serie Norte', description: 'Alojamiento equipo técnico', delivery_date: addDays(today, 10) }),
    po({ direction: 'payable', counterparty_id: ids.hotel, number: 'OC-00003', net_amount: 350_000, status: 'draft', description: 'Salón para casting' }),
    po({ direction: 'receivable', counterparty_id: ids.canal, number: '4500098712', net_amount: 15_000_000, status: 'approved', description: 'Temporada 2 · 8 capítulos', issue_date: addDays(today, -40) }),
    po({ direction: 'receivable', counterparty_id: ids.bebidas, number: 'PO-2026-118', net_amount: 6_500_000, status: 'pending', description: 'Campaña verano' }),
  ]
  const line = (poIndex: number, description: string, quantity: number, unit_price: number): State['poLines'][number] => ({
    tenant_id: tenantId, purchase_order_id: purchaseOrders[poIndex].id, description, quantity, unit_price, discount: 0, amount: Math.round(quantity * unit_price),
  })
  return {
    purchaseOrders,
    poLines: [
      line(0, 'Arriendo locación Valle de la Luna (días)', 4, 750_000),
      line(0, 'Permisos y guía local', 1, 1_000_000),
      line(1, 'Habitación doble (noches)', 8, 150_000),
      line(2, 'Arriendo salón (jornada)', 1, 350_000),
    ],
    poAttachments: [],
    nextPoNumber: 4,
  }
}

function seed(): State {
  const today = todayIn('America/Santiago')
  const tenantId = uid()
  const cp = (name: string, tax_id: string | null, supplier: boolean, customer: boolean, country = 'CL', tags: string[] = []): Counterparty => ({
    id: uid(), tenant_id: tenantId, name, legal_name: name, country, tax_id, is_supplier: supplier, is_customer: customer,
    tags, email: null, phone: null, address: null, default_currency: null, payment_terms_days: 30, notes: null,
  })
  const counterparties = [
    cp('Hotelera Cordillera SpA', '76526480-4', true, false, 'CL', ['Viajes']),
    cp('Transportes Andinos Ltda.', '77217248-6', true, false),
    cp('Atacama Aventura SpA', '76475772-6', true, false, 'CL', ['Locaciones']),
    cp('Comercial Pacífico Ltda.', '77008883-6', true, true),
    cp('Estudio Sonoro Norte', '12156264-2', true, false, 'CL', ['Post']),
    cp('Canal Uno Televisión S.A.', '78171372-4', false, true, 'CL', ['Medios']),
    cp('Marca Bebidas del Sur SpA', '96806980-2', false, true),
    cp('Plataforma Streaming Inc.', null, true, false, 'US', ['Internacional']),
  ]
  const [hotel, transporte, atacama, pacifico, sonoro, canal, bebidas, streaming] = counterparties
  canal.portal_slug = slugFor(canal.name)
  const doc = (d: Partial<StoredDocument> & Pick<StoredDocument, 'direction' | 'counterparty_id' | 'folio' | 'total_amount'>): StoredDocument => ({
    id: uid(), tenant_id: tenantId, doc_type: 'factura', currency: 'CLP', net_amount: Math.round(d.total_amount / 1.19),
    exempt_amount: 0, tax_amount: d.total_amount - Math.round(d.total_amount / 1.19), issue_date: addDays(today, -20),
    due_date: addDays(today, 10), status: 'open', applies_to_id: null, detraction_rate: 0, detraction_amount: 0,
    detraction_status: 'no_aplica', description: null, scheduled_payment_date: null, purchase_order_id: null, ...d,
  })
  const documents = [
    doc({ direction: 'payable', counterparty_id: hotel.id, folio: '20412', total_amount: 1_845_000, due_date: addDays(today, -12), issue_date: addDays(today, -42) }),
    doc({ direction: 'payable', counterparty_id: transporte.id, folio: '8831', total_amount: 640_000, due_date: addDays(today, 3) }),
    doc({ direction: 'payable', counterparty_id: atacama.id, folio: '1177', total_amount: 3_200_000, due_date: addDays(today, 18) }),
    doc({ direction: 'payable', counterparty_id: sonoro.id, folio: '552', doc_type: 'honorarios', total_amount: 450_000, net_amount: 450_000, tax_amount: 0, due_date: addDays(today, -40), issue_date: addDays(today, -70) }),
    doc({ direction: 'payable', counterparty_id: streaming.id, folio: 'INV-2291', doc_type: 'invoice', currency: 'USD', total_amount: 129_900, net_amount: 129_900, tax_amount: 0, due_date: addDays(today, 6) }),
    doc({ direction: 'payable', counterparty_id: pacifico.id, folio: '99120', total_amount: 238_000, due_date: addDays(today, -2) }),
    doc({ direction: 'receivable', counterparty_id: canal.id, folio: '1043', total_amount: 11_900_000, due_date: addDays(today, 25) }),
    doc({ direction: 'receivable', counterparty_id: canal.id, folio: '1038', total_amount: 5_950_000, due_date: addDays(today, -35), issue_date: addDays(today, -65) }),
    doc({ direction: 'receivable', counterparty_id: bebidas.id, folio: '1041', total_amount: 4_165_000, due_date: addDays(today, -5) }),
    doc({ direction: 'receivable', counterparty_id: pacifico.id, folio: '1044', total_amount: 1_190_000, due_date: addDays(today, 14) }),
    doc({ direction: 'receivable', counterparty_id: bebidas.id, folio: 'UF-12', currency: 'UF', total_amount: 1_250_000, net_amount: 1_250_000, tax_amount: 0, doc_type: 'factura_exenta', due_date: addDays(today, 40) }),
  ]
  const orders = seedPurchaseOrders(tenantId, today, { hotel: hotel.id, atacama: atacama.id, canal: canal.id, bebidas: bebidas.id })
  documents[2].purchase_order_id = orders.purchaseOrders[0].id
  documents[6].purchase_order_id = orders.purchaseOrders[3].id
  const module = seedModule(tenantId, 'CL')
  module.moduleSettings[0].po_next_number = 4
  const payments: State['payments'] = [
    { id: uid(), tenant_id: tenantId, direction: 'out', counterparty_id: transporte.id, currency: 'CLP', amount: 240_000, paid_on: addDays(today, -4), method: 'transferencia', reference: 'TRF 88213', notes: null, source: 'manual', status: 'confirmed', allocations: [{ document_id: documents[1].id, amount: 240_000 }] },
    { id: uid(), tenant_id: tenantId, direction: 'in', counterparty_id: canal.id, currency: 'CLP', amount: 3_000_000, paid_on: addDays(today, -8), method: 'transferencia', reference: 'Abono Canal Uno', notes: null, source: 'manual', status: 'confirmed', allocations: [{ document_id: documents[7].id, amount: 3_000_000 }] },
  ]
  return {
    session: null,
    tenants: [
      { id: tenantId, name: 'Nube Films SpA', legal_name: 'Nube Films SpA', tax_id: '76086428-5', country: 'CL', base_currency: 'CLP', timezone: 'America/Santiago', role: 'owner', portal_enabled: true, portal_message: 'Ante dudas escríbenos a finanzas@nubefilms.example' },
    ],
    counterparties,
    contacts: [
      { id: uid(), tenant_id: tenantId, counterparty_id: canal.id, name: 'Paula Rojas', position: 'Jefa de pagos', email: 'pagos@canaluno.example', phone: '+56 2 2345 6789' },
      { id: uid(), tenant_id: tenantId, counterparty_id: hotel.id, name: 'Diego Soto', position: 'Cobranza', email: 'cobranza@cordillera.example', phone: null },
    ],
    documents,
    payments,
    integrations: [],
    members: [
      { tenant_id: tenantId, user_id: 'demo-user', role: 'owner', full_name: 'Usuario demo', email: 'demo@produ.test', created_at: new Date().toISOString() },
      { tenant_id: tenantId, user_id: uid(), role: 'finance', full_name: 'Equipo finanzas', email: 'finanzas@nubefilms.example', created_at: new Date().toISOString() },
    ],
    attachments: [],
    portalAccess: [
      { id: uid(), tenant_id: tenantId, counterparty_id: canal.id, kind: 'email', email: 'pagos@canaluno.example', label: null, code_hint: null, expires_at: null, enabled: true, last_access_at: null, created_at: new Date().toISOString() },
    ],
    portalEmail: null,
    ...seedCatalogs(tenantId),
    ...module,
    docTypeSettings: [],
    ...orders,
    allocations: [],
    comments: [],
    bankAccounts: [
      { id: uid(), tenant_id: tenantId, counterparty_id: hotel.id, bank_name: 'Banco de Chile', account_type: 'Cuenta corriente', account_number: '0012458701', holder_name: 'Hotelera Cordillera SpA', holder_tax_id: '76526480-4', email: 'pagos@cordillera.example', currency: 'CLP' },
    ],
  }
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as State
  } catch {
    // sin storage: se usa un estado nuevo en memoria
  }
  return seed()
}

export function createDemoApi(): DataApi {
  let state = load()
  const listeners = new Set<(s: Session | null) => void>()
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // ignorar
    }
  }
  const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), 120))
  /** ¿La sesión del portal (correo o código) tiene acceso vigente por este registro? */
  const portalGrants = (a: State['portalAccess'][number]) =>
    a.enabled &&
    (!a.expires_at || a.expires_at > new Date().toISOString()) &&
    ((a.kind === 'email' && !!state.portalEmail && a.email === state.portalEmail) || (a.kind === 'code' && a.id === state.portalCodeAccessId))
  const settingsOf = (tenantId: string, direction: 'payable' | 'receivable'): ModuleSettings =>
    state.moduleSettings.find((m) => m.tenant_id === tenantId && m.direction === direction) ?? { ...DEFAULT_MODULE_SETTINGS, direction, require_approval: direction === 'payable' }
  const typeSetting = (tenantId: string, direction: 'payable' | 'receivable', docType: string) =>
    state.docTypeSettings.find((t) => t.tenant_id === tenantId && t.direction === direction && t.doc_type === docType)
  const moduleName = (direction: 'payable' | 'receivable') => (direction === 'payable' ? 'cuentas por pagar' : 'cuentas por cobrar')
  const tenantTz = (tenantId: string) => state.tenants.find((t) => t.id === tenantId)?.timezone ?? 'America/Santiago'

  function balances(tenantId: string): DocumentRow[] {
    const today = todayIn(tenantTz(tenantId))
    const docs = state.documents.filter((d) => d.tenant_id === tenantId)
    return docs.map((d) => {
      const credits = docs.filter((c) => c.applies_to_id === d.id && c.status === 'open').reduce((s, c) => s + c.total_amount, 0)
      const paid = state.payments
        .filter((p) => p.status === 'confirmed')
        .flatMap((p) => p.allocations)
        .filter((a) => a.document_id === d.id)
        .reduce((s, a) => s + a.amount, 0)
      const isCredit = d.doc_type === 'nota_credito'
      const b = computeBalance(
        { status: d.status, totalMinor: d.total_amount, creditsMinor: credits, detractionMinor: d.detraction_amount, allocatedMinor: paid, dueDate: d.due_date },
        today,
      )
      const cp = state.counterparties.find((c) => c.id === d.counterparty_id)
      return {
        ...d,
        counterparty_name: cp?.name ?? '—',
        counterparty_tax_id: cp?.tax_id ?? null,
        credits_amount: credits,
        paid_amount: paid,
        net_total: b.netMinor,
        pending_amount: isCredit ? 0 : b.pendingMinor,
        payment_status: isCredit && d.status === 'open' ? 'aplicada' : b.paymentStatus,
        days_overdue: isCredit ? 0 : b.daysOverdue,
        scheduled_payment_date: d.scheduled_payment_date ?? null,
        attachment_count: state.attachments.filter((a) => a.document_id === d.id).length,
        approval_status: d.approval_status ?? (d.direction === 'receivable' || paid > 0 ? 'approved' : 'pending'),
        approved_by: d.approved_by ?? null,
        approved_at: d.approved_at ?? null,
        rejection_reason: d.rejection_reason ?? null,
        allocation_base: d.tax_amount > 0 ? d.net_amount + d.exempt_amount : d.total_amount,
        allocated_amount: state.allocations.filter((a) => a.document_id === d.id).reduce((sum, a) => sum + a.amount, 0),
        created_at: d.created_at ?? `${d.issue_date}T12:00:00Z`,
        payment_stage: d.payment_stage ?? null,
        payment_stage_at: d.payment_stage_at ?? null,
        purchase_order_id: d.purchase_order_id ?? null,
        purchase_order_number: state.purchaseOrders.find((o) => o.id === d.purchase_order_id)?.number ?? null,
        payment_management: ((): DocumentRow['payment_management'] => {
          if (d.direction !== 'payable' || isCredit || d.status === 'void') return null
          if (d.status === 'open' && b.pendingMinor === 0) return 'paid'
          const approved = (d.approval_status ?? (paid > 0 ? 'approved' : 'pending')) === 'approved'
          return approved ? d.payment_stage ?? null : null
        })(),
      }
    })
  }

  function poBalances(tenantId: string): PurchaseOrderRow[] {
    const docs = balances(tenantId)
    return state.purchaseOrders
      .filter((o) => o.tenant_id === tenantId)
      .map((o) => {
        const linked = docs.filter((d) => d.purchase_order_id === o.id && d.status === 'open')
        const invoiced = linked.reduce((sum, d) => sum + d.net_total, 0)
        const cp = state.counterparties.find((c) => c.id === o.counterparty_id)
        return {
          ...o,
          counterparty_name: cp?.name ?? '—',
          counterparty_tax_id: cp?.tax_id ?? null,
          category_name: state.categories.find((c) => c.id === o.category_id)?.name ?? null,
          cost_center_name: state.costCenters.find((c) => c.id === o.cost_center_id)?.name ?? null,
          document_count: linked.length,
          invoiced_amount: invoiced,
          remaining_amount: Math.max(0, o.total_amount - invoiced),
          paid_amount: linked.reduce((sum, d) => sum + d.paid_amount, 0),
          documents_pending_amount: linked.reduce((sum, d) => sum + d.pending_amount, 0),
          line_count: state.poLines.filter((l) => l.purchase_order_id === o.id).length,
          attachment_count: state.poAttachments.filter((a) => a.purchase_order_id === o.id).length,
          billing_status: invoiced === 0 ? 'sin_documentos' : invoiced >= o.total_amount ? 'completa' : 'parcial',
        } satisfies PurchaseOrderRow
      })
  }

  /** Reglas de OC de un documento (igual que private.document_purchase_order_rules). */
  function checkDocumentPurchaseOrder(tenantId: string, input: DocumentInput, current: DocumentRow | undefined, approvalStatus: ApprovalStatus) {
    const poId = input.purchase_order_id
    if (poId) {
      if (input.doc_type === 'nota_credito') throw new Error('Una nota de crédito se asocia al documento, no a la orden de compra')
      const o = state.purchaseOrders.find((x) => x.id === poId && x.tenant_id === tenantId)
      if (!o) throw new Error('Orden de compra no encontrada')
      if (o.direction !== input.direction || o.counterparty_id !== input.counterparty_id || o.currency !== input.currency) {
        throw new Error('La orden de compra debe ser de la misma contraparte y moneda que el documento')
      }
      const linking = !current || current.purchase_order_id !== poId
      if (linking && o.status !== 'approved') throw new Error(`La orden de compra ${o.number} no está aprobada`)
      if (input.status === 'open') {
        const others = balances(tenantId).filter((d) => d.purchase_order_id === poId && d.status === 'open' && d.id !== current?.id).reduce((sum, d) => sum + d.net_total, 0)
        const mine = Math.max(0, input.total_amount - (current?.credits_amount ?? 0))
        if (others + mine > o.total_amount) throw new Error(`El documento supera el saldo por facturar de la orden de compra ${o.number} (${o.total_amount - others})`)
      }
    }
    if (settingsOf(tenantId, input.direction).require_purchase_order && !poId && input.doc_type !== 'nota_credito') {
      if (input.direction === 'payable' && approvalStatus === 'approved') throw new Error('Asocia el documento a una orden de compra antes de aprobarlo')
      if (input.direction === 'receivable' && input.status === 'open') throw new Error('Asocia el documento a la orden de compra del cliente')
    }
  }

  const poTransitions: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
    draft: ['pending', 'approved', 'void'],
    pending: ['draft', 'approved', 'rejected', 'void'],
    approved: ['closed', 'void', 'pending'],
    rejected: ['draft', 'pending', 'void'],
    closed: ['approved'],
    void: [],
  }
  const canAdminTenant = (tenantId: string) => ['owner', 'admin'].includes(state.tenants.find((t) => t.id === tenantId)?.role ?? '')

  function applyPoStatus(tenantId: string, o: StoredPurchaseOrder, status: PurchaseOrderStatus, reason?: string) {
    if (o.status === status) return
    if (!poTransitions[o.status].includes(status)) throw new Error('Cambio de estado no permitido para la orden de compra')
    const hasDocs = state.documents.some((d) => d.purchase_order_id === o.id && d.status !== 'void')
    if ((o.status === 'approved' || o.status === 'closed') && !['approved', 'closed'].includes(status) && hasDocs) {
      throw new Error(`La orden de compra tiene documentos asociados: ciérrala en vez de ${status === 'void' ? 'anularla' : 'cambiarla de estado'}`)
    }
    if (status === 'rejected' && !reason?.trim()) throw new Error('Indica el motivo del rechazo')
    if (status === 'approved' && o.status !== 'closed' && o.direction === 'payable' && settingsOf(tenantId, 'payable').po_approval_admin_only && !canAdminTenant(tenantId)) {
      throw new Error('Solo un administrador puede aprobar órdenes de compra')
    }
    o.rejection_reason = status === 'rejected' ? reason!.trim() : null
    if (status === 'approved' && o.status !== 'closed') {
      o.approved_by = state.session?.userId ?? null
      o.approved_at = new Date().toISOString()
    } else if (['draft', 'pending', 'rejected'].includes(status)) {
      o.approved_by = null
      o.approved_at = null
    }
    o.status = status
  }

  return {
    mode: 'demo',
    async getSession() {
      return state.session
    },
    onSessionChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async signIn(email) {
      state.session = { userId: 'demo-user', email, fullName: email.split('@')[0] || 'Demo' }
      save()
      listeners.forEach((l) => l(state.session))
    },
    async signUp(email, _password, fullName) {
      state.session = { userId: 'demo-user', email, fullName }
      save()
      listeners.forEach((l) => l(state.session))
      return { needsConfirmation: false }
    },
    async signOut() {
      state.session = null
      save()
      listeners.forEach((l) => l(null))
    },

    async listTenants() {
      return delay(state.tenants)
    },
    async createTenant(input) {
      const tenant: Tenant = {
        id: uid(), name: input.name, legal_name: input.legal_name ?? null, tax_id: input.tax_id ?? null, country: input.country,
        base_currency: input.country === 'CL' ? 'CLP' : 'PEN', timezone: input.country === 'CL' ? 'America/Santiago' : 'America/Lima', role: 'owner', portal_enabled: false, portal_message: null,
      }
      state.tenants.push(tenant)
      const catalogs = seedCatalogs(tenant.id)
      state.categories.push(...catalogs.categories)
      state.costCenters.push(...catalogs.costCenters)
      const module = seedModule(tenant.id, tenant.country)
      state.moduleSettings.push(...module.moduleSettings)
      state.paymentMethods.push(...module.paymentMethods)
      state.members.push({ tenant_id: tenant.id, user_id: state.session?.userId ?? 'demo-user', role: 'owner', full_name: state.session?.fullName ?? null, email: state.session?.email ?? null, created_at: new Date().toISOString() })
      save()
      return delay(tenant)
    },

    async updateTenant(tenantId, input) {
      state.tenants = state.tenants.map((t) => (t.id === tenantId ? { ...t, ...input } : t))
      save()
    },
    async listMembers(tenantId) {
      return delay(state.members.filter((m) => m.tenant_id === tenantId))
    },
    async inviteMember(tenantId, input) {
      const email = input.email.trim().toLowerCase()
      if (state.members.some((m) => m.tenant_id === tenantId && m.email === email)) throw new Error('Ese usuario ya es miembro de la empresa')
      state.members.push({ tenant_id: tenantId, user_id: uid(), role: input.role, full_name: null, email, created_at: new Date().toISOString() })
      save()
      return { invited: true }
    },
    async updateMemberRole(tenantId, userId, role) {
      state.members = state.members.map((m) => (m.tenant_id === tenantId && m.user_id === userId && m.role !== 'owner' ? { ...m, role } : m))
      save()
    },
    async removeMember(tenantId, userId) {
      state.members = state.members.filter((m) => !(m.tenant_id === tenantId && m.user_id === userId && m.role !== 'owner'))
      save()
    },

    async listCounterparties(tenantId) {
      return delay(state.counterparties.filter((c) => c.tenant_id === tenantId).sort((a, b) => a.name.localeCompare(b.name)))
    },
    async saveCounterparty(tenantId, input, id) {
      const dup = state.counterparties.find((c) => c.tenant_id === tenantId && c.id !== id && input.tax_id && c.tax_id === input.tax_id && c.country === input.country)
      if (dup) throw new Error('Ya existe un registro con esos datos (folio o RUT duplicado).')
      let row: Counterparty
      if (id) {
        row = { ...state.counterparties.find((c) => c.id === id)!, ...input }
        state.counterparties = state.counterparties.map((c) => (c.id === id ? row : c))
      } else {
        row = { ...input, id: uid(), tenant_id: tenantId }
        state.counterparties.push(row)
      }
      save()
      return delay(row)
    },
    async listContacts(tenantId) {
      return delay(
        state.contacts
          .filter((c) => c.tenant_id === tenantId)
          .map((c) => ({ ...c, counterparty_name: state.counterparties.find((cp) => cp.id === c.counterparty_id)?.name })),
      )
    },
    async saveContact(tenantId, input, id) {
      let row: Contact
      if (id) {
        row = { ...state.contacts.find((c) => c.id === id)!, ...input }
        state.contacts = state.contacts.map((c) => (c.id === id ? row : c))
      } else {
        row = { ...input, id: uid(), tenant_id: tenantId }
        state.contacts.push(row)
      }
      save()
      return delay(row)
    },

    async listBankAccounts(tenantId, counterpartyId) {
      return delay(state.bankAccounts.filter((b) => b.tenant_id === tenantId && b.counterparty_id === counterpartyId))
    },
    async saveBankAccount(tenantId, input, id) {
      if (id) state.bankAccounts = state.bankAccounts.map((b) => (b.id === id && b.tenant_id === tenantId ? { ...b, ...input } : b))
      else state.bankAccounts.push({ ...input, id: uid(), tenant_id: tenantId })
      save()
    },
    async deleteBankAccount(tenantId, id) {
      state.bankAccounts = state.bankAccounts.filter((b) => !(b.id === id && b.tenant_id === tenantId))
      save()
    },

    async listDocuments(tenantId, direction) {
      return delay(
        balances(tenantId)
          .filter((d) => d.direction === direction)
          .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')),
      )
    },
    async saveDocument(tenantId, input, id) {
      const dup = state.documents.find(
        (d) => d.tenant_id === tenantId && d.id !== id && d.status !== 'void' && d.direction === input.direction &&
          d.counterparty_id === input.counterparty_id && d.doc_type === input.doc_type && d.folio === input.folio,
      )
      if (dup) throw new Error('Ya existe un registro con esos datos (folio o RUT duplicado).')
      const rows = balances(tenantId)
      const current = id ? rows.find((d) => d.id === id) : undefined
      if (current && current.paid_amount > 0) {
        if (input.counterparty_id !== current.counterparty_id || input.currency !== current.currency) {
          throw new Error('El documento tiene pagos asignados: no se puede cambiar contraparte, moneda ni dirección')
        }
        if (input.status === 'open' && input.total_amount - current.credits_amount - input.detraction_amount < current.paid_amount) {
          throw new Error(`El nuevo total queda por debajo de lo ya pagado (${current.paid_amount})`)
        }
      }
      if ((!current || current.doc_type !== input.doc_type) && typeSetting(tenantId, input.direction, input.doc_type)?.can_create === false) {
        throw new Error(`Este tipo de documento no está habilitado en ${moduleName(input.direction)}`)
      }
      const settings = settingsOf(tenantId, input.direction)
      const willApprove = current ? current.approval_status : input.direction === 'receivable' || !settings.require_approval ? 'approved' : 'pending'
      checkDocumentPurchaseOrder(tenantId, input, current, willApprove)
      const newId = id ?? uid()
      if (id) state.documents = state.documents.map((d) => (d.id === id ? { ...d, ...input } : d))
      else {
        const autoApproved = input.direction === 'receivable' || !settings.require_approval
        state.documents.push({
          ...input, id: newId, tenant_id: tenantId, created_at: new Date().toISOString(),
          approval_status: autoApproved ? 'approved' : 'pending', approved_at: autoApproved ? new Date().toISOString() : null, approved_by: autoApproved ? state.session?.userId ?? null : null,
        })
      }
      save()
      return newId
    },
    async voidDocument(tenantId, id) {
      state.documents = state.documents.map((d) => (d.id === id && d.tenant_id === tenantId ? { ...d, status: 'void', payment_stage: null } : d))
      save()
    },

    async deleteDocument(tenantId, id) {
      const hasPayments = state.payments.some((p) => p.allocations.some((a) => a.document_id === id))
      if (hasPayments) throw new Error('El documento tiene pagos asociados: anúlalo en vez de eliminarlo')
      if (state.documents.some((d) => d.applies_to_id === id)) throw new Error('El documento tiene notas de crédito asociadas: anúlalo en vez de eliminarlo')
      state.documents = state.documents.filter((d) => !(d.id === id && d.tenant_id === tenantId))
      state.attachments = state.attachments.filter((a) => a.document_id !== id)
      save()
    },
    async listAttachments(tenantId, documentId) {
      return delay(state.attachments.filter((a) => a.tenant_id === tenantId && a.document_id === documentId))
    },
    async uploadAttachment(tenantId, documentId, file) {
      if (file.size > 2 * 1024 * 1024) throw new Error('En modo demo el máximo es 2 MB por archivo (en producción, 20 MB)')
      const data_url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
        reader.readAsDataURL(file)
      })
      const id = uid()
      state.attachments.push({
        id, tenant_id: tenantId, document_id: documentId, storage_path: `${tenantId}/${documentId}/${id}-${file.name}`, file_name: file.name,
        mime_type: file.type || null, size_bytes: file.size, created_at: new Date().toISOString(), data_url,
      })
      save()
    },
    async deleteAttachment(tenantId, attachment) {
      state.attachments = state.attachments.filter((a) => !(a.id === attachment.id && a.tenant_id === tenantId))
      save()
    },
    async attachmentUrl(_tenantId, attachment) {
      const found = state.attachments.find((a) => a.id === attachment.id)
      if (!found) throw new Error('Archivo no encontrado')
      return found.data_url
    },

    async setApproval(tenantId, id, status, reason) {
      const row = balances(tenantId).find((d) => d.id === id)
      if (!row) throw new Error('Documento no encontrado')
      if (status === 'rejected' && !reason?.trim()) throw new Error('Indica el motivo del rechazo')
      if (status === 'rejected' && row.paid_amount > 0) throw new Error('El documento ya tiene pagos: no se puede rechazar')
      if (status === 'approved' && row.approval_status !== 'approved' && row.direction === 'payable' && settingsOf(tenantId, 'payable').require_purchase_order && !row.purchase_order_id && row.doc_type !== 'nota_credito') {
        throw new Error('Asocia el documento a una orden de compra antes de aprobarlo')
      }
      if (status === 'approved' && row.approval_status !== 'approved' && row.direction === 'payable' && settingsOf(tenantId, 'payable').require_allocation && row.allocated_amount < row.allocation_base) {
        throw new Error('Completa la distribución contable antes de aprobar el documento')
      }
      state.documents = state.documents.map((d) =>
        d.id === id
          ? { ...d, payment_stage: status === 'approved' ? d.payment_stage : null, approval_status: status, approved_by: status === 'pending' ? null : state.session?.userId ?? null, approved_at: status === 'pending' ? null : new Date().toISOString(), rejection_reason: status === 'rejected' ? reason!.trim() : null }
          : d,
      )
      save()
    },
    async setPaymentStage(tenantId, id, stage, scheduledDate) {
      const row = balances(tenantId).find((d) => d.id === id)
      if (!row) throw new Error('Documento no encontrado')
      if (stage && row.direction !== 'payable') throw new Error('La gestión de pagos aplica solo a cuentas por pagar')
      if (stage && row.approval_status !== 'approved') throw new Error('Aprueba el documento antes de gestionar su pago')
      const date = scheduledDate !== undefined ? scheduledDate : row.scheduled_payment_date
      if (stage === 'scheduled' && !date) throw new Error('Indica la fecha en que se programa el pago')
      state.documents = state.documents.map((d) =>
        d.id === id ? { ...d, payment_stage: stage, payment_stage_at: stage ? new Date().toISOString() : null, scheduled_payment_date: date ?? null } : d,
      )
      save()
    },
    async listDocumentAllocations(tenantId, documentId) {
      return delay(state.allocations.filter((a) => a.tenant_id === tenantId && a.document_id === documentId).map(({ category_id, cost_center_id, description, amount }) => ({ category_id, cost_center_id, description, amount })))
    },
    async setDocumentAllocations(tenantId, documentId, lines) {
      const doc = balances(tenantId).find((d) => d.id === documentId)
      if (!doc) throw new Error('Documento no encontrado')
      const total = lines.reduce((sum, l) => sum + l.amount, 0)
      if (total > doc.allocation_base) throw new Error(`La asignación (${total}) supera el monto a distribuir (${doc.allocation_base})`)
      state.allocations = [...state.allocations.filter((a) => a.document_id !== documentId), ...lines.map((l) => ({ ...l, tenant_id: tenantId, document_id: documentId }))]
      save()
    },
    async listComments(tenantId, documentId) {
      return delay(state.comments.filter((c) => c.tenant_id === tenantId && c.document_id === documentId))
    },
    async addComment(tenantId, documentId, body, visibility) {
      state.comments.push({ id: uid(), tenant_id: tenantId, document_id: documentId, visibility, author_kind: 'member', author_id: state.session?.userId ?? null, author_name: state.session?.fullName ?? null, body: body.trim(), created_at: new Date().toISOString() })
      save()
    },
    async deleteComment(tenantId, id) {
      state.comments = state.comments.filter((c) => !(c.id === id && c.tenant_id === tenantId && c.author_kind === 'member'))
      save()
    },
    async listCategories(tenantId) {
      return delay(state.categories.filter((c) => c.tenant_id === tenantId))
    },
    async saveCategory(tenantId, input, id) {
      if (state.categories.some((c) => c.tenant_id === tenantId && c.id !== id && c.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error('Ya existe una categoría con ese nombre')
      if (id) state.categories = state.categories.map((c) => (c.id === id ? { ...c, ...input } : c))
      else state.categories.push({ ...input, id: uid(), tenant_id: tenantId })
      save()
    },
    async listCostCenters(tenantId) {
      return delay(state.costCenters.filter((c) => c.tenant_id === tenantId))
    },
    async saveCostCenter(tenantId, input, id) {
      if (state.costCenters.some((c) => c.tenant_id === tenantId && c.id !== id && c.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error('Ya existe un centro de costos con ese nombre')
      if (id) state.costCenters = state.costCenters.map((c) => (c.id === id ? { ...c, ...input } : c))
      else state.costCenters.push({ ...input, id: uid(), tenant_id: tenantId })
      save()
    },

    async listPurchaseOrders(tenantId, direction) {
      return delay(poBalances(tenantId).filter((o) => o.direction === direction).sort((a, b) => b.issue_date.localeCompare(a.issue_date) || b.number.localeCompare(a.number)))
    },
    async listPurchaseOrderLines(tenantId, id) {
      return delay(state.poLines.filter((l) => l.tenant_id === tenantId && l.purchase_order_id === id).map(({ description, quantity, unit_price, discount, amount }) => ({ description, quantity, unit_price, discount, amount })))
    },
    async savePurchaseOrder(tenantId, input, lines, id) {
      const current = id ? state.purchaseOrders.find((o) => o.id === id && o.tenant_id === tenantId) : undefined
      if (id && !current) throw new Error('Orden de compra no encontrada')
      const internal = {
        delivery_date: input.delivery_date, category_id: input.category_id, cost_center_id: input.cost_center_id, requester: input.requester,
        payment_method: input.payment_method, payment_terms_days: input.payment_terms_days, description: input.description, notes: input.notes,
      }
      if (current && ['approved', 'closed', 'void'].includes(current.status)) {
        Object.assign(current, internal)
        save()
        return current.id
      }
      const lineRows = lines.map((l) => {
        if (!l.description.trim()) throw new Error('Cada línea necesita una descripción')
        if (!(l.quantity > 0)) throw new Error('La cantidad debe ser mayor a cero')
        const amount = Math.round(l.quantity * l.unit_price) - l.discount
        if (amount < 0) throw new Error('El descuento supera el subtotal de la línea')
        return { ...l, description: l.description.trim(), amount }
      })
      const net = lineRows.length ? lineRows.reduce((sum, l) => sum + l.amount, 0) : input.net_amount
      const total = net + input.exempt_amount + input.tax_amount
      if (total <= 0) throw new Error('El total de la orden de compra debe ser mayor a cero')
      if (input.delivery_date && input.delivery_date < input.issue_date) throw new Error('La fecha de entrega no puede ser anterior a la emisión')
      let number = input.number?.trim() || current?.number || ''
      if (!number) {
        if (input.direction !== 'payable') throw new Error('Indica el número de la orden de compra del cliente')
        const prefix = settingsOf(tenantId, 'payable').po_prefix
        do {
          const settings = state.moduleSettings.find((m) => m.tenant_id === tenantId && m.direction === 'payable')
          const n = settings?.po_next_number ?? state.nextPoNumber
          if (settings) settings.po_next_number = n + 1
          else state.nextPoNumber = n + 1
          number = `${prefix}${String(n).padStart(5, '0')}`
        } while (state.purchaseOrders.some((o) => o.tenant_id === tenantId && o.direction === 'payable' && o.status !== 'void' && o.number.toLowerCase() === number.toLowerCase()))
      }
      const dup = state.purchaseOrders.some((o) => o.tenant_id === tenantId && o.id !== id && o.status !== 'void' && o.direction === input.direction &&
        o.number.toLowerCase() === number.toLowerCase() && (input.direction === 'payable' || o.counterparty_id === input.counterparty_id))
      if (dup) throw new Error('Ya existe una orden de compra con ese número')
      const header = {
        ...internal, direction: input.direction, counterparty_id: input.counterparty_id, number, currency: input.currency, issue_date: input.issue_date,
        net_amount: net, exempt_amount: input.exempt_amount, tax_amount: input.tax_amount, total_amount: total,
      }
      let row: StoredPurchaseOrder
      if (current) {
        row = Object.assign(current, header)
      } else {
        row = { ...header, id: uid(), tenant_id: tenantId, status: 'draft', rejection_reason: null, approved_by: null, approved_at: null, sent_at: null, sent_to: null, created_at: new Date().toISOString() }
        state.purchaseOrders.push(row)
      }
      state.poLines = [...state.poLines.filter((l) => l.purchase_order_id !== row.id), ...lineRows.map((l) => ({ ...l, tenant_id: tenantId, purchase_order_id: row.id }))]
      if (!current && input.status && input.status !== 'draft') {
        try {
          applyPoStatus(tenantId, row, input.status)
        } catch (err) {
          state.purchaseOrders = state.purchaseOrders.filter((o) => o.id !== row.id)
          state.poLines = state.poLines.filter((l) => l.purchase_order_id !== row.id)
          throw err
        }
      }
      save()
      return row.id
    },
    async setPurchaseOrderStatus(tenantId, id, status, reason) {
      const o = state.purchaseOrders.find((x) => x.id === id && x.tenant_id === tenantId)
      if (!o) throw new Error('Orden de compra no encontrada')
      applyPoStatus(tenantId, o, status, reason)
      save()
    },
    async markPurchaseOrderSent(tenantId, id, sentTo) {
      const o = state.purchaseOrders.find((x) => x.id === id && x.tenant_id === tenantId)
      if (!o) throw new Error('Orden de compra no encontrada')
      o.sent_at = sentTo === null ? null : new Date().toISOString()
      o.sent_to = sentTo || null
      save()
    },
    async deletePurchaseOrder(tenantId, id) {
      const o = state.purchaseOrders.find((x) => x.id === id && x.tenant_id === tenantId)
      if (!o) return
      if (!['draft', 'pending', 'rejected'].includes(o.status)) throw new Error('Solo se eliminan órdenes en borrador, por aprobar o rechazadas: anúlala')
      state.purchaseOrders = state.purchaseOrders.filter((x) => x.id !== id)
      state.poLines = state.poLines.filter((l) => l.purchase_order_id !== id)
      state.poAttachments = state.poAttachments.filter((a) => a.purchase_order_id !== id)
      save()
    },
    async listPurchaseOrderAttachments(tenantId, id) {
      return delay(state.poAttachments.filter((a) => a.tenant_id === tenantId && a.purchase_order_id === id))
    },
    async uploadPurchaseOrderAttachment(tenantId, id, file) {
      if (file.size > 2 * 1024 * 1024) throw new Error('En modo demo el máximo es 2 MB por archivo (en producción, 20 MB)')
      const data_url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
        reader.readAsDataURL(file)
      })
      const fileId = uid()
      state.poAttachments.push({
        id: fileId, tenant_id: tenantId, purchase_order_id: id, storage_path: `${tenantId}/po/${id}/${fileId}-${file.name}`, file_name: file.name,
        mime_type: file.type || null, size_bytes: file.size, created_at: new Date().toISOString(), data_url,
      })
      save()
    },
    async deletePurchaseOrderAttachment(tenantId, attachment) {
      state.poAttachments = state.poAttachments.filter((a) => !(a.id === attachment.id && a.tenant_id === tenantId))
      save()
    },
    async purchaseOrderAttachmentUrl(_tenantId, attachment) {
      const found = state.poAttachments.find((a) => a.id === attachment.id)
      if (!found) throw new Error('Archivo no encontrado')
      return found.data_url
    },

    async getModuleSettings(tenantId, direction) {
      return delay(settingsOf(tenantId, direction))
    },
    async saveModuleSettings(tenantId, direction, input) {
      if (input.default_due_days != null && (input.default_due_days < 0 || input.default_due_days > 365)) throw new Error('El plazo debe estar entre 0 y 365 días')
      state.moduleSettings = [...state.moduleSettings.filter((m) => !(m.tenant_id === tenantId && m.direction === direction)), { ...input, tenant_id: tenantId, direction }]
      save()
    },
    async listDocumentTypeSettings(tenantId, direction) {
      return delay(state.docTypeSettings.filter((t) => t.tenant_id === tenantId && t.direction === direction).map(({ doc_type, can_create, can_pay }) => ({ doc_type, can_create, can_pay })))
    },
    async saveDocumentTypeSetting(tenantId, direction, input) {
      state.docTypeSettings = [...state.docTypeSettings.filter((t) => !(t.tenant_id === tenantId && t.direction === direction && t.doc_type === input.doc_type)), { ...input, tenant_id: tenantId, direction }]
      save()
    },
    async listPaymentMethods(tenantId, direction) {
      return delay(state.paymentMethods.filter((m) => m.tenant_id === tenantId && m.direction === direction).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)))
    },
    async savePaymentMethod(tenantId, input, id) {
      if (state.paymentMethods.some((m) => m.tenant_id === tenantId && m.direction === input.direction && m.id !== id && m.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error('Ya existe una forma de pago con ese nombre')
      if (input.is_default && !input.active) throw new Error('Una forma de pago inactiva no puede ser la predeterminada')
      const rowId = id ?? uid()
      if (input.is_default) state.paymentMethods = state.paymentMethods.map((m) => (m.tenant_id === tenantId && m.direction === input.direction ? { ...m, is_default: false } : m))
      if (id) state.paymentMethods = state.paymentMethods.map((m) => (m.id === id ? { ...m, ...input } : m))
      else state.paymentMethods.push({ ...input, id: rowId, tenant_id: tenantId })
      save()
    },

    async listPayments(tenantId, direction) {
      const docs = state.documents
      return delay(
        state.payments
          .filter((p) => p.tenant_id === tenantId && p.direction === direction)
          .map((p) => ({
            ...p,
            counterparty_name: state.counterparties.find((c) => c.id === p.counterparty_id)?.name ?? null,
            allocations: p.allocations.map((a) => ({ ...a, folio: docs.find((d) => d.id === a.document_id)?.folio })),
          }))
          .sort((a, b) => b.paid_on.localeCompare(a.paid_on)),
      )
    },
    async createPayment(tenantId, input) {
      const rows = balances(tenantId)
      const allocated = input.allocations.reduce((s, a) => s + a.amount, 0)
      if (allocated > input.amount) throw new Error('La asignación supera el monto del pago')
      for (const a of input.allocations) {
        const d = rows.find((r) => r.id === a.document_id)
        if (!d) throw new Error('Documento no existe')
        if (d.approval_status === 'rejected') throw new Error('El documento está rechazado: no se le pueden asignar pagos')
        if (d.currency !== input.currency) throw new Error(`La moneda del pago (${input.currency}) no coincide con la del documento (${d.currency})`)
        if (a.amount > d.pending_amount) throw new Error('La asignación supera el saldo pendiente del documento')
        if (typeSetting(tenantId, d.direction, d.doc_type)?.can_pay === false) throw new Error(`Este tipo de documento no se ${d.direction === 'payable' ? 'paga' : 'cobra'} desde el módulo`)
        if (!settingsOf(tenantId, d.direction).allow_partial_payments && a.amount < d.pending_amount) throw new Error(`No se permiten pagos parciales: asigna el saldo completo del documento ${d.folio}`)
      }
      const methods = state.paymentMethods.filter((m) => m.tenant_id === tenantId && m.direction === input.direction)
      if (methods.length && !methods.some((m) => m.active && m.name.toLowerCase() === input.method.toLowerCase())) throw new Error(`La forma de pago "${input.method}" no está habilitada`)
      state.payments.push({ ...input, id: uid(), tenant_id: tenantId, source: 'manual', status: 'confirmed', created_at: new Date().toISOString() })
      save()
    },

    async voidPayment(tenantId, id) {
      state.payments = state.payments.map((p) => (p.id === id && p.tenant_id === tenantId ? { ...p, status: 'void' } : p))
      save()
    },

    async listPortalAccess(tenantId) {
      return delay(state.portalAccess.filter((a) => a.tenant_id === tenantId))
    },
    async addPortalAccess(tenantId, counterpartyId, email) {
      const clean = email.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('Correo inválido')
      if (state.portalAccess.some((a) => a.tenant_id === tenantId && a.counterparty_id === counterpartyId && a.email === clean)) {
        throw new Error('Ya existe un registro con esos datos (folio o RUT duplicado).')
      }
      state.portalAccess.push({ id: uid(), tenant_id: tenantId, counterparty_id: counterpartyId, kind: 'email', email: clean, label: null, code_hint: null, expires_at: null, enabled: true, last_access_at: null, created_at: new Date().toISOString() })
      state.counterparties = state.counterparties.map((c) => (c.id === counterpartyId && !c.portal_slug ? { ...c, portal_slug: slugFor(c.name) } : c))
      save()
    },
    async setPortalAccessEnabled(tenantId, id, enabled) {
      state.portalAccess = state.portalAccess.map((a) => (a.id === id && a.tenant_id === tenantId ? { ...a, enabled } : a))
      save()
    },
    async removePortalAccess(tenantId, id) {
      state.portalAccess = state.portalAccess.filter((a) => !(a.id === id && a.tenant_id === tenantId))
      save()
    },

    async regeneratePortalSlug(tenantId, counterpartyId) {
      let slug = ''
      state.counterparties = state.counterparties.map((c) => {
        if (c.id !== counterpartyId || c.tenant_id !== tenantId) return c
        slug = slugFor(c.name)
        return { ...c, portal_slug: slug }
      })
      save()
      return slug
    },
    async createPortalCode(tenantId, counterpartyId, label, expiresAt) {
      if (!label.trim()) throw new Error('Indica a quién corresponde el código')
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
      const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join('')
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
      state.counterparties = state.counterparties.map((c) => (c.id === counterpartyId && !c.portal_slug ? { ...c, portal_slug: slugFor(c.name) } : c))
      state.portalAccess.push({ id: uid(), tenant_id: tenantId, counterparty_id: counterpartyId, kind: 'code', email: null, label: label.trim(), code_hint: code.slice(-2), expires_at: expiresAt, enabled: true, last_access_at: null, created_at: new Date().toISOString(), code })
      save()
      return { code, slug: state.counterparties.find((c) => c.id === counterpartyId)!.portal_slug! }
    },
    async regeneratePortalCode(tenantId, accessId) {
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
      const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join('')
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
      const access = state.portalAccess.find((a) => a.id === accessId && a.tenant_id === tenantId && a.kind === 'code')
      if (!access) throw new Error('Sin permisos')
      access.code = code
      access.code_hint = code.slice(-2)
      if (state.portalCodeAccessId === accessId) state.portalCodeAccessId = null
      save()
      return { code, slug: state.counterparties.find((c) => c.id === access.counterparty_id)!.portal_slug! }
    },
    async portalRedeemCode(slug, code) {
      const c = state.counterparties.find((x) => x.portal_slug === slug)
      const normalize = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '')
      const access = c && state.portalAccess.find((a) => a.counterparty_id === c.id && a.kind === 'code' && a.enabled && (!a.expires_at || a.expires_at > new Date().toISOString()) && a.code && normalize(a.code) === normalize(code))
      if (!access) throw new Error('Código inválido o vencido')
      state.portalCodeAccessId = access.id
      state.portalEmail = null
      access.last_access_at = new Date().toISOString()
      save()
    },
    async portalPublicInfo(slug) {
      const c = state.counterparties.find((x) => x.portal_slug === slug)
      const t = c && state.tenants.find((x) => x.id === c.tenant_id)
      if (!c || !t?.portal_enabled || !state.portalAccess.some((a) => a.counterparty_id === c.id && a.enabled)) return null
      return { tenant_name: t.legal_name ?? t.name, counterparty_name: c.name, message: t.portal_message }
    },
    async portalSession() {
      return state.portalEmail ?? (state.portalCodeAccessId ? 'Acceso con código' : null)
    },
    async portalSignOut() {
      state.portalEmail = null
      state.portalCodeAccessId = null
      save()
    },
    async portalSendCode(email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('Correo inválido')
    },
    async portalVerifyCode(email, code) {
      if (code.trim() !== DEMO_PORTAL_CODE) throw new Error('Código inválido o vencido.')
      state.portalEmail = email.trim().toLowerCase()
      state.portalCodeAccessId = null
      save()
    },
    async portalAccounts() {
      return delay(
        state.portalAccess
          .filter((a) => portalGrants(a) && state.tenants.find((t) => t.id === a.tenant_id)?.portal_enabled)
          .map((a) => {
            const t = state.tenants.find((x) => x.id === a.tenant_id)!
            const c = state.counterparties.find((x) => x.id === a.counterparty_id)!
            return { access_id: a.id, tenant_id: t.id, tenant_name: t.legal_name ?? t.name, counterparty_id: c.id, counterparty_name: c.name, is_supplier: c.is_supplier, is_customer: c.is_customer, portal_slug: c.portal_slug ?? null }
          }),
      )
    },
    async portalSnapshot(tenantId, counterpartyId) {
      const access = state.portalAccess.find((a) => a.tenant_id === tenantId && a.counterparty_id === counterpartyId && portalGrants(a))
      const t = state.tenants.find((x) => x.id === tenantId)
      if (!access || !t?.portal_enabled) throw new Error('Sin acceso a este portal')
      access.last_access_at = new Date().toISOString()
      save()
      const c = state.counterparties.find((x) => x.id === counterpartyId)!
      const snapshot: PortalSnapshot = {
        tenant: { name: t.legal_name ?? t.name, tax_id: t.tax_id, country: t.country, message: t.portal_message },
        counterparty: { name: c.name, legal_name: c.legal_name, tax_id: c.tax_id, country: c.country, is_supplier: c.is_supplier, is_customer: c.is_customer, email: c.email, phone: c.phone, address: c.address },
        documents: balances(tenantId)
          .filter((d) => d.counterparty_id === counterpartyId && d.status !== 'draft')
          .map((d) => ({
            id: d.id, direction: d.direction, doc_type: d.doc_type, folio: d.folio, currency: d.currency, total_amount: d.total_amount,
            paid_amount: d.paid_amount, pending_amount: d.pending_amount, issue_date: d.issue_date, due_date: d.due_date,
            scheduled_payment_date: d.scheduled_payment_date, payment_status: d.payment_status, days_overdue: d.days_overdue,
            detraction_amount: d.detraction_amount, detraction_status: d.detraction_status,
            attachments: state.attachments.filter((a) => a.document_id === d.id).map((a) => ({ id: a.id, file_name: a.file_name, storage_path: a.storage_path, size_bytes: a.size_bytes })),
            payment_url: null,
            approval_status: d.approval_status,
            rejection_reason: d.rejection_reason,
            payment_management: d.payment_management,
            purchase_order_number: d.purchase_order_number,
          })),
        purchase_orders: poBalances(tenantId)
          .filter((o) => o.counterparty_id === counterpartyId && (o.direction === 'payable' ? ['approved', 'closed'].includes(o.status) : !['draft', 'void'].includes(o.status)))
          .map((o) => ({
            id: o.id, direction: o.direction, number: o.number, status: o.status, currency: o.currency, issue_date: o.issue_date, delivery_date: o.delivery_date,
            net_amount: o.net_amount, exempt_amount: o.exempt_amount, tax_amount: o.tax_amount, total_amount: o.total_amount,
            invoiced_amount: o.invoiced_amount, remaining_amount: o.remaining_amount, billing_status: o.billing_status,
            payment_terms_days: o.payment_terms_days, notes: o.notes,
            lines: state.poLines.filter((l) => l.purchase_order_id === o.id).map(({ description, quantity, unit_price, discount, amount }) => ({ description, quantity, unit_price, discount, amount })),
          })),
        payments: state.payments
          .filter((p) => p.tenant_id === tenantId && p.counterparty_id === counterpartyId && p.status === 'confirmed')
          .map((p) => ({ id: p.id, direction: p.direction, currency: p.currency, amount: p.amount, paid_on: p.paid_on, method: p.method, reference: p.reference,
            folios: p.allocations.map((a) => state.documents.find((d) => d.id === a.document_id)?.folio ?? '') })),
        bank_accounts: state.bankAccounts.filter((b) => b.tenant_id === tenantId && b.counterparty_id === counterpartyId),
      }
      return delay(snapshot)
    },
    async portalFileUrl(storagePath) {
      const found = state.attachments.find((a) => a.storage_path === storagePath)
      if (!found) throw new Error('No se pudo descargar el archivo.')
      return found.data_url
    },

    async portalComments(documentId) {
      const doc = state.documents.find((d) => d.id === documentId)
      const ok = doc && state.portalAccess.some((a) => portalGrants(a) && a.counterparty_id === doc.counterparty_id && a.tenant_id === doc.tenant_id)
      if (!ok) throw new Error('Sin acceso a este documento')
      return delay(state.comments.filter((c) => c.document_id === documentId && c.visibility === 'shared').map(({ id, author_kind, author_name, body, created_at }) => ({ id, author_kind, author_name, body, created_at })))
    },
    async portalAddComment(documentId, body) {
      const doc = state.documents.find((d) => d.id === documentId)
      const ok = doc && state.portalAccess.some((a) => portalGrants(a) && a.counterparty_id === doc.counterparty_id && a.tenant_id === doc.tenant_id)
      if (!ok || !doc) throw new Error('Sin acceso a este documento')
      state.comments.push({ id: uid(), tenant_id: doc.tenant_id, document_id: documentId, visibility: 'shared', author_kind: 'counterparty', author_id: null, author_name: state.portalEmail ?? state.portalAccess.find((a) => a.id === state.portalCodeAccessId)?.label ?? null, body: body.trim(), created_at: new Date().toISOString() })
      save()
    },

    async getIntegration(tenantId, provider) {
      return delay(state.integrations.find((i) => i.tenant_id === tenantId && i.provider === provider) ?? null)
    },
    async connectMercadoPago(tenantId, input) {
      if (!/^(APP_USR|TEST)-/.test(input.accessToken)) throw new Error('Access token inválido')
      if (input.webhookSecret.length < 16) throw new Error('Clave secreta de webhook inválida')
      const tenant = state.tenants.find((t) => t.id === tenantId)
      state.integrations = state.integrations.filter((i) => !(i.tenant_id === tenantId && i.provider === 'mercadopago'))
      state.integrations.push({
        id: uid(), tenant_id: tenantId, provider: 'mercadopago', status: 'active', last_event_at: null, last_error: null,
        public_config: { nickname: 'CUENTA_DEMO', site_id: tenant?.country === 'PE' ? 'MPE' : 'MLC', currency: tenant?.base_currency, token_last4: input.accessToken.slice(-4), sandbox: input.accessToken.startsWith('TEST-') },
      })
      save()
      return { webhookUrl: `https://<tu-proyecto>.supabase.co/functions/v1/mercadopago-webhook?tenant=${tenantId}` }
    },
    async createPaymentLink(tenantId, documentId) {
      if (!state.integrations.some((i) => i.tenant_id === tenantId && i.provider === 'mercadopago')) throw new Error('MercadoPago no está conectado')
      return { url: `https://www.mercadopago.cl/checkout/v1/redirect?pref_id=demo-${documentId.slice(0, 8)}` }
    },
  }
}
