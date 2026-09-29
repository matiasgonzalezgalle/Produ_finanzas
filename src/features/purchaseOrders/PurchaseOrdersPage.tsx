// Órdenes de compra. CxP: OC emitidas a proveedores (numeración propia y aprobación).
// CxC: OC recibidas de clientes (se aceptan o rechazan). Los documentos se asocian a la OC
// y consumen su saldo por facturar.
import { Ban, CircleCheck, Copy, Download, Eye, FileDown, FilePlus2, FileText, Lock, MoreHorizontal, Paperclip, Pencil, Plus, Send, Trash2, Undo2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useCategories, useCostCenters, useCounterparties, useDocuments, useModuleSettings, usePaymentMethods, usePurchaseOrderAttachments, usePurchaseOrderLines, usePurchaseOrderMutations, usePurchaseOrders } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api, type DocumentRow, type PurchaseOrderAttachment, type PurchaseOrderInput, type PurchaseOrderLine, type PurchaseOrderRow, type PurchaseOrderStatus } from '../../data'
import { formatDate, formatTimestampDate } from '../../domain/dates'
import { computeTax, documentTypeLabel, TAX_LABEL, type DocumentDirection } from '../../domain/documents'
import { CURRENCIES, CURRENCY_DECIMALS, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { csvAmount, downloadCsv, type CsvColumn } from '../../lib/csv'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, StatCard, Textarea, type Tone } from '../../ui'
import { BulkButton, ListView, RowAction, RowMenu, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { DocumentDrawer, FilePicker, sectionCopy, sectionTabs } from '../documents/DocumentsPage'
import { rememberDocumentOrder } from '../documents/documentOrder'
import { errorMessage, minorToInput, Money, MoneyTotals, parseMoneyInput, StatusBadge, useNewParam } from '../shared'

// ---------------------------------------------------------------------------
// Textos por módulo
// ---------------------------------------------------------------------------
export function poCopy(direction: DocumentDirection) {
  return direction === 'payable'
    ? {
        counterparty: 'Proveedor',
        create: 'Nueva orden de compra',
        createDoc: 'Registrar factura',
        approve: 'Aprobar',
        reject: 'Rechazar',
        empty: 'Emite órdenes de compra a tus proveedores y asocia sus facturas para controlar lo comprometido y lo facturado.',
      }
    : {
        counterparty: 'Cliente',
        create: 'Registrar OC de cliente',
        createDoc: 'Emitir documento',
        approve: 'Aceptar',
        reject: 'Rechazar',
        empty: 'Registra las órdenes de compra que te envían tus clientes y asocia los documentos que emites contra ellas.',
      }
}

export function poStatusLabel(status: PurchaseOrderStatus, direction: DocumentDirection) {
  const labels: Record<PurchaseOrderStatus, string> = {
    draft: 'Borrador',
    pending: direction === 'payable' ? 'Por aprobar' : 'Por aceptar',
    approved: direction === 'payable' ? 'Aprobada' : 'Aceptada',
    rejected: 'Rechazada',
    closed: 'Cerrada',
    void: 'Anulada',
  }
  return labels[status]
}

const STATUS_TONE: Record<PurchaseOrderStatus, Tone> = { draft: 'neutral', pending: 'warn', approved: 'ok', rejected: 'bad', closed: 'solid', void: 'neutral' }
const BILLING_LABEL = { sin_documentos: 'Sin facturar', parcial: 'Facturada parcial', completa: 'Facturada' } as const

export function PurchaseOrderStatusBadge({ order }: { order: Pick<PurchaseOrderRow, 'status' | 'direction'> }) {
  return <Badge tone={STATUS_TONE[order.status]}>{poStatusLabel(order.status, order.direction)}</Badge>
}

/** Barra de avance de lo facturado contra el total de la OC. */
function BillingProgress({ order, compact }: { order: PurchaseOrderRow; compact?: boolean }) {
  const pct = order.total_amount ? Math.min(100, Math.round((order.invoiced_amount / order.total_amount) * 100)) : 0
  return (
    <span className={cn('flex flex-col gap-1', compact ? 'w-32' : 'w-full')}>
      <span className="flex items-center justify-between gap-2 text-[11px] leading-none whitespace-nowrap">
        <span className={cn('font-medium', order.billing_status === 'completa' ? 'text-ok' : order.billing_status === 'parcial' ? 'text-brand-600' : 'text-faint')}>
          {BILLING_LABEL[order.billing_status]}
        </span>
        <span className="text-faint tabular">{pct}%</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <span className={cn('block h-full rounded-full', pct >= 100 ? 'bg-ok' : 'bg-brand-500')} style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Acciones compartidas (lista y detalle)
// ---------------------------------------------------------------------------
function usePurchaseOrderActions(direction: DocumentDirection, onError: (msg: string | null) => void) {
  const { tenant, canAdmin } = useCurrentTenant()
  const settings = useModuleSettings(direction)
  const m = usePurchaseOrderMutations()
  const approvalAdminOnly = direction === 'payable' && (settings.data?.po_approval_admin_only ?? true)
  const canApprove = !approvalAdminOnly || canAdmin

  async function run(fn: () => Promise<unknown>) {
    onError(null)
    try {
      await fn()
      return true
    } catch (err) {
      onError(errorMessage(err))
      return false
    }
  }

  return {
    canApprove,
    setStatus: (order: PurchaseOrderRow, status: PurchaseOrderStatus, reason?: string) => run(() => m.setStatus.mutateAsync({ id: order.id, status, reason })),
    remove: async (order: PurchaseOrderRow) => {
      if (!window.confirm(`¿Eliminar la orden de compra N° ${order.number}? Esta acción no se puede deshacer.`)) return false
      return run(() => m.remove.mutateAsync(order.id))
    },
    voidOrder: async (order: PurchaseOrderRow) => {
      if (!window.confirm(`¿Anular la orden de compra N° ${order.number}? Quedará registrada como anulada.`)) return false
      return run(() => m.setStatus.mutateAsync({ id: order.id, status: 'void' }))
    },
    markSent: (order: PurchaseOrderRow, sentTo: string | null) => run(() => m.markSent.mutateAsync({ id: order.id, sentTo })),
    downloadPdf: (order: PurchaseOrderRow) =>
      run(async () => {
        const lines = await api.listPurchaseOrderLines(tenant.id, order.id)
        // pdf-lib pesa ~400 KB: se carga solo al descargar.
        const { buildPurchaseOrderPdf } = await import('../../lib/purchaseOrderPdf')
        const { downloadBlob } = await import('../../lib/documentPdf')
        const bytes = await buildPurchaseOrderPdf({
          order,
          lines,
          tenant: { name: tenant.legal_name ?? tenant.name, taxId: tenant.tax_id, country: tenant.country },
          statusLabel: poStatusLabel(order.status, order.direction),
        })
        downloadBlob(bytes, `orden-de-compra-${order.number.replace(/[^\w-]+/g, '_')}.pdf`)
      }),
  }
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export function PurchaseOrdersPage({ direction }: { direction: DocumentDirection }) {
  const copy = sectionCopy(direction)
  const text = poCopy(direction)
  const { canWrite, tenant } = useCurrentTenant()
  const orders = usePurchaseOrders(direction)
  const documents = useDocuments(direction)
  const [newOpen, setNewOpen] = useNewParam()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<PurchaseOrderRow | null>(null)
  const [duplicating, setDuplicating] = useState<PurchaseOrderRow | null>(null)
  const [creatingDoc, setCreatingDoc] = useState<PurchaseOrderRow | null>(null)
  const [rejecting, setRejecting] = useState<PurchaseOrderRow | null>(null)
  const [sending, setSending] = useState<PurchaseOrderRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = usePurchaseOrderActions(direction, setError)

  const all = useMemo(() => orders.data ?? [], [orders.data])
  const detailId = params.get('id')
  const detail = detailId ? all.find((o) => o.id === detailId) ?? null : null
  const openDetail = (o: PurchaseOrderRow | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (o) next.set('id', o.id)
        else next.delete('id')
        return next
      },
      { replace: true },
    )

  const pending = all.filter((o) => o.status === 'pending')
  const active = all.filter((o) => o.status === 'approved')
  const pickTotal = (o: PurchaseOrderRow) => ({ currency: o.currency, amount: o.total_amount })
  const pickRemaining = (o: PurchaseOrderRow) => ({ currency: o.currency, amount: o.remaining_amount })
  const pickInvoiced = (o: PurchaseOrderRow) => ({ currency: o.currency, amount: o.invoiced_amount })

  const columns: ListColumn<PurchaseOrderRow>[] = [
    {
      key: 'number',
      header: 'Orden',
      cell: (o) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="font-medium whitespace-nowrap text-ink">N° {o.number}</span>
          <span className="max-w-56 truncate text-xs text-faint">{o.description ?? (o.line_count ? `${o.line_count} ${o.line_count === 1 ? 'línea' : 'líneas'}` : '—')}</span>
        </span>
      ),
      sortValue: (o) => o.number.padStart(20, '0'),
    },
    { key: 'cp', header: text.counterparty, cell: (o) => o.counterparty_name, sortValue: (o) => o.counterparty_name, className: 'min-w-40' },
    { key: 'issue', header: 'Emisión', cell: (o) => formatDate(o.issue_date), sortValue: (o) => o.issue_date },
    { key: 'delivery', mobileHidden: true, header: 'Entrega', cell: (o) => formatDate(o.delivery_date), sortValue: (o) => o.delivery_date, className: 'hidden 2xl:table-cell' },
    {
      key: 'status',
      mobileBadge: true,
      header: 'Estado',
      cell: (o) => (
        <span className="flex flex-col items-start gap-0.5">
          <PurchaseOrderStatusBadge order={o} />
          {direction === 'payable' && o.status === 'approved' && (
            <span className={cn('text-[10px] font-medium', o.sent_at ? 'text-muted' : 'text-warn')}>{o.sent_at ? `Enviada ${formatTimestampDate(o.sent_at, tenant.timezone)}` : 'Sin enviar'}</span>
          )}
        </span>
      ),
      sortValue: (o) => o.status,
    },
    { key: 'billing', mobileHidden: true, header: 'Facturación', cell: (o) => (o.status === 'draft' || o.status === 'void' ? <span className="text-faint">—</span> : <BillingProgress order={o} compact />), sortValue: (o) => (o.total_amount ? o.invoiced_amount / o.total_amount : 0) },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => <Money minor={o.total_amount} currency={o.currency} />, sortValue: (o) => o.total_amount },
    {
      key: 'remaining',
      header: 'Por facturar',
      align: 'right',
      cell: (o) => (o.status === 'approved' ? <Money minor={o.remaining_amount} currency={o.currency} className={o.remaining_amount ? 'font-semibold text-ink' : 'text-faint'} /> : <span className="text-faint">—</span>),
      sortValue: (o) => (o.status === 'approved' ? o.remaining_amount : -1),
    },
  ]

  const counterparties = [...new Map(all.map((o) => [o.counterparty_id, o.counterparty_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const currencies = [...new Set(all.map((o) => o.currency))]
  const costCenters = [...new Map(all.filter((o) => o.cost_center_id).map((o) => [o.cost_center_id!, o.cost_center_name ?? ''])).entries()]
  const statusOrder: PurchaseOrderStatus[] = ['draft', 'pending', 'approved', 'rejected', 'closed', 'void']
  const filters: ListFilter<PurchaseOrderRow>[] = [
    {
      type: 'select',
      key: 'status',
      label: 'Estado',
      options: [{ value: 'vigentes', label: 'Vigentes (sin cerradas ni anuladas)' }, ...statusOrder.map((s) => ({ value: s, label: poStatusLabel(s, direction) }))],
      defaultValue: 'vigentes',
      match: (o, v) => (v === 'vigentes' ? o.status !== 'closed' && o.status !== 'void' : o.status === v),
    },
    {
      type: 'select',
      key: 'billing',
      label: 'Facturación',
      options: (Object.keys(BILLING_LABEL) as (keyof typeof BILLING_LABEL)[]).map((k) => ({ value: k, label: BILLING_LABEL[k] })),
      match: (o, v) => o.billing_status === v,
    },
    { type: 'select', key: 'cp', label: text.counterparty, options: counterparties.map(([value, label]) => ({ value, label })), match: (o, v) => o.counterparty_id === v },
    ...(direction === 'payable'
      ? [
          {
            type: 'select' as const,
            key: 'sent',
            label: 'Envío',
            options: [{ value: 'si', label: 'Enviadas' }, { value: 'no', label: 'Aprobadas sin enviar' }],
            match: (o: PurchaseOrderRow, v: string) => (v === 'si' ? !!o.sent_at : o.status === 'approved' && !o.sent_at),
          },
          { type: 'select' as const, key: 'cc', label: 'Centro de costos', options: costCenters.map(([value, label]) => ({ value, label })), match: (o: PurchaseOrderRow, v: string) => o.cost_center_id === v },
        ]
      : []),
    { type: 'select', key: 'currency', label: 'Moneda', options: currencies.map((c) => ({ value: c, label: c })), match: (o, v) => o.currency === v },
    { type: 'dateRange', key: 'issue', label: 'Emisión', getDate: (o) => o.issue_date },
    { type: 'dateRange', key: 'delivery', label: 'Entrega', getDate: (o) => o.delivery_date },
  ]

  const list = useListState({
    rows: all,
    rowKey: (o) => o.id,
    columns,
    filters,
    searchText: (o) => `${o.number} ${o.counterparty_name} ${o.counterparty_tax_id ?? ''} ${o.description ?? ''} ${o.requester ?? ''}`,
    storageKey: `purchase-orders-${direction}`,
    defaultSort: { key: 'issue', dir: 'desc' },
  })

  const csvColumns: CsvColumn<PurchaseOrderRow>[] = [
    { header: 'Número', value: (o) => o.number },
    { header: text.counterparty, value: (o) => o.counterparty_name },
    { header: 'RUT / RUC', value: (o) => o.counterparty_tax_id ?? '' },
    { header: 'Emisión', value: (o) => o.issue_date },
    { header: 'Entrega', value: (o) => o.delivery_date ?? '' },
    { header: 'Estado', value: (o) => poStatusLabel(o.status, o.direction) },
    { header: 'Moneda', value: (o) => o.currency },
    { header: 'Neto', value: (o) => csvAmount(o.net_amount, CURRENCY_DECIMALS[o.currency]) },
    { header: 'Impuesto', value: (o) => csvAmount(o.tax_amount, CURRENCY_DECIMALS[o.currency]) },
    { header: 'Total', value: (o) => csvAmount(o.total_amount, CURRENCY_DECIMALS[o.currency]) },
    { header: 'Facturado', value: (o) => csvAmount(o.invoiced_amount, CURRENCY_DECIMALS[o.currency]) },
    { header: 'Por facturar', value: (o) => csvAmount(o.remaining_amount, CURRENCY_DECIMALS[o.currency]) },
    { header: 'Documentos', value: (o) => o.document_count },
    { header: 'Descripción', value: (o) => o.description ?? '' },
    ...(direction === 'payable'
      ? [
          { header: 'Solicitante', value: (o: PurchaseOrderRow) => o.requester ?? '' },
          { header: 'Centro de costos', value: (o: PurchaseOrderRow) => o.cost_center_name ?? '' },
          { header: 'Enviada', value: (o: PurchaseOrderRow) => (o.sent_at ? o.sent_at.slice(0, 10) : '') },
        ]
      : []),
  ]
  const fileBase = direction === 'payable' ? 'ordenes-de-compra-emitidas' : 'ordenes-de-compra-clientes'

  async function approveMany(rows: PurchaseOrderRow[]) {
    const eligible = rows.filter((o) => o.status === 'pending' || o.status === 'draft')
    if (!eligible.length) return setError(`Ninguna de las órdenes seleccionadas está por ${direction === 'payable' ? 'aprobar' : 'aceptar'}.`)
    for (const o of eligible) if (!(await actions.setStatus(o, 'approved'))) return
    list.clearSelection()
  }

  async function closeMany(rows: PurchaseOrderRow[]) {
    const eligible = rows.filter((o) => o.status === 'approved')
    if (!eligible.length) return setError('Solo se cierran órdenes aprobadas.')
    if (!window.confirm(`¿Cerrar ${eligible.length} ${eligible.length === 1 ? 'orden' : 'órdenes'}? No se podrán asociar más documentos.`)) return
    for (const o of eligible) if (!(await actions.setStatus(o, 'closed'))) return
    list.clearSelection()
  }

  function rowMenu(o: PurchaseOrderRow) {
    const items: { label: string; onClick: () => void; tone?: 'danger'; disabled?: boolean }[] = [{ label: 'Descargar PDF', onClick: () => actions.downloadPdf(o) }]
    if (!canWrite) return items
    if (o.status === 'approved' && o.remaining_amount > 0) items.unshift({ label: text.createDoc, onClick: () => setCreatingDoc(o) })
    items.push({ label: 'Duplicar', onClick: () => setDuplicating(o) })
    if (o.status === 'draft') items.push({ label: direction === 'payable' ? 'Enviar a aprobación' : 'Marcar por aceptar', onClick: () => actions.setStatus(o, 'pending') })
    if ((o.status === 'draft' || o.status === 'pending') && actions.canApprove) items.push({ label: text.approve, onClick: () => actions.setStatus(o, 'approved') })
    if (o.status === 'pending' && actions.canApprove) items.push({ label: text.reject, onClick: () => setRejecting(o) })
    if (o.status === 'rejected') items.push({ label: 'Volver a borrador', onClick: () => actions.setStatus(o, 'draft') })
    if (direction === 'payable' && o.status === 'approved') items.push({ label: o.sent_at ? 'Registrar nuevo envío' : 'Marcar como enviada', onClick: () => setSending(o) })
    if (o.status === 'approved') items.push({ label: 'Cerrar orden', onClick: () => actions.setStatus(o, 'closed') })
    if (o.status === 'closed') items.push({ label: 'Reabrir', onClick: () => actions.setStatus(o, 'approved') })
    if (['draft', 'pending', 'rejected'].includes(o.status)) items.push({ label: 'Eliminar', tone: 'danger', onClick: () => actions.remove(o) })
    else if (o.status !== 'void' && o.document_count === 0) items.push({ label: 'Anular', tone: 'danger', onClick: () => actions.voidOrder(o) })
    return items
  }

  return (
    <div>
      <PageHeader
        title={copy.title}
        tabs={sectionTabs(direction)}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus size={16} /> {text.create}</Button>}
      />
      <div className="stat-row pt-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={direction === 'payable' ? 'Por aprobar' : 'Por aceptar'} tone={pending.length ? 'bad' : undefined} value={<MoneyTotals totals={sumByCurrency(pending, pickTotal)} empty="$0" />} detail={`${pending.length} órdenes`} />
        <StatCard label={direction === 'payable' ? 'Comprometido' : 'Contratado'} hint="Total de las órdenes aprobadas vigentes" value={<MoneyTotals totals={sumByCurrency(active, pickTotal)} empty="$0" />} detail={`${active.length} vigentes`} />
        <StatCard label="Facturado" hint="Documentos asociados a órdenes vigentes" value={<MoneyTotals totals={sumByCurrency(active, pickInvoiced)} empty="$0" />} />
        <StatCard label="Por facturar" hint="Saldo de las órdenes aprobadas sin documentos asociados" value={<MoneyTotals totals={sumByCurrency(active, pickRemaining)} empty="$0" />} detail={`${active.filter((o) => o.remaining_amount > 0).length} con saldo`} />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <FormError error={error} />
        <ListView
          state={list}
          columns={columns}
          rowKey={(o) => o.id}
          filters={filters}
          loading={orders.isLoading}
          searchPlaceholder={`Buscar por número, ${text.counterparty.toLowerCase()} o descripción…`}
          onRowClick={openDetail}
          toolbarExtra={
            <Button size="sm" onClick={() => downloadCsv(`${fileBase}.csv`, list.filtered, csvColumns)} disabled={!list.total}>
              <Download size={16} /> Exportar
            </Button>
          }
          bulkActions={(rows) => (
            <>
              <BulkButton onClick={() => downloadCsv(`${fileBase}-seleccion.csv`, rows, csvColumns)}><Download size={15} /> Exportar</BulkButton>
              {canWrite && actions.canApprove && <BulkButton onClick={() => approveMany(rows)}><CircleCheck size={15} /> {text.approve}</BulkButton>}
              {canWrite && <BulkButton onClick={() => closeMany(rows)}><Lock size={15} /> Cerrar</BulkButton>}
            </>
          )}
          rowActions={(o) => (
            <>
              <RowAction label="Ver detalle" onClick={() => openDetail(o)}><Eye size={17} /></RowAction>
              {canWrite && o.status !== 'void' && <RowAction label="Editar" onClick={() => setEditing(o)}><Pencil size={17} /></RowAction>}
              <RowMenu label="Más acciones" icon={<MoreHorizontal size={17} />} items={rowMenu(o)} />
            </>
          )}
          empty={
            <EmptyState
              icon={<FileText size={20} />}
              title={all.length ? 'Sin órdenes para estos filtros' : 'Aún no hay órdenes de compra'}
              description={all.length ? 'Cambia el estado o limpia los filtros para ver más.' : text.empty}
            />
          }
        />
      </div>

      {detail && (
        <PurchaseOrderDetail
          order={detail}
          documents={(documents.data ?? []).filter((d) => d.purchase_order_id === detail.id)}
          actions={actions}
          onClose={() => openDetail(null)}
          onEdit={() => setEditing(detail)}
          onCreateDocument={() => setCreatingDoc(detail)}
          onReject={() => setRejecting(detail)}
          onSend={() => setSending(detail)}
          menu={rowMenu(detail)}
        />
      )}
      {(newOpen || editing || duplicating) && (
        <PurchaseOrderDrawer
          key={editing?.id ?? duplicating?.id ?? 'new'}
          direction={direction}
          order={editing}
          copyFrom={duplicating}
          canApprove={actions.canApprove}
          onClose={() => {
            setEditing(null)
            setDuplicating(null)
            setNewOpen(false)
          }}
        />
      )}
      {creatingDoc && (
        <DocumentDrawer
          open
          direction={direction}
          doc={null}
          documents={documents.data ?? []}
          preset={creatingDoc}
          onClose={() => setCreatingDoc(null)}
        />
      )}
      {rejecting && (
        <ReasonDrawer
          title={`Rechazar orden N° ${rejecting.number}`}
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => {
            if (await actions.setStatus(rejecting, 'rejected', reason)) setRejecting(null)
          }}
        />
      )}
      {sending && <SendDrawer order={sending} onClose={() => setSending(null)} onConfirm={async (to) => { if (await actions.markSent(sending, to)) setSending(null) }} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------
function PurchaseOrderDetail({
  order,
  documents,
  actions,
  onClose,
  onEdit,
  onCreateDocument,
  onReject,
  onSend,
  menu,
}: {
  order: PurchaseOrderRow
  documents: DocumentRow[]
  actions: ReturnType<typeof usePurchaseOrderActions>
  onClose: () => void
  onEdit: () => void
  onCreateDocument: () => void
  onReject: () => void
  onSend: () => void
  menu: { label: string; onClick: () => void; tone?: 'danger'; disabled?: boolean }[]
}) {
  const { tenant, canWrite } = useCurrentTenant()
  const navigate = useNavigate()
  const text = poCopy(order.direction)
  const lines = usePurchaseOrderLines(order.id)
  const base = order.direction === 'payable' ? '/cxp' : '/cxc'
  const [error, setError] = useState<string | null>(null)
  const isPayable = order.direction === 'payable'

  const facts: [string, React.ReactNode][] = [
    ['Emisión', formatDate(order.issue_date)],
    ['Entrega', formatDate(order.delivery_date)],
    ['Plazo de pago', order.payment_terms_days != null ? `${order.payment_terms_days} días` : '—'],
    ['Forma de pago', order.payment_method ?? '—'],
    ...(isPayable ? ([['Solicitante', order.requester ?? '—']] as [string, React.ReactNode][]) : []),
    ['Categoría', order.category_name ?? '—'],
    ['Centro de costos', order.cost_center_name ?? '—'],
    ['Moneda', order.currency],
  ]

  return (
    <Drawer
      open
      width="xl"
      title={`Orden de compra N° ${order.number}`}
      onClose={onClose}
      header={
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-wide text-faint uppercase">{isPayable ? 'Orden de compra emitida' : 'Orden de compra del cliente'}</p>
            <h2 className="mt-0.5 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
              N° {order.number}
              <PurchaseOrderStatusBadge order={order} />
            </h2>
            <p className="mt-0.5 truncate text-sm text-muted">
              {order.counterparty_name}
              {order.counterparty_tax_id ? ` · ${formatTaxId(order.counterparty_tax_id, tenant.country as Country)}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && order.status === 'pending' && actions.canApprove && (
              <>
                <Button size="sm" onClick={onReject}><X size={15} /> {text.reject}</Button>
                <Button size="sm" variant="primary" onClick={() => actions.setStatus(order, 'approved')}><CircleCheck size={15} /> {text.approve}</Button>
              </>
            )}
            {canWrite && order.status === 'draft' && (
              <Button size="sm" variant="primary" onClick={() => actions.setStatus(order, actions.canApprove ? 'approved' : 'pending')}>
                <Send size={15} /> {actions.canApprove ? text.approve : 'Enviar a aprobación'}
              </Button>
            )}
            {canWrite && order.status === 'approved' && order.remaining_amount > 0 && (
              <Button size="sm" variant="primary" onClick={onCreateDocument}><FilePlus2 size={15} /> {text.createDoc}</Button>
            )}
            {canWrite && isPayable && order.status === 'approved' && !order.sent_at && <Button size="sm" onClick={onSend}><Send size={15} /> Marcar enviada</Button>}
            {canWrite && order.status !== 'void' && <Button size="sm" onClick={onEdit}><Pencil size={15} /> Editar</Button>}
            <RowMenu label="Más acciones" icon={<MoreHorizontal size={17} />} items={menu} />
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-subtle" aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        {order.status === 'rejected' && order.rejection_reason && (
          <div className="rounded-lg border border-bad/25 bg-bad-bg px-4 py-3 text-sm text-bad">
            <span className="font-medium">Rechazada:</span> {order.rejection_reason}
          </div>
        )}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Total" value={<Money minor={order.total_amount} currency={order.currency} />} />
          <Metric label="Facturado" value={<Money minor={order.invoiced_amount} currency={order.currency} />} detail={`${order.document_count} documentos`} />
          <Metric label="Por facturar" value={<Money minor={order.remaining_amount} currency={order.currency} />} strong />
          <Metric label={isPayable ? 'Pagado' : 'Cobrado'} value={<Money minor={order.paid_amount} currency={order.currency} />} detail={order.documents_pending_amount ? `Saldo ${formatMoney(order.documents_pending_amount, order.currency)}` : undefined} />
          <div className="col-span-2 md:col-span-4"><BillingProgress order={order} /></div>
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
            <Panel title="Detalle">
              {order.description && <p className="mb-3 text-sm font-medium text-ink">{order.description}</p>}
              {lines.isLoading ? (
                <p className="text-sm text-faint">Cargando líneas…</p>
              ) : (lines.data ?? []).length === 0 ? (
                <p className="text-sm text-faint">Sin detalle por líneas: la orden se registró por monto.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-[11px] font-semibold tracking-wide text-faint uppercase">
                        <th className="py-2 pr-3 font-semibold">Descripción</th>
                        <th className="py-2 pr-3 text-right font-semibold">Cant.</th>
                        <th className="py-2 pr-3 text-right font-semibold">Precio unit.</th>
                        <th className="py-2 pr-3 text-right font-semibold">Desc.</th>
                        <th className="py-2 text-right font-semibold">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(lines.data ?? []).map((l, i) => (
                        <tr key={i}>
                          <td className="py-2 pr-3 text-ink">{l.description}</td>
                          <td className="py-2 pr-3 text-right tabular">{l.quantity.toLocaleString('es-CL', { maximumFractionDigits: 4 })}</td>
                          <td className="py-2 pr-3 text-right"><Money minor={l.unit_price} currency={order.currency} /></td>
                          <td className="py-2 pr-3 text-right">{l.discount ? <Money minor={l.discount} currency={order.currency} /> : <span className="text-faint">—</span>}</td>
                          <td className="py-2 text-right font-medium"><Money minor={l.amount} currency={order.currency} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <dl className="mt-3 ml-auto flex max-w-xs flex-col gap-1.5 border-t border-line pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-muted">{order.tax_amount ? 'Neto' : 'Subtotal'}</dt><dd><Money minor={order.net_amount} currency={order.currency} /></dd></div>
                {order.exempt_amount > 0 && <div className="flex justify-between"><dt className="text-muted">Exento</dt><dd><Money minor={order.exempt_amount} currency={order.currency} /></dd></div>}
                {order.tax_amount > 0 && <div className="flex justify-between"><dt className="text-muted">{TAX_LABEL[tenant.country]}</dt><dd><Money minor={order.tax_amount} currency={order.currency} /></dd></div>}
                <div className="flex justify-between font-semibold text-ink"><dt>Total</dt><dd><Money minor={order.total_amount} currency={order.currency} /></dd></div>
              </dl>
            </Panel>

            <Panel
              title={`Documentos asociados (${documents.length})`}
              actions={canWrite && order.status === 'approved' && order.remaining_amount > 0 ? <Button size="sm" onClick={onCreateDocument}><Plus size={14} /> {text.createDoc}</Button> : undefined}
            >
              {documents.length === 0 ? (
                <p className="text-sm text-faint">
                  {order.status === 'approved'
                    ? `Aún no hay documentos. Registra ${isPayable ? 'la factura del proveedor' : 'el documento'} y asócialo a esta orden.`
                    : `Los documentos se asocian cuando la orden está ${isPayable ? 'aprobada' : 'aceptada'}.`}
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {documents.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => {
                          rememberDocumentOrder(order.direction, documents.map((x) => x.id))
                          navigate(`${base}/documentos/${d.id}`)
                        }}
                        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-left text-sm hover:bg-subtle/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-ink">{documentTypeLabel(d.doc_type)} N° {d.folio}</span>
                          <span className="block text-xs text-faint">Emitido {formatDate(d.issue_date)} · vence {formatDate(d.due_date)}</span>
                        </span>
                        <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />
                        <span className="w-28 text-right"><Money minor={d.net_total} currency={d.currency} className="font-medium text-ink" /></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Panel title="Información">
              <dl className="flex flex-col gap-2 text-sm">
                {facts.map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted">{label}</dt>
                    <dd className="truncate text-right text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
            <Panel title="Seguimiento">
              <ul className="flex flex-col gap-2 text-sm">
                <li className="flex justify-between gap-3"><span className="text-muted">Registrada</span><span className="text-ink">{formatTimestampDate(order.created_at, tenant.timezone)}</span></li>
                <li className="flex justify-between gap-3">
                  <span className="text-muted">{isPayable ? 'Aprobada' : 'Aceptada'}</span>
                  <span className="text-ink">{order.approved_at ? formatTimestampDate(order.approved_at, tenant.timezone) : '—'}</span>
                </li>
                {isPayable && (
                  <li className="flex justify-between gap-3">
                    <span className="text-muted">Enviada</span>
                    <span className="truncate text-right text-ink">{order.sent_at ? `${formatTimestampDate(order.sent_at, tenant.timezone)}${order.sent_to ? ` · ${order.sent_to}` : ''}` : '—'}</span>
                  </li>
                )}
              </ul>
            </Panel>
            <Panel title="Archivos">
              <PurchaseOrderFiles order={order} editable={canWrite && order.status !== 'void'} onError={setError} />
            </Panel>
            {order.notes && (
              <Panel title="Observaciones">
                <p className="text-sm whitespace-pre-line text-ink">{order.notes}</p>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  )
}

function Metric({ label, value, detail, strong }: { label: string; value: React.ReactNode; detail?: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', strong ? 'border-navy-900/15 bg-head' : 'border-line')}>
      <p className="text-[10px] font-semibold tracking-wider text-faint uppercase">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold text-ink tabular">{value}</p>
      {detail && <p className="text-[11px] text-faint">{detail}</p>}
    </div>
  )
}

function Panel({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function PurchaseOrderFiles({ order, editable, onError }: { order: PurchaseOrderRow; editable: boolean; onError: (m: string | null) => void }) {
  const { tenant } = useCurrentTenant()
  const files = usePurchaseOrderAttachments(order.id)
  const m = usePurchaseOrderMutations()
  const [pending, setPending] = useState<File[]>([])

  async function download(file: PurchaseOrderAttachment) {
    onError(null)
    try {
      const url = await api.purchaseOrderAttachmentUrl(tenant.id, file)
      const a = document.createElement('a')
      a.href = url
      a.download = file.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      a.click()
    } catch (err) {
      onError(errorMessage(err))
    }
  }

  async function upload(list: File[]) {
    setPending(list)
    onError(null)
    try {
      for (const file of list) await m.upload.mutateAsync({ id: order.id, file })
      await files.refetch()
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setPending([])
    }
  }

  const rows = files.data ?? []
  return (
    <div className="flex flex-col gap-2">
      {files.isLoading ? (
        <p className="text-sm text-faint">Cargando archivos…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-faint">{order.direction === 'receivable' ? 'Adjunta el PDF de la OC que envió el cliente.' : 'Sin archivos adjuntos.'}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Paperclip size={14} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-ink">{f.file_name}</span>
              <span className="shrink-0 text-xs text-faint">{formatSize(f.size_bytes)}</span>
              <RowAction label="Descargar" onClick={() => download(f)}><FileDown size={16} /></RowAction>
              {editable && (
                <RowAction
                  label="Eliminar archivo"
                  tone="danger"
                  onClick={async () => {
                    if (!window.confirm(`¿Eliminar ${f.file_name}?`)) return
                    try {
                      await m.removeFile.mutateAsync(f)
                      await files.refetch()
                    } catch (err) {
                      onError(errorMessage(err))
                    }
                  }}
                >
                  <Trash2 size={16} />
                </RowAction>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && <FilePicker files={pending} onChange={(list) => list.length && upload(list)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formulario
// ---------------------------------------------------------------------------
interface LineDraft {
  key: string
  description: string
  quantity: string
  unit_price: string
  discount: string
}

const newLine = (): LineDraft => ({ key: crypto.randomUUID(), description: '', quantity: '1', unit_price: '', discount: '' })
const parseQuantity = (text: string) => {
  const n = Number(text.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

function PurchaseOrderDrawer({
  direction,
  order,
  copyFrom,
  canApprove,
  onClose,
}: {
  direction: DocumentDirection
  order: PurchaseOrderRow | null
  copyFrom: PurchaseOrderRow | null
  canApprove: boolean
  onClose: () => void
}) {
  const { tenant, today } = useCurrentTenant()
  const text = poCopy(direction)
  const counterparties = useCounterparties()
  const categories = useCategories()
  const costCenters = useCostCenters()
  const methods = usePaymentMethods(direction === 'payable' ? 'out' : 'in')
  const settings = useModuleSettings(direction)
  const m = usePurchaseOrderMutations()
  const source = order ?? copyFrom
  const sourceLines = usePurchaseOrderLines(source?.id)
  const locked = !!order && ['approved', 'closed', 'void'].includes(order.status)
  const isPayable = direction === 'payable'

  const options = (counterparties.data ?? []).filter((c) => (isPayable ? c.is_supplier : c.is_customer) || c.id === source?.counterparty_id)
  const [form, setForm] = useState(() => ({
    counterparty_id: source?.counterparty_id ?? '',
    number: order?.number ?? '',
    currency: (source?.currency ?? tenant.base_currency) as Currency,
    issue_date: order?.issue_date ?? today,
    delivery_date: order?.delivery_date ?? '',
    payment_terms_days: source?.payment_terms_days != null ? String(source.payment_terms_days) : '',
    payment_method: source?.payment_method ?? '',
    requester: source?.requester ?? '',
    category_id: source?.category_id ?? '',
    cost_center_id: source?.cost_center_id ?? '',
    description: source?.description ?? '',
    notes: source?.notes ?? '',
    taxed: source ? source.tax_amount > 0 : true,
    // CxC: la OC del cliente puede registrarse solo por monto.
    byLines: source ? source.line_count > 0 : isPayable,
    net: source && source.line_count === 0 ? minorToInput(source.net_amount, source.currency) : '',
  }))
  const [lines, setLines] = useState<LineDraft[] | null>(source ? null : [newLine()])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))

  // Las líneas de la OC existente llegan después: se cargan una vez.
  const loadedLines: LineDraft[] =
    lines ??
    (sourceLines.data
      ? sourceLines.data.length
        ? sourceLines.data.map((l) => ({
            key: crypto.randomUUID(),
            description: l.description,
            quantity: String(l.quantity).replace('.', ','),
            unit_price: minorToInput(l.unit_price, source!.currency),
            discount: l.discount ? minorToInput(l.discount, source!.currency) : '',
          }))
        : [newLine()]
      : [])
  const editLines = (fn: (ls: LineDraft[]) => LineDraft[]) => setLines(fn(loadedLines))

  const parsedLines = loadedLines.map((l) => {
    const quantity = parseQuantity(l.quantity || '0')
    const unit = parseMoneyInput(l.unit_price || '0', form.currency)
    const discount = parseMoneyInput(l.discount || '0', form.currency)
    const amount = unit === null || discount === null || Number.isNaN(quantity) ? null : Math.round(quantity * unit) - discount
    return { ...l, quantityValue: quantity, unit, discountValue: discount, amount }
  })
  const usedLines = parsedLines.filter((l) => l.description.trim() || l.unit_price)
  const netMinor = form.byLines ? usedLines.reduce((sum, l) => sum + (l.amount ?? 0), 0) : parseMoneyInput(form.net || '0', form.currency) ?? 0
  const taxMinor = form.taxed ? computeTax(netMinor, tenant.country) : 0
  const totalMinor = netMinor + taxMinor

  const categoryOptions = (categories.data ?? []).filter((c) => (c.active || c.id === form.category_id) && (c.kind === 'both' || c.kind === (isPayable ? 'expense' : 'income')))
  const costCenterOptions = (costCenters.data ?? []).filter((c) => c.active || c.id === form.cost_center_id)
  const methodOptions = (methods.data ?? []).filter((mm) => mm.active || mm.name === form.payment_method)
  const nextNumber = settings.data ? `${settings.data.po_prefix}${String(settings.data.po_next_number).padStart(5, '0')}` : ''

  function onCounterpartyChange(id: string) {
    const cp = options.find((c) => c.id === id)
    setForm((f) => ({
      ...f,
      counterparty_id: id,
      currency: !order && cp?.default_currency ? cp.default_currency : f.currency,
      payment_terms_days: !f.payment_terms_days && cp?.payment_terms_days != null ? String(cp.payment_terms_days) : f.payment_terms_days,
    }))
  }

  async function submit(status: 'draft' | 'pending' | 'approved' | null) {
    setError(null)
    if (!form.counterparty_id) return setError(`Selecciona un ${text.counterparty.toLowerCase()}`)
    if (!isPayable && !form.number.trim()) return setError('Indica el número de la orden de compra del cliente')
    if (form.delivery_date && form.delivery_date < form.issue_date) return setError('La fecha de entrega no puede ser anterior a la emisión')
    const days = form.payment_terms_days.trim() ? Number(form.payment_terms_days) : null
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) return setError('El plazo de pago debe ser un número de días entre 0 y 365')
    let payloadLines: Omit<PurchaseOrderLine, 'amount'>[] = []
    if (!locked) {
      if (form.byLines) {
        if (!usedLines.length) return setError('Agrega al menos una línea')
        for (const [i, l] of usedLines.entries()) {
          if (!l.description.trim()) return setError(`La línea ${i + 1} necesita una descripción`)
          if (!(l.quantityValue > 0)) return setError(`La cantidad de la línea ${i + 1} debe ser mayor a cero`)
          if (l.unit === null || l.discountValue === null) return setError(`La línea ${i + 1} tiene un monto con formato inválido`)
          if (l.amount === null || l.amount < 0) return setError(`El descuento de la línea ${i + 1} supera su subtotal`)
          payloadLines.push({ description: l.description.trim(), quantity: l.quantityValue, unit_price: l.unit, discount: l.discountValue })
        }
      } else {
        if (form.net && parseMoneyInput(form.net, form.currency) === null) return setError('El monto tiene un formato inválido')
        payloadLines = []
      }
      if (totalMinor <= 0) return setError('El total debe ser mayor a cero')
    }
    const input: PurchaseOrderInput = {
      direction,
      counterparty_id: form.counterparty_id,
      number: form.number.trim() || null,
      currency: form.currency,
      issue_date: form.issue_date,
      delivery_date: form.delivery_date || null,
      net_amount: form.byLines ? 0 : netMinor,
      exempt_amount: 0,
      tax_amount: taxMinor,
      category_id: form.category_id || null,
      cost_center_id: form.cost_center_id || null,
      requester: form.requester.trim() || null,
      payment_method: form.payment_method || null,
      payment_terms_days: days,
      description: form.description.trim() || null,
      notes: form.notes.trim() || null,
      ...(status && !order ? { status } : {}),
    }
    try {
      const id = await m.save.mutateAsync({ input, lines: payloadLines, id: order?.id })
      for (const file of pendingFiles) await m.upload.mutateAsync({ id, file })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const saving = m.save.isPending || m.upload.isPending
  const loadingLines = !!source && sourceLines.isLoading && lines === null

  return (
    <Drawer
      open
      width="xl"
      title={order ? `Editar orden N° ${order.number}` : copyFrom ? `Duplicar orden N° ${copyFrom.number}` : text.create}
      subtitle={locked ? `La orden está ${poStatusLabel(order!.status, direction).toLowerCase()}: solo se editan los datos internos, fechas y observaciones.` : undefined}
      onClose={onClose}
      footer={
        order ? (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" onClick={() => submit(null)} disabled={saving}>{saving ? 'Guardando…' : 'Guardar cambios'}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            {isPayable && <Button onClick={() => submit('draft')} disabled={saving}>Guardar borrador</Button>}
            {isPayable && !canApprove && <Button variant="primary" onClick={() => submit('pending')} disabled={saving}><Send size={15} /> Enviar a aprobación</Button>}
            {isPayable && canApprove && <Button onClick={() => submit('pending')} disabled={saving}>Enviar a aprobación</Button>}
            {!isPayable && <Button onClick={() => submit('pending')} disabled={saving}>Guardar por aceptar</Button>}
            {canApprove && <Button variant="primary" onClick={() => submit('approved')} disabled={saving}><CircleCheck size={15} /> {isPayable ? 'Guardar y aprobar' : 'Guardar como aceptada'}</Button>}
          </>
        )
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(order ? null : isPayable ? 'draft' : 'pending') }} className="flex flex-col gap-5">
        <FormError error={error} />
        <section className="grid grid-cols-1 gap-4 md:grid-cols-6">
          <Field label={text.counterparty} className="md:col-span-3" hint={options.length === 0 ? `Primero crea un ${text.counterparty.toLowerCase()} en Empresas.` : undefined}>
            {(id) => (
              <Select id={id} value={form.counterparty_id} onChange={(e) => onCounterpartyChange(e.target.value)} disabled={locked} autoFocus>
                <option value="">Selecciona…</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.tax_id ? ` · ${formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country)}` : ''}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={isPayable ? 'Número' : 'N° OC del cliente'} className="md:col-span-2" hint={isPayable && !order ? `Vacío = correlativo (${nextNumber || 'automático'})` : undefined}>
            {(id) => <Input id={id} value={form.number} onChange={(e) => set('number', e.target.value)} placeholder={isPayable ? nextNumber : 'Ej: 4500012345'} disabled={locked} />}
          </Field>
          <Field label="Moneda" className="md:col-span-1">
            {(id) => (
              <Select id={id} value={form.currency} onChange={(e) => set('currency', e.target.value as Currency)} disabled={locked}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Emisión" className="md:col-span-2">{(id) => <Input id={id} type="date" value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} disabled={locked} />}</Field>
          <Field label="Entrega / vigencia" className="md:col-span-2">
            {(id) => <Input id={id} type="date" value={form.delivery_date} min={form.issue_date} onChange={(e) => set('delivery_date', e.target.value)} />}
          </Field>
          <Field label="Plazo de pago (días)" className="md:col-span-2">
            {(id) => <Input id={id} inputMode="numeric" value={form.payment_terms_days} onChange={(e) => set('payment_terms_days', e.target.value.replace(/\D/g, ''))} placeholder="Ej: 30" />}
          </Field>
          <Field label="Forma de pago" className="md:col-span-2">
            {(id) => (
              <Select id={id} value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
                <option value="">Sin especificar</option>
                {methodOptions.map((mm) => (
                  <option key={mm.id} value={mm.name}>{mm.name}</option>
                ))}
              </Select>
            )}
          </Field>
          {isPayable && (
            <Field label="Solicitante" className="md:col-span-2">
              {(id) => <Input id={id} value={form.requester} onChange={(e) => set('requester', e.target.value)} placeholder="Persona o área que pide la compra" />}
            </Field>
          )}
          <Field label="Categoría" className={isPayable ? 'md:col-span-1' : 'md:col-span-2'}>
            {(id) => (
              <Select id={id} value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
                <option value="">—</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ''}{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Centro de costos" className={isPayable ? 'md:col-span-1' : 'md:col-span-2'}>
            {(id) => (
              <Select id={id} value={form.cost_center_id} onChange={(e) => set('cost_center_id', e.target.value)}>
                <option value="">—</option>
                {costCenterOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ''}{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Descripción" className="md:col-span-6">{(id) => <Input id={id} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={isPayable ? 'Ej: Arriendo de equipos rodaje norte' : 'Ej: Temporada 2 · 8 capítulos'} />}</Field>
        </section>

        <section className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <h3 className="text-[13px] font-semibold text-ink">Detalle</h3>
            {!locked && (
              <div className="flex rounded-lg bg-subtle p-0.5 text-[12px]" role="tablist">
                {[
                  { key: true, label: 'Por líneas' },
                  { key: false, label: 'Solo monto' },
                ].map((opt) => (
                  <button
                    key={String(opt.key)}
                    type="button"
                    role="tab"
                    aria-selected={form.byLines === opt.key}
                    onClick={() => set('byLines', opt.key)}
                    className={cn('rounded-md px-2.5 py-1', form.byLines === opt.key ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="p-4">
            {loadingLines ? (
              <p className="text-sm text-faint">Cargando líneas…</p>
            ) : form.byLines ? (
              <div className="flex flex-col gap-2">
                <div className="hidden grid-cols-[1fr_80px_130px_110px_130px_32px] gap-2 text-[11px] font-semibold tracking-wide text-faint uppercase md:grid">
                  <span>Descripción</span><span className="text-right">Cant.</span><span className="text-right">Precio unit.</span><span className="text-right">Descuento</span><span className="text-right">Subtotal</span><span />
                </div>
                {parsedLines.map((l, i) => (
                  <div key={l.key} className="grid grid-cols-2 gap-2 rounded-lg border border-line p-2 md:grid-cols-[1fr_80px_130px_110px_130px_32px] md:items-center md:border-0 md:p-0">
                    <Input aria-label={`Descripción línea ${i + 1}`} className="col-span-2 md:col-span-1" value={l.description} disabled={locked} placeholder="Producto o servicio" onChange={(e) => editLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))} />
                    <Input aria-label={`Cantidad línea ${i + 1}`} inputMode="decimal" className="text-right tabular" value={l.quantity} disabled={locked} onChange={(e) => editLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} />
                    <Input aria-label={`Precio unitario línea ${i + 1}`} inputMode="decimal" className="text-right tabular" value={l.unit_price} disabled={locked} placeholder="0" onChange={(e) => editLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unit_price: e.target.value } : x)))} />
                    <Input aria-label={`Descuento línea ${i + 1}`} inputMode="decimal" className="text-right tabular" value={l.discount} disabled={locked} placeholder="0" onChange={(e) => editLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, discount: e.target.value } : x)))} />
                    <span className={cn('flex h-8 items-center justify-end text-sm font-medium tabular', l.amount !== null && l.amount < 0 ? 'text-bad' : 'text-ink')}>
                      {l.amount === null ? '—' : formatMoney(l.amount, form.currency)}
                    </span>
                    {!locked && (
                      <span className="flex justify-end">
                        <RowAction label="Quitar línea" tone="danger" onClick={() => editLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()]))}>
                          <Trash2 size={15} />
                        </RowAction>
                      </span>
                    )}
                  </div>
                ))}
                {!locked && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => editLines((ls) => [...ls, newLine()])}><Plus size={14} /> Agregar línea</Button>
                  </div>
                )}
              </div>
            ) : (
              <Field label={form.taxed ? 'Monto neto' : 'Monto'} className="max-w-xs">
                {(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={form.net} disabled={locked} onChange={(e) => set('net', e.target.value)} placeholder="0" />}
              </Field>
            )}

            <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-4">
              <label className={cn('flex items-center gap-2 text-sm', locked ? 'text-faint' : 'text-ink')}>
                <input type="checkbox" checked={form.taxed} disabled={locked} onChange={(e) => set('taxed', e.target.checked)} className="accent-navy-900" />
                Afecta a {TAX_LABEL[tenant.country]} ({Math.round((tenant.country === 'CL' ? 0.19 : 0.18) * 100)}%)
              </label>
              <dl className="flex min-w-56 flex-col gap-1 text-sm">
                <div className="flex justify-between gap-6"><dt className="text-muted">{form.taxed ? 'Neto' : 'Subtotal'}</dt><dd className="tabular">{formatMoney(locked ? order!.net_amount : netMinor, form.currency)}</dd></div>
                {(locked ? order!.tax_amount > 0 : form.taxed) && <div className="flex justify-between gap-6"><dt className="text-muted">{TAX_LABEL[tenant.country]}</dt><dd className="tabular">{formatMoney(locked ? order!.tax_amount : taxMinor, form.currency)}</dd></div>}
                <div className="flex justify-between gap-6 font-semibold text-ink"><dt>Total</dt><dd className="tabular">{formatMoney(locked ? order!.total_amount : totalMinor, form.currency)}</dd></div>
              </dl>
            </div>
          </div>
        </section>

        <Field label="Observaciones" hint={`Aparecen en el PDF y en el portal del ${text.counterparty.toLowerCase()}.`}>
          {(id) => <Textarea id={id} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Condiciones de entrega, lugar, contacto…" />}
        </Field>
        {!order && (
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-medium text-ink">Archivos</span>
            <FilePicker files={pendingFiles} onChange={setPendingFiles} />
          </div>
        )}
        {order && (
          <p className="text-xs text-faint">
            <Copy size={12} className="mr-1 inline" />
            Para adjuntar archivos, usa la sección Archivos del detalle de la orden.
          </p>
        )}
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Rechazo y envío
// ---------------------------------------------------------------------------
function ReasonDrawer({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <Drawer
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="danger"
            disabled={!reason.trim() || saving}
            onClick={async () => {
              setSaving(true)
              await onConfirm(reason.trim())
              setSaving(false)
            }}
          >
            <Ban size={15} /> Rechazar
          </Button>
        </>
      }
    >
      <Field label="Motivo del rechazo" hint="Queda registrado en la orden.">
        {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
      </Field>
    </Drawer>
  )
}

function SendDrawer({ order, onClose, onConfirm }: { order: PurchaseOrderRow; onClose: () => void; onConfirm: (to: string) => Promise<void> }) {
  const [to, setTo] = useState(order.sent_to ?? '')
  const [saving, setSaving] = useState(false)
  const { tenant } = useCurrentTenant()
  const actions = usePurchaseOrderActions(order.direction, () => undefined)
  return (
    <Drawer
      open
      title={`Enviar orden N° ${order.number}`}
      subtitle="Descarga el PDF, envíalo al proveedor y registra el envío."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              await onConfirm(to.trim())
              setSaving(false)
            }}
          >
            <Send size={15} /> Registrar envío
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Button onClick={() => actions.downloadPdf(order)} className="self-start"><FileDown size={15} /> Descargar PDF</Button>
        <Field label="Enviada a" hint="Correo o persona que la recibió (opcional).">
          {(id) => <Input id={id} value={to} onChange={(e) => setTo(e.target.value)} placeholder="compras@proveedor.cl" autoFocus />}
        </Field>
        {order.sent_at && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Undo2 size={14} /> Último envío: {formatTimestampDate(order.sent_at, tenant.timezone)}{order.sent_to ? ` a ${order.sent_to}` : ''}
          </p>
        )}
      </div>
    </Drawer>
  )
}
