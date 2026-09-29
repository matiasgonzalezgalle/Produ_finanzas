// Gestión de pagos (CxP): de la aprobación al pago realizado.
// Etapas: Por aprobar → Aprobado → Pago solicitado → Pago programado (con fecha) → Pago realizado.
import { Banknote, CalendarClock, CircleCheck, Columns3, List, Send, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDocuments, useSetApproval, useSetPaymentStage } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentRow } from '../../data'
import { addDays, formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { sumByCurrency } from '../../domain/money'
import { Button, cn, Drawer, EmptyState, Field, FormError, Input, PageHeader } from '../../ui'
import { BulkButton, ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { rememberDocumentOrder } from '../documents/documentOrder'
import { sectionTabs } from '../documents/DocumentsPage'
import { PaymentDrawer } from '../payments/PaymentsPage'
import { ApprovalStatusBadge, errorMessage, Money, MoneyTotals, PaymentManagementBadge, StatusBadge } from '../shared'

type Stage = 'por_aprobar' | 'aprobado' | 'solicitado' | 'programado' | 'realizado'

const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: 'por_aprobar', label: 'Por aprobar', hint: 'Revisar y aprobar o rechazar' },
  { key: 'aprobado', label: 'Aprobados', hint: 'Listos para solicitar el pago' },
  { key: 'solicitado', label: 'Pago solicitado', hint: 'Esperando fecha de pago' },
  { key: 'programado', label: 'Pago programado', hint: 'Con fecha de pago' },
  { key: 'realizado', label: 'Pago realizado', hint: 'Pagados por completo' },
]

export function stageOf(d: DocumentRow): Stage | null {
  if (d.direction !== 'payable' || d.doc_type === 'nota_credito' || d.status !== 'open') return null
  if (d.payment_management === 'paid') return 'realizado'
  if (d.approval_status === 'rejected') return null
  if (d.approval_status === 'pending') return 'por_aprobar'
  if (d.payment_management === 'scheduled') return 'programado'
  if (d.payment_management === 'requested') return 'solicitado'
  return 'aprobado'
}

export function PaymentManagementPage() {
  const { canWrite, today } = useCurrentTenant()
  const navigate = useNavigate()
  const documents = useDocuments('payable')
  const approval = useSetApproval()
  const stage = useSetPaymentStage()
  const [view, setView] = useState<'board' | 'list'>(() => {
    try {
      return (localStorage.getItem('produ-finanzas:payments-view') as 'board' | 'list') || 'board'
    } catch {
      return 'board'
    }
  })
  const [error, setError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState<DocumentRow[] | null>(null)
  const [paying, setPaying] = useState<DocumentRow[] | null>(null)
  const [search, setSearch] = useState('')

  const all = useMemo(() => (documents.data ?? []).filter((d) => stageOf(d) !== null), [documents.data])
  const rejected = (documents.data ?? []).filter((d) => d.direction === 'payable' && d.status === 'open' && d.approval_status === 'rejected').length

  function changeView(v: 'board' | 'list') {
    setView(v)
    try {
      localStorage.setItem('produ-finanzas:payments-view', v)
    } catch {
      // ignorar
    }
  }

  function open(d: DocumentRow, ids: string[]) {
    rememberDocumentOrder('payable', ids)
    navigate(`/cxp/documentos/${d.id}`)
  }

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const approve = (docs: DocumentRow[]) => run(async () => {
    for (const d of docs.filter((x) => stageOf(x) === 'por_aprobar')) await approval.mutateAsync({ id: d.id, status: 'approved' })
  })
  const request = (docs: DocumentRow[]) => run(async () => {
    const targets = docs.filter((x) => stageOf(x) === 'aprobado' || stageOf(x) === 'programado')
    if (!targets.length) throw new Error('Selecciona documentos aprobados para solicitar su pago.')
    for (const d of targets) await stage.mutateAsync({ id: d.id, stage: 'requested' })
  })
  const unrequest = (d: DocumentRow) => run(() => stage.mutateAsync({ id: d.id, stage: null }))
  const pay = (docs: DocumentRow[]) => {
    const targets = docs.filter((x) => x.pending_amount > 0 && x.approval_status === 'approved')
    const same = targets.every((x) => x.counterparty_id === targets[0]?.counterparty_id && x.currency === targets[0]?.currency)
    if (!targets.length) return setError('Selecciona documentos aprobados con saldo.')
    if (!same) return setError('Para registrar un pago en bloque, elige documentos del mismo proveedor y moneda.')
    setError(null)
    setPaying(targets)
  }
  const schedule = (docs: DocumentRow[]) => {
    const targets = docs.filter((x) => ['aprobado', 'solicitado', 'programado'].includes(stageOf(x) ?? ''))
    if (!targets.length) return setError('Selecciona documentos aprobados para programar su pago.')
    setError(null)
    setScheduling(targets)
  }

  const q = search.trim().toLowerCase()
  const visible = q ? all.filter((d) => `${d.counterparty_name} ${d.folio}`.toLowerCase().includes(q)) : all
  const byStage = (s: Stage) => visible.filter((d) => stageOf(d) === s)
  const soon = all.filter((d) => stageOf(d) === 'programado' && d.scheduled_payment_date && d.scheduled_payment_date <= addDays(today, 7))
  const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })

  return (
    <div>
      <PageHeader title="Cuentas por pagar" tabs={sectionTabs('payable')} />
      <div className="stat-row pt-4 sm:grid-cols-4">
        {(['por_aprobar', 'solicitado', 'programado'] as Stage[]).map((s) => {
          const docs = all.filter((d) => stageOf(d) === s)
          return <StatCardLite key={s} label={STAGES.find((x) => x.key === s)!.label} count={docs.length} value={<MoneyTotals totals={sumByCurrency(docs, pick)} empty="$0" />} />
        })}
        <StatCardLite label="Se pagan en 7 días" count={soon.length} value={<MoneyTotals totals={sumByCurrency(soon, pick)} empty="$0" />} tone="info" />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-4 pb-3">
        {view === 'board' && (
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar proveedor o folio…"
            aria-label="Buscar"
            className="h-7 w-full rounded-md border border-line bg-white px-2.5 text-[12px] focus:border-brand-500 focus:outline-none sm:w-72"
          />
        )}
        {rejected > 0 && (
          <button type="button" onClick={() => navigate('/cxp/documentos')} className="text-[12px] text-bad hover:underline">
            {rejected} rechazado{rejected === 1 ? '' : 's'} (ver en Documentos)
          </button>
        )}
        <div className="ml-auto flex gap-0.5 rounded-md bg-subtle p-0.5" role="tablist" aria-label="Vista">
          {([
            ['board', 'Tablero', <Columns3 key="b" size={14} />],
            ['list', 'Lista', <List key="l" size={14} />],
          ] as const).map(([key, label, icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => changeView(key)}
              className={cn('inline-flex h-6 items-center gap-1.5 rounded px-2 text-[12px]', view === key ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      </div>
      <FormError error={error} />

      {view === 'board' ? (
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
          {STAGES.map((s) => {
            const docs = byStage(s.key).sort((a, b) =>
              s.key === 'programado' ? (a.scheduled_payment_date ?? '').localeCompare(b.scheduled_payment_date ?? '') : (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'),
            )
            const ids = docs.map((d) => d.id)
            return (
              <section key={s.key} className="flex w-72 shrink-0 flex-col rounded-lg bg-subtle/80 lg:w-auto lg:min-w-0 lg:flex-1" aria-label={s.label}>
                <header className="px-3 pt-3 pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-[13px] font-semibold text-ink">{s.label}</h2>
                    <span className="rounded-full bg-white px-2 text-[11px] font-medium text-muted">{docs.length}</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    <MoneyTotals totals={sumByCurrency(docs, pick)} empty={s.hint} />
                  </div>
                </header>
                <div className="flex max-h-[62vh] min-h-24 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {documents.isLoading && <div className="h-20 animate-pulse rounded-md bg-white" />}
                  {!documents.isLoading && docs.length === 0 && <p className="px-2 py-6 text-center text-[11px] text-faint">{s.hint}</p>}
                  {docs.map((d) => (
                    <article
                      key={d.id}
                      onClick={() => open(d, ids)}
                      className="cursor-pointer rounded-md border border-line bg-white p-2.5 shadow-xs transition-shadow hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{d.counterparty_name}</span>
                        <Money minor={s.key === 'realizado' ? d.total_amount : d.pending_amount} currency={d.currency} className="shrink-0 text-[12px] font-semibold text-ink" />
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-faint">
                        <span className="truncate">{documentTypeLabel(d.doc_type)} N° {d.folio}</span>
                        <span className="shrink-0">Vence {formatDate(d.due_date)}</span>
                      </div>
                      {s.key === 'programado' && d.scheduled_payment_date && (
                        <div className="mt-1.5 inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-600">
                          <CalendarClock size={12} /> Se paga el {formatDate(d.scheduled_payment_date)}
                        </div>
                      )}
                      {d.payment_status === 'vencido' && s.key !== 'realizado' && <div className="mt-1.5"><StatusBadge status="vencido" daysOverdue={d.days_overdue} /></div>}
                      {canWrite && s.key !== 'realizado' && (
                        <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2" onClick={(e) => e.stopPropagation()}>
                          {s.key === 'por_aprobar' && (
                            <>
                              <Button size="sm" variant="primary" onClick={() => approve([d])}><CircleCheck size={13} /> Aprobar</Button>
                              <Button size="sm" onClick={() => open(d, ids)}>Revisar</Button>
                            </>
                          )}
                          {s.key === 'aprobado' && (
                            <>
                              <Button size="sm" variant="primary" onClick={() => request([d])}><Send size={13} /> Solicitar pago</Button>
                              <Button size="sm" onClick={() => schedule([d])}><CalendarClock size={13} /> Programar</Button>
                            </>
                          )}
                          {s.key === 'solicitado' && (
                            <>
                              <Button size="sm" variant="primary" onClick={() => schedule([d])}><CalendarClock size={13} /> Programar</Button>
                              <Button size="sm" variant="ghost" onClick={() => unrequest(d)} title="Quitar solicitud"><Undo2 size={13} /></Button>
                            </>
                          )}
                          {s.key === 'programado' && (
                            <>
                              <Button size="sm" variant="primary" onClick={() => pay([d])}><Banknote size={13} /> Registrar pago</Button>
                              <Button size="sm" onClick={() => schedule([d])}>Reprogramar</Button>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <PaymentsList
          docs={all}
          loading={documents.isLoading}
          canWrite={canWrite}
          onOpen={open}
          onApprove={approve}
          onRequest={request}
          onSchedule={schedule}
          onPay={pay}
        />
      )}

      {scheduling && (
        <ScheduleDrawer
          docs={scheduling}
          onClose={() => setScheduling(null)}
          onSave={async (date) => {
            for (const d of scheduling) await stage.mutateAsync({ id: d.id, stage: 'scheduled', scheduledDate: date })
            setScheduling(null)
          }}
        />
      )}
      {paying && <PaymentDrawer open direction="out" presets={paying} onClose={() => setPaying(null)} />}
    </div>
  )
}

function StatCardLite({ label, count, value, tone }: { label: string; count: number; value: React.ReactNode; tone?: 'info' }) {
  return (
    <div className={cn('rounded-lg border bg-white px-4 py-3', tone === 'info' ? 'border-brand-600/25' : 'border-line')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-[10px] font-semibold tracking-wider text-faint uppercase">{label}</span>
        <span className="text-[11px] text-faint">{count} documentos</span>
      </div>
      <div className="mt-1 text-[16px] leading-tight font-semibold text-ink tabular">{value}</div>
    </div>
  )
}

function PaymentsList({
  docs,
  loading,
  canWrite,
  onOpen,
  onApprove,
  onRequest,
  onSchedule,
  onPay,
}: {
  docs: DocumentRow[]
  loading: boolean
  canWrite: boolean
  onOpen: (d: DocumentRow, ids: string[]) => void
  onApprove: (d: DocumentRow[]) => void
  onRequest: (d: DocumentRow[]) => void
  onSchedule: (d: DocumentRow[]) => void
  onPay: (d: DocumentRow[]) => void
}) {
  const columns: ListColumn<DocumentRow>[] = [
    { key: 'cp', header: 'Proveedor', cell: (d) => d.counterparty_name, sortValue: (d) => d.counterparty_name, className: 'min-w-40' },
    {
      key: 'doc',
      header: 'Documento',
      cell: (d) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium text-ink">N° {d.folio}</span>
          <span className="text-[11px] text-faint">{documentTypeLabel(d.doc_type)}</span>
        </span>
      ),
      sortValue: (d) => d.folio,
    },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date), sortValue: (d) => d.due_date },
    { key: 'approval', header: 'Aprobación', cell: (d) => <ApprovalStatusBadge status={d.approval_status} />, sortValue: (d) => d.approval_status, mobileHidden: true },
    { key: 'stage', header: 'Gestión de pago', cell: (d) => <PaymentManagementBadge value={d.payment_management} date={d.scheduled_payment_date} />, sortValue: (d) => STAGES.findIndex((s) => s.key === stageOf(d)), mobileBadge: true },
    { key: 'pending', header: 'Saldo', align: 'right', cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className="font-semibold text-ink" />, sortValue: (d) => d.pending_amount },
  ]
  const filters: ListFilter<DocumentRow>[] = [
    { type: 'select', key: 'stage', label: 'Etapa', options: STAGES.map((s) => ({ value: s.key, label: s.label })), defaultValue: '', match: (d, v) => stageOf(d) === v },
    {
      type: 'select',
      key: 'cp',
      label: 'Proveedor',
      options: [...new Map(docs.map((d) => [d.counterparty_id, d.counterparty_name])).entries()].map(([value, label]) => ({ value, label })),
      match: (d, v) => d.counterparty_id === v,
    },
    { type: 'dateRange', key: 'scheduled', label: 'Fecha programada', getDate: (d) => d.scheduled_payment_date },
    { type: 'dateRange', key: 'due', label: 'Vencimiento', getDate: (d) => d.due_date },
  ]
  const list = useListState({
    rows: docs,
    rowKey: (d) => d.id,
    columns,
    filters,
    searchText: (d) => `${d.counterparty_name} ${d.folio}`,
    storageKey: 'payment-management',
    defaultSort: { key: 'stage', dir: 'asc' },
  })
  const ids = list.filtered.map((d) => d.id)
  return (
    <ListView
      state={list}
      columns={columns}
      rowKey={(d) => d.id}
      filters={filters}
      loading={loading}
      searchPlaceholder="Buscar proveedor o folio…"
      onRowClick={(d) => onOpen(d, ids)}
      bulkActions={
        canWrite
          ? (rows) => (
              <>
                <BulkButton onClick={() => onApprove(rows)}><CircleCheck size={14} /> Aprobar</BulkButton>
                <BulkButton onClick={() => onRequest(rows)}><Send size={14} /> Solicitar pago</BulkButton>
                <BulkButton onClick={() => onSchedule(rows)}><CalendarClock size={14} /> Programar</BulkButton>
                <BulkButton onClick={() => onPay(rows)}><Banknote size={14} /> Registrar pago</BulkButton>
              </>
            )
          : undefined
      }
      rowActions={(d) => {
        if (!canWrite) return null
        const s = stageOf(d)
        return (
          <>
            {s === 'por_aprobar' && <RowAction label="Aprobar" onClick={() => onApprove([d])}><CircleCheck /></RowAction>}
            {s === 'aprobado' && <RowAction label="Solicitar pago" onClick={() => onRequest([d])}><Send /></RowAction>}
            {(s === 'aprobado' || s === 'solicitado' || s === 'programado') && <RowAction label={s === 'programado' ? 'Reprogramar' : 'Programar pago'} onClick={() => onSchedule([d])}><CalendarClock /></RowAction>}
            {(s === 'solicitado' || s === 'programado' || s === 'aprobado') && <RowAction label="Registrar pago" onClick={() => onPay([d])}><Banknote /></RowAction>}
          </>
        )
      }}
      empty={<EmptyState title="Sin documentos en gestión" description="Los documentos por pagar abiertos aparecen aquí según su etapa." />}
    />
  )
}

function ScheduleDrawer({ docs, onClose, onSave }: { docs: DocumentRow[]; onClose: () => void; onSave: (date: string) => Promise<void> }) {
  const { today } = useCurrentTenant()
  const [date, setDate] = useState(docs.length === 1 && docs[0].scheduled_payment_date ? docs[0].scheduled_payment_date : addDays(today, 7))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const quick = [
    ['Hoy', today],
    ['Mañana', addDays(today, 1)],
    ['En 7 días', addDays(today, 7)],
    ['En 15 días', addDays(today, 15)],
  ] as const
  const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })
  return (
    <Drawer
      open
      title={docs.length === 1 ? 'Programar pago' : `Programar ${docs.length} pagos`}
      subtitle={docs.length === 1 ? `${docs[0].counterparty_name} · N° ${docs[0].folio}` : undefined}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={saving || !date}
            onClick={async () => {
              setError(null)
              setSaving(true)
              try {
                await onSave(date)
              } catch (err) {
                setError(errorMessage(err))
              } finally {
                setSaving(false)
              }
            }}
          >
            <CalendarClock size={14} /> Programar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="rounded-lg bg-subtle px-3 py-2 text-[12px] text-muted">
          Total a pagar: <b className="text-ink"><MoneyTotals totals={sumByCurrency(docs, pick)} /></b>
        </div>
        <Field label="Fecha de pago" hint="El proveedor la verá en su portal financiero.">
          {(id) => <Input id={id} type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          {quick.map(([label, value]) => (
            <button key={label} type="button" onClick={() => setDate(value)} className={cn('rounded-full border px-3 py-1 text-[12px]', date === value ? 'border-navy-900 bg-head text-ink' : 'border-line text-muted hover:bg-subtle')}>
              {label}
            </button>
          ))}
        </div>
        {docs.length > 1 && (
          <ul className="divide-y divide-line rounded-lg border border-line text-[12px]">
            {docs.map((d) => (
              <li key={d.id} className="flex justify-between gap-3 px-3 py-2">
                <span className="truncate">{d.counterparty_name} · N° {d.folio}</span>
                <Money minor={d.pending_amount} currency={d.currency} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
