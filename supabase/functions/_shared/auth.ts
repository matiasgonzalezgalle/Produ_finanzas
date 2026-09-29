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

/** La empresa debe tener el módulo contratado y estar activa (no suspendida). */
export async function requireModule(admin: SupabaseClient, tenantId: string, module: string) {
  const { data: tenant } = await admin.from('tenants').select('modules, status, country, tax_id').eq('id', tenantId).single()
  if (!tenant || !(tenant.modules as string[]).includes(module)) throw new HttpError(403, 'El módulo no está activo para esta empresa')
  if (tenant.status !== 'active') throw new HttpError(403, 'La empresa está suspendida')
  return tenant as { modules: string[]; status: string; country: string; tax_id: string | null }
}
