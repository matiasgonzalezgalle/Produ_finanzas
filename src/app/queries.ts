// Hooks de datos por feature. Las claves incluyen el tenant para no mezclar empresas en caché.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Attachment, type BankAccountInput, type MemberRole, type TenantInput, type ContactInput, type CounterpartyInput, type DocumentInput, type PaymentInput } from '../data'
import type { DocumentDirection } from '../domain/documents'
import { useCurrentTenant } from './tenant'

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

function useInvalidateFinance() {
  const { tenant } = useCurrentTenant()
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
      qc.invalidateQueries({ queryKey: ['payments', tenant.id] }),
    ])
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

export function useIntegration(provider: 'mercadopago') {
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
    add: useMutation({ mutationFn: ({ counterpartyId, email }: { counterpartyId: string; email: string }) => api.addPortalAccess(tenant.id, counterpartyId, email), onSuccess }),
    setEnabled: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setPortalAccessEnabled(tenant.id, id, enabled), onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => api.removePortalAccess(tenant.id, id), onSuccess }),
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
