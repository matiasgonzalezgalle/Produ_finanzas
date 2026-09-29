// Bandeja de documentos del SII (Chile, vía Fintoc).
//   CxP: documentos recibidos (compras). CxC: documentos emitidos (ventas).
// Muestra cuáles ya están registrados en la app y permite importar los que faltan.
import { CircleAlert, Download, EyeOff, FileInput, FileText, RefreshCw, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useIntegration, useSiiDocuments, useSiiMutations } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { SiiDocument, SiiImportResult } from '../../data'
import { formatDate, formatTimestamp } from '../../domain/dates'
import { documentTypeLabel, type DocumentDirection } from '../../domain/documents'
import { formatTaxId } from '../../domain/taxId'
import { csvAmount, downloadCsv, type CsvColumn } from '../../lib/csv'
import { Badge, Button, Drawer, EmptyState, FormError, StatCard, type Tone } from '../../ui'
import { BulkButton, ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { sectionCopy } from '../documents/DocumentsPage'
import { rememberDocumentOrder } from '../documents/documentOrder'
import { errorMessage, Money, MoneyTotals } from '../shared'

const SII_TYPE_LABEL: Record<number, string> = {
  30: 'Factura', 32: 'Factura exenta', 33: 'Factura electrónica', 34: 'Factura exenta electrónica', 35: 'Boleta', 38: 'Boleta exenta',
  39: 'Boleta electrónica', 40: 'Liquidación factura', 41: 'Boleta exenta electrónica', 43: 'Liquidación factura electrónica', 45: 'Factura de compra',
  46: 'Factura de compra electrónica', 47: 'Vale especial', 48: 'Pago electrónico', 50: 'Guía de despacho', 52: 'Guía de despacho electrónica',
  55: 'Nota de débito', 56: 'Nota de débito electrónica', 60: 'Nota de crédito', 61: 'Nota de crédito electrónica', 103: 'Liquidación',
  110: 'Factura de exportación', 111: 'Nota de débito de exportación', 112: 'Nota de crédito de exportación',
}

export function siiTypeLabel(d: Pick<SiiDocument, 'sii_type' | 'is_fee_receipt'>) {
  if (d.is_fee_receipt) return 'Boleta de honorarios'
  return d.sii_type != null ? SII_TYPE_LABEL[d.sii_type] ?? `Tipo ${d.sii_type}` : 'Documento'
}

type AppStatus = 'registrado' | 'sin_registrar' | 'no_importable' | 'ignorado' | 'reclamado'

function appStatus(d: SiiDocument): AppStatus {
  if (d.matched_document_id) return 'registrado'
  if (d.ignored) return 'ignorado'
  if (d.claimed) return 'reclamado'
  if (!d.importable) return 'no_importable'
  return 'sin_registrar'
}

const APP_STATUS: Record<AppStatus, { label: string; tone: Tone }> = {
  registrado: { label: 'Registrado', tone: 'ok' },
  sin_registrar: { label: 'Sin registrar', tone: 'warn' },
  reclamado: { label: 'Reclamado', tone: 'bad' },
  no_importable: { label: 'No aplica', tone: 'neutral' },
  ignorado: { label: 'Ignorado', tone: 'neutral' },
}

/** Estado en el SII: registro (Registro / Pendientes / Reclamados) y acuse de recibo. */
function siiStatus(d: SiiDocument): { label: string; tone: Tone; hint?: string } {
  if (d.is_fee_receipt) {
    if (d.fee_status === 'ANUL') return { label: 'Anulada', tone: 'bad' }
    if (d.fee_status === 'VCA') return { label: 'Vigente · anulación solicitada', tone: 'warn' }
    return { label: 'Vigente', tone: 'ok' }
  }
  if (d.confirmation_status === 'R' || d.registry_status === 'cancelled') return { label: 'Reclamado', tone: 'bad' }
  if (d.registry_status === 'rejected') return { label: 'No incluir', tone: 'bad' }
  if (d.registry_status === 'pending') return { label: 'Pendiente de acuse', tone: 'warn', hint: 'El receptor tiene 8 días para aceptar o reclamar.' }
  const ack: Record<string, string> = { C: 'Acuse de recibo', A: 'Aceptado automáticamente', P: 'Pagado al contado', G: 'Acuse por guía de despacho' }
  return { label: d.confirmation_status ? ack[d.confirmation_status] ?? 'Registrado' : 'Registrado', tone: 'ok' }
}

/** Bandeja de documentos del SII por revisar e importar (se abre desde Documentos). */
export function SiiInbox({ direction }: { direction: DocumentDirection }) {
  const copy = sectionCopy(direction)
  const { tenant, canWrite } = useCurrentTenant()
  const navigate = useNavigate()
  const integration = useIntegration('fintoc_sii')
  const connected = !!integration.data
  const documents = useSiiDocuments(direction, tenant.country === 'CL')
  const sii = useSiiMutations()
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SiiImportResult | null>(null)
  const isPayable = direction === 'payable'
  const all = useMemo(() => documents.data ?? [], [documents.data])
  const counterparty = isPayable ? 'Emisor' : 'Receptor'

  const pending = all.filter((d) => appStatus(d) === 'sin_registrar')
  const registered = all.filter((d) => appStatus(d) === 'registrado')
  const claimed = all.filter((d) => d.claimed)
  const awaitingAck = all.filter((d) => d.registry_status === 'pending')
  const pick = (d: SiiDocument) => ({ currency: 'CLP' as const, amount: d.doc_type === 'nota_credito' ? -d.total_amount : d.total_amount })

  async function importRows(rows: SiiDocument[]) {
    setError(null)
    setResult(null)
    const ids = rows.filter((d) => ['sin_registrar', 'registrado'].includes(appStatus(d)) && !d.document_id).map((d) => d.id)
    if (!ids.length) return setError('Ninguno de los documentos seleccionados se puede importar.')
    try {
      setResult(await sii.importDocs.mutateAsync(ids))
      list.clearSelection()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function sync() {
    setError(null)
    try {
      await sii.sync.mutateAsync()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const columns: ListColumn<SiiDocument>[] = [
    {
      key: 'doc',
      header: 'Documento',
      cell: (d) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium whitespace-nowrap text-ink">{d.folio ? `N° ${d.folio}` : d.is_summary ? 'Resumen diario' : '—'}</span>
          <span className="text-xs text-faint">{siiTypeLabel(d)}{d.reference_folio ? ` · ref. N° ${d.reference_folio}` : ''}</span>
        </span>
      ),
      sortValue: (d) => `${d.sii_type ?? 0} ${(d.folio ?? '').padStart(12, '0')}`,
    },
    {
      key: 'cp',
      header: counterparty,
      cell: (d) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-ink">{d.counterparty_name ?? '—'}</span>
          {d.counterparty_tax_id && <span className="text-xs text-faint">{formatTaxId(d.counterparty_tax_id, 'CL')}</span>}
        </span>
      ),
      sortValue: (d) => d.counterparty_name ?? '',
      className: 'min-w-44',
    },
    { key: 'date', header: 'Emisión', cell: (d) => formatDate(d.issue_date), sortValue: (d) => d.issue_date },
    { key: 'period', mobileHidden: true, header: 'Período', cell: (d) => d.tax_period ?? '—', sortValue: (d) => d.tax_period?.split('/').reverse().join('') ?? '', className: 'hidden xl:table-cell' },
    {
      key: 'sii',
      mobileHidden: true,
      header: 'Estado SII',
      cell: (d) => {
        const st = siiStatus(d)
        return <span title={st.hint}><Badge tone={st.tone}>{st.label}</Badge></span>
      },
      sortValue: (d) => siiStatus(d).label,
    },
    {
      key: 'app',
      mobileBadge: true,
      header: 'En Produ',
      cell: (d) => {
        const st = APP_STATUS[appStatus(d)]
        return d.matched_document_id ? (
          <Link to={`${copy.base}/documentos/${d.matched_document_id}`} onClick={(e) => e.stopPropagation()} className="hover:opacity-80">
            <Badge tone={st.tone}>{st.label}</Badge>
          </Link>
        ) : (
          <Badge tone={st.tone}>{st.label}</Badge>
        )
      },
      sortValue: (d) => appStatus(d),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      cell: (d) => (
        <span className="flex flex-col items-end leading-tight">
          <Money minor={d.doc_type === 'nota_credito' ? -d.total_amount : d.total_amount} currency="CLP" className="font-medium text-ink" />
          {d.withheld_amount > 0 && <span className="text-[11px] text-faint">Retención {new Intl.NumberFormat('es-CL').format(d.withheld_amount)}</span>}
        </span>
      ),
      sortValue: (d) => d.total_amount,
    },
  ]

  const statusOptions = (Object.keys(APP_STATUS) as AppStatus[]).map((k) => ({ value: k, label: APP_STATUS[k].label }))
  const types = [...new Map(all.map((d) => [d.is_fee_receipt ? 'fee' : String(d.sii_type), siiTypeLabel(d)])).entries()]
  const periods = [...new Set(all.map((d) => d.tax_period).filter(Boolean) as string[])].sort((a, b) => b.split('/').reverse().join('').localeCompare(a.split('/').reverse().join('')))
  const filters: ListFilter<SiiDocument>[] = [
    { type: 'select', key: 'app', label: 'En Produ', options: statusOptions, defaultValue: 'sin_registrar', match: (d, v) => appStatus(d) === v },
    {
      type: 'select',
      key: 'sii',
      label: 'Estado SII',
      options: [{ value: 'ok', label: 'Registrados / aceptados' }, { value: 'pending', label: 'Pendientes de acuse' }, { value: 'claimed', label: 'Reclamados o anulados' }],
      match: (d, v) => (v === 'claimed' ? d.claimed : v === 'pending' ? d.registry_status === 'pending' : !d.claimed && d.registry_status !== 'pending'),
    },
    { type: 'select', key: 'type', label: 'Tipo', options: types.map(([value, label]) => ({ value, label })), match: (d, v) => (d.is_fee_receipt ? 'fee' : String(d.sii_type)) === v },
    { type: 'select', key: 'period', label: 'Período', options: periods.map((p) => ({ value: p, label: p })), match: (d, v) => d.tax_period === v },
    { type: 'dateRange', key: 'date', label: 'Emisión', getDate: (d) => d.issue_date },
  ]
  const list = useListState({
    rows: all,
    rowKey: (d) => d.id,
    columns,
    filters,
    searchText: (d) => `${d.folio ?? ''} ${d.counterparty_name ?? ''} ${d.counterparty_tax_id ?? ''} ${(d.counterparty_tax_id ?? '').replace(/\W/g, '')}`,
    storageKey: `sii-${direction}`,
    defaultSort: { key: 'date', dir: 'desc' },
  })

  const csvColumns: CsvColumn<SiiDocument>[] = [
    { header: 'Tipo', value: (d) => siiTypeLabel(d) },
    { header: 'Folio', value: (d) => d.folio ?? '' },
    { header: counterparty, value: (d) => d.counterparty_name ?? '' },
    { header: 'RUT', value: (d) => d.counterparty_tax_id ?? '' },
    { header: 'Emisión', value: (d) => d.issue_date },
    { header: 'Período', value: (d) => d.tax_period ?? '' },
    { header: 'Neto', value: (d) => csvAmount(d.net_amount, 0) },
    { header: 'Exento', value: (d) => csvAmount(d.exempt_amount, 0) },
    { header: 'IVA', value: (d) => csvAmount(d.tax_amount, 0) },
    { header: 'Total', value: (d) => csvAmount(d.total_amount, 0) },
    { header: 'Estado SII', value: (d) => siiStatus(d).label },
    { header: 'En Produ', value: (d) => APP_STATUS[appStatus(d)].label },
  ]

  if (!integration.isLoading && !connected) {
    return (
      <EmptyState
        icon={<FileInput size={20} />}
        title="Conecta el SII para ver tus documentos tributarios"
        description={`Trae las ${isPayable ? 'facturas y boletas que te emitieron tus proveedores' : 'facturas que emitiste a tus clientes'} y regístralas con un clic.`}
        action={<Button variant="primary" onClick={() => navigate('/configuracion/integraciones')}>Ir a Integraciones</Button>}
      />
    )
  }

  const lastSync = integration.data?.public_config.last_sync_at
  return (
    <div>
      <div className="stat-row sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Sin registrar" tone={pending.length ? 'bad' : undefined} value={<MoneyTotals totals={{ CLP: pending.reduce((s, d) => s + pick(d).amount, 0) }} empty="$0" />} detail={`${pending.length} documentos`} />
        <StatCard label="Registrados" value={<MoneyTotals totals={{ CLP: registered.reduce((s, d) => s + pick(d).amount, 0) }} empty="$0" />} detail={`${registered.length} documentos`} />
        <StatCard label="Pendientes de acuse" hint="Documentos que el receptor aún no acepta ni reclama (8 días)" value={String(awaitingAck.length)} detail="en el SII" />
        <StatCard label="Reclamados o anulados" tone={claimed.length ? 'bad' : undefined} value={String(claimed.length)} detail="no se importan" />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{isPayable ? 'Documentos recibidos (compras)' : 'Documentos emitidos (ventas)'} del Registro de Compras y Ventas.</span>
            <span>Última sincronización: {lastSync ? formatTimestamp(lastSync, tenant.timezone) : 'nunca'}.</span>
            {integration.data?.last_error && <span className="flex items-center gap-1 text-bad"><CircleAlert size={13} /> {integration.data.last_error}</span>}
          </p>
          {canWrite && (
            <Button size="sm" onClick={sync} disabled={sii.sync.isPending}>
              <RefreshCw size={14} className={sii.sync.isPending ? 'animate-spin' : ''} /> {sii.sync.isPending ? 'Sincronizando…' : 'Sincronizar con el SII'}
            </Button>
          )}
        </div>
        <FormError error={error} />
        {result && (
          <div className="rounded-lg border border-line bg-white px-4 py-3 text-sm">
            <p className="text-ink">
              <b>{result.imported}</b> importados{result.linked ? <>, <b>{result.linked}</b> ya estaban registrados</> : null}
              {result.skipped.length ? <>, <b className="text-bad">{result.skipped.length}</b> no se pudieron importar:</> : '.'}
            </p>
            {result.skipped.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-muted">
                {result.skipped.slice(0, 8).map((s) => <li key={s.id}>N° {s.folio ?? '—'}: {s.reason}</li>)}
                {result.skipped.length > 8 && <li>y {result.skipped.length - 8} más.</li>}
              </ul>
            )}
          </div>
        )}
        <ListView
          state={list}
          columns={columns}
          rowKey={(d) => d.id}
          filters={filters}
          loading={documents.isLoading || integration.isLoading}
          searchPlaceholder="Buscar por folio, razón social o RUT…"
          onRowClick={(d) => {
            if (!d.matched_document_id) return
            rememberDocumentOrder(direction, [d.matched_document_id])
            navigate(`${copy.base}/documentos/${d.matched_document_id}`)
          }}
          toolbarExtra={
            <Button size="sm" onClick={() => downloadCsv(`sii-${isPayable ? 'compras' : 'ventas'}.csv`, list.filtered, csvColumns)} disabled={!list.total}>
              <Download size={16} /> Exportar
            </Button>
          }
          bulkActions={(rows) => (
            <>
              <BulkButton onClick={() => downloadCsv(`sii-${isPayable ? 'compras' : 'ventas'}-seleccion.csv`, rows, csvColumns)}><Download size={15} /> Exportar</BulkButton>
              {canWrite && <BulkButton onClick={() => importRows(rows)}><FileInput size={15} /> Importar</BulkButton>}
            </>
          )}
          rowActions={(d) =>
            canWrite ? (
              <>
                {appStatus(d) === 'sin_registrar' && (
                  <RowAction label={`Importar a ${copy.title.toLowerCase()}`} onClick={() => importRows([d])}><FileInput size={17} /></RowAction>
                )}
                {!d.matched_document_id && (
                  <RowAction label={d.ignored ? 'Dejar de ignorar' : 'Ignorar'} onClick={() => sii.setIgnored.mutate({ id: d.id, ignored: !d.ignored })}>
                    {d.ignored ? <Undo2 size={16} /> : <EyeOff size={16} />}
                  </RowAction>
                )}
              </>
            ) : null
          }
          empty={
            <EmptyState
              icon={<FileText size={20} />}
              title={all.length ? 'Sin documentos para estos filtros' : 'Aún no hay documentos del SII'}
              description={all.length ? 'Cambia el estado o limpia los filtros para ver más.' : 'Sincroniza para traer los documentos. La primera vez, Fintoc puede tardar unos minutos en reunir los últimos 12 meses.'}
            />
          }
        />
        <p className="text-xs text-faint">
          Al importar se crea el {isPayable ? 'proveedor' : 'cliente'} si no existe. Los documentos quedan como {documentTypeLabel('factura').toLowerCase()}s, notas o boletas en CLP;
          las boletas de honorarios se registran por el líquido (bruto menos la retención).{isPayable ? ' Los documentos importados quedan por aprobar según las preferencias del módulo.' : ''}
        </p>
      </div>
    </div>
  )
}

/** Aviso sobre la lista de Documentos: documentos del SII por registrar. Abre la bandeja en un panel. */
export function SiiPendingBanner({ direction }: { direction: DocumentDirection }) {
  const { tenant, hasModule } = useCurrentTenant()
  const integration = useIntegration('fintoc_sii')
  const connected = tenant.country === 'CL' && hasModule('sii') && !!integration.data
  const documents = useSiiDocuments(direction, connected)
  const [params, setParams] = useSearchParams()
  const open = params.get('sii') === '1'
  const setOpen = (value: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set('sii', '1')
        else next.delete('sii')
        return next
      },
      { replace: true },
    )
  if (!connected) return null
  const pending = (documents.data ?? []).filter((d) => appStatus(d) === 'sin_registrar')
  const total = pending.reduce((s, d) => s + (d.doc_type === 'nota_credito' ? -d.total_amount : d.total_amount), 0)
  const isPayable = direction === 'payable'
  return (
    <>
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${pending.length ? 'border-warn/30 bg-warn-bg' : 'border-line bg-white'}`}>
        <span className="flex items-center gap-2 text-ink">
          <FileInput size={16} className={pending.length ? 'text-warn' : 'text-faint'} />
          {pending.length ? (
            <span>
              <b>{pending.length}</b> {pending.length === 1 ? 'documento' : 'documentos'} del SII por registrar
              <span className="text-muted"> · <Money minor={total} currency="CLP" /></span>
            </span>
          ) : (
            <span className="text-muted">Todos los {isPayable ? 'documentos recibidos' : 'documentos emitidos'} en el SII están registrados.</span>
          )}
        </span>
        <Button size="sm" variant={pending.length ? 'primary' : 'secondary'} onClick={() => setOpen(true)}>{pending.length ? 'Revisar' : 'Ver documentos del SII'}</Button>
      </div>
      {open && (
        <Drawer open width="xl" title={isPayable ? 'Documentos del SII · compras' : 'Documentos del SII · ventas'} subtitle="Revisa, importa o ignora los documentos que el SII tiene a nombre de la empresa." onClose={() => setOpen(false)}>
          <SiiInbox direction={direction} />
        </Drawer>
      )}
    </>
  )
}

/** Estado en el SII de un documento registrado (para el detalle del documento). */
export function useSiiInfoFor(documentId: string, direction: DocumentDirection) {
  const { tenant, hasModule } = useCurrentTenant()
  const integration = useIntegration('fintoc_sii')
  const documents = useSiiDocuments(direction, tenant.country === 'CL' && hasModule('sii') && !!integration.data)
  const row = (documents.data ?? []).find((d) => d.matched_document_id === documentId)
  return row ? { row, status: siiStatus(row) } : null
}
