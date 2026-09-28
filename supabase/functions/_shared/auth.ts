import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

export type Role = 'owner' | 'admin' | 'finance' | 'viewer'

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
}

/** Valida el JWT del usuario y que pertenezca al tenant con uno de los roles permitidos. */
export async function requireMember(req: Request, tenantId: unknown, roles: Role[]) {
  if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
    throw new HttpError(400, 'tenantId inválido')
  }
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'No autenticado')
  const admin = adminClient()
  const { data: userData, error } = await admin.auth.getUser(token)
  if (error || !userData.user) throw new HttpError(401, 'Sesión inválida')
  const { data: member } = await admin
    .from('tenant_members')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', userData.user.id)
    .maybeSingle()
  if (!member || !roles.includes(member.role as Role)) throw new HttpError(403, 'Sin permisos en esta empresa')
  return { admin, user: userData.user, role: member.role as Role, tenantId }
}
