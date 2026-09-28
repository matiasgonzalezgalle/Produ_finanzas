import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { DataApi, Session } from './api'
import type { Contact, Counterparty, DocumentRow, IntegrationConnection, Payment, Tenant } from './types'

function toSession(user: User | null | undefined): Session | null {
  if (!user) return null
  return {
    userId: user.id,
    email: user.email ?? '',
    fullName: (user.user_metadata?.full_name as string | undefined) ?? user.email?.split('@')[0] ?? '',
  }
}

/** Convierte errores de Postgres/RLS en mensajes legibles. */
function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    const { message, code } = result.error
    if (code === '23505') throw new Error('Ya existe un registro con esos datos (folio o RUT duplicado).')
    if (code === '42501') throw new Error('No tienes permisos para realizar esta acción.')
    throw new Error(message)
  }
  return result.data
}

export function createSupabaseApi(url: string, anonKey: string): DataApi {
  const sb: SupabaseClient = createClient(url, anonKey)

  async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await sb.functions.invoke<T>(name, { body })
    if (error) {
      const context = (error as { context?: Response }).context
      const detail = context ? await context.json().catch(() => null) : null
      throw new Error(detail?.error ?? error.message)
    }
    return data as T
  }

  return {
    mode: 'supabase',

    async getSession() {
      const { data } = await sb.auth.getSession()
      return toSession(data.session?.user)
    },
    onSessionChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => cb(toSession(session?.user)))
      return () => data.subscription.unsubscribe()
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password })
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : error.message)
    },
    async signUp(email, password, fullName) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: fullName } } })
      if (error) throw new Error(error.message)
      return { needsConfirmation: !data.session }
    },
    async signOut() {
      await sb.auth.signOut()
    },

    async listTenants() {
      const rows = check(await sb.from('tenant_members').select('role, tenants(*)').order('created_at'))
      return (rows as unknown as { role: Tenant['role']; tenants: Omit<Tenant, 'role'> }[])
        .filter((r) => r.tenants)
        .map((r) => ({ ...r.tenants, role: r.role }))
    },
    async createTenant(input) {
      const tenant = check(
        await sb.rpc('create_tenant', {
          p_name: input.name,
          p_country: input.country,
          p_legal_name: input.legal_name ?? null,
          p_tax_id: input.tax_id ?? null,
        }),
      ) as Omit<Tenant, 'role'>
      return { ...tenant, role: 'owner' }
    },

    async listCounterparties(tenantId) {
      return check(await sb.from('counterparties').select('*').eq('tenant_id', tenantId).order('name')) as Counterparty[]
    },
    async saveCounterparty(tenantId, input, id) {
      const query = id
        ? sb.from('counterparties').update(input).eq('id', id).eq('tenant_id', tenantId)
        : sb.from('counterparties').insert({ ...input, tenant_id: tenantId })
      return check(await query.select('*').single()) as Counterparty
    },
    async listContacts(tenantId) {
      const rows = check(
        await sb.from('contacts').select('*, counterparties(name)').eq('tenant_id', tenantId).order('name'),
      ) as (Contact & { counterparties: { name: string } | null })[]
      return rows.map(({ counterparties, ...c }) => ({ ...c, counterparty_name: counterparties?.name }))
    },
    async saveContact(tenantId, input, id) {
      const query = id
        ? sb.from('contacts').update(input).eq('id', id).eq('tenant_id', tenantId)
        : sb.from('contacts').insert({ ...input, tenant_id: tenantId })
      return check(await query.select('*').single()) as Contact
    },

    async listDocuments(tenantId, direction) {
      return check(
        await sb
          .from('document_balances')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('direction', direction)
          .order('due_date', { ascending: true, nullsFirst: false }),
      ) as DocumentRow[]
    },
    async saveDocument(tenantId, input, id) {
      const query = id
        ? sb.from('documents').update(input).eq('id', id).eq('tenant_id', tenantId)
        : sb.from('documents').insert({ ...input, tenant_id: tenantId })
      check(await query)
    },
    async voidDocument(tenantId, id) {
      check(await sb.from('documents').update({ status: 'void' }).eq('id', id).eq('tenant_id', tenantId))
    },

    async listPayments(tenantId, direction) {
      const rows = check(
        await sb
          .from('payments')
          .select('*, counterparties(name), payment_allocations(document_id, amount, documents(folio))')
          .eq('tenant_id', tenantId)
          .eq('direction', direction)
          .order('paid_on', { ascending: false }),
      ) as (Payment & {
        counterparties: { name: string } | null
        payment_allocations: { document_id: string; amount: number; documents: { folio: string } | null }[]
      })[]
      return rows.map(({ counterparties, payment_allocations, ...p }) => ({
        ...p,
        counterparty_name: counterparties?.name ?? null,
        allocations: payment_allocations.map((a) => ({ document_id: a.document_id, amount: a.amount, folio: a.documents?.folio })),
      }))
    },
    async createPayment(tenantId, input) {
      check(
        await sb.rpc('create_payment', {
          p_tenant_id: tenantId,
          p_direction: input.direction,
          p_counterparty_id: input.counterparty_id,
          p_currency: input.currency,
          p_amount: input.amount,
          p_paid_on: input.paid_on,
          p_method: input.method,
          p_reference: input.reference,
          p_notes: input.notes,
          p_allocations: input.allocations.map((a) => ({ document_id: a.document_id, amount: a.amount })),
        }),
      )
    },

    async getIntegration(tenantId, provider) {
      return check(
        await sb.from('integration_connections').select('*').eq('tenant_id', tenantId).eq('provider', provider).maybeSingle(),
      ) as IntegrationConnection | null
    },
    async connectMercadoPago(tenantId, input) {
      return invoke<{ webhookUrl: string }>('mercadopago-connect', { tenantId, ...input })
    },
    async createPaymentLink(tenantId, documentId) {
      return invoke<{ url: string }>('mercadopago-create-link', { tenantId, documentId })
    },
  }
}
