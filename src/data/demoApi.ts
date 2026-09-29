// Backend de demostración en memoria (persistido en localStorage del navegador).
// Sirve para ver y probar la app sin un proyecto Supabase. Replica las reglas clave del SQL.
import type { DataApi, Session } from './api'
import type { Contact, Counterparty, DocumentInput, DocumentRow, IntegrationConnection, Payment, Tenant } from './types'
import { computeBalance } from '../domain/documents'
import { todayIn } from '../domain/dates'

interface StoredDocument extends DocumentInput {
  id: string
  tenant_id: string
}

interface State {
  session: Session | null
  tenants: Tenant[]
  counterparties: Counterparty[]
  contacts: Contact[]
  documents: StoredDocument[]
  payments: Omit<Payment, 'counterparty_name'>[]
  integrations: (IntegrationConnection & { tenant_id: string })[]
}

const KEY = 'produ-finanzas:demo:v1'
const uid = () => crypto.randomUUID()

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
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
  const doc = (d: Partial<StoredDocument> & Pick<StoredDocument, 'direction' | 'counterparty_id' | 'folio' | 'total_amount'>): StoredDocument => ({
    id: uid(), tenant_id: tenantId, doc_type: 'factura', currency: 'CLP', net_amount: Math.round(d.total_amount / 1.19),
    exempt_amount: 0, tax_amount: d.total_amount - Math.round(d.total_amount / 1.19), issue_date: addDays(today, -20),
    due_date: addDays(today, 10), status: 'open', applies_to_id: null, detraction_rate: 0, detraction_amount: 0,
    detraction_status: 'no_aplica', description: null, ...d,
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
  const payments: State['payments'] = [
    { id: uid(), tenant_id: tenantId, direction: 'out', counterparty_id: transporte.id, currency: 'CLP', amount: 240_000, paid_on: addDays(today, -4), method: 'transferencia', reference: 'TRF 88213', notes: null, source: 'manual', status: 'confirmed', allocations: [{ document_id: documents[1].id, amount: 240_000 }] },
    { id: uid(), tenant_id: tenantId, direction: 'in', counterparty_id: canal.id, currency: 'CLP', amount: 3_000_000, paid_on: addDays(today, -8), method: 'transferencia', reference: 'Abono Canal Uno', notes: null, source: 'manual', status: 'confirmed', allocations: [{ document_id: documents[7].id, amount: 3_000_000 }] },
  ]
  return {
    session: null,
    tenants: [
      { id: tenantId, name: 'Nube Films SpA', legal_name: 'Nube Films SpA', tax_id: '76086428-5', country: 'CL', base_currency: 'CLP', timezone: 'America/Santiago', role: 'owner' },
    ],
    counterparties,
    contacts: [
      { id: uid(), tenant_id: tenantId, counterparty_id: canal.id, name: 'Paula Rojas', position: 'Jefa de pagos', email: 'pagos@canaluno.example', phone: '+56 2 2345 6789' },
      { id: uid(), tenant_id: tenantId, counterparty_id: hotel.id, name: 'Diego Soto', position: 'Cobranza', email: 'cobranza@cordillera.example', phone: null },
    ],
    documents,
    payments,
    integrations: [],
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
      }
    })
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
        base_currency: input.country === 'CL' ? 'CLP' : 'PEN', timezone: input.country === 'CL' ? 'America/Santiago' : 'America/Lima', role: 'owner',
      }
      state.tenants.push(tenant)
      save()
      return delay(tenant)
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
      if (id) state.documents = state.documents.map((d) => (d.id === id ? { ...d, ...input } : d))
      else state.documents.push({ ...input, id: uid(), tenant_id: tenantId })
      save()
    },
    async voidDocument(tenantId, id) {
      state.documents = state.documents.map((d) => (d.id === id && d.tenant_id === tenantId ? { ...d, status: 'void' } : d))
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
        if (d.currency !== input.currency) throw new Error(`La moneda del pago (${input.currency}) no coincide con la del documento (${d.currency})`)
        if (a.amount > d.pending_amount) throw new Error('La asignación supera el saldo pendiente del documento')
      }
      state.payments.push({ ...input, id: uid(), tenant_id: tenantId, source: 'manual', status: 'confirmed' })
      save()
    },

    async voidPayment(tenantId, id) {
      state.payments = state.payments.map((p) => (p.id === id && p.tenant_id === tenantId ? { ...p, status: 'void' } : p))
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
