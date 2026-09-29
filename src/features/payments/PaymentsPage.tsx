import { Banknote, Download, Eye, Landmark, Plus, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useBankMutations, useCounterparties, useCreatePayment, useDocuments, useDocumentTypeSettings, usePaymentMethods, usePayments, useVoidPayment } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { BankMovement, DocumentRow, Payment } from '../../data'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { CURRENCIES, CURRENCY_DECIMALS, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { csvAmount, downloadCsv, type CsvColumn } from '../../lib/csv'
import { Badge, Button, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, StatCard } from '../../ui'
import { BulkButton, ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { sectionCopy, sectionTabs } from '../documents/DocumentsPage'
import { errorMessage, minorToInput, Money, MoneyTotals, parseMoneyInput, useNewParam } from '../shared'
import { accountLabel, BankLinkDetail, movementCandidates, ReconciledBadge, useBankData } from '../reconciliation/bankLinks'

const SOURCE_LABEL: Record<string, string> = { manual: 'Registro manual', bank: 'Desde la cartola bancaria', mercadopago: 'MercadoPago' }
// Se pueden anular los registrados en la app (los de MercadoPago se gestionan en MercadoPago).
const canVoid = (p: Payment) => p.status === 'confirmed' && (p.source === 'manual' || p.source === 'bank')
const METHOD_LABEL = (m: string) => (m.startsWith('mercadopago') ? 'MercadoPago' : m.charAt(0).toUpperCase() + m.slice(1))
const allocatedOf = (p: Payment) => p.allocations.reduce((s, a) => s + a.amount, 0)

export function PaymentsPage({ direction }: { direction: 'in' | 'out' }) {
  const docDirection = direction === 'out' ? 'payable' : 'receivable'
  const copy = sectionCopy(docDirection)
  const { canWrite, today } = useCurrentTenant()
  const payments = usePayments(direction)
  const bank = useBankData()
  const voidPayment = useVoidPayment()
  const [newOpen, setNewOpen] = useNewParam()
  const [detail, setDetail] = useState<Payment | null>(null)
  const [error, setError] = useState<string | null>(null)

  const all = useMemo(() => payments.data ?? [], [payments.data])
  const confirmed = all.filter((p) => p.status === 'confirmed')
  const month = today.slice(0, 7)
  const thisMonth = confirmed.filter((p) => p.paid_on.startsWith(month))
  const unallocated = confirmed.filter((p) => allocatedOf(p) < p.amount)
  const verb = direction === 'out' ? 'Pagado' : 'Cobrado'

  const columns: ListColumn<Payment>[] = [
    { key: 'cp', header: copy.counterparty, cell: (p) => p.counterparty_name ?? '—', sortValue: (p) => p.counterparty_name ?? '', className: 'min-w-48' },
    { key: 'date', header: 'Fecha', cell: (p) => formatDate(p.paid_on), sortValue: (p) => p.paid_on },
    { key: 'method', header: 'Medio', cell: (p) => METHOD_LABEL(p.method), sortValue: (p) => p.method },
    { key: 'ref', mobileHidden: true, header: 'Referencia', cell: (p) => p.reference ?? '', sortValue: (p) => p.reference ?? '' },
    {
      key: 'docs',
      header: 'Documentos',
      cell: (p) => (
        <span className="flex flex-wrap gap-1">
          {p.allocations.length ? p.allocations.map((a) => <Badge key={a.document_id}>N° {a.folio ?? '—'}</Badge>) : <span className="text-faint">—</span>}
        </span>
      ),
    },
    { key: 'amount', header: 'Monto', align: 'right', cell: (p) => <Money minor={p.amount} currency={p.currency} className="font-semibold text-ink" />, sortValue: (p) => p.amount },
    {
      key: 'status', mobileBadge: true,
      header: 'Estado',
      cell: (p) =>
        p.status === 'void' ? <Badge>Anulado</Badge> : allocatedOf(p) < p.amount ? <Badge tone="warn">Sin asignar {formatMoney(p.amount - allocatedOf(p), p.currency)}</Badge> : <Badge tone="solid">Asignado</Badge>,
      sortValue: (p) => (p.status === 'void' ? 2 : allocatedOf(p) < p.amount ? 0 : 1),
    },
    ...(bank.enabled
      ? [{
          key: 'bank', header: 'Banco', mobileHidden: true,
          cell: (p: Payment) => (p.status === 'void' ? <span className="text-faint">—</span> : <ReconciledBadge link={bank.byPayment.get(p.id)} />),
          sortValue: (p: Payment) => (bank.byPayment.has(p.id) ? 1 : 0),
        } satisfies ListColumn<Payment>]
      : []),
  ]

  const counterparties = [...new Map(all.filter((p) => p.counterparty_id).map((p) => [p.counterparty_id!, p.counterparty_name ?? '—'])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const filters: ListFilter<Payment>[] = [
    {
      type: 'select',
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'confirmed', label: 'Vigentes' },
        { value: 'unallocated', label: 'Con saldo sin asignar' },
        { value: 'void', label: 'Anulados' },
      ],
      defaultValue: 'confirmed',
      match: (p, v) => (v === 'unallocated' ? p.status === 'confirmed' && allocatedOf(p) < p.amount : p.status === v),
    },
    { type: 'select', key: 'cp', label: copy.counterparty, options: counterparties.map(([value, label]) => ({ value, label })), match: (p, v) => p.counterparty_id === v },
    {
      type: 'select',
      key: 'method',
      label: 'Medio',
      options: [...new Set(all.map((p) => (p.method.startsWith('mercadopago') ? 'mercadopago' : p.method)))].map((m) => ({ value: m, label: METHOD_LABEL(m) })),
      match: (p, v) => (v === 'mercadopago' ? p.method.startsWith('mercadopago') : p.method === v),
    },
    { type: 'select', key: 'currency', label: 'Moneda', options: [...new Set(all.map((p) => p.currency))].map((c) => ({ value: c, label: c })), match: (p, v) => p.currency === v },
    { type: 'dateRange', key: 'date', label: 'Fecha', getDate: (p) => p.paid_on },
    ...(bank.enabled
      ? [{
          type: 'select', key: 'bank', label: 'Conciliación',
          options: [{ value: 'yes', label: 'Conciliados con el banco' }, { value: 'no', label: 'Sin conciliar' }],
          match: (p: Payment, v: string) => (v === 'yes') === bank.byPayment.has(p.id),
        } satisfies ListFilter<Payment>]
      : []),
  ]

  const list = useListState({
    rows: all,
    rowKey: (p) => p.id,
    columns,
    filters,
    searchText: (p) => `${p.counterparty_name ?? ''} ${p.reference ?? ''} ${p.method} ${p.allocations.map((a) => a.folio).join(' ')}`,
    storageKey: `payments-${direction}`,
    defaultSort: { key: 'date', dir: 'desc' },
  })

  const csvColumns: CsvColumn<Payment>[] = [
    { header: 'Fecha', value: (p) => formatDate(p.paid_on) },
    { header: copy.counterparty, value: (p) => p.counterparty_name },
    { header: 'Medio', value: (p) => METHOD_LABEL(p.method) },
    { header: 'Referencia', value: (p) => p.reference },
    { header: 'Moneda', value: (p) => p.currency },
    { header: 'Monto', value: (p) => csvAmount(p.amount, CURRENCY_DECIMALS[p.currency]) },
    { header: 'Asignado', value: (p) => csvAmount(allocatedOf(p), CURRENCY_DECIMALS[p.currency]) },
    { header: 'Documentos', value: (p) => p.allocations.map((a) => a.folio).join(', ') },
    { header: 'Estado', value: (p) => (p.status === 'void' ? 'Anulado' : 'Vigente') },
    ...(bank.enabled ? [{ header: 'Conciliado con el banco', value: (p: Payment) => (bank.byPayment.has(p.id) ? 'Sí' : 'No') }] : []),
  ]
  const fileBase = direction === 'out' ? 'pagos' : 'cobros'

  async function voidMany(rows: Payment[]) {
    const targets = rows.filter(canVoid)
    if (!targets.length) return setError('Solo se pueden anular movimientos manuales vigentes. Los de MercadoPago se gestionan en MercadoPago.')
    if (!window.confirm(`¿Anular ${targets.length} movimiento(s)? Los documentos asociados recuperarán su saldo.`)) return
    setError(null)
    try {
      for (const p of targets) await voidPayment.mutateAsync(p.id)
      list.clearSelection()
      setDetail(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div>
      <PageHeader
        title={copy.title}
        tabs={sectionTabs(docDirection)}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus size={16} /> {copy.pay}</Button>}
      />
      <div className="stat-row pt-5 sm:grid-cols-3">
        <StatCard label={`${verb} este mes`} value={<MoneyTotals totals={sumByCurrency(thisMonth, (p) => ({ currency: p.currency, amount: p.amount }))} empty="$0" />} detail={`${thisMonth.length} movimientos`} />
        <StatCard label="Movimientos vigentes" value={confirmed.length} />
        <StatCard label="Con saldo sin asignar" value={unallocated.length} tone={unallocated.length ? 'bad' : undefined} detail="No cubren documentos por completo" />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <FormError error={error} />
        <ListView
          state={list}
          columns={columns}
          rowKey={(p) => p.id}
          filters={filters}
          loading={payments.isLoading}
          searchPlaceholder="Buscar por contraparte, referencia o folio…"
          onRowClick={setDetail}
          toolbarExtra={
            <Button size="sm" onClick={() => downloadCsv(`${fileBase}.csv`, list.filtered, csvColumns)} disabled={!list.total}>
              <Download size={16} /> Exportar
            </Button>
          }
          bulkActions={(rows) => (
            <>
              <BulkButton onClick={() => downloadCsv(`${fileBase}-seleccion.csv`, rows, csvColumns)}><Download size={15} /> Exportar</BulkButton>
              {canWrite && <BulkButton tone="danger" onClick={() => voidMany(rows)}><Trash2 size={15} /> Anular</BulkButton>}
            </>
          )}
          rowActions={(p) => (
            <>
              <RowAction label="Ver detalle" onClick={() => setDetail(p)}><Eye size={17} /></RowAction>
              {canWrite && canVoid(p) && (
                <RowAction label="Anular" tone="danger" onClick={() => voidMany([p])}><Trash2 size={17} /></RowAction>
              )}
            </>
          )}
          empty={
            <EmptyState
              icon={<Banknote size={20} />}
              title={all.length ? 'Sin movimientos para estos filtros' : direction === 'out' ? 'Sin pagos registrados' : 'Sin cobros registrados'}
              description={all.length ? 'Cambia el estado o limpia los filtros.' : 'Cada movimiento se asigna a uno o más documentos para mantener los saldos al día.'}
            />
          }
        />
      </div>
      {newOpen && <PaymentDrawer open direction={direction} onClose={() => setNewOpen(false)} />}
      {detail && (
        <Drawer
          open
          title={`${direction === 'out' ? 'Pago' : 'Cobro'} · ${formatDate(detail.paid_on)}`}
          subtitle={detail.counterparty_name ?? undefined}
          onClose={() => setDetail(null)}
          footer={
            canWrite && canVoid(detail) && (
              <Button variant="danger" onClick={() => voidMany([detail])}><Trash2 size={16} /> Anular</Button>
            )
          }
        >
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between rounded-lg bg-subtle p-4">
              <div>
                <div className="text-[12px] text-muted">Monto</div>
                <div className="text-2xl font-semibold text-ink"><Money minor={detail.amount} currency={detail.currency} /></div>
              </div>
              {detail.status === 'void' ? <Badge>Anulado</Badge> : <Badge tone="solid">Vigente</Badge>}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div><dt className="text-faint">Medio</dt><dd className="text-ink">{METHOD_LABEL(detail.method)}</dd></div>
              <div><dt className="text-faint">Referencia</dt><dd className="text-ink">{detail.reference ?? '—'}</dd></div>
              <div><dt className="text-faint">Origen</dt><dd className="text-ink">{SOURCE_LABEL[detail.source] ?? (detail.source.startsWith('mercadopago') ? 'MercadoPago' : detail.source)}</dd></div>
              <div><dt className="text-faint">Sin asignar</dt><dd className="text-ink"><Money minor={detail.amount - allocatedOf(detail)} currency={detail.currency} /></dd></div>
            </dl>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Documentos asignados</h3>
              {detail.allocations.length === 0 ? (
                <p className="text-sm text-faint">Este movimiento no está asignado a documentos.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {detail.allocations.map((a) => (
                    <li key={a.document_id} className="flex justify-between px-3 py-2.5 text-sm">
                      <span className="text-ink">Documento N° {a.folio ?? '—'}</span>
                      <Money minor={a.amount} currency={detail.currency} className="font-medium text-ink" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {bank.enabled && detail.status === 'confirmed' && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-ink">Conciliación bancaria</h3>
                <BankLinkDetail link={bank.byPayment.get(detail.id)} direction={direction} />
              </section>
            )}
            {detail.notes && <p className="rounded-lg border border-line p-3 text-sm text-muted">{detail.notes}</p>}
          </div>
        </Drawer>
      )}
    </div>
  )
}

export function PaymentDrawer({ open, direction, presets, onClose }: { open: boolean; direction: 'in' | 'out'; presets?: DocumentRow[]; onClose: () => void }) {
  const preset = presets?.[0]
  const docDirection = direction === 'out' ? 'payable' : 'receivable'
  const copy = sectionCopy(docDirection)
  const { tenant, today } = useCurrentTenant()
  const counterparties = useCounterparties()
  const documents = useDocuments(docDirection)
  const create = useCreatePayment()
  const bankMutations = useBankMutations()
  const bank = useBankData()
  const methods = usePaymentMethods(direction)
  const typeSettings = useDocumentTypeSettings(docDirection)

  const [counterpartyId, setCounterpartyId] = useState(preset?.counterparty_id ?? '')
  const [currency, setCurrency] = useState<Currency>(preset?.currency ?? tenant.base_currency)
  const presetTotal = (presets ?? []).reduce((sum, d) => sum + d.pending_amount, 0)
  const [amountText, setAmountText] = useState(preset ? minorToInput(presetTotal, preset.currency) : '')
  const [paidOn, setPaidOn] = useState(today)
  const activeMethods = (methods.data ?? []).filter((m) => m.active)
  const [methodChoice, setMethod] = useState<string | null>(null)
  const method = methodChoice ?? activeMethods.find((m) => m.is_default)?.name ?? activeMethods[0]?.name ?? ''
  const notPayable = new Set((typeSettings.data ?? []).filter((t) => !t.can_pay).map((t) => t.doc_type))
  const [reference, setReference] = useState('')
  const [allocations, setAllocations] = useState<Record<string, string>>(() => Object.fromEntries((presets ?? []).map((d) => [d.id, minorToInput(d.pending_amount, d.currency)])))
  const [error, setError] = useState<string | null>(null)
  // Movimiento de la cartola con el que se concilia al guardar (fija monto, fecha y referencia).
  const [movementId, setMovementId] = useState<string | null>(null)

  const options = (counterparties.data ?? []).filter((c) => (direction === 'out' ? c.is_supplier : c.is_customer))
  const openDocs = (documents.data ?? [])
    .filter((d) => d.counterparty_id === counterpartyId && d.currency === currency && d.pending_amount > 0 && !notPayable.has(d.doc_type))
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))

  const amount = parseMoneyInput(amountText, currency)
  const allocatedMinor = Object.entries(allocations).reduce((s, [id, text]) => (openDocs.some((d) => d.id === id) ? s + (parseMoneyInput(text || '0', currency) ?? 0) : s), 0)
  const remaining = (amount ?? 0) - allocatedMinor
  const movement = bank.movements.find((m) => m.id === movementId) ?? null
  const candidates = bank.enabled && !movement
    ? movementCandidates({
        movements: bank.movements, direction, currency, amount, date: paidOn,
        counterparty: options.find((c) => c.id === counterpartyId) ?? null, counterparties: counterparties.data ?? [],
      })
    : []

  function pickMovement(m: BankMovement) {
    setMovementId(m.id)
    setAmountText(minorToInput(Math.abs(m.amount), currency))
    setPaidOn(m.post_date)
    setReference(m.reference_id ?? m.document_number ?? '')
  }

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
    if (!method) return setError('Configura al menos una forma de pago activa')
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
      if (movement) {
        await bankMutations.createPayment.mutateAsync({ movementId: movement.id, input: { counterparty_id: counterpartyId, method, notes: null, allocations: items } })
        return onClose()
      }
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
          <Button variant="primary" type="submit" form="payment-form" disabled={create.isPending || bankMutations.createPayment.isPending}>
            {create.isPending || bankMutations.createPayment.isPending ? 'Guardando…' : movement ? 'Guardar y conciliar' : 'Guardar'}
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
              <Select id={id} value={currency} onChange={(e) => { setCurrency(e.target.value as Currency); setAllocations({}) }} disabled={!!preset || !!movement}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Monto" error={amountText && amount === null ? 'Formato inválido' : null}>
            {(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0" autoFocus disabled={!!movement} />}
          </Field>
          <Field label="Fecha">{(id) => <Input id={id} type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} disabled={!!movement} />}</Field>
          <Field label="Forma de pago">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>
                {!activeMethods.length && <option value="">Sin formas de pago</option>}
                {activeMethods.map((m) => (
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Referencia" hint="N° de transferencia, cheque u operación">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} disabled={!!movement} />}</Field>

        {movement && (
          <section className="flex items-start justify-between gap-3 rounded-lg border border-ok/40 bg-ok-bg px-4 py-3">
            <div className="flex min-w-0 gap-3">
              <Landmark size={18} className="mt-0.5 shrink-0 text-ok" />
              <div className="min-w-0 text-sm">
                <div className="font-medium text-ink">Se conciliará con el movimiento del banco</div>
                <div className="truncate text-xs text-muted">
                  {formatDate(movement.post_date)} · {movement.description} · {accountLabel(bank.accountById.get(movement.account_id))} · <Money minor={movement.amount} currency={movement.currency} />
                </div>
                <div className="text-xs text-faint">El monto, la fecha y la referencia se toman del banco.</div>
              </div>
            </div>
            <button type="button" onClick={() => setMovementId(null)} className="rounded-md p-1 text-muted hover:bg-white" aria-label="Quitar movimiento"><X size={16} /></button>
          </section>
        )}
        {candidates.length > 0 && (
          <section className="rounded-lg border border-brand-500/30 bg-brand-50/50">
            <div className="flex items-center gap-2 border-b border-brand-500/20 px-4 py-2.5">
              <Landmark size={16} className="text-brand-600" />
              <h3 className="text-sm font-semibold text-ink">Movimientos del banco que coinciden</h3>
            </div>
            <ul className="divide-y divide-brand-500/10">
              {candidates.map((c) => (
                <li key={c.movement.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 text-sm">
                    <div className="truncate text-ink">{c.movement.description ?? (direction === 'in' ? 'Abono' : 'Cargo')}</div>
                    <div className="truncate text-xs text-faint">
                      {formatDate(c.movement.post_date)} · {c.movement.counterparty_name ?? 'Sin contraparte'}{c.sameCounterparty && ' (mismo RUT)'} · {accountLabel(bank.accountById.get(c.movement.account_id))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Money minor={Math.abs(c.movement.amount)} currency={c.movement.currency} className="text-sm font-medium text-ink" />
                    <Button size="sm" onClick={() => pickMovement(c.movement)}>Usar</Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

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
