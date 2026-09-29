import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { DataApi, Session } from './api'
import type { AccountingCategory, AllocationLine, CostCenter, DocumentComment, PortalComment, Attachment, BankAccount, Contact, Counterparty, CounterpartyInput, DocumentRow, IntegrationConnection, Member, Payment, PortalAccess, PortalAccount, PortalPublicInfo, PortalSnapshot, Tenant } from './types'

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

    async updateTenant(tenantId, input) {
      check(await sb.from('tenants').update(input).eq('id', tenantId))
    },

    async listMembers(tenantId) {
      return check(
        await sb.from('tenant_member_list').select('user_id, role, full_name, email, created_at').eq('tenant_id', tenantId).order('created_at'),
      ) as Member[]
    },
    async inviteMember(tenantId, input) {
      return invoke<{ invited: boolean }>('tenant-invite', { tenantId, ...input })
    },
    async updateMemberRole(tenantId, userId, role) {
      check(await sb.from('tenant_members').update({ role }).eq('tenant_id', tenantId).eq('user_id', userId))
    },
    async removeMember(tenantId, userId) {
      check(await sb.from('tenant_members').delete().eq('tenant_id', tenantId).eq('user_id', userId))
    },

    async listCounterparties(tenantId) {
      return check(await sb.from('counterparties').select('*').eq('tenant_id', tenantId).order('name')) as Counterparty[]
    },
    async saveCounterparty(tenantId, input, id) {
      // El slug del portal lo gestiona la base de datos: nunca se envía desde el formulario.
      const { portal_slug: _ignored, ...clean } = input as CounterpartyInput & { portal_slug?: unknown }
      void _ignored
      const query = id
        ? sb.from('counterparties').update(clean).eq('id', id).eq('tenant_id', tenantId)
        : sb.from('counterparties').insert({ ...clean, tenant_id: tenantId })
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

    async listBankAccounts(tenantId, counterpartyId) {
      return check(
        await sb.from('bank_accounts').select('id, counterparty_id, bank_name, account_type, account_number, holder_name, holder_tax_id, email, currency')
          .eq('tenant_id', tenantId).eq('counterparty_id', counterpartyId).order('created_at'),
      ) as BankAccount[]
    },
    async saveBankAccount(tenantId, input, id) {
      const query = id
        ? sb.from('bank_accounts').update(input).eq('id', id).eq('tenant_id', tenantId)
        : sb.from('bank_accounts').insert({ ...input, tenant_id: tenantId })
      check(await query)
    },
    async deleteBankAccount(tenantId, id) {
      check(await sb.from('bank_accounts').delete().eq('id', id).eq('tenant_id', tenantId))
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
      return (check(await query.select('id').single()) as { id: string }).id
    },
    async voidDocument(tenantId, id) {
      check(await sb.from('documents').update({ status: 'void' }).eq('id', id).eq('tenant_id', tenantId))
    },

    async deleteDocument(tenantId, id) {
      const files = check(await sb.from('document_attachments').select('storage_path').eq('document_id', id).eq('tenant_id', tenantId)) as { storage_path: string }[]
      check(await sb.from('documents').delete().eq('id', id).eq('tenant_id', tenantId))
      if (files.length) await sb.storage.from('documents').remove(files.map((f) => f.storage_path))
    },
    async listAttachments(tenantId, documentId) {
      return check(
        await sb.from('document_attachments').select('*').eq('tenant_id', tenantId).eq('document_id', documentId).order('created_at'),
      ) as Attachment[]
    },
    async uploadAttachment(tenantId, documentId, file) {
      if (file.size > 20 * 1024 * 1024) throw new Error('El archivo supera 20 MB')
      const safeName = file.name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-120)
      const path = `${tenantId}/${documentId}/${crypto.randomUUID()}-${safeName}`
      const { error } = await sb.storage.from('documents').upload(path, file, { contentType: file.type || undefined, upsert: false })
      if (error) throw new Error(error.message)
      const res = await sb.from('document_attachments').insert({
        tenant_id: tenantId, document_id: documentId, storage_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
      })
      if (res.error) {
        await sb.storage.from('documents').remove([path])
        check(res)
      }
    },
    async deleteAttachment(tenantId, attachment) {
      check(await sb.from('document_attachments').delete().eq('id', attachment.id).eq('tenant_id', tenantId))
      await sb.storage.from('documents').remove([attachment.storage_path])
    },
    async attachmentUrl(_tenantId, attachment) {
      const { data, error } = await sb.storage.from('documents').createSignedUrl(attachment.storage_path, 300, { download: attachment.file_name })
      if (error) throw new Error(error.message)
      return data.signedUrl
    },

    async setApproval(tenantId, id, status, reason) {
      check(await sb.from('documents').update({ approval_status: status, rejection_reason: status === 'rejected' ? reason ?? null : null }).eq('id', id).eq('tenant_id', tenantId))
    },
    async listDocumentAllocations(tenantId, documentId) {
      return check(
        await sb.from('document_allocations').select('category_id, cost_center_id, description, amount').eq('tenant_id', tenantId).eq('document_id', documentId).order('position'),
      ) as AllocationLine[]
    },
    async setDocumentAllocations(_tenantId, documentId, lines) {
      check(await sb.rpc('set_document_allocations', { p_document_id: documentId, p_lines: lines }))
    },
    async listComments(tenantId, documentId) {
      return check(
        await sb.from('document_comments').select('id, visibility, author_kind, author_id, author_name, body, created_at').eq('tenant_id', tenantId).eq('document_id', documentId).order('created_at'),
      ) as DocumentComment[]
    },
    async addComment(tenantId, documentId, body, visibility) {
      const { data } = await sb.auth.getUser()
      const name = (data.user?.user_metadata?.full_name as string | undefined) ?? data.user?.email ?? null
      check(await sb.from('document_comments').insert({ tenant_id: tenantId, document_id: documentId, body: body.trim(), visibility, author_kind: 'member', author_id: data.user?.id, author_name: name }))
    },
    async deleteComment(tenantId, id) {
      check(await sb.from('document_comments').delete().eq('id', id).eq('tenant_id', tenantId))
    },
    async listCategories(tenantId) {
      return check(await sb.from('accounting_categories').select('id, code, name, kind, active').eq('tenant_id', tenantId).order('code')) as AccountingCategory[]
    },
    async saveCategory(tenantId, input, id) {
      check(await (id ? sb.from('accounting_categories').update(input).eq('id', id).eq('tenant_id', tenantId) : sb.from('accounting_categories').insert({ ...input, tenant_id: tenantId })))
    },
    async listCostCenters(tenantId) {
      return check(await sb.from('cost_centers').select('id, code, name, active').eq('tenant_id', tenantId).order('code')) as CostCenter[]
    },
    async saveCostCenter(tenantId, input, id) {
      check(await (id ? sb.from('cost_centers').update(input).eq('id', id).eq('tenant_id', tenantId) : sb.from('cost_centers').insert({ ...input, tenant_id: tenantId })))
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

    async voidPayment(tenantId, id) {
      check(await sb.from('payments').update({ status: 'void' }).eq('id', id).eq('tenant_id', tenantId))
    },

    async listPortalAccess(tenantId) {
      return check(
        await sb.from('portal_access').select('id, counterparty_id, kind, email, label, code_hint, expires_at, enabled, last_access_at, created_at').eq('tenant_id', tenantId).order('created_at'),
      ) as PortalAccess[]
    },
    async addPortalAccess(tenantId, counterpartyId, email) {
      check(await sb.from('portal_access').insert({ tenant_id: tenantId, counterparty_id: counterpartyId, email: email.trim().toLowerCase() }))
    },
    async setPortalAccessEnabled(tenantId, id, enabled) {
      check(await sb.from('portal_access').update({ enabled }).eq('id', id).eq('tenant_id', tenantId))
    },
    async removePortalAccess(tenantId, id) {
      check(await sb.from('portal_access').delete().eq('id', id).eq('tenant_id', tenantId))
    },

    async regeneratePortalSlug(_tenantId, counterpartyId) {
      return check(await sb.rpc('regenerate_portal_slug', { p_counterparty_id: counterpartyId })) as string
    },
    async createPortalCode(_tenantId, counterpartyId, label, expiresAt) {
      return check(await sb.rpc('create_portal_code', { p_counterparty_id: counterpartyId, p_label: label, p_expires_at: expiresAt })) as { code: string; slug: string }
    },
    async regeneratePortalCode(_tenantId, accessId) {
      return check(await sb.rpc('regenerate_portal_code', { p_access_id: accessId })) as { code: string; slug: string }
    },
    async portalRedeemCode(slug, code) {
      const { data } = await sb.auth.getSession()
      if (!data.session) {
        const { error } = await sb.auth.signInAnonymously()
        if (error) throw new Error('El ingreso con código no está habilitado. Pide a la empresa tu acceso.')
      }
      const res = check(await sb.rpc('portal_redeem_code', { p_slug: slug, p_code: code })) as { ok: boolean; error?: string }
      if (!res.ok) throw new Error(res.error ?? 'Código inválido o vencido')
    },
    async portalPublicInfo(slug) {
      const rows = check(await sb.rpc('portal_public_info', { p_slug: slug })) as PortalPublicInfo[]
      return rows[0] ?? null
    },
    async portalSession() {
      const { data } = await sb.auth.getSession()
      const user = data.session?.user
      if (!user) return null
      return user.email?.toLowerCase() ?? (user.is_anonymous ? 'Acceso con código' : null)
    },
    async portalSignOut() {
      await sb.auth.signOut()
    },
    async portalSendCode(email, redirectTo) {
      const { error } = await sb.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true, emailRedirectTo: redirectTo } })
      if (error) throw new Error(error.message.includes('rate') ? 'Demasiados intentos. Espera unos minutos.' : error.message)
    },
    async portalVerifyCode(email, code) {
      const { error } = await sb.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
      if (error) throw new Error('Código inválido o vencido.')
    },
    async portalAccounts() {
      return check(await sb.rpc('portal_my_accounts')) as PortalAccount[]
    },
    async portalSnapshot(tenantId, counterpartyId) {
      return check(await sb.rpc('portal_snapshot', { p_tenant_id: tenantId, p_counterparty_id: counterpartyId })) as PortalSnapshot
    },
    async portalFileUrl(storagePath) {
      const { data, error } = await sb.storage.from('documents').createSignedUrl(storagePath, 300, { download: true })
      if (error) throw new Error('No se pudo descargar el archivo.')
      return data.signedUrl
    },

    async portalComments(documentId) {
      return check(await sb.rpc('portal_document_comments', { p_document_id: documentId })) as PortalComment[]
    },
    async portalAddComment(documentId, body) {
      check(await sb.rpc('portal_add_comment', { p_document_id: documentId, p_body: body }))
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
