// Hooks de datos por feature. Las claves incluyen el tenant para no mezclar empresas en caché.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AccountingCategory, type AllocationLine, type ApprovalStatus, type CostCenter, type Attachment, type BankAccountInput, type MemberRole, type TenantInput, type ContactInput, type CounterpartyInput, type DocumentInput, type PaymentInput, type ModuleSettingsInput, type DocumentTypeSetting, type PaymentMethodInput, type PurchaseOrderAttachment, type PurchaseOrderInput, type PurchaseOrderLine, type PurchaseOrderStatus, type IntegrationProvider, type EmailSettings, type CollectionEventInput, type CollectionRuleInput, type AdminTenantInput, type MovementPaymentInput, type TenantUserInput } from '../data'
import type { DocumentDirection } from '../domain/documents'
import { useCurrentTenant } from './tenant'
import { useSession } from './session'

export function useCounterparties() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['counterparties', tenant.id], queryFn: () => api.listCounterparties(tenant.id) })
}

export function useSaveCounterparty() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, id }: { input: CounterpartyInput; id?: string }) => api.saveCounterparty(tenant.id, input, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] }),
  })
}

export function useContacts() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['contacts', tenant.id], queryFn: () => api.listContacts(tenant.id) })
}

export function useSaveContact() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, id }: { input: ContactInput; id?: string }) => api.saveContact(tenant.id, input, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts', tenant.id] }),
  })
}

export function useDocuments(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['documents', tenant.id, direction], queryFn: () => api.listDocuments(tenant.id, direction) })
}

/** Envía los avisos por correo que la base de datos anotó (sin esperar ni mostrar errores). */
export function kickEmails(tenantId: string) {
  api.dispatchEmails(tenantId).catch(() => undefined)
}

function useInvalidateFinance() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  // Programar/rechazar/pagar anota avisos por correo en la base de datos: se envían enseguida.
  return () => {
    kickEmails(tenant.id)
    return Promise.all([
      qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['payments', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['purchase-orders', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['bank', tenant.id] }),
    ])
  }
}

export function useSaveDocument() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: ({ input, id }: { input: DocumentInput; id?: string }) => api.saveDocument(tenant.id, input, id),
    onSuccess: invalidate,
  })
}

export function useDeleteDocument() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({ mutationFn: (id: string) => api.deleteDocument(tenant.id, id), onSuccess: invalidate })
}

export function useAttachments(documentId: string | undefined) {
  const { tenant } = useCurrentTenant()
  return useQuery({
    queryKey: ['attachments', tenant.id, documentId],
    queryFn: () => api.listAttachments(tenant.id, documentId!),
    enabled: !!documentId,
  })
}

export function useUploadAttachment() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, file }: { documentId: string; file: File }) => api.uploadAttachment(tenant.id, documentId, file),
    onSuccess: (_d, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['attachments', tenant.id, v.documentId] }),
        qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      ]),
  })
}

export function useDeleteAttachment() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (attachment: Attachment) => api.deleteAttachment(tenant.id, attachment),
    onSuccess: (_d, a) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['attachments', tenant.id, a.document_id] }),
        qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      ]),
  })
}

export function useVoidDocument() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({ mutationFn: (id: string) => api.voidDocument(tenant.id, id), onSuccess: invalidate })
}

export function usePayments(direction: 'in' | 'out') {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['payments', tenant.id, direction], queryFn: () => api.listPayments(tenant.id, direction) })
}

export function useCreatePayment() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({ mutationFn: (input: PaymentInput) => api.createPayment(tenant.id, input), onSuccess: invalidate })
}

export function useVoidPayment() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({ mutationFn: (id: string) => api.voidPayment(tenant.id, id), onSuccess: invalidate })
}

export function useIntegration(provider: IntegrationProvider) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['integration', tenant.id, provider], queryFn: () => api.getIntegration(tenant.id, provider) })
}

export function useConnectMercadoPago() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { accessToken: string; webhookSecret: string }) => api.connectMercadoPago(tenant.id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integration', tenant.id] }),
  })
}

export function useCreatePaymentLink() {
  const { tenant } = useCurrentTenant()
  return useMutation({ mutationFn: (documentId: string) => api.createPaymentLink(tenant.id, documentId) })
}

export function useMembers() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['members', tenant.id], queryFn: () => api.listMembers(tenant.id) })
}

export function useMemberMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['members', tenant.id] })
  return {
    invite: useMutation({ mutationFn: (input: { email: string; role: Exclude<MemberRole, 'owner'> }) => api.inviteMember(tenant.id, input), onSuccess }),
    setRole: useMutation({ mutationFn: ({ userId, role }: { userId: string; role: Exclude<MemberRole, 'owner'> }) => api.updateMemberRole(tenant.id, userId, role), onSuccess }),
    remove: useMutation({ mutationFn: (userId: string) => api.removeMember(tenant.id, userId), onSuccess }),
  }
}

export function useUpdateTenant() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({ mutationFn: (input: TenantInput) => api.updateTenant(tenant.id, input), onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }) })
}

export function usePortalAccess() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['portal-access', tenant.id], queryFn: () => api.listPortalAccess(tenant.id) })
}

export function usePortalAccessMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['portal-access', tenant.id] })
  return {
    add: useMutation({
      mutationFn: ({ counterpartyId, email }: { counterpartyId: string; email: string }) => api.addPortalAccess(tenant.id, counterpartyId, email),
      onSuccess: () => {
        kickEmails(tenant.id)
        return Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] })])
      },
    }),
    setEnabled: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setPortalAccessEnabled(tenant.id, id, enabled), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => api.removePortalAccess(tenant.id, id), onSuccess }),
    createCode: useMutation({
      mutationFn: ({ counterpartyId, label, expiresAt }: { counterpartyId: string; label: string; expiresAt: string | null }) =>
        api.createPortalCode(tenant.id, counterpartyId, label, expiresAt),
      onSuccess: () => Promise.all([onSuccess(), qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] })]),
    }),
    regenerateCode: useMutation({ mutationFn: (accessId: string) => api.regeneratePortalCode(tenant.id, accessId), onSuccess }),
    regenerate: useMutation({
      mutationFn: (counterpartyId: string) => api.regeneratePortalSlug(tenant.id, counterpartyId),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] }),
    }),
  }
}

export function useBankAccounts(counterpartyId: string) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['bank-accounts', tenant.id, counterpartyId], queryFn: () => api.listBankAccounts(tenant.id, counterpartyId) })
}

export function useBankAccountMutations(counterpartyId: string) {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['bank-accounts', tenant.id, counterpartyId] })
  return {
    save: useMutation({ mutationFn: ({ input, id }: { input: BankAccountInput; id?: string }) => api.saveBankAccount(tenant.id, input, id), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteBankAccount(tenant.id, id), onSuccess }),
  }
}

export function useSetApproval() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: ApprovalStatus; reason?: string }) => api.setApproval(tenant.id, id, status, reason),
    onSuccess: invalidate,
  })
}

export function useDocumentAllocations(documentId: string) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['allocations', tenant.id, documentId], queryFn: () => api.listDocumentAllocations(tenant.id, documentId) })
}

export function useSetDocumentAllocations(documentId: string) {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lines: AllocationLine[]) => api.setDocumentAllocations(tenant.id, documentId, lines),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['allocations', tenant.id, documentId] }),
        qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      ]),
  })
}

export function useComments(documentId: string) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['comments', tenant.id, documentId], queryFn: () => api.listComments(tenant.id, documentId) })
}

export function useCommentMutations(documentId: string) {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['comments', tenant.id, documentId] })
  return {
    add: useMutation({
      mutationFn: ({ body, visibility }: { body: string; visibility: 'internal' | 'shared' }) => api.addComment(tenant.id, documentId, body, visibility),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteComment(tenant.id, id), onSuccess }),
  }
}

export function useCategories() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['categories', tenant.id], queryFn: () => api.listCategories(tenant.id) })
}

export function useCostCenters() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['cost-centers', tenant.id], queryFn: () => api.listCostCenters(tenant.id) })
}

export function useCatalogMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return {
    saveCategory: useMutation({
      mutationFn: ({ input, id }: { input: Omit<AccountingCategory, 'id'>; id?: string }) => api.saveCategory(tenant.id, input, id),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', tenant.id] }),
    }),
    saveCostCenter: useMutation({
      mutationFn: ({ input, id }: { input: Omit<CostCenter, 'id'>; id?: string }) => api.saveCostCenter(tenant.id, input, id),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['cost-centers', tenant.id] }),
    }),
  }
}

export function useSetPaymentStage() {
  const { tenant } = useCurrentTenant()
  const invalidate = useInvalidateFinance()
  return useMutation({
    mutationFn: ({ id, stage, scheduledDate }: { id: string; stage: 'requested' | 'scheduled' | null; scheduledDate?: string | null }) =>
      api.setPaymentStage(tenant.id, id, stage, scheduledDate),
    onSuccess: invalidate,
  })
}

// ---------------------------------------------------------------------------
// Administradores de CxP / CxC
// ---------------------------------------------------------------------------
export function useModuleSettings(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['module-settings', tenant.id, direction], queryFn: () => api.getModuleSettings(tenant.id, direction) })
}

export function useSaveModuleSettings(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ModuleSettingsInput) => api.saveModuleSettings(tenant.id, direction, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['module-settings', tenant.id, direction] }),
  })
}

export function useDocumentTypeSettings(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['doc-type-settings', tenant.id, direction], queryFn: () => api.listDocumentTypeSettings(tenant.id, direction) })
}

export function useSaveDocumentTypeSetting(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DocumentTypeSetting) => api.saveDocumentTypeSetting(tenant.id, direction, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['doc-type-settings', tenant.id, direction] }),
  })
}

export function usePaymentMethods(direction: 'in' | 'out') {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['payment-methods', tenant.id, direction], queryFn: () => api.listPaymentMethods(tenant.id, direction) })
}

export function useSavePaymentMethod() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, id }: { input: PaymentMethodInput; id?: string }) => api.savePaymentMethod(tenant.id, input, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-methods', tenant.id] }),
  })
}

// ---------------------------------------------------------------------------
// Órdenes de compra
// ---------------------------------------------------------------------------
export function usePurchaseOrders(direction: DocumentDirection) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['purchase-orders', tenant.id, direction], queryFn: () => api.listPurchaseOrders(tenant.id, direction) })
}

export function usePurchaseOrderLines(id: string | undefined) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['purchase-orders', tenant.id, 'lines', id], queryFn: () => api.listPurchaseOrderLines(tenant.id, id!), enabled: !!id })
}

export function usePurchaseOrderAttachments(id: string | undefined) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['purchase-orders', tenant.id, 'files', id], queryFn: () => api.listPurchaseOrderAttachments(tenant.id, id!), enabled: !!id })
}

export function usePurchaseOrderMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const invalidate = useInvalidateFinance()
  const invalidateSettings = () => qc.invalidateQueries({ queryKey: ['module-settings', tenant.id] })
  return {
    save: useMutation({
      mutationFn: ({ input, lines, id }: { input: PurchaseOrderInput; lines: Omit<PurchaseOrderLine, 'amount'>[]; id?: string }) =>
        api.savePurchaseOrder(tenant.id, input, lines, id),
      onSuccess: () => Promise.all([invalidate(), invalidateSettings()]),
    }),
    setStatus: useMutation({
      mutationFn: ({ id, status, reason }: { id: string; status: PurchaseOrderStatus; reason?: string }) => api.setPurchaseOrderStatus(tenant.id, id, status, reason),
      onSuccess: invalidate,
    }),
    markSent: useMutation({
      mutationFn: ({ id, sentTo }: { id: string; sentTo: string | null }) => api.markPurchaseOrderSent(tenant.id, id, sentTo),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deletePurchaseOrder(tenant.id, id), onSuccess: invalidate }),
    upload: useMutation({
      mutationFn: ({ id, file }: { id: string; file: File }) => api.uploadPurchaseOrderAttachment(tenant.id, id, file),
      onSuccess: invalidate,
    }),
    removeFile: useMutation({
      mutationFn: (attachment: PurchaseOrderAttachment) => api.deletePurchaseOrderAttachment(tenant.id, attachment),
      onSuccess: invalidate,
    }),
  }
}

// ---------------------------------------------------------------------------
// Documentos del SII (Fintoc)
// ---------------------------------------------------------------------------
export function useSiiDocuments(direction: DocumentDirection, enabled = true) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['sii-documents', tenant.id, direction], queryFn: () => api.listSiiDocuments(tenant.id, direction), enabled })
}

export function useSiiMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['sii-documents', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['integration', tenant.id] }),
    ])
  const invalidateAll = () =>
    Promise.all([
      invalidate(),
      qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] }),
    ])
  return {
    start: useMutation({ mutationFn: () => api.siiStart(tenant.id), onSuccess: invalidate }),
    sync: useMutation({ mutationFn: () => api.siiSync(tenant.id), onSettled: invalidate }),
    disconnect: useMutation({ mutationFn: () => api.siiDisconnect(tenant.id), onSuccess: invalidate }),
    importDocs: useMutation({ mutationFn: (ids: string[]) => api.importSiiDocuments(tenant.id, ids), onSuccess: invalidateAll }),
    setIgnored: useMutation({ mutationFn: ({ id, ignored }: { id: string; ignored: boolean }) => api.setSiiIgnored(tenant.id, id, ignored), onSuccess: invalidate }),
  }
}

// ---------------------------------------------------------------------------
// Correos del negocio
// ---------------------------------------------------------------------------
export function useEmailSettings() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['email-settings', tenant.id], queryFn: () => api.getEmailSettings(tenant.id) })
}

export function useEmailLog() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['email-log', tenant.id], queryFn: () => api.listEmailLog(tenant.id) })
}

export function useEmailMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const invalidateLog = () => qc.invalidateQueries({ queryKey: ['email-log', tenant.id] })
  return {
    saveSettings: useMutation({
      mutationFn: (input: EmailSettings) => api.saveEmailSettings(tenant.id, input),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['email-settings', tenant.id] }),
    }),
    dispatch: useMutation({ mutationFn: () => api.dispatchEmails(tenant.id), onSettled: invalidateLog }),
    reminder: useMutation({ mutationFn: (documentId: string) => api.sendCollectionReminder(tenant.id, documentId), onSettled: invalidateLog }),
    sendPurchaseOrder: useMutation({
      mutationFn: (input: { purchaseOrderId: string; to: string[]; message: string; pdfBase64: string }) => api.sendPurchaseOrderEmail(tenant.id, input),
      onSettled: () => Promise.all([invalidateLog(), qc.invalidateQueries({ queryKey: ['purchase-orders', tenant.id] })]),
    }),
  }
}

// ---------------------------------------------------------------------------
// Cobranza
// ---------------------------------------------------------------------------
export function useCollectionRules() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['collection-rules', tenant.id], queryFn: () => api.listCollectionRules(tenant.id) })
}

export function useCounterpartyRuleSettings(counterpartyId: string) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['collection-rule-settings', tenant.id, counterpartyId], queryFn: () => api.listCounterpartyRuleSettings(tenant.id, counterpartyId) })
}

export function useCollectionEvents(counterpartyId?: string) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['collection-events', tenant.id, counterpartyId ?? 'all'], queryFn: () => api.listCollectionEvents(tenant.id, counterpartyId) })
}

export function useCollectionMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const rules = () => qc.invalidateQueries({ queryKey: ['collection-rules', tenant.id] })
  const events = () => qc.invalidateQueries({ queryKey: ['collection-events', tenant.id] })
  return {
    saveRule: useMutation({ mutationFn: ({ input, id }: { input: CollectionRuleInput; id?: string }) => api.saveCollectionRule(tenant.id, input, id), onSuccess: rules }),
    deleteRule: useMutation({ mutationFn: (id: string) => api.deleteCollectionRule(tenant.id, id), onSuccess: rules }),
    setClientRule: useMutation({
      mutationFn: ({ counterpartyId, ruleId, enabled }: { counterpartyId: string; ruleId: string; enabled: boolean | null }) => api.setCounterpartyRule(tenant.id, counterpartyId, ruleId, enabled),
      onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['collection-rule-settings', tenant.id, v.counterpartyId] }),
    }),
    addEvent: useMutation({ mutationFn: (input: CollectionEventInput) => api.addCollectionEvent(tenant.id, input), onSuccess: events }),
    setPromise: useMutation({ mutationFn: ({ id, status }: { id: string; status: 'pending' | 'kept' | 'broken' }) => api.setPromiseStatus(tenant.id, id, status), onSuccess: events }),
    deleteEvent: useMutation({ mutationFn: (id: string) => api.deleteCollectionEvent(tenant.id, id), onSuccess: events }),
    sendEmail: useMutation({
      mutationFn: (input: { counterpartyId: string; ruleId?: string | null; documentId?: string | null }) => api.sendCollectionEmail(tenant.id, input),
      onSettled: () => qc.invalidateQueries({ queryKey: ['email-log', tenant.id] }),
    }),
  }
}

// ---------------------------------------------------------------------------
// Administrador de la plataforma
// ---------------------------------------------------------------------------
export function usePlatformAdmin() {
  const { session } = useSession()
  return useQuery({ queryKey: ['platform-admin', session?.userId], queryFn: () => api.amIPlatformAdmin(), enabled: !!session, staleTime: 5 * 60_000 })
}

export function useAdminTenants() {
  return useQuery({ queryKey: ['admin', 'tenants'], queryFn: () => api.adminListTenants() })
}

export function useAdminTenantMembers(id: string | null) {
  return useQuery({ queryKey: ['admin', 'members', id], queryFn: () => api.adminTenantMembers(id!), enabled: !!id })
}

export function usePlatformAdmins() {
  return useQuery({ queryKey: ['admin', 'platform-admins'], queryFn: () => api.adminListPlatformAdmins() })
}

export function useAdminMutations() {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: ['admin'] })
    qc.invalidateQueries({ queryKey: ['tenants'] })
  }
  return {
    create: useMutation({ mutationFn: (input: Parameters<typeof api.adminCreateTenant>[0]) => api.adminCreateTenant(input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: AdminTenantInput }) => api.adminUpdateTenant(id, input), onSuccess: done }),
    setPlatformAdmin: useMutation({ mutationFn: ({ email, enabled }: { email: string; enabled: boolean }) => api.adminSetPlatformAdmin(email, enabled), onSuccess: done }),
  }
}

// ---------------------------------------------------------------------------
// Conciliación bancaria
// ---------------------------------------------------------------------------
export function useBankConnections() {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['bank', tenant.id, 'connections'], queryFn: () => api.listBankConnections(tenant.id) })
}

export function useBankFeedAccounts(enabled = true) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['bank', tenant.id, 'accounts'], queryFn: () => api.listBankFeedAccounts(tenant.id), enabled })
}

export function useBankMovements(enabled = true) {
  const { tenant } = useCurrentTenant()
  return useQuery({ queryKey: ['bank', tenant.id, 'movements'], queryFn: () => api.listBankMovements(tenant.id), enabled })
}

export function useBankMutations() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  const invalidateFinance = useInvalidateFinance()
  const invalidateBank = () => qc.invalidateQueries({ queryKey: ['bank', tenant.id] })
  return {
    start: useMutation({ mutationFn: () => api.bankStart(tenant.id) }),
    exchange: useMutation({ mutationFn: (exchangeToken: string) => api.bankExchange(tenant.id, exchangeToken), onSettled: invalidateBank }),
    sync: useMutation({ mutationFn: () => api.bankSync(tenant.id), onSettled: invalidateBank }),
    disconnect: useMutation({ mutationFn: (connectionId: string) => api.bankDisconnect(tenant.id, connectionId), onSuccess: invalidateBank }),
    reconcile: useMutation({ mutationFn: ({ movementId, paymentId }: { movementId: string; paymentId: string }) => api.reconcileMovement(tenant.id, movementId, paymentId), onSuccess: invalidateBank }),
    createPayment: useMutation({
      mutationFn: ({ movementId, input }: { movementId: string; input: MovementPaymentInput }) => api.createPaymentFromMovement(tenant.id, movementId, input),
      onSuccess: invalidateFinance,
    }),
    setStatus: useMutation({
      mutationFn: ({ movementId, status, reason }: { movementId: string; status: 'pending' | 'ignored'; reason?: string | null }) => api.setMovementStatus(tenant.id, movementId, status, reason),
      onSuccess: invalidateBank,
    }),
  }
}

// ---------------------------------------------------------------------------
// Gestión de usuarios (por empresa; también desde el administrador de empresas)
// ---------------------------------------------------------------------------
export function useTenantUsers(tenantId: string) {
  return useQuery({ queryKey: ['tenant-users', tenantId], queryFn: () => api.listTenantUsers(tenantId) })
}

export function useTenantUserMutations(tenantId: string) {
  const qc = useQueryClient()
  const done = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tenant-users', tenantId] }),
      qc.invalidateQueries({ queryKey: ['members', tenantId] }),
      qc.invalidateQueries({ queryKey: ['admin'] }),
    ])
  return {
    create: useMutation({ mutationFn: (input: TenantUserInput) => api.createTenantUser(tenantId, input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ userId, fullName, role }: { userId: string; fullName: string; role: MemberRole }) => api.updateTenantUser(tenantId, userId, { fullName, role }), onSuccess: done }),
    setPassword: useMutation({ mutationFn: ({ userId, password }: { userId: string; password: string }) => api.setTenantUserPassword(tenantId, userId, password), onSuccess: done }),
    sendReset: useMutation({ mutationFn: (userId: string) => api.sendTenantUserReset(tenantId, userId) }),
    remove: useMutation({ mutationFn: (userId: string) => api.removeMember(tenantId, userId), onSuccess: done }),
    destroy: useMutation({ mutationFn: (userId: string) => api.deleteTenantUser(tenantId, userId), onSuccess: done }),
  }
}
