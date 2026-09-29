// Consola del superadministrador: crear empresas con sus módulos y su dueño.
// Solo usuarios en private.platform_admins. Si el dueño no tiene cuenta, se le envía una invitación.
import { adminClient } from '../_shared/auth.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const MODULES = ['cuentas_por_pagar', 'cuentas_por_cobrar', 'ordenes_compra', 'cobranza', 'tesoreria', 'portal', 'sii', 'mercadopago', 'conciliacion']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'No autenticado')
  const admin = adminClient()
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData.user) throw new HttpError(401, 'Sesión inválida')
  const { data: isAdmin } = await admin.rpc('is_platform_admin_user', { p_user: userData.user.id })
  if (!isAdmin) throw new HttpError(403, 'Solo el administrador de la plataforma')

  if (body.action !== 'create_tenant') throw new HttpError(400, 'Acción inválida')
  const name = String(body.name ?? '').trim()
  const country = String(body.country ?? '')
  const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase()
  const modules = [...new Set((Array.isArray(body.modules) ? body.modules : []).map(String))].filter((m) => MODULES.includes(m)).sort()
  if (!name || name.length > 120) throw new HttpError(400, 'Indica el nombre de la empresa')
  if (!['CL', 'PE'].includes(country)) throw new HttpError(400, 'País inválido')
  if (!EMAIL_RE.test(ownerEmail)) throw new HttpError(400, 'Correo del dueño inválido')

  const { data: tenant, error } = await admin.from('tenants').insert({
    name,
    legal_name: String(body.legalName ?? '').trim() || null,
    tax_id: String(body.taxId ?? '').trim() || null,
    country,
    base_currency: country === 'CL' ? 'CLP' : 'PEN',
    timezone: country === 'CL' ? 'America/Santiago' : 'America/Lima',
    modules,
    admin_notes: String(body.notes ?? '').trim() || null,
  }).select('id').single()
  if (error) throw error

  let invited = false
  const { data: profile } = await admin.from('profiles').select('id').ilike('email', ownerEmail).maybeSingle()
  let ownerId = profile?.id as string | undefined
  if (!ownerId) {
    const appUrl = Deno.env.get('APP_URL') ?? undefined
    const { data, error: inviteError } = await admin.auth.admin.inviteUserByEmail(ownerEmail, {
      redirectTo: appUrl ? `${appUrl}/nueva-contrasena?invitacion=1` : undefined,
      data: { invited_by: userData.user.id, invited_by_name: 'Produ Finanzas', invited_to: name, role_label: 'Dueño' },
    })
    if (inviteError) {
      await admin.from('tenants').delete().eq('id', tenant.id)
      throw new HttpError(400, `No se pudo invitar al dueño: ${inviteError.message}`)
    }
    ownerId = data.user.id
    invited = true
  }
  const { error: memberError } = await admin.from('tenant_members').insert({ tenant_id: tenant.id, user_id: ownerId, role: 'owner' })
  if (memberError) throw memberError
  return json(req, 200, { tenantId: tenant.id, invited })
}))
