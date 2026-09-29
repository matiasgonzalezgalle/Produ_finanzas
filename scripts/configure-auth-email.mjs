// Aplica al proyecto de Supabase en la nube: plantillas y asuntos de los correos de Auth,
// SMTP de Resend (remitente avisos@finanzas.produ.cl), URL del sitio y redirecciones.
// Uso (en tu terminal, los secretos se leen del entorno y nunca se imprimen):
//   SUPABASE_ACCESS_TOKEN=sbp_... RESEND_API_KEY=re_... node scripts/configure-auth-email.mjs
// Sin RESEND_API_KEY solo actualiza plantillas y URLs (el SMTP queda como está).
import { TEMPLATES } from '../supabase/templates/build.mjs'

const PROJECT_REF = 'crcudxjqirceotausfuz'
const SITE_URL = 'https://finanzas.produ.cl'
const REDIRECTS = ['https://finanzas.produ.cl/**', 'https://produ-finanzas.vercel.app/**', 'http://localhost:5173/**']

const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  console.error('Falta SUPABASE_ACCESS_TOKEN')
  process.exit(1)
}
const resendKey = process.env.RESEND_API_KEY

const body = {
  site_url: SITE_URL,
  uri_allow_list: REDIRECTS.join(','),
  mailer_otp_length: 6,
  mailer_otp_exp: 3600,
  mailer_notifications_password_changed_enabled: true,
  mailer_notifications_email_changed_enabled: true,
}
for (const [name, t] of Object.entries(TEMPLATES)) {
  body[`mailer_subjects_${name}`] = t.subject
  body[`mailer_templates_${name}_content`] = t.html
}
if (resendKey) {
  Object.assign(body, {
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: resendKey,
    smtp_admin_email: 'avisos@finanzas.produ.cl',
    smtp_sender_name: 'Produ Finanzas',
    smtp_max_frequency: 30,
    rate_limit_email_sent: 100,
  })
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.error(`Supabase respondió ${res.status}: ${(await res.text()).slice(0, 500)}`)
  process.exit(1)
}
const config = await res.json()
console.log('Correos de Auth actualizados:')
console.log(`  Site URL: ${config.site_url}`)
console.log(`  Redirecciones: ${config.uri_allow_list}`)
console.log(`  Plantillas: ${Object.keys(TEMPLATES).join(', ')}`)
console.log(`  SMTP: ${config.smtp_host ? `${config.smtp_host} como ${config.smtp_sender_name} <${config.smtp_admin_email}>` : 'servidor de Supabase (sin SMTP propio)'}`)
