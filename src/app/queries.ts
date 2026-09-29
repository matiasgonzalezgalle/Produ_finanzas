// Hooks de datos por feature. Las claves incluyen el tenant para no mezclar empresas en caché.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ContactInput, type CounterpartyInput, type DocumentInput, type PaymentInput } from '../data'
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
