// Plantillas de los correos de Supabase Auth (Produ Finanzas).
// Un solo diseño base; cada correo define asunto, título, texto, botón y código.
// `node supabase/templates/build.mjs` regenera los .html de esta carpeta (los usa config.toml
// en local y scripts/configure-auth-email.mjs para el proyecto en la nube).
// Variables de Supabase: {{ .ConfirmationURL }}, {{ .Token }}, {{ .Email }}, {{ .NewEmail }}, {{ .Data.* }}.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INK = '#1b1f2e'
const MUTED = '#5b6275'
const FAINT = '#8a90a0'
const LINE = '#eceef2'
const GRAPHITE = '#16181d'
const BRAND = '#3b82f6'
const SUBTLE = '#f6f7f9'

const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

function layout({ preheader, title, body, button, code, codeHint, footnote }) {
  const buttonHtml = button
    ? `<tr><td style="padding:8px 0 4px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-radius:8px;background:${GRAPHITE}">
            <a href="${button.url}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${font};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${button.label}</a>
          </td>
        </tr></table>
      </td></tr>`
    : ''
  const codeHtml = code
    ? `<tr><td style="padding:16px 0 4px">
        ${codeHint ? `<p style="margin:0 0 8px;font-family:${font};font-size:13px;color:${MUTED}">${codeHint}</p>` : ''}
        <div style="display:inline-block;padding:12px 18px;border:1px solid ${LINE};border-radius:8px;background:${SUBTLE};font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:26px;font-weight:700;letter-spacing:6px;color:${INK}">${code}</div>
      </td></tr>`
    : ''
  const linkFallback = button
    ? `<tr><td style="padding:18px 0 0;font-family:${font};font-size:12px;line-height:18px;color:${FAINT}">
        Si el botón no funciona, copia este enlace en tu navegador:<br>
        <a href="${button.url}" style="color:${BRAND};word-break:break-all">${button.url}</a>
      </td></tr>`
    : ''
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${SUBTLE}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SUBTLE}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
      <tr><td style="padding:0 4px 16px;font-family:${font};font-size:22px;font-weight:700;letter-spacing:-0.5px;color:${GRAPHITE}">
        produ<span style="color:${BRAND}">.</span> <span style="font-size:13px;font-weight:500;letter-spacing:0;color:${MUTED}">Finanzas</span>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:28px 28px 24px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-family:${font};font-size:18px;line-height:24px;font-weight:600;color:${INK};padding:0 0 10px">${title}</td></tr>
          <tr><td style="font-family:${font};font-size:14px;line-height:22px;color:${MUTED};padding:0 0 12px">${body}</td></tr>
          ${buttonHtml}
          ${codeHtml}
          ${linkFallback}
        </table>
      </td></tr>
      <tr><td style="padding:16px 8px 0;font-family:${font};font-size:12px;line-height:18px;color:${FAINT}">
        ${footnote ?? 'Si no esperabas este correo, puedes ignorarlo: no se hará ningún cambio en tu cuenta.'}<br>
        Produ Finanzas · <a href="https://finanzas.produ.cl" style="color:${FAINT}">finanzas.produ.cl</a> · Este correo se envía automáticamente, no lo respondas.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`
}

const hello = `Hola{{ if .Data.full_name }} {{ .Data.full_name }}{{ end }},<br>`

export const TEMPLATES = {
  // Registro con contraseña (app) y primer ingreso al portal con código (OTP de un usuario nuevo).
  confirmation: {
    subject: 'Confirma tu correo · Produ Finanzas',
    html: layout({
      preheader: 'Confirma tu correo para activar tu cuenta.',
      title: 'Confirma tu correo',
      body: `${hello}confirma que <b style="color:${INK}">{{ .Email }}</b> es tu correo para activar tu cuenta en Produ Finanzas.`,
      button: { label: 'Confirmar correo', url: '{{ .ConfirmationURL }}' },
      code: '{{ .Token }}',
      codeHint: '¿Estás entrando al portal financiero? Escribe este código en la pantalla de ingreso:',
      footnote: 'El enlace y el código vencen en 1 hora. Si no creaste una cuenta, ignora este correo.',
    }),
  },
  invite: {
    subject: '{{ if .Data.invited_to }}{{ .Data.invited_to }} te invitó a Produ Finanzas{{ else }}Te invitaron a Produ Finanzas{{ end }}',
    html: layout({
      preheader: 'Acepta la invitación y define tu contraseña.',
      title: 'Te invitaron a Produ Finanzas',
      body: `Hola,<br>{{ if .Data.invited_by_name }}<b style="color:${INK}">{{ .Data.invited_by_name }}</b> te invitó{{ else }}Te invitaron{{ end }} a trabajar en {{ if .Data.invited_to }}<b style="color:${INK}">{{ .Data.invited_to }}</b>{{ else }}una empresa{{ end }} en Produ Finanzas{{ if .Data.role_label }} con el rol <b style="color:${INK}">{{ .Data.role_label }}</b>{{ end }}.<br>Acepta la invitación y define tu contraseña para entrar.`,
      button: { label: 'Aceptar invitación', url: '{{ .ConfirmationURL }}' },
      footnote: 'La invitación vence en 24 horas. Si no esperabas esta invitación, ignora este correo.',
    }),
  },
  // Portal financiero: ingreso con correo + código de un solo uso.
  magic_link: {
    subject: 'Tu código de acceso: {{ .Token }}',
    html: layout({
      preheader: 'Tu código para entrar al portal financiero.',
      title: 'Tu código de acceso al portal',
      body: `Hola,<br>usa este código para entrar al portal financiero con <b style="color:${INK}">{{ .Email }}</b>. También puedes entrar directo con el botón.`,
      code: '{{ .Token }}',
      button: { label: 'Entrar al portal', url: '{{ .ConfirmationURL }}' },
      footnote: 'El código vence en 1 hora y sirve una sola vez. Si no intentaste entrar, ignora este correo.',
    }),
  },
  recovery: {
    subject: 'Restablece tu contraseña · Produ Finanzas',
    html: layout({
      preheader: 'Crea una contraseña nueva para tu cuenta.',
      title: 'Restablece tu contraseña',
      body: `${hello}recibimos una solicitud para cambiar la contraseña de <b style="color:${INK}">{{ .Email }}</b>. Crea una nueva con el botón.`,
      button: { label: 'Crear contraseña nueva', url: '{{ .ConfirmationURL }}' },
      footnote: 'El enlace vence en 1 hora. Si no pediste el cambio, ignora este correo: tu contraseña actual sigue funcionando.',
    }),
  },
  email_change: {
    subject: 'Confirma tu nuevo correo · Produ Finanzas',
    html: layout({
      preheader: 'Confirma el cambio de correo de tu cuenta.',
      title: 'Confirma tu nuevo correo',
      body: `${hello}pediste cambiar el correo de tu cuenta de <b style="color:${INK}">{{ .Email }}</b> a <b style="color:${INK}">{{ .NewEmail }}</b>. Confírmalo con el botón.`,
      button: { label: 'Confirmar cambio', url: '{{ .ConfirmationURL }}' },
      footnote: 'Si no pediste este cambio, ignora este correo y cambia tu contraseña.',
    }),
  },
  reauthentication: {
    subject: 'Tu código de verificación: {{ .Token }}',
    html: layout({
      preheader: 'Confirma que eres tú para continuar.',
      title: 'Confirma que eres tú',
      body: `${hello}usa este código para confirmar la acción que estás realizando en Produ Finanzas.`,
      code: '{{ .Token }}',
      footnote: 'El código vence en pocos minutos. Si no fuiste tú, cambia tu contraseña.',
    }),
  },
  password_changed_notification: {
    subject: 'Tu contraseña cambió · Produ Finanzas',
    html: layout({
      preheader: 'La contraseña de tu cuenta se actualizó.',
      title: 'Tu contraseña cambió',
      body: `${hello}la contraseña de <b style="color:${INK}">{{ .Email }}</b> se actualizó recién.`,
      footnote: 'Si no fuiste tú, restablece tu contraseña de inmediato desde la pantalla de ingreso y avisa al administrador de tu empresa.',
    }),
  },
  email_changed_notification: {
    subject: 'El correo de tu cuenta cambió · Produ Finanzas',
    html: layout({
      preheader: 'El correo de tu cuenta se actualizó.',
      title: 'El correo de tu cuenta cambió',
      body: `${hello}el correo de tu cuenta cambió de <b style="color:${INK}">{{ .OldEmail }}</b> a <b style="color:${INK}">{{ .Email }}</b>.`,
      footnote: 'Si no fuiste tú, avisa de inmediato al administrador de tu empresa.',
    }),
  },
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url))
  for (const [name, t] of Object.entries(TEMPLATES)) {
    writeFileSync(join(dir, `${name}.html`), t.html)
  }
  writeFileSync(join(dir, 'subjects.json'), `${JSON.stringify(Object.fromEntries(Object.entries(TEMPLATES).map(([k, t]) => [k, t.subject])), null, 2)}\n`)
  console.log(`${Object.keys(TEMPLATES).length} plantillas generadas en ${dir}`)
}
