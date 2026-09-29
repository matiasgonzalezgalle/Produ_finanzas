import { Banknote, CalendarClock, CircleCheck, Download, Eye, FileDown, FileText, Paperclip, Pencil, Plus, Trash2, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAttachments, useCounterparties, useDeleteAttachment, useDeleteDocument, useDocuments, useDocumentTypeSettings, useModuleSettings, usePurchaseOrders, useSaveDocument, useSetApproval, useUploadAttachment, useVoidDocument } from '../../app/queries'
import { useNavigate } from 'react-router-dom'
import { rememberDocumentOrder } from './documentOrder'
import { api, type Attachment } from '../../data'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentInput, DocumentRow, PurchaseOrderRow } from '../../data'
import { addDays, formatDate } from '../../domain/dates'
import { computeDetraction, computeTax, DOCUMENT_TYPES, documentTypeLabel, TAX_LABEL, type DocumentDirection, type DocumentTypeCode } from '../../domain/documents'
import { CURRENCIES, CURRENCY_DECIMALS, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { csvAmount, downloadCsv, type CsvColumn } from '../../lib/csv'
import { Button, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, StatCard, Textarea } from '../../ui'
import { BulkButton, ListView, RowAction, RowMenu, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage, minorToInput, Money, MoneyTotals, parseMoneyInput, StatusBadge, useNewParam } from '../shared'
import { PaymentDrawer } from '../payments/PaymentsPage'
import { SiiPendingBanner } from '../sii/SiiInbox'

export function sectionCopy(direction: DocumentDirection) {
  return direction === 'payable'
    ? { title: 'Cuentas por pagar', base: '/cxp', paymentsTab: 'Pagos', paymentsPath: '/cxp/pagos', counterparty: 'Proveedor', open: 'Por pagar', pay: 'Registrar pago' }
    : { title: 'Cuentas por cobrar', base: '/cxc', paymentsTab: 'Cobros', paymentsPath: '/cxc/cobros', counterparty: 'Cliente', open: 'Por cobrar', pay: 'Registrar cobro' }
}

/** Marca de origen del documento: SII (importado) o Manual. */
export function OriginTag({ doc }: { doc: Pick<DocumentRow, 'external_source'> }) {
  const sii = doc.external_source === 'sii'
  return (
    <span
      title={sii ? 'Importado del Registro de Compras y Ventas del SII' : 'Registrado manualmente'}
      className={`rounded px-1 py-px text-[9px] leading-none font-semibold tracking-wide uppercase ${sii ? 'bg-brand-50 text-brand-600' : 'bg-subtle text-faint'}`}
    >
      {sii ? 'SII' : 'Manual'}
    </span>
  )
}

export function sectionTabs(direction: DocumentDirection) {
  const copy = sectionCopy(direction)
  return [
    { to: `${copy.base}/ordenes`, label: 'Órdenes de compra' },
    { to: `${copy.base}/documentos`, label: 'Documentos' },
    ...(direction === 'payable' ? [{ to: '/cxp/gestion', label: 'Gestión de pagos' }] : []),
    { to: copy.paymentsPath, label: copy.paymentsTab },
  ]
}

/** Acciones comunes de documento: descargar ficha PDF y eliminar (o anular si ya tiene pagos). */
export function useDocumentActions(onError: (msg: string | null) => void) {
  const { tenant } = useCurrentTenant()
  const deleteDoc = useDeleteDocument()
  const voidDoc = useVoidDocument()

  async function downloadPdf(doc: DocumentRow) {
    onError(null)
    try {
      const files = doc.attachment_count ? await api.listAttachments(tenant.id, doc.id) : []
      // pdf-lib pesa ~400 KB: se carga solo al descargar.
      const { buildDocumentPdf, downloadBlob } = await import('../../lib/documentPdf')
      const bytes = await buildDocumentPdf({ doc, tenantName: tenant.legal_name ?? tenant.name, country: tenant.country, attachments: files.map((f) => f.file_name) })
      downloadBlob(bytes, `${documentTypeLabel(doc.doc_type).toLowerCase().replace(/\W+/g, '-')}-${doc.folio}.pdf`)
    } catch (err) {
      onError(errorMessage(err))
    }
  }

  /** Devuelve true si el documento se eliminó o anuló. */
  async function remove(doc: DocumentRow): Promise<boolean> {
    onError(null)
    const hasMovements = doc.paid_amount > 0 || doc.credits_amount > 0
    if (hasMovements) {
      if (doc.status === 'void') {
        onError('El documento ya está anulado y tiene movimientos asociados: se conserva para auditoría.')
        return false
      }
      if (!window.confirm(`El documento N° ${doc.folio} tiene pagos o notas de crédito, así que no se puede eliminar.\n¿Quieres anularlo? Dejará de contar en los saldos.`)) return false
      try {
        await voidDoc.mutateAsync(doc.id)
        return true
      } catch (err) {
        onError(errorMessage(err))
        return false
      }
    }
    if (!window.confirm(`¿Eliminar definitivamente el documento N° ${doc.folio} y sus archivos?`)) return false
    try {
      await deleteDoc.mutateAsync(doc.id)
      return true
    } catch (err) {
      onError(errorMessage(err))
      return false
    }
  }

  return { downloadPdf, remove }
}

const STATUS_OPTIONS = [
  { value: 'abiertos', label: 'Con saldo pendiente' },
  { value: 'vencido', label: 'Vencidos' },
  { value: 'parcial', label: 'Pago parcial' },
  { value: 'pendiente', label: 'Pendientes (sin pagos)' },
  { value: 'pagado', label: 'Pagados' },
  { value: 'aplicada', label: 'Notas de crédito' },
  { value: 'anulado', label: 'Anulados' },
]

export function DocumentsPage({ direction }: { direction: DocumentDirection }) {
  const copy = sectionCopy(direction)
  const { tenant, canWrite, today } = useCurrentTenant()
  const documents = useDocuments(direction)
  const voidDoc = useVoidDocument()
  const [newOpen, setNewOpen] = useNewParam()
  const [error, setError] = useState<string | null>(null)
  const actions = useDocumentActions(setError)
  const [editing, setEditing] = useState<DocumentRow | null>(null)
  const navigate = useNavigate()
  const approval = useSetApproval()
  const [paying, setPaying] = useState<DocumentRow[] | null>(null)

  const all = useMemo(() => documents.data ?? [], [documents.data])

  const open = all.filter((d) => d.pending_amount > 0)
  const overdue = open.filter((d) => d.payment_status === 'vencido')
  const soon = open.filter((d) => d.payment_status !== 'vencido' && d.due_date && d.due_date <= addDays(today, 7))
  const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })

  const columns: ListColumn<DocumentRow>[] = [
    { key: 'cp', header: copy.counterparty, cell: (d) => d.counterparty_name, sortValue: (d) => d.counterparty_name, className: 'min-w-40' },
    {
      key: 'type',
      header: 'Documento',
      cell: (d) => (
        <span className="flex flex-col leading-tight">
          <span className="flex items-center gap-1.5 font-medium whitespace-nowrap text-ink">
            N° {d.folio}
            <OriginTag doc={d} />
          </span>
          <span className="text-xs text-faint">{documentTypeLabel(d.doc_type)}{d.purchase_order_number ? ` · OC ${d.purchase_order_number}` : ''}</span>
        </span>
      ),
      sortValue: (d) => `${d.doc_type} ${d.folio.padStart(12, '0')}`,
    },
    { key: 'issue', mobileHidden: true, header: 'Emisión', cell: (d) => formatDate(d.issue_date), sortValue: (d) => d.issue_date, className: 'hidden 2xl:table-cell' },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date), sortValue: (d) => d.due_date },
    {
      key: 'scheduled',
      header: 'Pago agendado',
      cell: (d) =>
        d.scheduled_payment_date ? (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink"><CalendarClock size={14} className="text-brand-600" />{formatDate(d.scheduled_payment_date)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (d) => d.scheduled_payment_date,
    },
    { key: 'total', mobileHidden: true, header: 'Total', align: 'right', cell: (d) => <Money minor={d.total_amount} currency={d.currency} />, sortValue: (d) => d.total_amount },
    {
      key: 'pending',
      header: 'Saldo',
      align: 'right',
      cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className={d.pending_amount ? 'font-semibold text-ink' : ''} />,
      sortValue: (d) => d.pending_amount,
    },
    {
      key: 'status', mobileBadge: true,
      header: 'Estado',
      cell: (d) => (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />
          {d.direction === 'payable' && d.status === 'open' && d.approval_status !== 'approved' && (
            <span className={`text-[10px] font-medium ${d.approval_status === 'rejected' ? 'text-bad' : 'text-warn'}`}>
              {d.approval_status === 'rejected' ? 'Rechazado' : 'Por aprobar'}
            </span>
          )}
          {d.direction === 'payable' && (d.payment_management === 'requested' || d.payment_management === 'scheduled') && (
            <span className="text-[10px] font-medium text-brand-600">
              {d.payment_management === 'requested' ? 'Pago solicitado' : `Programado ${d.scheduled_payment_date ? formatDate(d.scheduled_payment_date) : ''}`}
            </span>
          )}
        </span>
      ),
      sortValue: (d) => d.days_overdue * 1000 + (d.pending_amount > 0 ? 1 : 0),
    },
  ]

  const counterparties = [...new Map(all.map((d) => [d.counterparty_id, d.counterparty_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const currencies = [...new Set(all.map((d) => d.currency))]
  const types = [...new Set(all.map((d) => d.doc_type))]
  const filters: ListFilter<DocumentRow>[] = [
    {
      type: 'select',
      key: 'status',
      label: 'Estado',
      options: STATUS_OPTIONS,
      defaultValue: 'abiertos',
      match: (d, v) => (v === 'abiertos' ? d.pending_amount > 0 : d.payment_status === v),
    },
    ...(direction === 'payable'
      ? [{
          type: 'select' as const,
          key: 'approval',
          label: 'Aprobación',
          options: [{ value: 'pending', label: 'Por aprobar' }, { value: 'approved', label: 'Aprobados' }, { value: 'rejected', label: 'Rechazados' }],
          match: (d: DocumentRow, v: string) => d.approval_status === v,
        }, {
          type: 'select' as const,
          key: 'management',
          label: 'Gestión de pago',
          options: [{ value: 'none', label: 'Sin gestionar' }, { value: 'requested', label: 'Pago solicitado' }, { value: 'scheduled', label: 'Pago programado' }, { value: 'paid', label: 'Pago realizado' }],
          match: (d: DocumentRow, v: string) => (v === 'none' ? d.payment_management === null && d.approval_status === 'approved' : d.payment_management === v),
        }]
      : []),
    { type: 'select', key: 'cp', label: copy.counterparty, options: counterparties.map(([value, label]) => ({ value, label })), match: (d, v) => d.counterparty_id === v },
    { type: 'select', key: 'type', label: 'Tipo', options: types.map((t) => ({ value: t, label: documentTypeLabel(t) })), match: (d, v) => d.doc_type === v },
    { type: 'select', key: 'currency', label: 'Moneda', options: currencies.map((c) => ({ value: c, label: c })), match: (d, v) => d.currency === v },
    { type: 'dateRange', key: 'due', label: 'Vencimiento', getDate: (d) => d.due_date },
    { type: 'dateRange', key: 'scheduled', label: 'Pago agendado', getDate: (d) => d.scheduled_payment_date },
    {
      type: 'select',
      key: 'files',
      label: 'Archivos',
      options: [{ value: 'con', label: 'Con archivos' }, { value: 'sin', label: 'Sin archivos' }],
      match: (d, v) => (v === 'con' ? d.attachment_count > 0 : d.attachment_count === 0),
    },
    {
      type: 'select',
      key: 'origin',
      label: 'Origen',
      options: [{ value: 'sii', label: 'SII (importado)' }, { value: 'manual', label: 'Manual' }],
      match: (d, v) => (v === 'sii' ? d.external_source === 'sii' : d.external_source !== 'sii'),
    },
    {
      type: 'select',
      key: 'po',
      label: 'Orden de compra',
      options: [{ value: 'con', label: 'Con orden de compra' }, { value: 'sin', label: 'Sin orden de compra' }],
      match: (d, v) => (v === 'con' ? !!d.purchase_order_id : !d.purchase_order_id),
    },
    { type: 'dateRange', key: 'issue', label: 'Emisión', getDate: (d) => d.issue_date },
  ]

  const list = useListState({
    rows: all,
    rowKey: (d) => d.id,
    columns,
    filters,
    searchText: (d) => `${d.purchase_order_number ?? ''} ${d.counterparty_name} ${d.folio} ${d.counterparty_tax_id ?? ''} ${d.counterparty_tax_id ? formatTaxId(d.counterparty_tax_id, tenant.country) : ''} ${d.description ?? ''}`,
    storageKey: `documents-${direction}`,
    defaultSort: { key: 'due', dir: 'asc' },
  })

  const csvColumns: CsvColumn<DocumentRow>[] = [
    { header: copy.counterparty, value: (d) => d.counterparty_name },
    { header: 'RUT/RUC', value: (d) => (d.counterparty_tax_id ? formatTaxId(d.counterparty_tax_id, tenant.country) : '') },
    { header: 'Tipo', value: (d) => documentTypeLabel(d.doc_type) },
    { header: 'Folio', value: (d) => d.folio },
    { header: 'Moneda', value: (d) => d.currency },
    { header: 'Emisión', value: (d) => formatDate(d.issue_date) },
    { header: 'Vencimiento', value: (d) => formatDate(d.due_date) },
    { header: 'Pago agendado', value: (d) => formatDate(d.scheduled_payment_date) },
    { header: 'Total', value: (d) => csvAmount(d.total_amount, CURRENCY_DECIMALS[d.currency]) },
    { header: 'Pagado', value: (d) => csvAmount(d.paid_amount, CURRENCY_DECIMALS[d.currency]) },
    { header: 'Saldo', value: (d) => csvAmount(d.pending_amount, CURRENCY_DECIMALS[d.currency]) },
    { header: 'Estado', value: (d) => d.payment_status },
    { header: 'Días vencido', value: (d) => d.days_overdue },
  ]
  const fileBase = direction === 'payable' ? 'cuentas-por-pagar' : 'cuentas-por-cobrar'

  function openDoc(doc: DocumentRow) {
    rememberDocumentOrder(direction, list.filtered.map((d) => d.id))
    navigate(`${copy.base}/documentos/${doc.id}`)
  }

  async function approveMany(docs: DocumentRow[]) {
    const targets = docs.filter((d) => d.approval_status === 'pending' && d.status === 'open')
    if (!targets.length) return setError('Ninguno de los documentos seleccionados está pendiente de aprobación.')
    if (!window.confirm(`¿Aprobar ${targets.length} documento(s) para pago?`)) return
    setError(null)
    try {
      for (const d of targets) await approval.mutateAsync({ id: d.id, status: 'approved' })
      list.clearSelection()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function voidMany(docs: DocumentRow[]) {
    const targets = docs.filter((d) => d.status !== 'void')
    if (!targets.length) return
    if (!window.confirm(`¿Anular ${targets.length} documento(s)? Dejarán de contar en los saldos.`)) return
    setError(null)
    try {
      for (const d of targets) await voidDoc.mutateAsync(d.id)
      list.clearSelection()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  function payMany(docs: DocumentRow[]) {
    const unapproved = docs.filter((d) => d.direction === 'payable' && d.pending_amount > 0 && d.approval_status !== 'approved')
    if (unapproved.length) return setError(`Hay ${unapproved.length} documento(s) sin aprobar. Apruébalos antes de pagarlos.`)
    const payable = docs.filter((d) => d.pending_amount > 0)
    const sameGroup = payable.every((d) => d.counterparty_id === payable[0]?.counterparty_id && d.currency === payable[0]?.currency)
    if (!payable.length) return setError('Los documentos seleccionados no tienen saldo pendiente.')
    if (!sameGroup) return setError(`Para ${copy.pay.toLowerCase()} en bloque, selecciona documentos del mismo ${copy.counterparty.toLowerCase()} y moneda.`)
    setError(null)
    setPaying(payable)
  }

  return (
    <div>
      <PageHeader
        title={copy.title}
        tabs={sectionTabs(direction)}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus size={16} /> Registrar documento</Button>}
      />
      <div className="stat-row pt-5 sm:grid-cols-3">
        <StatCard label={copy.open} value={<MoneyTotals totals={sumByCurrency(open, pick)} empty="$0" />} detail={`${open.length} documentos`} />
        <StatCard label="Vencido" tone={overdue.length ? 'bad' : undefined} value={<MoneyTotals totals={sumByCurrency(overdue, pick)} empty="$0" />} detail={`${overdue.length} documentos`} />
        <StatCard label="Vence en 7 días" value={<MoneyTotals totals={sumByCurrency(soon, pick)} empty="$0" />} detail={`${soon.length} documentos`} />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <SiiPendingBanner direction={direction} />
        <FormError error={error} />
        <ListView
          state={list}
          columns={columns}
          rowKey={(d) => d.id}
          filters={filters}
          loading={documents.isLoading}
          searchPlaceholder={`Buscar por ${copy.counterparty.toLowerCase()}, folio o RUT…`}
          onRowClick={openDoc}
          toolbarExtra={
            <Button size="sm" onClick={() => downloadCsv(`${fileBase}.csv`, list.filtered, csvColumns)} disabled={!list.total}>
              <Download size={16} /> Exportar
            </Button>
          }
          bulkActions={(rows) => (
            <>
              <BulkButton onClick={() => downloadCsv(`${fileBase}-seleccion.csv`, rows, csvColumns)}><Download size={15} /> Exportar</BulkButton>
              {canWrite && direction === 'payable' && <BulkButton onClick={() => approveMany(rows)}><CircleCheck size={15} /> Aprobar</BulkButton>}
              {canWrite && <BulkButton onClick={() => payMany(rows)}><Banknote size={15} /> {copy.pay}</BulkButton>}
              {canWrite && <BulkButton tone="danger" onClick={() => voidMany(rows)}><Trash2 size={15} /> Anular</BulkButton>}
            </>
          )}
          rowActions={(d) => (
            <>
              <RowAction label="Ver detalle" onClick={() => openDoc(d)}><Eye size={17} /></RowAction>
              {canWrite && d.status !== 'void' && <RowAction label="Editar" onClick={() => setEditing(d)}><Pencil size={17} /></RowAction>}
              <RowMenu
                label="Descargar"
                icon={<FileDown size={17} />}
                items={[
                  { label: 'Ficha del documento (PDF)', onClick: () => actions.downloadPdf(d) },
                  { label: d.attachment_count ? `Archivos adjuntos (${d.attachment_count})` : 'Sin archivos adjuntos', onClick: () => openDoc(d), disabled: !d.attachment_count },
                ]}
              />
              {canWrite && d.pending_amount > 0 && d.approval_status === 'approved' && <RowAction label={copy.pay} onClick={() => setPaying([d])}><Banknote size={17} /></RowAction>}
              {canWrite && <RowAction label="Eliminar" tone="danger" onClick={() => actions.remove(d)}><Trash2 size={17} /></RowAction>}
            </>
          )}
          empty={
            <EmptyState
              icon={<FileText size={20} />}
              title={all.length ? 'Sin documentos para estos filtros' : 'Aún no hay documentos'}
              description={all.length ? 'Cambia el estado o limpia los filtros para ver más.' : 'Registra facturas, boletas o notas de crédito para controlar su saldo.'}
            />
          }
        />
      </div>

      <DocumentDrawer
        key={editing?.id ?? (newOpen ? 'new' : 'closed')}
        open={newOpen || !!editing}
        direction={direction}
        doc={editing}
        documents={all}
        onClose={() => {
          setEditing(null)
          setNewOpen(false)
        }}
      />
      {paying && (
        <PaymentDrawer
          open
          direction={direction === 'payable' ? 'out' : 'in'}
          presets={paying}
          onClose={() => {
            setPaying(null)
            list.clearSelection()
          }}
        />
      )}
    </div>
  )
}

export function DocumentDrawer({
  open,
  direction,
  doc,
  documents,
  preset,
  onClose,
}: {
  open: boolean
  direction: DocumentDirection
  doc: DocumentRow | null
  documents: DocumentRow[]
  /** Documento nuevo desde una orden de compra: contraparte, moneda, OC y saldo por facturar. */
  preset?: PurchaseOrderRow | null
  onClose: () => void
}) {
  const { tenant, today } = useCurrentTenant()
  const copy = sectionCopy(direction)
  const counterparties = useCounterparties()
  const save = useSaveDocument()
  const settings = useModuleSettings(direction)
  const typeSettings = useDocumentTypeSettings(direction)
  const purchaseOrders = usePurchaseOrders(direction)
  const options = (counterparties.data ?? []).filter((c) => (direction === 'payable' ? c.is_supplier : c.is_customer))

  const presetCp = preset ? options.find((c) => c.id === preset.counterparty_id) : undefined
  // Desde una OC se propone el saldo por facturar, repartido como en la OC (neto / exento / impuesto).
  const presetShare = preset && preset.total_amount ? preset.remaining_amount / preset.total_amount : 0
  const presetNet = preset ? Math.round(preset.net_amount * presetShare) : 0
  const presetExempt = preset ? Math.round(preset.exempt_amount * presetShare) : 0
  const presetTax = preset ? preset.remaining_amount - presetNet - presetExempt : 0
  const [form, setForm] = useState(() => ({
    counterparty_id: doc?.counterparty_id ?? preset?.counterparty_id ?? '',
    doc_type: (doc?.doc_type ?? (preset && !preset.tax_amount ? 'factura_exenta' : 'factura')) as DocumentTypeCode,
    folio: doc?.folio ?? '',
    currency: (doc?.currency ?? preset?.currency ?? tenant.base_currency) as Currency,
    issue_date: doc?.issue_date ?? today,
    due_date: doc?.due_date ?? (preset?.payment_terms_days != null ? addDays(today, preset.payment_terms_days) : presetCp?.payment_terms_days != null ? addDays(today, presetCp.payment_terms_days) : ''),
    net: doc ? minorToInput(doc.net_amount, doc.currency) : preset ? minorToInput(presetNet, preset.currency) : '',
    exempt: doc ? minorToInput(doc.exempt_amount, doc.currency) : presetExempt ? minorToInput(presetExempt, preset!.currency) : '',
    tax: doc ? minorToInput(doc.tax_amount, doc.currency) : preset ? minorToInput(presetTax, preset.currency) : '',
    taxTouched: !!doc || !!preset,
    purchase_order_id: doc?.purchase_order_id ?? preset?.id ?? '',
    applies_to_id: doc?.applies_to_id ?? '',
    detraction_rate: doc?.detraction_rate ? String(doc.detraction_rate) : '',
    detraction_status: doc?.detraction_status ?? 'no_aplica',
    description: doc?.description ?? preset?.description ?? '',
    scheduled_payment_date: doc?.scheduled_payment_date ?? '',
  }))
  const [error, setError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const upload = useUploadAttachment()
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))

  const disabledTypes = new Set((typeSettings.data ?? []).filter((t) => !t.can_create).map((t) => t.doc_type))
  // Tipos habilitados en el administrador del módulo (se mantiene el actual al editar).
  const typeOptions = DOCUMENT_TYPES.filter((t) => t.countries.includes(tenant.country) && (!disabledTypes.has(t.code) || t.code === doc?.doc_type))
  const defaultDueDays = settings.data?.default_due_days ?? null
  // OC disponibles: aprobadas, misma contraparte y moneda, con saldo (o la OC actual del documento).
  const poOptions = (purchaseOrders.data ?? []).filter(
    (o) => o.id === form.purchase_order_id || (o.status === 'approved' && o.counterparty_id === form.counterparty_id && o.currency === form.currency && o.remaining_amount > 0),
  )
  const selectedPo = poOptions.find((o) => o.id === form.purchase_order_id)
  const poRequired = !!settings.data?.require_purchase_order && form.doc_type !== 'nota_credito'
  const hasTax = ['factura', 'nota_credito', 'nota_debito', 'boleta'].includes(form.doc_type)
  const netMinor = parseMoneyInput(form.net || '0', form.currency) ?? 0
  const exemptMinor = parseMoneyInput(form.exempt || '0', form.currency) ?? 0
  const autoTax = hasTax ? computeTax(netMinor, tenant.country) : 0
  const taxMinor = form.taxTouched ? parseMoneyInput(form.tax || '0', form.currency) ?? 0 : autoTax
  const totalMinor = netMinor + exemptMinor + taxMinor
  const detractionRate = Number(form.detraction_rate.replace(',', '.')) || 0
  const detractionMinor = tenant.country === 'PE' ? computeDetraction(totalMinor, detractionRate, CURRENCY_DECIMALS[form.currency]) : 0

  const creditTargets = documents.filter(
    (d) => d.id !== doc?.id && d.doc_type !== 'nota_credito' && d.status === 'open' && d.counterparty_id === form.counterparty_id && d.currency === form.currency,
  )

  function onCounterpartyChange(id: string) {
    const cp = options.find((c) => c.id === id)
    setForm((f) => {
      const next = { ...f, counterparty_id: id, applies_to_id: '', purchase_order_id: '' }
      if (cp?.default_currency && !doc) next.currency = cp.default_currency
      const days = cp?.payment_terms_days ?? defaultDueDays
      if (days != null && !f.due_date && f.issue_date) next.due_date = addDays(f.issue_date, days)
      return next
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.counterparty_id) return setError(`Selecciona un ${copy.counterparty.toLowerCase()}`)
    if (!typeOptions.some((t) => t.code === form.doc_type)) return setError('Selecciona un tipo de documento habilitado')
    if (!form.folio.trim()) return setError('El folio es obligatorio')
    if ([form.net, form.exempt, form.tax].some((v) => v && parseMoneyInput(v, form.currency) === null)) return setError('Hay un monto con formato inválido')
    if (totalMinor <= 0) return setError('El total debe ser mayor a cero')
    if (form.due_date && form.due_date < form.issue_date) return setError('El vencimiento no puede ser anterior a la emisión')
    if (form.doc_type === 'nota_credito' && !form.applies_to_id) return setError('Indica a qué documento se aplica la nota de crédito')
    if (selectedPo && selectedPo.id !== doc?.purchase_order_id && totalMinor > selectedPo.remaining_amount) {
      return setError(`El total supera el saldo por facturar de la OC ${selectedPo.number} (${formatMoney(selectedPo.remaining_amount, selectedPo.currency)})`)
    }
    const input: DocumentInput = {
      direction,
      counterparty_id: form.counterparty_id,
      doc_type: form.doc_type,
      folio: form.folio.trim(),
      currency: form.currency,
      net_amount: netMinor,
      exempt_amount: exemptMinor,
      tax_amount: taxMinor,
      total_amount: totalMinor,
      issue_date: form.issue_date,
      due_date: form.doc_type === 'nota_credito' ? null : form.due_date || null,
      status: 'open',
      applies_to_id: form.doc_type === 'nota_credito' ? form.applies_to_id : null,
      detraction_rate: detractionMinor ? detractionRate : 0,
      detraction_amount: detractionMinor,
      detraction_status: detractionMinor ? (form.detraction_status === 'no_aplica' ? 'pendiente' : form.detraction_status) : 'no_aplica',
      description: form.description.trim() || null,
      scheduled_payment_date: form.doc_type === 'nota_credito' ? null : form.scheduled_payment_date || null,
      purchase_order_id: form.doc_type === 'nota_credito' ? null : form.purchase_order_id || null,
    }
    try {
      const savedId = await save.mutateAsync({ input, id: doc?.id })
      for (const file of pendingFiles) await upload.mutateAsync({ documentId: savedId, file })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open={open}
      title={doc ? 'Editar documento' : `Nuevo documento · ${copy.title.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="document-form" disabled={save.isPending || upload.isPending}>
            {save.isPending || upload.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form id="document-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label={copy.counterparty} hint={options.length === 0 ? `Primero crea un ${copy.counterparty.toLowerCase()} en Empresas.` : undefined}>
          {(id) => (
            <Select id={id} value={form.counterparty_id} onChange={(e) => onCounterpartyChange(e.target.value)} autoFocus>
              <option value="">Selecciona…</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.tax_id ? ` · ${formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country)}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tipo de documento">
            {(id) => (
              <Select id={id} value={typeOptions.some((t) => t.code === form.doc_type) ? form.doc_type : ''} onChange={(e) => set('doc_type', e.target.value as DocumentTypeCode)}>
                {!typeOptions.some((t) => t.code === form.doc_type) && <option value="">Selecciona…</option>}
                {typeOptions.map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Folio">{(id) => <Input id={id} value={form.folio} onChange={(e) => set('folio', e.target.value)} />}</Field>
        </div>
        {form.doc_type === 'nota_credito' && (
          <Field label="Aplica al documento" hint="Misma contraparte y moneda. Resta del saldo de ese documento.">
            {(id) => (
              <Select id={id} value={form.applies_to_id} onChange={(e) => set('applies_to_id', e.target.value)}>
                <option value="">Selecciona…</option>
                {creditTargets.map((d) => (
                  <option key={d.id} value={d.id}>{documentTypeLabel(d.doc_type)} N° {d.folio}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {form.doc_type !== 'nota_credito' && (
          <Field
            label={direction === 'payable' ? 'Orden de compra' : 'Orden de compra del cliente'}
            hint={
              selectedPo
                ? <>Saldo por facturar: <Money minor={selectedPo.remaining_amount + (doc?.purchase_order_id === selectedPo.id ? doc.net_total : 0)} currency={selectedPo.currency} /> de <Money minor={selectedPo.total_amount} currency={selectedPo.currency} /></>
                : poRequired
                  ? direction === 'payable' ? 'Obligatoria para aprobar el documento.' : 'Obligatoria para registrar el documento.'
                  : form.counterparty_id && !poOptions.length ? 'Sin órdenes aprobadas con saldo para esta contraparte y moneda.' : 'Opcional.'
            }
          >
            {(id) => (
              <Select id={id} value={form.purchase_order_id} onChange={(e) => set('purchase_order_id', e.target.value)} disabled={!form.counterparty_id}>
                <option value="">{poRequired ? 'Selecciona…' : 'Sin orden de compra'}</option>
                {poOptions.map((o) => (
                  <option key={o.id} value={o.id}>N° {o.number}{o.description ? ` · ${o.description}` : ''}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid grid-cols-3 gap-4">
          <Field label="Moneda">
            {(id) => (
              <Select id={id} value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value as Currency, purchase_order_id: '' }))}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Emisión">{(id) => <Input id={id} type="date" value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} />}</Field>
          {form.doc_type !== 'nota_credito' && (
            <Field label="Vencimiento">{(id) => <Input id={id} type="date" value={form.due_date} min={form.issue_date} onChange={(e) => set('due_date', e.target.value)} />}</Field>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label={hasTax ? 'Neto' : 'Monto'}>{(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={form.net} onChange={(e) => set('net', e.target.value)} placeholder="0" />}</Field>
          <Field label="Exento">{(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={form.exempt} onChange={(e) => set('exempt', e.target.value)} placeholder="0" />}</Field>
          <Field label={TAX_LABEL[tenant.country]} hint={!form.taxTouched && hasTax ? 'Calculado' : undefined}>
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="text-right tabular"
                value={form.taxTouched ? form.tax : minorToInput(autoTax, form.currency)}
                onChange={(e) => setForm((f) => ({ ...f, tax: e.target.value, taxTouched: true }))}
                placeholder="0"
              />
            )}
          </Field>
        </div>
        {tenant.country === 'PE' && form.doc_type !== 'nota_credito' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Detracción (%)" hint={detractionMinor ? <>Monto: <Money minor={detractionMinor} currency={form.currency} /> (en soles enteros)</> : 'Déjalo vacío si no aplica'}>
              {(id) => <Input id={id} inputMode="decimal" value={form.detraction_rate} onChange={(e) => set('detraction_rate', e.target.value)} placeholder="Ej: 12" />}
            </Field>
            {detractionMinor > 0 && (
              <Field label="Estado detracción">
                {(id) => (
                  <Select id={id} value={form.detraction_status} onChange={(e) => set('detraction_status', e.target.value as DocumentInput['detraction_status'])}>
                    <option value="pendiente">Pendiente</option>
                    <option value="depositada">Depositada</option>
                    <option value="observada">Observada</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}
        <div className="flex items-center justify-between rounded-lg bg-subtle px-4 py-3">
          <span className="text-sm text-muted">Total documento</span>
          <Money minor={totalMinor} currency={form.currency} className="text-lg font-semibold text-ink" />
        </div>
        {form.doc_type !== 'nota_credito' && (
          <Field label="Fecha de pago agendada" hint={direction === 'payable' ? 'Cuándo planeas pagarlo. Aparece en Tesorería y en el portal del proveedor.' : 'Cuándo el cliente comprometió el pago.'}>
            {(id) => <Input id={id} type="date" value={form.scheduled_payment_date} onChange={(e) => set('scheduled_payment_date', e.target.value)} />}
          </Field>
        )}
        <Field label="Descripción">{(id) => <Textarea id={id} value={form.description} onChange={(e) => set('description', e.target.value)} />}</Field>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-ink">Archivos</span>
          {doc && <AttachmentsPanel documentId={doc.id} editable onError={setError} />}
          <FilePicker files={pendingFiles} onChange={setPendingFiles} />
        </div>
      </form>
    </Drawer>
  )
}

function formatSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Archivos ya subidos de un documento: descargar y (si se puede editar) eliminar. */
export function AttachmentsPanel({ documentId, editable, onError }: { documentId: string; editable: boolean; onError: (msg: string | null) => void }) {
  const { tenant } = useCurrentTenant()
  const attachments = useAttachments(documentId)
  const remove = useDeleteAttachment()
  const files = attachments.data ?? []

  async function download(file: Attachment) {
    onError(null)
    try {
      const url = await api.attachmentUrl(tenant.id, file)
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

  if (attachments.isLoading) return <p className="text-sm text-faint">Cargando archivos…</p>
  if (!files.length) return <p className="text-sm text-faint">Sin archivos adjuntos.</p>
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <Paperclip size={15} className="shrink-0 text-faint" />
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
                  await remove.mutateAsync(f)
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
  )
}

/** Selector de archivos a subir al guardar (arrastrar o elegir). */
export function FilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const add = (list: FileList | null) => list && onChange([...files, ...Array.from(list)])
  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          add(e.dataTransfer.files)
        }}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center text-sm transition-colors ${dragging ? 'border-brand-500 bg-brand-50' : 'border-line hover:bg-subtle'}`}
      >
        <Upload size={18} className="text-muted" />
        <span className="text-ink">Arrastra archivos o <span className="text-brand-600">elígelos</span></span>
        <span className="text-xs text-faint">PDF, XML, imágenes o planillas · máx. 20 MB c/u</span>
        <input type="file" multiple className="sr-only" onChange={(e) => add(e.target.files)} />
      </label>
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md bg-subtle px-3 py-1.5 text-sm">
              <Paperclip size={14} className="text-faint" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-faint">{formatSize(f.size)} · se sube al guardar</span>
              <button type="button" aria-label={`Quitar ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))} className="rounded p-0.5 text-faint hover:text-bad">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
