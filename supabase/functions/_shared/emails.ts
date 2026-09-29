// Correos del negocio: diseño (el mismo de las plantillas de Auth en supabase/templates/build.mjs),
// contenido por tipo y envío con Resend. RESEND_API_KEY es un secreto de Supabase.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

const FROM_ADDRESS = 'avisos@finanzas.produ.cl'
const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://finanzas.produ.cl'

const INK = '#1b1f2e'
const MUTED = '#5b6275'
const FAINT = '#8a90a0'
const LINE = '#eceef2'
const GRAPHITE = '#16181d'
const BRAND = '#3b82f6'
const SUBTLE = '#f6f7f9'
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const DECIMALS: Record<string, number> = { CLP: 0, PEN: 2, USD: 2, EUR: 2, UF: 2 }
const STORED: Record<string, number> = { CLP: 0, PEN: 2, USD: 2, EUR: 2, UF: 4 }

export function money(minor: number, currency: string): string {
  if (minor < 0) return `-${money(-minor, currency)}`
  const value = minor / 10 ** (STORED[currency] ?? 0)
  const d = DECIMALS[currency] ?? 0
  const n = value.toLocaleString(currency === 'PEN' ? 'es-PE' : 'es-CL', { minimumFractionDigits: d, maximumFractionDigits: d })
  if (currency === 'UF') return `UF ${n}`
  if (currency === 'PEN') return `S/ ${n}`
  if (currency === 'CLP') return `$${n}`
  if (currency === 'USD') return `US$ ${n}`
  return `€ ${n}`
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

interface EmailContent {
  subject: string
  preheader: string
  title: string
  /** HTML ya escapado. */
  body: string
  rows?: [string, string][]
  /** Tabla de documentos (celdas ya escapadas); la última columna se alinea a la derecha. */
  table?: { headers: string[]; rows: string[][]; total?: [string, string] }
  button?: { label: string; url: string }
  footnote?: string
}

export function renderEmail(c: EmailContent, tenantName: string): string {
  const rows = c.rows?.length
    ? `<tr><td style="padding:4px 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:8px">
        ${c.rows.map(([k, v], i) => `<tr><td style="padding:9px 14px;font-family:${font};font-size:13px;color:${MUTED};${i ? `border-top:1px solid ${LINE};` : ''}">${esc(k)}</td><td align="right" style="padding:9px 14px;font-family:${font};font-size:13px;font-weight:600;color:${INK};${i ? `border-top:1px solid ${LINE};` : ''}">${v}</td></tr>`).join('')}
      </table></td></tr>`
    : ''
  const table = c.table?.rows.length
    ? `<tr><td style="padding:4px 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:8px;border-collapse:separate">
        <tr>${c.table.headers.map((h, i) => `<td ${i === c.table!.headers.length - 1 ? 'align="right" ' : ''}style="padding:8px 12px;background:${SUBTLE};font-family:${font};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:${FAINT}">${esc(h)}</td>`).join('')}</tr>
        ${c.table.rows.map((r) => `<tr>${r.map((v, i) => `<td ${i === r.length - 1 ? 'align="right" ' : ''}style="padding:8px 12px;border-top:1px solid ${LINE};font-family:${font};font-size:13px;color:${INK}">${v}</td>`).join('')}</tr>`).join('')}
        ${c.table.total ? `<tr><td colspan="${c.table.headers.length - 1}" style="padding:9px 12px;border-top:1px solid ${LINE};font-family:${font};font-size:13px;font-weight:600;color:${INK}">${esc(c.table.total[0])}</td><td align="right" style="padding:9px 12px;border-top:1px solid ${LINE};font-family:${font};font-size:13px;font-weight:700;color:${INK}">${c.table.total[1]}</td></tr>` : ''}
      </table></td></tr>`
    : ''
  const button = c.button
    ? `<tr><td style="padding:8px 0 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background:${GRAPHITE}">
        <a href="${esc(c.button.url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${font};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(c.button.label)}</a>
      </td></tr></table></td></tr>`
    : ''
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(c.title)}</title></head>
<body style="margin:0;padding:0;background:${SUBTLE}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(c.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SUBTLE}"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
    <tr><td style="padding:0 4px 16px;font-family:${font};font-size:15px;font-weight:600;color:${GRAPHITE}">${esc(tenantName)}</td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:28px 28px 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:${font};font-size:18px;line-height:24px;font-weight:600;color:${INK};padding:0 0 10px">${esc(c.title)}</td></tr>
        <tr><td style="font-family:${font};font-size:14px;line-height:22px;color:${MUTED};padding:0 0 12px">${c.body}</td></tr>
        ${rows}
        ${table}
        ${button}
      </table>
    </td></tr>
    <tr><td style="padding:16px 8px 0;font-family:${font};font-size:12px;line-height:18px;color:${FAINT}">
      ${c.footnote ? `${c.footnote}<br>` : ''}Enviado por ${esc(tenantName)} con Produ<span style="color:${BRAND}">.</span> Finanzas · <a href="${esc(APP_URL())}" style="color:${FAINT}">finanzas.produ.cl</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`
}

export interface OutgoingEmail {
  to: string[]
  subject: string
  html: string
  replyTo?: string | null
  fromName: string
  attachments?: { filename: string; content: string }[]
  idempotencyKey?: string
}

export async function sendWithResend(email: OutgoingEmail): Promise<string> {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) throw new HttpError(503, 'El envío de correos no está configurado en el servidor')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(email.idempotencyKey ? { 'Idempotency-Key': email.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: `${email.fromName.replace(/[<>"]/g, '')} <${FROM_ADDRESS}>`,
      to: email.to,
      subject: email.subject,
      html: email.html,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      ...(email.attachments?.length ? { attachments: email.attachments } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Resend ${res.status}: ${String(data?.message ?? 'error').slice(0, 200)}`)
  return String(data.id ?? '')
}

// ---------------------------------------------------------------------------
// Contenido por tipo
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Correos de la contraparte: el de su ficha, los autorizados en su portal y sus contactos de cobranza. */
export async function counterpartyRecipients(admin: SupabaseClient, tenantId: string, counterpartyId: string): Promise<string[]> {
  const [{ data: cp }, { data: access }, { data: contacts }] = await Promise.all([
    admin.from('counterparties').select('email').eq('id', counterpartyId).eq('tenant_id', tenantId).maybeSingle(),
    admin.from('portal_access').select('email').eq('tenant_id', tenantId).eq('counterparty_id', counterpartyId).eq('kind', 'email').eq('enabled', true),
    admin.from('contacts').select('email').eq('tenant_id', tenantId).eq('counterparty_id', counterpartyId).eq('is_collection_contact', true),
  ])
  const all = [cp?.email, ...(access ?? []).map((a: { email: string | null }) => a.email), ...(contacts ?? []).map((c: { email: string | null }) => c.email)]
    .map((e) => (e ?? '').trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e))
  return [...new Set(all)].slice(0, 10)
}

async function portalUrl(admin: SupabaseClient, tenantId: string, counterpartyId: string): Promise<string | null> {
  const [{ data: tenant }, { data: cp }] = await Promise.all([
    admin.from('tenants').select('portal_enabled').eq('id', tenantId).single(),
    admin.from('counterparties').select('portal_slug').eq('id', counterpartyId).single(),
  ])
  return tenant?.portal_enabled && cp?.portal_slug ? `${APP_URL()}/portal/${cp.portal_slug}` : null
}

const DOC_LABEL: Record<string, string> = {
  factura: 'factura', factura_exenta: 'factura exenta', boleta: 'boleta', nota_credito: 'nota de crédito', nota_debito: 'nota de débito',
  honorarios: 'boleta de honorarios', invoice: 'invoice', otro: 'documento',
}
const docLabel = (t: string) => DOC_LABEL[t] ?? 'documento'
const b = (v: string) => `<b style="color:${INK}">${esc(v)}</b>`

export interface BuiltEmail {
  to: string[]
  content: EmailContent
}

/** Arma el correo de un evento del outbox. null = no hay a quién enviarlo o ya no aplica. */
export async function buildOutboxEmail(admin: SupabaseClient, row: { tenant_id: string; kind: string; payload: Record<string, string> }, tenantName: string): Promise<BuiltEmail | { skip: string }> {
  const t = row.tenant_id
  const p = row.payload

  if (row.kind === 'payment_scheduled' || row.kind === 'document_rejected' || row.kind === 'collection_reminder') {
    const { data: d } = await admin.from('document_balances').select('*').eq('id', p.document_id).eq('tenant_id', t).maybeSingle()
    if (!d) return { skip: 'El documento ya no existe' }
    const to = await counterpartyRecipients(admin, t, d.counterparty_id)
    if (!to.length) return { skip: `${d.counterparty_name} no tiene correo registrado` }
    const portal = await portalUrl(admin, t, d.counterparty_id)
    const label = docLabel(d.doc_type)
    if (row.kind === 'payment_scheduled') {
      if (d.payment_management !== 'scheduled') return { skip: 'El pago ya no está programado' }
      return {
        to,
        content: {
          subject: `${tenantName} programó el pago de tu ${label} N° ${d.folio}`,
          preheader: `Fecha de pago: ${date(d.scheduled_payment_date)}`,
          title: 'Tu pago está programado',
          body: `Hola ${esc(d.counterparty_name)},<br>${b(tenantName)} programó el pago de tu ${esc(label)} ${b(`N° ${d.folio}`)}.`,
          rows: [['Fecha de pago', b(date(d.scheduled_payment_date))], ['Monto a pagar', money(d.pending_amount, d.currency)], ['Emisión', date(d.issue_date)]],
          button: portal ? { label: 'Ver en el portal', url: portal } : undefined,
          footnote: 'La fecha puede cambiar; si se reprograma te avisaremos.',
        },
      }
    }
    if (row.kind === 'document_rejected') {
      if (d.approval_status !== 'rejected') return { skip: 'El documento ya no está rechazado' }
      return {
        to,
        content: {
          subject: `${tenantName} rechazó tu ${label} N° ${d.folio}`,
          preheader: d.rejection_reason ?? 'Revisa el motivo del rechazo.',
          title: `Documento rechazado`,
          body: `Hola ${esc(d.counterparty_name)},<br>${b(tenantName)} rechazó tu ${esc(label)} ${b(`N° ${d.folio}`)} por ${money(d.total_amount, d.currency)}.${d.rejection_reason ? `<br><br>Motivo: ${b(d.rejection_reason)}` : ''}`,
          button: portal ? { label: 'Responder en el portal', url: portal } : undefined,
          footnote: 'Si corresponde, emite una nota de crédito o un documento corregido.',
        },
      }
    }
    // Recordatorio de cobro
    if (d.pending_amount <= 0) return { skip: 'El documento ya está pagado' }
    const { data: link } = await admin.from('payment_links').select('url').eq('document_id', d.id).eq('status', 'active').not('url', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const overdue = d.days_overdue > 0
    return {
      to,
      content: {
        subject: overdue
          ? `Recordatorio: tu ${label} N° ${d.folio} venció hace ${d.days_overdue} días`
          : `Recordatorio: tu ${label} N° ${d.folio} vence el ${date(d.due_date)}`,
        preheader: `Saldo pendiente ${money(d.pending_amount, d.currency)}`,
        title: overdue ? 'Tienes un pago vencido' : 'Recordatorio de pago',
        body: `Hola ${esc(d.counterparty_name)},<br>te recordamos que la ${esc(label)} ${b(`N° ${d.folio}`)} de ${b(tenantName)} tiene un saldo pendiente.`,
        rows: [['Saldo pendiente', b(money(d.pending_amount, d.currency))], ['Vencimiento', date(d.due_date)], ...(overdue ? ([['Días de atraso', String(d.days_overdue)]] as [string, string][]) : [])],
        button: link?.url ? { label: 'Pagar ahora', url: link.url } : portal ? { label: 'Ver en el portal', url: portal } : undefined,
        footnote: 'Si ya pagaste, ignora este correo.',
      },
    }
  }

  if (row.kind === 'payment_sent' || row.kind === 'payment_received') {
    const { data: pay } = await admin.from('payments').select('*, counterparties(name), payment_allocations(amount, documents(folio, doc_type))').eq('id', p.payment_id).eq('tenant_id', t).maybeSingle()
    if (!pay || pay.status !== 'confirmed') return { skip: 'El pago fue anulado' }
    const to = await counterpartyRecipients(admin, t, pay.counterparty_id)
    const name = pay.counterparties?.name ?? ''
    if (!to.length) return { skip: `${name} no tiene correo registrado` }
    const portal = await portalUrl(admin, t, pay.counterparty_id)
    const docs = (pay.payment_allocations ?? []) as { amount: number; documents: { folio: string; doc_type: string } }[]
    const rows: [string, string][] = [
      ['Fecha', date(pay.paid_on)],
      ['Monto', b(money(pay.amount, pay.currency))],
      ['Medio', esc(pay.method.startsWith('mercadopago') ? 'MercadoPago' : pay.method.charAt(0).toUpperCase() + pay.method.slice(1))],
      ...(pay.reference ? ([['Referencia', esc(pay.reference)]] as [string, string][]) : []),
      ...docs.map((a) => [`${docLabel(a.documents.doc_type)} N° ${a.documents.folio}`.replace(/^./, (c) => c.toUpperCase()), money(a.amount, pay.currency)] as [string, string]),
    ]
    const sent = row.kind === 'payment_sent'
    return {
      to,
      content: {
        subject: sent ? `${tenantName} te pagó ${money(pay.amount, pay.currency)}` : `Recibimos tu pago de ${money(pay.amount, pay.currency)}`,
        preheader: sent ? `Pago del ${date(pay.paid_on)}` : `Comprobante de pago del ${date(pay.paid_on)}`,
        title: sent ? 'Te enviamos un pago' : 'Pago recibido',
        body: sent
          ? `Hola ${esc(name)},<br>${b(tenantName)} registró un pago a tu favor.`
          : `Hola ${esc(name)},<br>${b(tenantName)} recibió tu pago. Gracias.`,
        rows,
        button: portal ? { label: 'Ver en el portal', url: portal } : undefined,
      },
    }
  }

  if (row.kind === 'portal_access_granted') {
    const { data: access } = await admin.from('portal_access').select('email, enabled, counterparty_id, counterparties(name, portal_slug)').eq('id', p.access_id).eq('tenant_id', t).maybeSingle()
    if (!access?.enabled || !access.email) return { skip: 'El acceso ya no está vigente' }
    const url = `${APP_URL()}/portal${access.counterparties?.portal_slug ? `/${access.counterparties.portal_slug}` : ''}`
    return {
      to: [access.email],
      content: {
        subject: `${tenantName} te dio acceso a su portal financiero`,
        preheader: 'Revisa tus documentos, pagos y fechas de pago.',
        title: 'Tienes acceso al portal financiero',
        body: `Hola,<br>${b(tenantName)} te dio acceso a su portal financiero como ${b(access.counterparties?.name ?? '')}. Ahí puedes ver tus documentos, pagos y fechas de pago, y conversar sobre cada documento.<br><br>Para entrar, usa este correo (${esc(access.email)}): te enviaremos un código de un solo uso.`,
        button: { label: 'Entrar al portal', url },
      },
    }
  }

  if (row.kind === 'member_added') {
    const { data: profile } = await admin.from('profiles').select('email, full_name').eq('id', p.user_id).maybeSingle()
    if (!profile?.email) return { skip: 'El usuario no tiene correo' }
    return {
      to: [profile.email],
      content: {
        subject: `Te agregaron a ${tenantName} en Produ Finanzas`,
        preheader: 'Ya puedes entrar con tu cuenta.',
        title: `Ahora tienes acceso a ${tenantName}`,
        body: `Hola${profile.full_name ? ` ${esc(profile.full_name)}` : ''},<br>${p.invited_by_name ? `${b(p.invited_by_name)} te agregó` : 'Te agregaron'} a ${b(tenantName)} con el rol ${b(p.role_label ?? '')}. Entra con tu cuenta de siempre y elige la empresa en el selector.`,
        button: { label: 'Entrar a Produ Finanzas', url: `${APP_URL()}/login` },
      },
    }
  }

  if (row.kind === 'collection_rule' || row.kind === 'statement') return buildCollectionEmail(admin, row, tenantName)

  return { skip: `Tipo de correo sin contenido (${row.kind})` }
}

// ---------------------------------------------------------------------------
// Cobranza: recordatorios con plantilla y estado de cuenta
// ---------------------------------------------------------------------------
interface OpenDoc {
  id: string
  doc_type: string
  folio: string
  currency: string
  issue_date: string
  due_date: string | null
  pending_amount: number
  total_amount: number
  days_overdue: number
  counterparty_id: string
  counterparty_name: string
}

function totalsByCurrency(docs: OpenDoc[], pick: (d: OpenDoc) => number) {
  const totals = new Map<string, number>()
  for (const d of docs) totals.set(d.currency, (totals.get(d.currency) ?? 0) + pick(d))
  return [...totals.entries()].filter(([, v]) => v > 0).map(([c, v]) => money(v, c)).join(' + ') || money(0, 'CLP')
}

/** Reemplaza {{variables}} en texto plano (escapado) y convierte saltos de línea. */
export function fillTemplate(text: string, vars: Record<string, string>, html: boolean) {
  const out = (html ? esc(text) : text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (key in vars ? (html ? esc(vars[key]) : vars[key]) : m))
  if (!html) return out
  return out.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb">$1</a>').replace(/\n/g, '<br>')
}

async function buildCollectionEmail(admin: SupabaseClient, row: { tenant_id: string; kind: string; payload: Record<string, string> }, tenantName: string): Promise<BuiltEmail | { skip: string }> {
  const t = row.tenant_id
  const p = row.payload
  const { data: rule } = p.rule_id ? await admin.from('collection_rules').select('*').eq('id', p.rule_id).eq('tenant_id', t).maybeSingle() : { data: null }
  if (p.rule_id && !rule) return { skip: 'La plantilla ya no existe' }
  if (rule && !rule.active && !p.manual) return { skip: 'La regla está desactivada' }

  let counterpartyId = p.counterparty_id
  let focus: OpenDoc | null = null
  if (p.document_id) {
    const { data: d } = await admin.from('document_balances').select('*').eq('id', p.document_id).eq('tenant_id', t).maybeSingle()
    if (!d) return { skip: 'El documento ya no existe' }
    if (d.status !== 'open' || d.pending_amount <= 0) return { skip: 'El documento ya no tiene saldo' }
    focus = d as OpenDoc
    counterpartyId = d.counterparty_id
  }
  const { data: cp } = await admin.from('counterparties').select('name, collection_paused').eq('id', counterpartyId).eq('tenant_id', t).maybeSingle()
  if (!cp) return { skip: 'El cliente ya no existe' }
  if (cp.collection_paused && !p.manual) return { skip: 'La cobranza del cliente está pausada' }
  const to = await counterpartyRecipients(admin, t, counterpartyId)
  if (!to.length) return { skip: `${cp.name} no tiene correo de cobranza registrado` }

  const { data: open } = await admin.from('document_balances').select('id, doc_type, folio, currency, issue_date, due_date, pending_amount, total_amount, days_overdue, counterparty_id, counterparty_name')
    .eq('tenant_id', t).eq('counterparty_id', counterpartyId).eq('direction', 'receivable').eq('status', 'open').gt('pending_amount', 0).neq('doc_type', 'nota_credito')
    .order('due_date', { ascending: true, nullsFirst: false })
  const docs = (open ?? []) as OpenDoc[]
  if (!focus && !docs.length) return { skip: 'El cliente no tiene documentos con saldo' }
  const overdue = docs.filter((d) => d.days_overdue > 0)
  if (row.kind === 'collection_rule' && rule?.trigger === 'statement' && !overdue.length && !p.manual) return { skip: 'El cliente ya no tiene deuda vencida' }

  const portal = await portalUrl(admin, t, counterpartyId)
  let payUrl: string | null = null
  if (focus && (rule?.include_payment_link ?? true)) {
    const { data: link } = await admin.from('payment_links').select('url').eq('document_id', focus.id).eq('status', 'active').not('url', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
    payUrl = link?.url ?? null
  }
  const today = new Date().toISOString().slice(0, 10)
  const vars: Record<string, string> = {
    cliente: cp.name,
    empresa: tenantName,
    hoy: date(today),
    total_pendiente: totalsByCurrency(docs, (d) => d.pending_amount),
    total_vencido: totalsByCurrency(overdue, (d) => d.pending_amount),
    documentos_pendientes: String(docs.length),
    link_portal: portal ?? '',
    link_pago: payUrl ?? portal ?? '',
    ...(focus
      ? {
          documento: `${docLabel(focus.doc_type)} N° ${focus.folio}`,
          folio: focus.folio,
          saldo: money(focus.pending_amount, focus.currency),
          total: money(focus.total_amount, focus.currency),
          emision: date(focus.issue_date),
          vencimiento: date(focus.due_date),
          dias_atraso: String(Math.max(0, focus.days_overdue)),
        }
      : {}),
  }

  const includeDocs = rule ? rule.include_documents : true
  const tableDocs = focus ? [focus] : docs
  const table = includeDocs
    ? {
        headers: ['Documento', 'Vencimiento', 'Saldo'],
        rows: tableDocs.slice(0, 30).map((d) => [
          esc(`${docLabel(d.doc_type)} N° ${d.folio}`.replace(/^./, (c) => c.toUpperCase())),
          `${esc(date(d.due_date))}${d.days_overdue > 0 ? ` <span style="color:#b42318">(${d.days_overdue} d)</span>` : ''}`,
          esc(money(d.pending_amount, d.currency)),
        ]),
        total: tableDocs.length > 1 ? (['Total pendiente', esc(totalsByCurrency(tableDocs, (d) => d.pending_amount))] as [string, string]) : undefined,
      }
    : undefined

  const subject = rule ? fillTemplate(rule.subject, vars, false) : `Estado de cuenta de ${cp.name} con ${tenantName}`
  const body = rule
    ? fillTemplate(rule.body, vars, true)
    : `Hola ${esc(cp.name)},<br>te compartimos el detalle de tus documentos con saldo pendiente con ${b(tenantName)} al ${esc(vars.hoy)}.${overdue.length ? `<br>Total vencido: ${b(vars.total_vencido)}.` : ''}`
  return {
    to,
    content: {
      subject: subject.slice(0, 200),
      preheader: focus ? `Saldo ${vars.saldo}` : `Total pendiente ${vars.total_pendiente}`,
      title: rule ? subject.slice(0, 120) : 'Estado de cuenta',
      body,
      table,
      button: payUrl ? { label: 'Pagar ahora', url: payUrl } : portal ? { label: 'Ver en el portal', url: portal } : undefined,
      footnote: 'Si ya pagaste, ignora este correo.',
    },
  }
}

/** Envía los pendientes de una empresa. Devuelve cuántos se enviaron. */
export async function dispatchOutbox(admin: SupabaseClient, tenantId: string): Promise<{ sent: number; failed: number; skipped: number }> {
  const { data: rows, error } = await admin.rpc('claim_email_outbox', { p_tenant: tenantId, p_limit: 25 })
  if (error) throw error
  const result = { sent: 0, failed: 0, skipped: 0 }
  if (!rows?.length) return result
  const [{ data: tenant }, { data: settings }] = await Promise.all([
    admin.from('tenants').select('name, legal_name').eq('id', tenantId).single(),
    admin.from('tenant_email_settings').select('reply_to').eq('tenant_id', tenantId).maybeSingle(),
  ])
  const tenantName = tenant?.name ?? 'Produ Finanzas'
  for (const row of rows) {
    try {
      const built = await buildOutboxEmail(admin, row, tenantName)
      if ('skip' in built) {
        await admin.from('email_outbox').update({ status: 'skipped', error: built.skip }).eq('id', row.id)
        result.skipped++
        continue
      }
      const html = renderEmail(built.content, tenantName)
      const providerId = await sendWithResend({ to: built.to, subject: built.content.subject, html, replyTo: settings?.reply_to, fromName: tenantName, idempotencyKey: row.id })
      await admin.from('email_outbox').update({ status: 'sent', recipients: built.to, subject: built.content.subject, provider_id: providerId, sent_at: new Date().toISOString(), error: null }).eq('id', row.id)
      result.sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al enviar'
      await admin.from('email_outbox').update({ status: row.attempts >= 5 ? 'failed' : 'pending', error: message.slice(0, 300) }).eq('id', row.id)
      result.failed++
    }
  }
  return result
}
