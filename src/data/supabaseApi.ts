import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { DataApi, Session } from './api'
import type { AccountingCategory, AllocationLine, CostCenter, DocumentComment, PortalComment, Attachment, BankAccount, Contact, Counterparty, CounterpartyInput, DocumentRow, IntegrationConnection, Member, Payment, PortalAccess, PortalAccount, PortalPublicInfo, PortalSnapshot, Tenant, DocumentTypeSetting, ModuleSettings, PaymentMethod, PurchaseOrderAttachment, PurchaseOrderLine, PurchaseOrderRow, SiiDocument, SiiImportResult, EmailLogRow, EmailSettings, CollectionEvent, CollectionRule, CounterpartyRuleSetting, AdminMember, AdminTenant, PlatformAdmin, TenantUser, BankConnection, BankFeedAccount, BankMovement, BankImport } from './types'
import { DEFAULT_MODULE_SETTINGS } from './defaults'

function toSession(user: User | null | undefined): Session | null {
  // Las sesiones anónimas son solo del portal (acceso con código): no entran a la app interna.
  if (!user || user.is_anonymous) return null
  return {
    userId: user.id,
    email: user.email ?? '',
    fullName: (user.user_metadata?.full_name as string | undefined) ?? user.email?.split('@')[0] ?? '',
    mustChangePassword: user.user_metadata?.must_change_password === true,
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
      // FunctionsHttpError trae la respuesta; los errores de red (CORS, sin conexión) no.
      const context = (error as { context?: unknown }).context
      const detail = context instanceof Response ? await context.clone().json().catch(() => null) : null
      if (detail?.error) throw new Error(detail.error)
      if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError') {
        throw new Error('No se pudo contactar al servidor. Revisa tu conexión o inténtalo de nuevo en unos minutos.')
      }
      throw new Error(error.message)
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
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: `${window.location.origin}/` } })
      if (error) throw new Error(error.message)
      return { needsConfirmation: !data.session }
    },
    async signOut() {
      await sb.auth.signOut()
    },
    async requestPasswordReset(email, redirectTo) {
      const { error } = await sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo })
      if (error) throw new Error(error.message.includes('rate') ? 'Demasiados intentos. Espera unos minutos.' : error.message)
    },
    async updatePassword(password, fullName) {
      const { error } = await sb.auth.updateUser({ password, data: { must_change_password: false, ...(fullName ? { full_name: fullName } : {}) } })
      if (error) {
        if (/different from the old/i.test(error.message)) throw new Error('La contraseña nueva debe ser distinta de la anterior.')
        if (/session/i.test(error.message)) throw new Error('El enlace venció o ya se usó. Pide uno nuevo.')
        throw new Error(error.message)
      }
    },

    async amIPlatformAdmin() {
      const { data, error } = await sb.rpc('am_i_platform_admin')
      return !error && data === true
    },
    async adminListTenants() {
      return check(await sb.rpc('admin_list_tenants')) as AdminTenant[]
    },
    async adminUpdateTenant(id, input) {
      check(await sb.rpc('admin_update_tenant', { p_id: id, p_name: input.name, p_legal_name: input.legal_name, p_tax_id: input.tax_id, p_modules: input.modules, p_status: input.status, p_admin_notes: input.admin_notes }))
    },
    async adminCreateTenant(input) {
      return invoke<{ tenantId: string; invited: boolean }>('platform-admin', { action: 'create_tenant', ...input })
    },
    async adminDeleteTenant(id, confirmName) {
      await invoke('platform-admin', { action: 'delete_tenant', tenantId: id, confirmName })
    },
    async adminTenantMembers(id) {
      return check(await sb.rpc('admin_tenant_members', { p_id: id })) as AdminMember[]
    },
    async adminListPlatformAdmins() {
      return check(await sb.rpc('admin_list_platform_admins')) as PlatformAdmin[]
    },
    async adminSetPlatformAdmin(email, enabled) {
      check(await sb.rpc('admin_set_platform_admin', { p_email: email, p_enabled: enabled }))
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
    async listTenantUsers(tenantId) {
      return check(await sb.rpc('tenant_user_list', { p_tenant_id: tenantId })) as TenantUser[]
    },
    async createTenantUser(tenantId, input) {
      return invoke('tenant-users', { action: 'create', tenantId, ...input })
    },
    async updateTenantUser(tenantId, userId, input) {
      await invoke('tenant-users', { action: 'update', tenantId, userId, ...input })
    },
    async setTenantUserPassword(tenantId, userId, password) {
      await invoke('tenant-users', { action: 'set_password', tenantId, userId, password })
    },
    async sendTenantUserReset(tenantId, userId) {
      await invoke('tenant-users', { action: 'send_reset', tenantId, userId })
    },
    async deleteTenantUser(tenantId, userId) {
      return invoke('tenant-users', { action: 'delete', tenantId, userId })
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
    async setPaymentStage(tenantId, id, stage, scheduledDate) {
      const patch: Record<string, unknown> = { payment_stage: stage }
      if (scheduledDate !== undefined) patch.scheduled_payment_date = scheduledDate
      check(await sb.from('documents').update(patch).eq('id', id).eq('tenant_id', tenantId))
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

    async listPurchaseOrders(tenantId, direction) {
      return check(await sb.from('purchase_order_balances').select('*').eq('tenant_id', tenantId).eq('direction', direction).order('issue_date', { ascending: false })) as PurchaseOrderRow[]
    },
    async listPurchaseOrderLines(tenantId, id) {
      const rows = check(await sb.from('purchase_order_lines').select('description, quantity, unit_price, discount, amount').eq('tenant_id', tenantId).eq('purchase_order_id', id).order('position')) as PurchaseOrderLine[]
      return rows.map((l) => ({ ...l, quantity: Number(l.quantity) }))
    },
    async savePurchaseOrder(tenantId, input, lines, id) {
      const { data, error } = await sb.rpc('save_purchase_order', { p_tenant_id: tenantId, p_id: id ?? null, p_data: input, p_lines: lines })
      check({ data, error })
      return data as string
    },
    async setPurchaseOrderStatus(tenantId, id, status, reason) {
      check(await sb.from('purchase_orders').update({ status, rejection_reason: status === 'rejected' ? reason ?? null : null }).eq('id', id).eq('tenant_id', tenantId))
    },
    async markPurchaseOrderSent(tenantId, id, sentTo) {
      check(await sb.from('purchase_orders').update(sentTo === null ? { sent_at: null, sent_to: null } : { sent_at: new Date().toISOString(), sent_to: sentTo || null }).eq('id', id).eq('tenant_id', tenantId))
    },
    async deletePurchaseOrder(tenantId, id) {
      const files = check(await sb.from('purchase_order_attachments').select('storage_path').eq('purchase_order_id', id).eq('tenant_id', tenantId)) as { storage_path: string }[]
      check(await sb.from('purchase_orders').delete().eq('id', id).eq('tenant_id', tenantId))
      if (files.length) await sb.storage.from('documents').remove(files.map((f) => f.storage_path))
    },
    async listPurchaseOrderAttachments(tenantId, id) {
      return check(await sb.from('purchase_order_attachments').select('*').eq('tenant_id', tenantId).eq('purchase_order_id', id).order('created_at')) as PurchaseOrderAttachment[]
    },
    async uploadPurchaseOrderAttachment(tenantId, id, file) {
      if (file.size > 20 * 1024 * 1024) throw new Error('El archivo supera 20 MB')
      const safeName = file.name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-120)
      const path = `${tenantId}/po/${id}/${crypto.randomUUID()}-${safeName}`
      const { error } = await sb.storage.from('documents').upload(path, file, { contentType: file.type || undefined, upsert: false })
      if (error) throw new Error(error.message)
      const res = await sb.from('purchase_order_attachments').insert({
        tenant_id: tenantId, purchase_order_id: id, storage_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
      })
      if (res.error) {
        await sb.storage.from('documents').remove([path])
        check(res)
      }
    },
    async deletePurchaseOrderAttachment(tenantId, attachment) {
      check(await sb.from('purchase_order_attachments').delete().eq('id', attachment.id).eq('tenant_id', tenantId))
      await sb.storage.from('documents').remove([attachment.storage_path])
    },
    async purchaseOrderAttachmentUrl(_tenantId, attachment) {
      const { data, error } = await sb.storage.from('documents').createSignedUrl(attachment.storage_path, 300, { download: attachment.file_name })
      if (error) throw new Error(error.message)
      return data.signedUrl
    },

    async getModuleSettings(tenantId, direction) {
      const row = check(await sb.from('module_settings').select('direction, require_approval, require_allocation, require_purchase_order, allow_partial_payments, default_due_days, po_prefix, po_next_number, po_approval_admin_only').eq('tenant_id', tenantId).eq('direction', direction).maybeSingle())
      return (row ?? { ...DEFAULT_MODULE_SETTINGS, direction, require_approval: direction === 'payable' }) as ModuleSettings
    },
    async saveModuleSettings(tenantId, direction, input) {
      check(await sb.from('module_settings').upsert({ ...input, tenant_id: tenantId, direction }))
    },
    async listDocumentTypeSettings(tenantId, direction) {
      return check(await sb.from('document_type_settings').select('doc_type, can_create, can_pay').eq('tenant_id', tenantId).eq('direction', direction)) as DocumentTypeSetting[]
    },
    async saveDocumentTypeSetting(tenantId, direction, input) {
      check(await sb.from('document_type_settings').upsert({ ...input, tenant_id: tenantId, direction }))
    },
    async listPaymentMethods(tenantId, direction) {
      return check(await sb.from('payment_methods').select('id, direction, name, active, is_default, position').eq('tenant_id', tenantId).eq('direction', direction).order('position').order('name')) as PaymentMethod[]
    },
    async savePaymentMethod(tenantId, input, id) {
      check(await (id ? sb.from('payment_methods').update(input).eq('id', id).eq('tenant_id', tenantId) : sb.from('payment_methods').insert({ ...input, tenant_id: tenantId })))
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
      const createdAnonymous = !data.session
      if (createdAnonymous) {
        const { error } = await sb.auth.signInAnonymously()
        if (error) throw new Error('El ingreso con código no está habilitado. Pide a la empresa tu acceso.')
      }
      const { data: res, error } = await sb.rpc('portal_redeem_code', { p_slug: slug, p_code: code })
      if (error || !(res as { ok: boolean } | null)?.ok) {
        // Si la sesión anónima se creó para este intento y falló, no se deja abierta.
        if (createdAnonymous) await sb.auth.signOut()
        throw new Error(error ? error.message : (res as { error?: string } | null)?.error ?? 'Código inválido o vencido')
      }
    },
    async portalPublicInfo(slug) {
      const rows = check(await sb.rpc('portal_public_info', { p_slug: slug })) as PortalPublicInfo[]
      return rows[0] ?? null
    },
    async portalSession() {
      const { data } = await sb.auth.getSession()
      const user = data.session?.user
      if (!user) return null
      if (!user.is_anonymous) return user.email?.toLowerCase() ?? null
      // Sesión anónima: solo cuenta como ingresada si tiene un código canjeado vigente (12 h).
      // Así, mientras se canjea el código o cuando la sesión venció, se muestra el ingreso.
      const { data: accounts, error } = await sb.rpc('portal_my_accounts')
      return !error && Array.isArray(accounts) && accounts.length > 0 ? 'Acceso con código' : null
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
    async getEmailSettings(tenantId) {
      const row = check(await sb.from('tenant_email_settings').select('reply_to, notifications').eq('tenant_id', tenantId).maybeSingle())
      return (row ?? { reply_to: null, notifications: {} }) as EmailSettings
    },
    async saveEmailSettings(tenantId, input) {
      check(await sb.from('tenant_email_settings').upsert({ tenant_id: tenantId, reply_to: input.reply_to, notifications: input.notifications, updated_at: new Date().toISOString() }))
    },
    async listEmailLog(tenantId) {
      // Historial completo en bloques de 1000 (límite de PostgREST); la lista pagina en pantalla.
      const rows: EmailLogRow[] = []
      for (let from = 0; ; from += 1000) {
        const page = check(await sb.from('email_outbox').select('id, kind, status, recipients, subject, error, created_at, sent_at, counterparty_id, rule_id')
          .eq('tenant_id', tenantId).order('created_at', { ascending: false }).order('id').range(from, from + 999)) as EmailLogRow[]
        rows.push(...page)
        if (page.length < 1000) break
      }
      return rows
    },
    async dispatchEmails(tenantId) {
      await invoke('email-dispatch', { action: 'dispatch', tenantId })
    },
    async sendCollectionReminder(tenantId, documentId) {
      check(await sb.rpc('queue_collection_reminder', { p_document_id: documentId }))
      await invoke('email-dispatch', { action: 'dispatch', tenantId })
    },
    async sendPurchaseOrderEmail(tenantId, input) {
      await invoke('email-dispatch', { action: 'send_purchase_order', tenantId, ...input })
    },
    async listCollectionRules(tenantId) {
      return check(await sb.from('collection_rules').select('*').eq('tenant_id', tenantId).order('created_at')) as CollectionRule[]
    },
    async saveCollectionRule(tenantId, input, id) {
      const row = { ...input, updated_at: new Date().toISOString() }
      check(await (id ? sb.from('collection_rules').update(row).eq('id', id).eq('tenant_id', tenantId) : sb.from('collection_rules').insert({ ...row, tenant_id: tenantId })))
    },
    async deleteCollectionRule(tenantId, id) {
      check(await sb.from('collection_rules').delete().eq('id', id).eq('tenant_id', tenantId))
    },
    async listCounterpartyRuleSettings(tenantId, counterpartyId) {
      return check(await sb.from('counterparty_rule_settings').select('rule_id, enabled').eq('tenant_id', tenantId).eq('counterparty_id', counterpartyId)) as CounterpartyRuleSetting[]
    },
    async setCounterpartyRule(tenantId, counterpartyId, ruleId, enabled) {
      if (enabled === null) check(await sb.from('counterparty_rule_settings').delete().eq('tenant_id', tenantId).eq('counterparty_id', counterpartyId).eq('rule_id', ruleId))
      else check(await sb.from('counterparty_rule_settings').upsert({ tenant_id: tenantId, counterparty_id: counterpartyId, rule_id: ruleId, enabled }))
    },
    async listCollectionEvents(tenantId, counterpartyId) {
      let query = sb.from('collection_events').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(2000)
      if (counterpartyId) query = query.eq('counterparty_id', counterpartyId)
      return check(await query) as CollectionEvent[]
    },
    async addCollectionEvent(tenantId, input) {
      check(await sb.from('collection_events').insert({ ...input, tenant_id: tenantId }))
    },
    async setPromiseStatus(tenantId, id, status) {
      check(await sb.from('collection_events').update({ promise_status: status }).eq('id', id).eq('tenant_id', tenantId))
    },
    async deleteCollectionEvent(tenantId, id) {
      check(await sb.from('collection_events').delete().eq('id', id).eq('tenant_id', tenantId))
    },
    async sendCollectionEmail(tenantId, input) {
      check(await sb.rpc('queue_collection_email', { p_counterparty_id: input.counterpartyId, p_rule_id: input.ruleId ?? null, p_document_id: input.documentId ?? null }))
      await invoke('email-dispatch', { action: 'dispatch', tenantId })
    },
    async bankStart(tenantId) {
      return invoke('fintoc-bank', { action: 'start', tenantId })
    },
    async bankExchange(tenantId, exchangeToken) {
      return invoke('fintoc-bank', { action: 'exchange', tenantId, exchangeToken })
    },
    async bankSync(tenantId) {
      return invoke('fintoc-bank', { action: 'sync', tenantId })
    },
    async bankDisconnect(tenantId, connectionId) {
      await invoke('fintoc-bank', { action: 'disconnect', tenantId, connectionId })
    },
    async listBankConnections(tenantId) {
      return check(await sb.from('bank_connections').select('*').eq('tenant_id', tenantId).order('created_at')) as BankConnection[]
    },
    async listBankFeedAccounts(tenantId) {
      return check(await sb.from('bank_feed_accounts').select('*').eq('tenant_id', tenantId).order('created_at')) as BankFeedAccount[]
    },
    async listBankMovements(tenantId) {
      const rows: BankMovement[] = []
      for (let from = 0; ; from += 1000) {
        const page = check(await sb.from('bank_movements').select('*').eq('tenant_id', tenantId).order('post_date', { ascending: false }).order('id').range(from, from + 999)) as BankMovement[]
        rows.push(...page)
        if (page.length < 1000) return rows
      }
    },
    async reconcileMovement(tenantId, movementId, paymentId) {
      check(await sb.rpc('reconcile_bank_movement', { p_tenant_id: tenantId, p_movement_id: movementId, p_payment_id: paymentId }))
    },
    async createPaymentFromMovement(tenantId, movementId, input) {
      return check(await sb.rpc('create_payment_from_movement', {
        p_tenant_id: tenantId, p_movement_id: movementId, p_counterparty_id: input.counterparty_id, p_method: input.method, p_notes: input.notes,
        p_allocations: input.allocations.map((a) => ({ document_id: a.document_id, amount: a.amount })),
      })) as string
    },
    async saveFeedAccount(tenantId, id, input) {
      return check(await sb.rpc('save_bank_account', { p_tenant_id: tenantId, p_id: id, p_data: input })) as string
    },
    async deleteFeedAccount(tenantId, id) {
      check(await sb.rpc('delete_bank_account', { p_tenant_id: tenantId, p_id: id }))
    },
    async importStatement(tenantId, accountId, input) {
      return check(await sb.rpc('import_bank_movements', {
        p_tenant_id: tenantId, p_account_id: accountId, p_file_name: input.fileName, p_rows: input.rows, p_mapping: input.mapping, p_closing_balance: input.closingBalance,
      })) as { import_id: string; inserted: number; duplicates: number }
    },
    async listBankImports(tenantId) {
      return check(await sb.from('bank_statement_imports').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })) as BankImport[]
    },
    async deleteBankImport(tenantId, importId) {
      return check(await sb.rpc('delete_bank_import', { p_tenant_id: tenantId, p_import_id: importId })) as { deleted: number; kept: number }
    },
    async setMovementStatus(tenantId, movementId, status, reason) {
      check(await sb.rpc('set_bank_movement_status', { p_tenant_id: tenantId, p_movement_id: movementId, p_status: status, p_reason: reason ?? null }))
    },
    async siiStart(tenantId) {
      return invoke<{ publicKey: string; webhookUrl: string; holderId: string | null }>('fintoc-sii', { action: 'start', tenantId })
    },
    async siiSync(tenantId) {
      return invoke<{ fetched: number; syncedAt: string }>('fintoc-sii', { action: 'sync', tenantId })
    },
    async siiDisconnect(tenantId) {
      await invoke('fintoc-sii', { action: 'disconnect', tenantId })
    },
    async listSiiDocuments(tenantId, direction) {
      const rows: SiiDocument[] = []
      // Hasta 12 meses de documentos: se leen en bloques de 1000 (límite de PostgREST).
      for (let from = 0; ; from += 1000) {
        const page = check(await sb.from('sii_document_status').select('*').eq('tenant_id', tenantId).eq('direction', direction)
          .order('issue_date', { ascending: false }).order('id').range(from, from + 999)) as SiiDocument[]
        rows.push(...page)
        if (page.length < 1000) break
      }
      return rows
    },
    async importSiiDocuments(tenantId, ids) {
      const { data, error } = await sb.rpc('import_sii_documents', { p_tenant_id: tenantId, p_ids: ids })
      check({ data, error })
      return data as SiiImportResult
    },
    async setSiiIgnored(tenantId, id, ignored) {
      check(await sb.from('sii_documents').update({ ignored }).eq('id', id).eq('tenant_id', tenantId))
    },
    async createPaymentLink(tenantId, documentId) {
      return invoke<{ url: string }>('mercadopago-create-link', { tenantId, documentId })
    },
  }
}
