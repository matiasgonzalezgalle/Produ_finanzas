// Contrato de acceso a datos. La UI depende solo de esta interfaz, así se puede
// cambiar el backend (Supabase, demo en memoria, API propia) sin tocar pantallas.
import type { Country } from '../domain/taxId'
import type { DocumentDirection } from '../domain/documents'
import type {
  Contact,
  ContactInput,
  Counterparty,
  CounterpartyInput,
  DocumentInput,
  DocumentRow,
  IntegrationConnection,
  Payment,
  PaymentInput,
  Tenant,
} from './types'

export interface Session {
  userId: string
  email: string
  fullName: string
}

export interface DataApi {
  readonly mode: 'supabase' | 'demo'

  // Auth
  getSession(): Promise<Session | null>
  onSessionChange(cb: (session: Session | null) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string, fullName: string): Promise<{ needsConfirmation: boolean }>
  signOut(): Promise<void>

  // Empresas (tenants)
  listTenants(): Promise<Tenant[]>
  createTenant(input: { name: string; country: Country; legal_name?: string; tax_id?: string }): Promise<Tenant>

  // Contrapartes
  listCounterparties(tenantId: string): Promise<Counterparty[]>
  saveCounterparty(tenantId: string, input: CounterpartyInput, id?: string): Promise<Counterparty>
  listContacts(tenantId: string): Promise<Contact[]>
  saveContact(tenantId: string, input: ContactInput, id?: string): Promise<Contact>

  // Documentos
  listDocuments(tenantId: string, direction: DocumentDirection): Promise<DocumentRow[]>
  saveDocument(tenantId: string, input: DocumentInput, id?: string): Promise<void>
  voidDocument(tenantId: string, id: string): Promise<void>

  // Pagos y cobros
  listPayments(tenantId: string, direction: 'in' | 'out'): Promise<Payment[]>
  createPayment(tenantId: string, input: PaymentInput): Promise<void>

  // Integraciones
  getIntegration(tenantId: string, provider: 'mercadopago'): Promise<IntegrationConnection | null>
  connectMercadoPago(tenantId: string, input: { accessToken: string; webhookSecret: string }): Promise<{ webhookUrl: string }>
  createPaymentLink(tenantId: string, documentId: string): Promise<{ url: string }>
}
