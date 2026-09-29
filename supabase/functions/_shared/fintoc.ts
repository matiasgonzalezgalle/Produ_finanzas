// Cliente mínimo de la API de Fintoc (API Fiscal: documentos del SII; Movements: cartolas bancarias).
// FINTOC_SECRET_KEY y FINTOC_PUBLIC_KEY son secretos de Supabase (cuenta de Produ Finanzas).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

const FINTOC_API = 'https://api.fintoc.com'

export function fintocKeys() {
  const secretKey = Deno.env.get('FINTOC_SECRET_KEY') ?? ''
  const publicKey = Deno.env.get('FINTOC_PUBLIC_KEY') ?? ''
  if (!secretKey || !publicKey) throw new HttpError(503, 'La integración con Fintoc no está configurada en el servidor')
  return { secretKey, publicKey }
}

export async function fintocFetch(path: string, init: RequestInit = {}, invalidMessage = 'La conexión con el SII ya no es válida: vuelve a conectarla'): Promise<Response> {
  const { secretKey } = fintocKeys()
  const res = await fetch(`${FINTOC_API}${path}`, {
    ...init,
    headers: { Authorization: secretKey, Accept: 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    console.error('Fintoc error', res.status, (await res.text().catch(() => '')).slice(0, 500))
    if (res.status === 403 || res.status === 404) throw new HttpError(409, invalidMessage)
    throw new HttpError(502, `Fintoc respondió ${res.status}`)
  }
  return res
}

export interface FintocLink {
  id: string
  holder_id: string | null
  holder_type: string
  mode: string
  status: string
  institution?: { id: string; name?: string } | null
}

export interface FintocInvoice {
  id: string
  date: string
  issue_type: 'issued' | 'received'
  number: string | null
  net_amount: number | null
  total_amount: number | null
  tax_period: string | null
  issuer: { id: string; name: string | null } | null
  receiver: { id: string; name: string | null } | null
  institution_invoice: {
    document_type: number | null
    exempt_amount: number | null
    vat_amount: number | null
    other_taxes: { total_amount?: number } | null
    invoice_status: string | null
    confirmation_status: string | null
    accepted_at: string | null
    rejected_at: string | null
    is_services_invoice: boolean
    services_invoice: { receiver_withheld_amount?: number | null; status?: string | null } | null
    total_documents: number | null
    reference_number: string | null
    reference_type_code: number | null
    transaction_category: string | null
  } | null
}

export async function loadSiiConnection(admin: SupabaseClient, tenantId: string) {
  const { data: connection } = await admin
    .from('integration_connections')
    .select('id, status, public_config')
    .eq('tenant_id', tenantId)
    .eq('provider', 'fintoc_sii')
    .maybeSingle()
  if (!connection) return null
  const { data: secret } = await admin.from('integration_secrets').select('secrets').eq('connection_id', connection.id).maybeSingle()
  const linkToken = (secret?.secrets as { linkToken?: string } | undefined)?.linkToken
  if (!linkToken) return null
  return { connection, linkToken }
}

export const rutKey = (rut: string | null | undefined) => (rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase()
export const formatRut = (rut: string) => {
  const k = rutKey(rut)
  return k.length < 2 ? k : `${k.slice(0, -1)}-${k.slice(-1)}`
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const SUMMARY_TYPES = new Set([35, 38, 39, 41, 47, 48])

/** Invoice de Fintoc -> fila de sii_documents. */
export function toSiiRow(tenantId: string, inv: FintocInvoice) {
  const ii = inv.institution_invoice
  const counterparty = inv.issue_type === 'received' ? inv.issuer : inv.receiver
  const type = ii?.document_type ?? null
  return {
    tenant_id: tenantId,
    external_id: inv.id,
    direction: inv.issue_type === 'received' ? 'payable' : 'receivable',
    sii_type: type,
    is_fee_receipt: !!ii?.is_services_invoice,
    is_summary: type !== null && SUMMARY_TYPES.has(type),
    folio: inv.number,
    counterparty_tax_id: counterparty?.id ? formatRut(counterparty.id) : null,
    counterparty_name: counterparty?.name ?? null,
    issue_date: inv.date.slice(0, 10),
    tax_period: inv.tax_period,
    net_amount: inv.net_amount ?? 0,
    exempt_amount: ii?.exempt_amount ?? 0,
    tax_amount: ii?.vat_amount ?? 0,
    other_taxes_amount: ii?.other_taxes?.total_amount ?? 0,
    total_amount: inv.total_amount ?? 0,
    withheld_amount: ii?.services_invoice?.receiver_withheld_amount ?? 0,
    registry_status: ii?.invoice_status ?? null,
    confirmation_status: ii?.confirmation_status ?? null,
    fee_status: ii?.services_invoice?.status ?? null,
    accepted_at: ii?.accepted_at ?? null,
    rejected_at: ii?.rejected_at ?? null,
    reference_type: ii?.reference_type_code ?? null,
    reference_folio: ii?.reference_number ?? null,
    transaction_category: ii?.transaction_category ?? null,
    updated_at: new Date().toISOString(),
  }
}
