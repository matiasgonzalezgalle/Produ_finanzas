// Configuración › Notificaciones: qué correos envía la empresa, a qué correo se responden, e historial.
import { Mail, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useEmailLog, useEmailMutations, useEmailSettings } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { EmailKind, EmailLogRow, EmailSettings } from '../../data'
import { formatTimestamp } from '../../domain/dates'
import { Badge, Button, cn, EmptyState, Field, FormError, Input, type Tone } from '../../ui'
import { ListView, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage } from '../shared'
import { Section } from './parts'

export const EMAIL_KIND: Record<EmailKind, { label: string; description: string; to: string; defaultOn: boolean; automatic: boolean }> = {
  payment_scheduled: { label: 'Pago programado', description: 'Cuando programas (o reprogramas) el pago de un documento por pagar.', to: 'Proveedor', defaultOn: true, automatic: true },
  payment_sent: { label: 'Pago realizado', description: 'Cuando registras un pago a un proveedor, con los documentos que salda.', to: 'Proveedor', defaultOn: true, automatic: true },
  document_rejected: { label: 'Documento rechazado', description: 'Cuando rechazas una factura o documento por pagar, con el motivo.', to: 'Proveedor', defaultOn: true, automatic: true },
  payment_received: { label: 'Comprobante de cobro', description: 'Cuando registras un cobro de un cliente (incluye los de MercadoPago).', to: 'Cliente', defaultOn: false, automatic: true },
  portal_access_granted: { label: 'Acceso al portal', description: 'Cuando das acceso al portal financiero a un correo, con el link para entrar.', to: 'Contraparte', defaultOn: true, automatic: true },
  collection_reminder: { label: 'Recordatorio de cobro', description: 'Se envía a mano desde el detalle de un documento por cobrar.', to: 'Cliente', defaultOn: true, automatic: false },
  purchase_order: { label: 'Orden de compra', description: 'Se envía a mano desde la orden de compra, con el PDF adjunto.', to: 'Proveedor', defaultOn: true, automatic: false },
  member_added: { label: 'Usuario agregado', description: 'Cuando agregas a la empresa a alguien que ya tiene cuenta.', to: 'Usuario', defaultOn: true, automatic: true },
  collection_rule: { label: 'Recordatorio de cobranza', description: 'Reglas de Cuentas por cobrar › Cobranza › Recordatorios.', to: 'Cliente', defaultOn: true, automatic: true },
  statement: { label: 'Estado de cuenta', description: 'Se envía a mano desde la ficha de cobranza del cliente.', to: 'Cliente', defaultOn: true, automatic: false },
}

const STATUS: Record<EmailLogRow['status'], { label: string; tone: Tone }> = {
  sent: { label: 'Enviado', tone: 'ok' },
  pending: { label: 'Pendiente', tone: 'warn' },
  sending: { label: 'Enviando', tone: 'warn' },
  failed: { label: 'Falló', tone: 'bad' },
  skipped: { label: 'No enviado', tone: 'neutral' },
}

const CONFIGURABLE: EmailKind[] = ['payment_scheduled', 'payment_sent', 'document_rejected', 'payment_received', 'portal_access_granted', 'member_added']

export function NotificationsSettings() {
  const settings = useEmailSettings()
  return (
    <div className="flex flex-col gap-6">
      {settings.data ? <PreferencesForm key={JSON.stringify(settings.data)} initial={settings.data} /> : <p className="text-sm text-faint">Cargando…</p>}
      <EmailLog />
    </div>
  )
}

function PreferencesForm({ initial }: { initial: EmailSettings }) {
  const { canAdmin } = useCurrentTenant()
  const m = useEmailMutations()
  const [replyTo, setReplyTo] = useState(initial.reply_to ?? '')
  const [enabled, setEnabled] = useState(() => Object.fromEntries(CONFIGURABLE.map((k) => [k, initial.notifications[k] ?? EMAIL_KIND[k].defaultOn])) as Record<EmailKind, boolean>)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    const reply = replyTo.trim().toLowerCase()
    if (reply && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reply)) return setError('El correo de respuesta no es válido')
    try {
      await m.saveSettings.mutateAsync({ reply_to: reply || null, notifications: enabled })
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl">
      <Section title="Correos a proveedores, clientes y usuarios" description="Se envían desde avisos@finanzas.produ.cl con el nombre de la empresa. Los destinatarios son el correo de la ficha de la contraparte y los correos autorizados en su portal.">
        <div className="flex flex-col gap-5">
          <FormError error={error} />
          {saved && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Cambios guardados.</p>}
          <Field label="Las respuestas llegan a" hint="Opcional. Si lo dejas vacío, los correos automáticos no se pueden responder (la orden de compra se responde a quien la envía).">
            {(id) => <Input id={id} type="email" value={replyTo} onChange={(e) => { setReplyTo(e.target.value); setSaved(false) }} placeholder="finanzas@tuempresa.cl" disabled={!canAdmin} />}
          </Field>
          <div className="-my-1 divide-y divide-line rounded-lg border border-line">
            {CONFIGURABLE.map((k) => (
              <label key={k} className={cn('flex items-start justify-between gap-4 px-4 py-3', canAdmin ? 'cursor-pointer' : '')}>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">{EMAIL_KIND[k].label} <span className="text-[11px] font-normal text-faint">→ {EMAIL_KIND[k].to}</span></span>
                  <span className="block text-[12px] text-muted">{EMAIL_KIND[k].description}</span>
                </span>
                <span className="relative mt-0.5 inline-flex shrink-0">
                  <input type="checkbox" className="peer sr-only" checked={enabled[k]} disabled={!canAdmin} onChange={(e) => { setEnabled((s) => ({ ...s, [k]: e.target.checked })); setSaved(false) }} />
                  <span className="h-5 w-9 rounded-full bg-faint/35 transition-colors peer-checked:bg-navy-900 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 peer-disabled:opacity-60" />
                  <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                </span>
              </label>
            ))}
          </div>
          <p className="text-[12px] text-muted">El recordatorio de cobro, el estado de cuenta y la orden de compra se envían solo cuando alguien los manda desde su pantalla. Los recordatorios programados se configuran en Cuentas por cobrar › Cobranza › Recordatorios.</p>
          {canAdmin && (
            <div className="flex justify-end">
              <Button variant="primary" type="submit" disabled={m.saveSettings.isPending}>{m.saveSettings.isPending ? 'Guardando…' : 'Guardar cambios'}</Button>
            </div>
          )}
        </div>
      </Section>
    </form>
  )
}

function EmailLog() {
  const { tenant } = useCurrentTenant()
  const log = useEmailLog()
  const m = useEmailMutations()
  const rows = log.data ?? []
  const columns: ListColumn<EmailLogRow>[] = [
    { key: 'date', header: 'Fecha', cell: (r) => <span className="whitespace-nowrap">{formatTimestamp(r.sent_at ?? r.created_at, tenant.timezone)}</span>, sortValue: (r) => r.sent_at ?? r.created_at },
    { key: 'kind', header: 'Tipo', cell: (r) => EMAIL_KIND[r.kind]?.label ?? r.kind, sortValue: (r) => r.kind },
    { key: 'subject', header: 'Asunto', cell: (r) => <span className="line-clamp-1 max-w-80 text-ink">{r.subject ?? <span className="text-faint">—</span>}</span>, className: 'min-w-56' },
    { key: 'to', mobileHidden: true, header: 'Destinatarios', cell: (r) => <span className="line-clamp-1 max-w-64 text-muted">{r.recipients.join(', ') || '—'}{r.cc?.length ? ` · CC: ${r.cc.join(', ')}` : ''}</span> },
    {
      key: 'status',
      mobileBadge: true,
      header: 'Estado',
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5" title={r.error ?? undefined}>
          <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
          {r.error && r.status !== 'sent' && <span className="line-clamp-1 max-w-48 text-[10px] text-muted">{r.error}</span>}
        </span>
      ),
      sortValue: (r) => r.status,
    },
  ]
  const filters: ListFilter<EmailLogRow>[] = [
    { type: 'select', key: 'status', label: 'Estado', options: (Object.keys(STATUS) as EmailLogRow['status'][]).map((s) => ({ value: s, label: STATUS[s].label })), match: (r, v) => r.status === v },
    { type: 'select', key: 'kind', label: 'Tipo', options: (Object.keys(EMAIL_KIND) as EmailKind[]).map((k) => ({ value: k, label: EMAIL_KIND[k].label })), match: (r, v) => r.kind === v },
    { type: 'dateRange', key: 'date', label: 'Fecha', getDate: (r) => (r.sent_at ?? r.created_at).slice(0, 10) },
  ]
  const list = useListState({ rows, rowKey: (r) => r.id, columns, filters, searchText: (r) => `${r.subject ?? ''} ${r.recipients.join(' ')} ${(r.cc ?? []).join(' ')}`, storageKey: 'email-log', defaultSort: { key: 'date', dir: 'desc' } })
  const pending = rows.filter((r) => r.status === 'pending').length
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">Correos enviados</h2>
        {pending > 0 && (
          <Button size="sm" onClick={() => m.dispatch.mutate()} disabled={m.dispatch.isPending}>
            <RefreshCw size={14} className={m.dispatch.isPending ? 'animate-spin' : ''} /> Enviar {pending} pendientes
          </Button>
        )}
      </div>
      <ListView
        state={list}
        columns={columns}
        rowKey={(r) => r.id}
        filters={filters}
        loading={log.isLoading}
        searchPlaceholder="Buscar por asunto o destinatario…"
        empty={<EmptyState icon={<Mail size={20} />} title="Aún no se han enviado correos" description="Aquí verás cada aviso enviado, a quién y si llegó a salir." />}
      />
    </section>
  )
}
