// Consola del superadministrador: crear empresas con sus módulos y su dueño, y eliminarlas.
// Solo usuarios en private.platform_admins. Si el dueño no tiene cuenta, se le envía una invitación.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { adminClient } from '../_shared/auth.ts'
import { fintocFetch } from '../_shared/fintoc.ts'
import { handler, HttpError, json } from '../_shared/http.ts'

/** Rutas de todos los archivos bajo una carpeta del bucket (recorre subcarpetas). */
async function listFiles(admin: SupabaseClient, prefix: string): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from('documents').list(prefix, { limit: 1000, offset })
    if (error) throw error
    for (const item of data ?? []) {
      const path = `${prefix}/${item.name}`
      if (item.id) out.push(path)
      else out.push(...(await listFiles(admin, path)))
    }
    if ((data ?? []).length < 1000) return out
  }
}

async function deleteTenant(admin: SupabaseClient, tenantId: string) {
  // Conexiones con Fintoc (SII y bancos): se eliminan los links para no seguir consultando.
  const tokens: string[] = []
  const { data: sii } = await admin.from('integration_connections').select('id').eq('tenant_id', tenantId).eq('provider', 'fintoc_sii')
  for (const c of sii ?? []) {
    const { data } = await admin.from('integration_secrets').select('secrets').eq('connection_id', c.id).maybeSingle()
    const token = (data?.secrets as { linkToken?: string } | undefined)?.linkToken
    if (token) tokens.push(token)
  }
  const { data: banks } = await admin.from('bank_connections').select('id').eq('tenant_id', tenantId)
  if (banks?.length) {
    const { data } = await admin.from('bank_connection_secrets').select('link_token').in('connection_id', banks.map((b) => b.id))
    tokens.push(...(data ?? []).map((d) => d.link_token as string))
  }
  for (const token of tokens) {
    await fintocFetch(`/v1/links/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch((err) => console.error('No se pudo eliminar un link de Fintoc', err))
  }
  // Archivos adjuntos (documentos y órdenes de compra).
  const files = await listFiles(admin, tenantId)
  for (let i = 0; i < files.length; i += 100) {
    const { error } = await admin.storage.from('documents').remove(files.slice(i, i + 100))
    if (error) throw error
  }
  const { error } = await admin.rpc('delete_tenant', { p_id: tenantId })
  if (error) throw new HttpError(400, error.message)
  return { files: files.length }
}

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

  if (body.action === 'delete_tenant') {
    const tenantId = String(body.tenantId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(400, 'Empresa inválida')
    const { data: tenant } = await admin.from('tenants').select('name').eq('id', tenantId).maybeSingle()
    if (!tenant) throw new HttpError(404, 'Empresa no encontrada')
    if (String(body.confirmName ?? '').trim() !== tenant.name) throw new HttpError(400, 'Escribe el nombre exacto de la empresa para confirmar')
    const result = await deleteTenant(admin, tenantId)
    console.log(`Empresa ${tenantId} eliminada por ${userData.user.id} (${result.files} archivos)`)
    return json(req, 200, { ok: true, ...result })
  }

  if (body.action !== 'create_tenant') throw new HttpError(400, 'Acción inválida')
  const name = String(body.name ?? '').trim()
  const country = String(body.country ?? '')
  const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase()
  const ownerName = String(body.ownerName ?? '').trim().slice(0, 120)
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
      data: { full_name: ownerName || undefined, invited_by: userData.user.id, invited_by_name: 'Produ Finanzas', invited_to: name, role_label: 'Dueño' },
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
