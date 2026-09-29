// Da acceso de superadministrador (Administrador de empresas) a un usuario existente.
// Uso: SUPABASE_ACCESS_TOKEN=... node scripts/bootstrap-superadmin.mjs correo@dominio
const PROJECT = process.env.SUPABASE_PROJECT_REF ?? 'crcudxjqirceotausfuz'
const token = process.env.SUPABASE_ACCESS_TOKEN
const email = (process.argv[2] ?? '').trim().toLowerCase()
if (!token) throw new Error('Falta SUPABASE_ACCESS_TOKEN')
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) throw new Error('Correo inválido')

const query = `
  insert into private.platform_admins (user_id)
  select id from auth.users where lower(email) = '${email}'
  on conflict do nothing
  returning user_id`
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
})
const body = await res.json().catch(() => null)
if (!res.ok) throw new Error(`Error ${res.status}: ${JSON.stringify(body)}`)
console.log(body?.length ? `Listo: ${email} es superadministrador.` : `Sin cambios: ${email} no existe o ya era superadministrador.`)
