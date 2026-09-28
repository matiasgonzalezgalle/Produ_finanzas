import { Banknote } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCounterparties, useCreatePayment, useDocuments, usePayments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentRow, Payment } from '../../data'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { CURRENCIES, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { Badge, Button, DataTable, Drawer, EmptyState, Field, FormError, Input, PageHeader, Pagination, SearchInput, Select, StatCard, type Column } from '../../ui'
import { sectionCopy, sectionTabs } from '../documents/DocumentsPage'
import { errorMessage, minorToInput, Money, MoneyTotals, normalizeSearch, paginate, parseMoneyInput, useNewParam } from '../shared'

const METHODS = ['transferencia', 'cheque', 'efectivo', 'tarjeta', 'vale vista', 'otro']

export function PaymentsPage({ direction }: { direction: 'in' | 'out' }) {
  const docDirection = direction === 'out' ? 'payable' : 'receivable'
  const copy = sectionCopy(docDirection)
  const { canWrite, today } = useCurrentTenant()
  const payments = usePayments(direction)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [newOpen, setNewOpen] = useNewParam()

  const rows = useMemo(() => {
    const q = normalizeSearch(search)
    return (payments.data ?? []).filter(
      (p) => !q || normalizeSearch(`${p.counterparty_name ?? ''} ${p.reference ?? ''} ${p.allocations.map((a) => a.folio).join(' ')}`).includes(q),
    )
  }, [payments.data, search])

  const month = today.slice(0, 7)
  const thisMonth = (payments.data ?? []).filter((p) => p.paid_on.startsWith(month) && p.status === 'confirmed')
  const unallocated = (payments.data ?? []).filter((p) => p.status === 'confirmed' && p.allocations.reduce((s, a) => s + a.amount, 0) < p.amount)

  const columns: Column<Payment>[] = [
    { key: 'date', header: 'Fecha', cell: (p) => formatDate(p.paid_on) },
    { key: 'cp', header: copy.counterparty, cell: (p) => <span className="text-ink/85">{p.counterparty_name ?? '—'}</span> },
    { key: 'method', header: 'Medio', cell: (p) => <span className="capitalize">{p.method.replace('mercadopago:', 'MercadoPago · ')}</span> },
    { key: 'ref', header: 'Referencia', cell: (p) => p.reference ?? '' },
    {
      key: 'docs',
      header: 'Documentos',
      cell: (p) => {
        const allocated = p.allocations.reduce((s, a) => s + a.amount, 0)
        return (
          <span className="flex flex-wrap items-center gap-1">
            {p.allocations.map((a) => (
              <Badge key={a.document_id}>N° {a.folio ?? '—'}</Badge>
            ))}
            {allocated < p.amount && <Badge tone="warn">Sin asignar {formatMoney(p.amount - allocated, p.currency)}</Badge>}
          </span>
        )
      },
    },
    { key: 'amount', header: 'Monto', align: 'right', cell: (p) => <Money minor={p.amount} currency={p.currency} className="font-medium text-ink" /> },
  ]
  const paged = paginate(rows, page)

  return (
    <div>
      <PageHeader
        title={copy.title}
        tabs={sectionTabs(docDirection)}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}>{copy.pay}</Button>}
      />
      <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-3">
        <StatCard label={direction === 'out' ? 'Pagado este mes' : 'Cobrado este mes'} value={<MoneyTotals totals={sumByCurrency(thisMonth, (p) => ({ currency: p.currency, amount: p.amount }))} empty="$0" />} detail={`${thisMonth.length} movimientos`} />
        <StatCard label="Movimientos" value={(payments.data ?? []).length} />
        <StatCard label="Con saldo sin asignar" value={unallocated.length} tone={unallocated.length ? 'bad' : undefined} detail="Pagos que no cubren documentos por completo" />
      </div>
      <div className="flex justify-end pb-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="Buscar por contraparte, referencia o folio…" />
      </div>
      <DataTable
        columns={columns}
        rows={paged.rows}
        rowKey={(p) => p.id}
        loading={payments.isLoading}
        empty={<EmptyState icon={<Banknote size={20} />} title={direction === 'out' ? 'Sin pagos registrados' : 'Sin cobros registrados'} description="Cada movimiento se asigna a uno o más documentos para mantener los saldos al día." />}
      />
      <Pagination page={paged.page} pages={paged.pages} onChange={setPage} />
      {newOpen && <PaymentDrawer open direction={direction} onClose={() => setNewOpen(false)} />}
    </div>
  )
}

export function PaymentDrawer({ open, direction, preset, onClose }: { open: boolean; direction: 'in' | 'out'; preset?: DocumentRow; onClose: () => void }) {
  const docDirection = direction === 'out' ? 'payable' : 'receivable'
  const copy = sectionCopy(docDirection)
  const { tenant, today } = useCurrentTenant()
  const counterparties = useCounterparties()
  const documents = useDocuments(docDirection)
  const create = useCreatePayment()

  const [counterpartyId, setCounterpartyId] = useState(preset?.counterparty_id ?? '')
  const [currency, setCurrency] = useState<Currency>(preset?.currency ?? tenant.base_currency)
  const [amountText, setAmountText] = useState(preset ? minorToInput(preset.pending_amount, preset.currency) : '')
  const [paidOn, setPaidOn] = useState(today)
  const [method, setMethod] = useState('transferencia')
  const [reference, setReference] = useState('')
  const [allocations, setAllocations] = useState<Record<string, string>>(preset ? { [preset.id]: minorToInput(preset.pending_amount, preset.currency) } : {})
  const [error, setError] = useState<string | null>(null)

  const options = (counterparties.data ?? []).filter((c) => (direction === 'out' ? c.is_supplier : c.is_customer))
  const openDocs = (documents.data ?? [])
    .filter((d) => d.counterparty_id === counterpartyId && d.currency === currency && d.pending_amount > 0)
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))

  const amount = parseMoneyInput(amountText, currency)
  const allocatedMinor = Object.entries(allocations).reduce((s, [id, text]) => (openDocs.some((d) => d.id === id) ? s + (parseMoneyInput(text || '0', currency) ?? 0) : s), 0)
  const remaining = (amount ?? 0) - allocatedMinor

  function autoAllocate() {
    let left = amount ?? 0
    const next: Record<string, string> = {}
    for (const d of openDocs) {
      if (left <= 0) break
      const take = Math.min(left, d.pending_amount)
      next[d.id] = minorToInput(take, currency)
      left -= take
    }
    setAllocations(next)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!counterpartyId) return setError(`Selecciona un ${copy.counterparty.toLowerCase()}`)
    if (!amount || amount <= 0) return setError('Ingresa un monto válido')
    const items = []
    for (const d of openDocs) {
      const text = allocations[d.id]
      if (!text) continue
      const value = parseMoneyInput(text, currency)
      if (value === null) return setError(`Monto inválido para el documento N° ${d.folio}`)
      if (value > d.pending_amount) return setError(`El documento N° ${d.folio} tiene un saldo de ${formatMoney(d.pending_amount, currency)}`)
      if (value > 0) items.push({ document_id: d.id, amount: value })
    }
    if (allocatedMinor > amount) return setError('Lo asignado supera el monto del movimiento')
    try {
      await create.mutateAsync({
        direction,
        counterparty_id: counterpartyId,
        currency,
        amount,
        paid_on: paidOn,
        method,
        reference: reference.trim() || null,
        notes: null,
        allocations: items,
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open={open}
      width="lg"
      title={copy.pay}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="payment-form" disabled={create.isPending}>
            {create.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid grid-cols-2 gap-4">
          <Field label={copy.counterparty}>
            {(id) => (
              <Select id={id} value={counterpartyId} onChange={(e) => { setCounterpartyId(e.target.value); setAllocations({}) }} disabled={!!preset}>
                <option value="">Selecciona…</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Moneda">
            {(id) => (
              <Select id={id} value={currency} onChange={(e) => { setCurrency(e.target.value as Currency); setAllocations({}) }} disabled={!!preset}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Monto" error={amountText && amount === null ? 'Formato inválido' : null}>
            {(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0" autoFocus />}
          </Field>
          <Field label="Fecha">{(id) => <Input id={id} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
          <Field label="Medio">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)} className="capitalize">
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Referencia" hint="N° de transferencia, cheque u operación">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>

        <section className="rounded-lg border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Asignar a documentos</h3>
              <p className="text-xs text-muted">Solo documentos abiertos de este {copy.counterparty.toLowerCase()} en {currency}.</p>
            </div>
            <Button size="sm" onClick={autoAllocate} disabled={!amount || openDocs.length === 0}>Asignar automático</Button>
          </div>
          {openDocs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-faint">{counterpartyId ? 'No hay documentos con saldo en esta moneda.' : `Selecciona un ${copy.counterparty.toLowerCase()}.`}</p>
          ) : (
            <ul className="divide-y divide-line">
              {openDocs.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="min-w-40 flex-1 text-sm">
                    <div className="text-ink">{documentTypeLabel(d.doc_type)} N° {d.folio}</div>
                    <div className="text-xs text-faint">Vence {formatDate(d.due_date)} · saldo {formatMoney(d.pending_amount, d.currency)}</div>
                  </div>
                  <Input
                    aria-label={`Monto para documento ${d.folio}`}
                    inputMode="decimal"
                    className="w-36 text-right tabular"
                    value={allocations[d.id] ?? ''}
                    onChange={(e) => setAllocations((a) => ({ ...a, [d.id]: e.target.value }))}
                    placeholder="0"
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between border-t border-line bg-subtle px-4 py-2.5 text-sm">
            <span className="text-muted">Asignado <Money minor={allocatedMinor} currency={currency} className="text-ink" /></span>
            <span className={remaining < 0 ? 'font-medium text-bad' : 'text-muted'}>
              {remaining < 0 ? 'Excede en ' : 'Sin asignar '}
              <Money minor={Math.abs(remaining)} currency={currency} />
            </span>
          </div>
        </section>
      </form>
    </Drawer>
  )
}
