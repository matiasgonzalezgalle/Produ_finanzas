import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

const MP_API = 'https://api.mercadopago.com'

export interface MercadoPagoSecrets {
  accessToken: string
  webhookSecret: string
}

export async function mpFetch<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    console.error('MercadoPago error', res.status, await res.text().catch(() => ''))
    throw new HttpError(502, `MercadoPago respondió ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function loadConnection(admin: SupabaseClient, tenantId: string) {
  const { data: connection } = await admin
    .from('integration_connections')
    .select('id, status, public_config')
    .eq('tenant_id', tenantId)
    .eq('provider', 'mercadopago')
    .maybeSingle()
  if (!connection || connection.status !== 'active') return null
  const { data: secretRow } = await admin
    .from('integration_secrets')
    .select('secrets')
    .eq('connection_id', connection.id)
    .maybeSingle()
  if (!secretRow) return null
  return { connection, secrets: secretRow.secrets as MercadoPagoSecrets }
}

// Moneda de cada sitio de MercadoPago relevante.
export const SITE_CURRENCY: Record<string, string> = { MLC: 'CLP', MPE: 'PEN' }

export const CURRENCY_DECIMALS: Record<string, number> = { CLP: 0, PEN: 2, USD: 2, EUR: 2, UF: 4 }

export const toMajor = (minor: number, currency: string) => minor / 10 ** (CURRENCY_DECIMALS[currency] ?? 2)
export const toMinor = (major: number, currency: string) => Math.round(major * 10 ** (CURRENCY_DECIMALS[currency] ?? 2))

/**
 * Verifica la firma x-signature de MercadoPago:
 *   manifest = "id:{data.id};request-id:{x-request-id};ts:{ts};" firmado con HMAC-SHA256.
 */
export async function verifyMercadoPagoSignature(params: {
  signatureHeader: string | null
  requestId: string | null
  dataId: string
  secret: string
  now?: number
  toleranceSeconds?: number
}): Promise<boolean> {
  const { signatureHeader, requestId, dataId, secret, now = Date.now(), toleranceSeconds = 600 } = params
  if (!signatureHeader || !secret || !dataId) return false
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [k, ...v] = part.split('=')
      return [k.trim(), v.join('=').trim()]
    }),
  )
  const ts = parts.ts
  const v1 = parts.v1
  if (!ts || !v1) return false
  const tsMs = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > toleranceSeconds * 1000) return false

  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId
  let manifest = `id:${id};`
  if (requestId) manifest += `request-id:${requestId};`
  manifest += `ts:${ts};`

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)))
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(expected, v1.toLowerCase())
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
