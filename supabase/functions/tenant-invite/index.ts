// Invita a un usuario a la empresa. Solo owner/admin.
// Si el correo ya tiene cuenta, se agrega como miembro; si no, Supabase le envía una invitación.
import { requireMember } from '../_shared/auth.ts'
import { dispatchOutbox } from '../_shared/emails.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const ROLES = ['admin', 'finance', 'viewer'] as const
const ROLE_LABEL: Record<string, string> = { admin: 'Administrador', finance: 'Finanzas', viewer: 'Solo lectura' }

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const { admin, tenantId, user } = await requireMember(req, body.tenantId, ['owner', 'admin'])

  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo inválido')
  if (!ROLES.includes(role as (typeof ROLES)[number])) throw new HttpError(400, 'Rol inválido')

  let userId: string | null = null
  let invited = false
  const { data: profile } = await admin.from('profiles').select('id').ilike('email', email).maybeSingle()
  if (profile) {
    userId = profile.id
  } else {
    const appUrl = Deno.env.get('APP_URL') ?? undefined
    const { data: tenant } = await admin.from('tenants').select('name, legal_name').eq('id', tenantId).single()
    const inviterName = (user.user_metadata?.full_name as string | undefined) || user.email || null
    // Los datos se usan en la plantilla del correo de invitación.
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: appUrl ? `${appUrl}/nueva-contrasena?invitacion=1` : undefined,
      data: { invited_by: user.id, invited_by_name: inviterName, invited_to: tenant?.name ?? null, role_label: ROLE_LABEL[role] },
    })
    if (error) throw new HttpError(400, `No se pudo invitar: ${error.message}`)
    userId = data.user.id
    invited = true
  }

  const { data: existing } = await admin.from('tenant_members').select('role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle()
  if (existing) throw new HttpError(409, 'Ese usuario ya es miembro de la empresa')

  const { error } = await admin.from('tenant_members').insert({ tenant_id: tenantId, user_id: userId, role })
  if (error) throw error
  // Un usuario que ya tenía cuenta no recibe la invitación de Supabase: se le avisa por correo.
  if (!invited) {
    const inviterName = (user.user_metadata?.full_name as string | undefined) || user.email || null
    await admin.from('email_outbox').insert({
      tenant_id: tenantId, kind: 'member_added', created_by: user.id,
      payload: { user_id: userId, role_label: ROLE_LABEL[role], invited_by_name: inviterName },
    })
    await dispatchOutbox(admin, tenantId).catch((err) => console.error('No se pudo enviar el aviso', err))
  }
  return json(req, 200, { userId, invited })
}))
