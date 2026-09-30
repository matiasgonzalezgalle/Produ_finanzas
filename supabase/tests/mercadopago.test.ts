import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

type Mod = typeof import('../functions/_shared/mercadopago.ts')
let mp: Mod

beforeAll(async () => {
  // Las edge functions corren en Deno; aquí basta un stub de Deno.env.
  ;(globalThis as any).Deno = { env: { get: () => '' } }
  mp = await import('../functions/_shared/mercadopago.ts')
})

const secret = 'secreto-de-prueba-123456'
const sign = (manifest: string) => createHmac('sha256', secret).update(manifest).digest('hex')

describe('firma de webhook MercadoPago', () => {
  const now = 1_790_000_000_000
  const ts = String(now / 1000)

  it('acepta una firma válida', async () => {
    const v1 = sign(`id:123456;request-id:req-1;ts:${ts};`)
    await expect(mp.verifyMercadoPagoSignature({ signatureHeader: `ts=${ts},v1=${v1}`, requestId: 'req-1', dataId: '123456', secret, now })).resolves.toBe(true)
  })

  it('rechaza sin header, con otro id, otra clave o timestamp viejo', async () => {
    const v1 = sign(`id:123456;request-id:req-1;ts:${ts};`)
    const base = { requestId: 'req-1', dataId: '123456', secret, now }
    await expect(mp.verifyMercadoPagoSignature({ ...base, signatureHeader: null })).resolves.toBe(false)
    await expect(mp.verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${v1}`, dataId: '999' })).resolves.toBe(false)
    await expect(mp.verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${v1}`, secret: 'otra-clave-cualquiera' })).resolves.toBe(false)
    // Con límite de antigüedad explícito se rechaza; por defecto no (MercadoPago reintenta horas después).
    await expect(mp.verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${v1}`, now: now + 3_600_000, toleranceSeconds: 600 })).resolves.toBe(false)
    await expect(mp.verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${v1}`, now: now + 6 * 3_600_000 })).resolves.toBe(true)
  })

  it('convierte montos sin perder precisión', () => {
    expect(mp.toMinor(1500, 'CLP')).toBe(1500)
    expect(mp.toMinor(19.99, 'PEN')).toBe(1999)
    expect(mp.toMajor(1999, 'PEN')).toBe(19.99)
  })
})
