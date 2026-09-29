// Gestión de usuarios de una empresa. La usan el dueño/administrador de la empresa y los
// superadministradores de la plataforma.
//   create        crea el usuario (invitación por correo o contraseña temporal) y lo agrega con su rol
//   update        cambia nombre y rol
//   set_password  define una contraseña temporal (se pide cambiarla al entrar)
//   send_reset    envía el correo para crear/restablecer la contraseña
//   delete        elimina la cuenta (si no está en otras empresas) o la quita de la empresa
// Por seguridad, un administrador de empresa solo puede cambiar la contraseña o eliminar la cuenta
// de usuarios que pertenecen únicamente a su empresa (así no toma control de accesos a otras).
import type { SupabaseClient, User } from 'npm:@supabase/supabase-js@2'
import { adminClient } from '../_shared/auth.ts'
import { dispatchOutbox } from '../_shared/emails.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

const ROLES = ['admin', 'finance', 'viewer'] as const
const ROLE_LABEL: Record<string, string> = { owner: 'Dueño', admin: 'Administrador', finance: 'Finanzas', viewer: 'Solo lectura' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BAN_FOREVER = '876000h'

interface Caller {
  admin: SupabaseClient
  user: User
  role: string | null
  platformAdmin: boolean
  tenantId: string
}

async function authorize(req: Request, tenantId: unknown): Promise<Caller> {
  if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(400, 'tenantId inválido')
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'No autenticado')
  const admin = adminClient()
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Sesión inválida')
  const [{ data: member }, { data: platformAdmin }] = await Promise.all([
    admin.from('tenant_members').select('role').eq('tenant_id', tenantId).eq('user_id', data.user.id).maybeSingle(),
    admin.rpc('is_platform_admin_user', { p_user: data.user.id }),
  ])
  const role = (member?.role as string | undefined) ?? null
  if (!platformAdmin && role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Solo el dueño o un administrador gestiona usuarios')
  if (!platformAdmin) {
    const { data: tenant } = await admin.from('tenants').select('status').eq('id', tenantId).single()
    if (tenant?.status !== 'active') throw new HttpError(403, 'La empresa está suspendida')
  }
  return { admin, user: data.user, role, platformAdmin: !!platformAdmin, tenantId }
}

async function loadTarget(c: Caller, userId: unknown) {
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(400, 'Usuario inválido')
  const { data: member } = await c.admin.from('tenant_members').select('role').eq('tenant_id', c.tenantId).eq('user_id', userId).maybeSingle()
  if (!member) throw new HttpError(404, 'El usuario no pertenece a esta empresa')
  const { data, error } = await c.admin.auth.admin.getUserById(userId)
  if (error || !data.user) throw new HttpError(404, 'Usuario no encontrado')
  const { count } = await c.admin.from('tenant_members').select('tenant_id', { count: 'exact', head: true }).eq('user_id', userId).neq('tenant_id', c.tenantId)
  const { data: targetIsPlatformAdmin } = await c.admin.rpc('is_platform_admin_user', { p_user: userId })
  return { user: data.user, role: member.role as string, otherTenants: count ?? 0, targetIsPlatformAdmin: !!targetIsPlatformAdmin }
}

/** Acciones sobre la cuenta (contraseña, eliminar): no a uno mismo, al dueño solo el dueño, y solo cuentas exclusivas de la empresa. */
function assertAccountControl(c: Caller, t: Awaited<ReturnType<typeof loadTarget>>, what: string) {
  if (t.user.id === c.user.id) throw new HttpError(400, `No puedes ${what} tu propia cuenta desde aquí`)
  if (c.platformAdmin) return
  if (t.targetIsPlatformAdmin) throw new HttpError(403, `No puedes ${what} a un superadministrador`)
  if (t.role === 'owner' && c.role !== 'owner') throw new HttpError(403, `Solo el dueño puede ${what} al dueño`)
  if (t.otherTenants > 0) throw new HttpError(403, `Este usuario también pertenece a otras empresas: solo él o un superadministrador puede ${what} su cuenta. Puedes quitarlo de esta empresa.`)
}

function validPassword(password: unknown) {
  const p = String(password ?? '')
  if (p.length < 10) throw new HttpError(400, 'La contraseña debe tener al menos 10 caracteres')
  if (p.length > 72) throw new HttpError(400, 'La contraseña es demasiado larga')
  return p
}

async function setName(admin: SupabaseClient, user: User, fullName: string) {
  const { error } = await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...user.user_metadata, full_name: fullName } })
  if (error) throw new HttpError(400, error.message)
  await admin.from('profiles').update({ full_name: fullName }).eq('id', user.id)
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido')
  const body = await req.json().catch(() => ({}))
  const c = await authorize(req, body.tenantId)
  const appUrl = Deno.env.get('APP_URL') ?? undefined
  const callerName = (c.user.user_metadata?.full_name as string | undefined) || c.user.email || null

  switch (String(body.action ?? '')) {
    case 'create': {
      const email = String(body.email ?? '').trim().toLowerCase()
      const fullName = String(body.fullName ?? '').trim()
      const role = String(body.role ?? '')
      const mode = body.mode === 'password' ? 'password' : 'invite'
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Correo inválido')
      if (!fullName || fullName.length > 120) throw new HttpError(400, 'Indica el nombre del usuario')
      if (!ROLES.includes(role as (typeof ROLES)[number])) throw new HttpError(400, 'Rol inválido')
      const { data: tenant } = await c.admin.from('tenants').select('name').eq('id', c.tenantId).single()

      const { data: profile } = await c.admin.from('profiles').select('id').ilike('email', email).maybeSingle()
      let userId = profile?.id as string | undefined
      let created: 'invited' | 'password' | 'existing' = 'existing'
      if (userId) {
        const { data: existing } = await c.admin.from('tenant_members').select('role').eq('tenant_id', c.tenantId).eq('user_id', userId).maybeSingle()
        if (existing) throw new HttpError(409, 'Ese usuario ya es miembro de la empresa')
        // Una cuenta eliminada (bloqueada) sin empresas se reactiva.
        const { count } = await c.admin.from('tenant_members').select('tenant_id', { count: 'exact', head: true }).eq('user_id', userId)
        if (!count) await c.admin.auth.admin.updateUserById(userId, { ban_duration: 'none' })
      } else if (mode === 'password') {
        const { data, error } = await c.admin.auth.admin.createUser({
          email, password: validPassword(body.password), email_confirm: true,
          user_metadata: { full_name: fullName, must_change_password: true },
        })
        if (error) throw new HttpError(400, `No se pudo crear el usuario: ${error.message}`)
        userId = data.user.id
        created = 'password'
      } else {
        const { data, error } = await c.admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: appUrl ? `${appUrl}/nueva-contrasena?invitacion=1` : undefined,
          data: { full_name: fullName, invited_by: c.user.id, invited_by_name: callerName, invited_to: tenant?.name ?? null, role_label: ROLE_LABEL[role] },
        })
        if (error) throw new HttpError(400, `No se pudo invitar: ${error.message}`)
        userId = data.user.id
        created = 'invited'
      }
      const { error } = await c.admin.from('tenant_members').insert({ tenant_id: c.tenantId, user_id: userId, role })
      if (error) throw error
      if (created === 'existing') {
        await c.admin.from('email_outbox').insert({
          tenant_id: c.tenantId, kind: 'member_added', created_by: c.user.id,
          payload: { user_id: userId, role_label: ROLE_LABEL[role], invited_by_name: callerName },
        })
        await dispatchOutbox(c.admin, c.tenantId).catch((err) => console.error('No se pudo enviar el aviso', err))
      }
      return json(req, 200, { userId, created })
    }

    case 'update': {
      const t = await loadTarget(c, body.userId)
      const fullName = String(body.fullName ?? '').trim()
      if (!fullName || fullName.length > 120) throw new HttpError(400, 'Indica el nombre del usuario')
      if ((t.user.user_metadata?.full_name ?? '') !== fullName) await setName(c.admin, t.user, fullName)
      const role = body.role == null ? null : String(body.role)
      if (role && role !== t.role) {
        if (t.role === 'owner') throw new HttpError(400, 'El rol del dueño no se cambia')
        if (!ROLES.includes(role as (typeof ROLES)[number])) throw new HttpError(400, 'Rol inválido')
        if (t.user.id === c.user.id) throw new HttpError(400, 'No puedes cambiar tu propio rol')
        const { error } = await c.admin.from('tenant_members').update({ role }).eq('tenant_id', c.tenantId).eq('user_id', t.user.id)
        if (error) throw error
      }
      return json(req, 200, { ok: true })
    }

    case 'set_password': {
      const t = await loadTarget(c, body.userId)
      assertAccountControl(c, t, 'cambiar la contraseña de')
      const { error } = await c.admin.auth.admin.updateUserById(t.user.id, {
        password: validPassword(body.password),
        email_confirm: true,
        ban_duration: 'none',
        user_metadata: { ...t.user.user_metadata, must_change_password: true },
      })
      if (error) throw new HttpError(400, error.message)
      return json(req, 200, { ok: true })
    }

    case 'send_reset': {
      const t = await loadTarget(c, body.userId)
      if (!t.user.email) throw new HttpError(400, 'El usuario no tiene correo')
      const { error } = await c.admin.auth.resetPasswordForEmail(t.user.email, { redirectTo: appUrl ? `${appUrl}/nueva-contrasena` : undefined })
      if (error) throw new HttpError(400, `No se pudo enviar el correo: ${error.message}`)
      return json(req, 200, { ok: true })
    }

    case 'delete': {
      const t = await loadTarget(c, body.userId)
      if (t.role === 'owner') throw new HttpError(400, 'El dueño no se puede eliminar')
      if (t.otherTenants > 0 && !c.platformAdmin) {
        // Está en otras empresas: solo se quita de esta.
        await c.admin.from('tenant_members').delete().eq('tenant_id', c.tenantId).eq('user_id', t.user.id)
        return json(req, 200, { result: 'removed' })
      }
      assertAccountControl(c, t, 'eliminar')
      await c.admin.from('tenant_members').delete().eq('user_id', t.user.id)
      // Si registró información (documentos, pagos, auditoría) la cuenta no se puede borrar: se bloquea.
      const { error } = await c.admin.auth.admin.deleteUser(t.user.id)
      if (error) {
        const { error: banError } = await c.admin.auth.admin.updateUserById(t.user.id, { ban_duration: BAN_FOREVER })
        if (banError) throw new HttpError(400, banError.message)
        return json(req, 200, { result: 'blocked' })
      }
      return json(req, 200, { result: 'deleted' })
    }
  }
  throw new HttpError(400, 'Acción inválida')
}))
