// Lo llama pg_cron cada 15 minutos (private.collections_tick) para enviar los correos pendientes
// de todas las empresas. Público (verify_jwt = false) pero exige el secreto que genera la base de datos.
import { adminClient } from '../_shared/auth.ts'
import { dispatchOutbox } from '../_shared/emails.ts'
import { handler, json } from '../_shared/http.ts'

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') return json(req, 405, { error: 'Método no permitido' })
  const secret = req.headers.get('x-cron-secret') ?? ''
  if (secret.length < 32) return json(req, 401, { error: 'No autorizado' })
  const admin = adminClient()
  const { data: ok } = await admin.rpc('verify_cron_secret', { p_secret: secret })
  if (!ok) return json(req, 401, { error: 'No autorizado' })

  const { data: pending, error } = await admin.from('email_outbox').select('tenant_id').in('status', ['pending', 'sending']).lt('attempts', 5).limit(1000)
  if (error) throw error
  const tenants = [...new Set((pending ?? []).map((r: { tenant_id: string }) => r.tenant_id))]
  const totals = { tenants: tenants.length, sent: 0, failed: 0, skipped: 0 }
  for (const tenantId of tenants) {
    // Varias rondas por empresa (25 por ronda) sin pasar el tiempo límite de la función.
    for (let round = 0; round < 8; round++) {
      const r = await dispatchOutbox(admin, tenantId)
      totals.sent += r.sent
      totals.failed += r.failed
      totals.skipped += r.skipped
      if (r.sent + r.failed + r.skipped < 25) break
    }
  }
  return json(req, 200, totals)
}))
