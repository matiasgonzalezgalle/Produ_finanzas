import clsx from 'clsx'
import { FileText, Link2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCounterparties, useCreatePaymentLink, useDocuments, useIntegration, usePayments, useSaveDocument, useVoidDocument } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentInput, DocumentRow } from '../../data'
import { addDays, formatDate } from '../../domain/dates'
import { computeDetraction, computeTax, DOCUMENT_TYPES, documentTypeLabel, TAX_LABEL, type DocumentDirection, type DocumentTypeCode } from '../../domain/documents'
import { CURRENCIES, CURRENCY_DECIMALS, sumByCurrency, type Currency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { Button, DataTable, Drawer, EmptyState, Field, FormError, Input, PageHeader, Pagination, SearchInput, Select, StatCard, Textarea, type Column } from '../../ui'
import { errorMessage, minorToInput, Money, MoneyTotals, normalizeSearch, paginate, parseMoneyInput, StatusBadge, useNewParam } from '../shared'
import { PaymentDrawer } from '../payments/PaymentsPage'

const FILTERS = [
  { key: 'abiertos', label: 'Por pagar' },
  { key: 'vencido', label: 'Vencidos' },
  { key: 'pagado', label: 'Pagados' },
  { key: 'todos', label: 'Todos' },
] as const
type Filter = (typeof FILTERS)[number]['key']

export function sectionCopy(direction: DocumentDirection) {
  return direction === 'payable'
    ? { title: 'Cuentas por pagar', base: '/cxp', paymentsTab: 'Pagos', paymentsPath: '/cxp/pagos', counterparty: 'Proveedor', open: 'Por pagar', pay: 'Registrar pago' }
    : { title: 'Cuentas por cobrar', base: '/cxc', paymentsTab: 'Cobros', paymentsPath: '/cxc/cobros', counterparty: 'Cliente', open: 'Por cobrar', pay: 'Registrar cobro' }
}

export function sectionTabs(direction: DocumentDirection) {
  const copy = sectionCopy(direction)
  return [
    { to: `${copy.base}/documentos`, label: 'Documentos' },
    { to: copy.paymentsPath, label: copy.paymentsTab },
  ]
}

export function DocumentsPage({ direction }: { direction: DocumentDirection }) {
  const copy = sectionCopy(direction)
  const { canWrite, today } = useCurrentTenant()
  const documents = useDocuments(direction)
  const [filter, setFilter] = useState<Filter>('abiertos')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [newOpen, setNewOpen] = useNewParam()
  const [selected, setSelected] = useState<DocumentRow | null>(null)
  const [editing, setEditing] = useState<DocumentRow | null>(null)

  const all = useMemo(() => documents.data ?? [], [documents.data])
  const selectedFresh = selected ? all.find((d) => d.id === selected.id) ?? selected : null

  const rows = useMemo(() => {
    const q = normalizeSearch(search)
    return all
      .filter((d) => {
        if (filter === 'abiertos') return d.pending_amount > 0
        if (filter === 'vencido') return d.payment_status === 'vencido'
        if (filter === 'pagado') return d.payment_status === 'pagado'
        return true
      })
      .filter((d) => !q || normalizeSearch(`${d.counterparty_name} ${d.folio} ${d.counterparty_tax_id ?? ''}`).includes(q))
  }, [all, filter, search])

  const open = all.filter((d) => d.pending_amount > 0)
  const overdue = open.filter((d) => d.payment_status === 'vencido')
  const pendingTotals = sumByCurrency(open, (d) => ({ currency: d.currency, amount: d.pending_amount }))
  const overdueTotals = sumByCurrency(overdue, (d) => ({ currency: d.currency, amount: d.pending_amount }))

  const columns: Column<DocumentRow>[] = [
    { key: 'cp', header: copy.counterparty, cell: (d) => <span className="text-ink/85">{d.counterparty_name}</span> },
    { key: 'type', header: 'Documento', cell: (d) => <span className="whitespace-nowrap">{documentTypeLabel(d.doc_type)} <span className="text-ink/85">N° {d.folio}</span></span> },
    { key: 'issue', header: 'Emisión', cell: (d) => formatDate(d.issue_date) },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date) },
    { key: 'total', header: 'Total', align: 'right', cell: (d) => <Money minor={d.total_amount} currency={d.currency} /> },
    { key: 'pending', header: 'Saldo', align: 'right', cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className={d.pending_amount ? 'font-medium text-ink' : ''} /> },
    { key: 'status', header: 'Estado', cell: (d) => <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} /> },
  ]
  const paged = paginate(rows, page)

  return (
    <div>
      <PageHeader
        title={copy.title}
        tabs={sectionTabs(direction)}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}>Registrar documento</Button>}
      />
      <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-3">
        <StatCard label={copy.open} value={<MoneyTotals totals={pendingTotals} empty="$0" />} detail={`${open.length} documentos`} />
        <StatCard label="Vencido" tone={overdue.length ? 'bad' : undefined} value={<MoneyTotals totals={overdueTotals} empty="$0" />} detail={`${overdue.length} documentos`} />
        <StatCard label="Próximos 7 días" value={<MoneyTotals totals={sumByCurrency(open.filter((d) => d.payment_status !== 'vencido' && d.due_date && d.due_date <= addDays(today, 7)), (d) => ({ currency: d.currency, amount: d.pending_amount }))} empty="$0" />} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-subtle p-1" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => { setFilter(f.key); setPage(1) }}
              className={clsx('rounded-md px-3 py-1.5 text-sm whitespace-nowrap', filter === f.key ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}
            >
              {f.key === 'abiertos' ? copy.open : f.label}
            </button>
          ))}
        </div>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder={`Buscar ${copy.counterparty.toLowerCase()} o folio…`} />
      </div>
      <DataTable
        columns={columns}
        rows={paged.rows}
        rowKey={(d) => d.id}
        loading={documents.isLoading}
        onRowClick={setSelected}
        empty={<EmptyState icon={<FileText size={20} />} title="Sin documentos en esta vista" description="Registra facturas, boletas o notas de crédito para controlar su saldo." />}
      />
      <Pagination page={paged.page} pages={paged.pages} onChange={setPage} />

      {selectedFresh && (
        <DocumentDetail
          doc={selectedFresh}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditing(selectedFresh)
            setSelected(null)
          }}
        />
      )}
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
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  )
}

function DocumentDetail({ doc, onClose, onEdit }: { doc: DocumentRow; onClose: () => void; onEdit: () => void }) {
  const { tenant, canWrite } = useCurrentTenant()
  const copy = sectionCopy(doc.direction)
  const payments = usePayments(doc.direction === 'payable' ? 'out' : 'in')
  const integration = useIntegration('mercadopago')
  const createLink = useCreatePaymentLink()
  const voidDoc = useVoidDocument()
  const [payOpen, setPayOpen] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const related = (payments.data ?? []).filter((p) => p.allocations.some((a) => a.document_id === doc.id))
  const canCharge = doc.direction === 'receivable' && doc.pending_amount > 0 && integration.data?.status === 'active'

  return (
    <>
      <Drawer
        open
        width="lg"
        title={`${documentTypeLabel(doc.doc_type)} N° ${doc.folio}`}
        subtitle={
          <span className="flex items-center gap-2">
            {doc.counterparty_name}
            {doc.counterparty_tax_id && <span className="text-faint">· {formatTaxId(doc.counterparty_tax_id, tenant.country)}</span>}
          </span>
        }
        onClose={onClose}
        footer={
          canWrite && doc.status !== 'void' && (
            <>
              <Button
                variant="danger"
                onClick={async () => {
                  if (!window.confirm('¿Anular este documento? Dejará de contar en los saldos.')) return
                  try {
                    await voidDoc.mutateAsync(doc.id)
                    onClose()
                  } catch (err) {
                    setError(errorMessage(err))
                  }
                }}
              >
                Anular
              </Button>
              <Button onClick={onEdit}>Editar</Button>
              {doc.pending_amount > 0 && (
                <Button variant="primary" onClick={() => setPayOpen(true)}>
                  {copy.pay}
                </Button>
              )}
            </>
          )
        }
      >
        <div className="flex flex-col gap-6">
          <FormError error={error} />
          <div className="flex items-center justify-between rounded-lg bg-subtle p-4">
            <div>
              <div className="text-[13px] text-muted">Saldo pendiente</div>
              <div className="text-2xl font-semibold text-ink"><Money minor={doc.pending_amount} currency={doc.currency} /></div>
            </div>
            <StatusBadge status={doc.payment_status} daysOverdue={doc.days_overdue} />
          </div>

          <section>
            <DetailRow label="Emisión">{formatDate(doc.issue_date)}</DetailRow>
            <DetailRow label="Vencimiento">{formatDate(doc.due_date)}</DetailRow>
            {doc.net_amount > 0 && <DetailRow label="Neto"><Money minor={doc.net_amount} currency={doc.currency} /></DetailRow>}
            {doc.exempt_amount > 0 && <DetailRow label="Exento"><Money minor={doc.exempt_amount} currency={doc.currency} /></DetailRow>}
            {doc.tax_amount > 0 && <DetailRow label={TAX_LABEL[tenant.country]}><Money minor={doc.tax_amount} currency={doc.currency} /></DetailRow>}
            <DetailRow label="Total"><Money minor={doc.total_amount} currency={doc.currency} className="font-medium" /></DetailRow>
            {doc.credits_amount > 0 && <DetailRow label="Notas de crédito">− <Money minor={doc.credits_amount} currency={doc.currency} /></DetailRow>}
            {doc.detraction_amount > 0 && (
              <DetailRow label={`Detracción ${doc.detraction_rate}% (${doc.detraction_status})`}>
                − <Money minor={doc.detraction_amount} currency={doc.currency} />
              </DetailRow>
            )}
            <DetailRow label={doc.direction === 'payable' ? 'Pagado' : 'Cobrado'}>
              <Money minor={doc.paid_amount} currency={doc.currency} />
            </DetailRow>
          </section>

          {doc.description && <p className="rounded-lg border border-line p-3 text-sm text-muted">{doc.description}</p>}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">{doc.direction === 'payable' ? 'Pagos' : 'Cobros'} asociados</h3>
            {related.length === 0 ? (
              <p className="text-sm text-faint">Todavía no hay movimientos asociados.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {related.map((p) => {
                  const alloc = p.allocations.find((a) => a.document_id === doc.id)!
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                      <span>
                        <span className="text-ink">{formatDate(p.paid_on)}</span>
                        <span className="text-faint"> · {p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
                      </span>
                      <Money minor={alloc.amount} currency={p.currency} className="font-medium text-ink" />
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {doc.direction === 'receivable' && doc.pending_amount > 0 && canWrite && (
            <section className="rounded-lg border border-line p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Link de pago MercadoPago</h3>
                  <p className="text-xs text-muted">
                    {canCharge ? 'Genera un link por el saldo pendiente. El cobro se registra solo al confirmarse.' : 'Conecta MercadoPago en Integraciones para cobrar con link.'}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={!canCharge || createLink.isPending}
                  onClick={async () => {
                    setError(null)
                    try {
                      const res = await createLink.mutateAsync(doc.id)
                      setLink(res.url)
                    } catch (err) {
                      setError(errorMessage(err))
                    }
                  }}
                >
                  <Link2 size={15} /> {createLink.isPending ? 'Generando…' : 'Generar link'}
                </Button>
              </div>
              {link && (
                <div className="mt-3 flex items-center gap-2">
                  <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                  <Button size="sm" onClick={() => navigator.clipboard?.writeText(link)}>Copiar</Button>
                </div>
              )}
            </section>
          )}
        </div>
      </Drawer>
      {payOpen && <PaymentDrawer open direction={doc.direction === 'payable' ? 'out' : 'in'} preset={doc} onClose={() => setPayOpen(false)} />}
    </>
  )
}

export function DocumentDrawer({
  open,
  direction,
  doc,
  documents,
  onClose,
}: {
  open: boolean
  direction: DocumentDirection
  doc: DocumentRow | null
  documents: DocumentRow[]
  onClose: () => void
}) {
  const { tenant, today } = useCurrentTenant()
  const copy = sectionCopy(direction)
  const counterparties = useCounterparties()
  const save = useSaveDocument()
  const options = (counterparties.data ?? []).filter((c) => (direction === 'payable' ? c.is_supplier : c.is_customer))

  const [form, setForm] = useState(() => ({
    counterparty_id: doc?.counterparty_id ?? '',
    doc_type: (doc?.doc_type ?? 'factura') as DocumentTypeCode,
    folio: doc?.folio ?? '',
    currency: (doc?.currency ?? tenant.base_currency) as Currency,
    issue_date: doc?.issue_date ?? today,
    due_date: doc?.due_date ?? '',
    net: doc ? minorToInput(doc.net_amount, doc.currency) : '',
    exempt: doc ? minorToInput(doc.exempt_amount, doc.currency) : '',
    tax: doc ? minorToInput(doc.tax_amount, doc.currency) : '',
    taxTouched: !!doc,
    applies_to_id: doc?.applies_to_id ?? '',
    detraction_rate: doc?.detraction_rate ? String(doc.detraction_rate) : '',
    detraction_status: doc?.detraction_status ?? 'no_aplica',
    description: doc?.description ?? '',
  }))
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }))

  const typeOptions = DOCUMENT_TYPES.filter((t) => t.countries.includes(tenant.country))
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
      const next = { ...f, counterparty_id: id, applies_to_id: '' }
      if (cp?.default_currency && !doc) next.currency = cp.default_currency
      if (cp?.payment_terms_days != null && !f.due_date && f.issue_date) next.due_date = addDays(f.issue_date, cp.payment_terms_days)
      return next
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.counterparty_id) return setError(`Selecciona un ${copy.counterparty.toLowerCase()}`)
    if (!form.folio.trim()) return setError('El folio es obligatorio')
    if ([form.net, form.exempt, form.tax].some((v) => v && parseMoneyInput(v, form.currency) === null)) return setError('Hay un monto con formato inválido')
    if (totalMinor <= 0) return setError('El total debe ser mayor a cero')
    if (form.due_date && form.due_date < form.issue_date) return setError('El vencimiento no puede ser anterior a la emisión')
    if (form.doc_type === 'nota_credito' && !form.applies_to_id) return setError('Indica a qué documento se aplica la nota de crédito')
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
    }
    try {
      await save.mutateAsync({ input, id: doc?.id })
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
          <Button variant="primary" type="submit" form="document-form" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
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
              <Select id={id} value={form.doc_type} onChange={(e) => set('doc_type', e.target.value as DocumentTypeCode)}>
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
        <div className="grid grid-cols-3 gap-4">
          <Field label="Moneda">
            {(id) => (
              <Select id={id} value={form.currency} onChange={(e) => set('currency', e.target.value as Currency)}>
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
        <Field label="Descripción">{(id) => <Textarea id={id} value={form.description} onChange={(e) => set('description', e.target.value)} />}</Field>
      </form>
    </Drawer>
  )
}
