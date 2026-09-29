import clsx from 'clsx'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDocuments, usePayments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentRow } from '../../data'
import { addDays, formatDate } from '../../domain/dates'
import { AGING_LABEL, agingBucket, documentTypeLabel, type AgingBucket } from '../../domain/documents'
import { CURRENCIES, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { EmptyState, PageHeader, StatCard } from '../../ui'
import { ListView, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { Money, MoneyTotals, StatusBadge } from '../shared'

const BUCKETS: AgingBucket[] = ['al_dia', '1_30', '31_60', '61_90', 'mas_90']

function AgingTable({ title, docs, currency, to }: { title: string; docs: DocumentRow[]; currency: Currency; to: string }) {
  const inCurrency = docs.filter((d) => d.currency === currency && d.pending_amount > 0)
  const totals = BUCKETS.map((b) => inCurrency.filter((d) => agingBucket(d.days_overdue) === b).reduce((s, d) => s + d.pending_amount, 0))
  const total = totals.reduce((s, v) => s + v, 0)
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        <Link to={to} className="text-sm text-brand-600 hover:underline">Ver documentos</Link>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {BUCKETS.map((b, i) => (
          <div key={b} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-muted">{AGING_LABEL[b]}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-subtle">
              <div
                className={clsx('h-full rounded-full', b === 'al_dia' ? 'bg-brand-500' : b === '1_30' ? 'bg-warn/70' : 'bg-bad/80')}
                style={{ width: total ? `${(totals[i] / total) * 100}%` : 0 }}
              />
            </div>
            <span className="w-36 shrink-0 text-right tabular text-ink">{formatMoney(totals[i], currency)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-line pt-3 text-sm font-medium">
          <span>Total</span>
          <Money minor={total} currency={currency} />
        </div>
      </div>
    </section>
  )
}

/** Monto en la moneda principal para textos cortos (ej. "Vencido $1.234"). */
function shortTotal(totals: Partial<Record<Currency, number>>, main: Currency) {
  const value = totals[main] ?? 0
  const others = Object.keys(totals).filter((c) => c !== main && totals[c as Currency]).length
  return `${formatMoney(value, main)}${others ? ` +${others}` : ''}`
}

export function TreasuryPage() {
  const { tenant, today } = useCurrentTenant()
  const payables = useDocuments('payable')
  const receivables = useDocuments('receivable')
  const paymentsOut = usePayments('out')
  const paymentsIn = usePayments('in')

  const openPay = (payables.data ?? []).filter((d) => d.pending_amount > 0)
  const openRec = (receivables.data ?? []).filter((d) => d.pending_amount > 0)
  const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })
  const recTotals = sumByCurrency(openRec, pick)
  const payTotals = sumByCurrency(openPay, pick)
  const netTotals: Partial<Record<Currency, number>> = {}
  for (const c of CURRENCIES) {
    const v = (recTotals[c] ?? 0) - (payTotals[c] ?? 0)
    if (recTotals[c] || payTotals[c]) netTotals[c] = v
  }
  const overdueRec = sumByCurrency(openRec.filter((d) => d.payment_status === 'vencido'), pick)
  const overduePay = sumByCurrency(openPay.filter((d) => d.payment_status === 'vencido'), pick)

  const month = today.slice(0, 7)
  const inMonth = sumByCurrency((paymentsIn.data ?? []).filter((p) => p.paid_on.startsWith(month)), (p) => ({ currency: p.currency, amount: p.amount }))
  const outMonth = sumByCurrency((paymentsOut.data ?? []).filter((p) => p.paid_on.startsWith(month)), (p) => ({ currency: p.currency, amount: p.amount }))

  const currencies = CURRENCIES.filter((c) => recTotals[c] || payTotals[c])
  const main = currencies.includes(tenant.base_currency) ? tenant.base_currency : currencies[0] ?? tenant.base_currency

  return (
    <div>
      <PageHeader title="Tesorería" />
      <div className="stat-row py-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Por cobrar" value={<MoneyTotals totals={recTotals} empty="$0" />} detail={`Vencido ${shortTotal(overdueRec, main)}`} />
        <StatCard label="Por pagar" value={<MoneyTotals totals={payTotals} empty="$0" />} detail={`Vencido ${shortTotal(overduePay, main)}`} />
        <StatCard label="Posición neta" hint="Por cobrar menos por pagar, por moneda" value={<MoneyTotals totals={netTotals} empty="$0" />} />
        <StatCard
          label="Flujo del mes"
          hint="Cobros menos pagos registrados este mes"
          value={<MoneyTotals totals={Object.fromEntries(CURRENCIES.filter((c) => inMonth[c] || outMonth[c]).map((c) => [c, (inMonth[c] ?? 0) - (outMonth[c] ?? 0)]))} empty="$0" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgingTable title={`Antigüedad por cobrar · ${main}`} docs={receivables.data ?? []} currency={main} to="/cxc/documentos" />
        <AgingTable title={`Antigüedad por pagar · ${main}`} docs={payables.data ?? []} currency={main} to="/cxp/documentos" />
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-[14px] font-semibold text-ink">Vencimientos</h2>
        <DueList receivables={openRec} payables={openPay} today={today} loading={payables.isLoading || receivables.isLoading} />
      </section>
    </div>
  )
}

interface DueRow {
  doc: DocumentRow
  kind: 'cobro' | 'pago'
}

function DueList({ receivables, payables, today, loading }: { receivables: DocumentRow[]; payables: DocumentRow[]; today: string; loading: boolean }) {
  const navigate = useNavigate()
  const rows = useMemo<DueRow[]>(
    () => [...receivables.map((doc) => ({ doc, kind: 'cobro' as const })), ...payables.map((doc) => ({ doc, kind: 'pago' as const }))],
    [receivables, payables],
  )
  const columns: ListColumn<DueRow>[] = [
    { key: 'cp', header: 'Contraparte', cell: (r) => r.doc.counterparty_name, sortValue: (r) => r.doc.counterparty_name, className: 'min-w-48' },
    { key: 'kind', header: 'Tipo', cell: (r) => (r.kind === 'cobro' ? <span className="font-medium text-ok">Por cobrar</span> : <span className="font-medium text-ink">Por pagar</span>), sortValue: (r) => r.kind },
    { key: 'doc', header: 'Documento', cell: (r) => <span className="flex flex-col leading-tight"><span className="font-medium text-ink">N° {r.doc.folio}</span><span className="text-xs text-faint">{documentTypeLabel(r.doc.doc_type)}</span></span>, sortValue: (r) => r.doc.folio },
    { key: 'due', header: 'Vencimiento', cell: (r) => formatDate(r.doc.due_date), sortValue: (r) => r.doc.due_date },
    { key: 'scheduled', header: 'Pago agendado', cell: (r) => (r.doc.scheduled_payment_date ? formatDate(r.doc.scheduled_payment_date) : <span className="text-faint">—</span>), sortValue: (r) => r.doc.scheduled_payment_date },
    { key: 'status', mobileBadge: true, header: 'Estado', cell: (r) => <StatusBadge status={r.doc.payment_status} daysOverdue={r.doc.days_overdue} />, sortValue: (r) => r.doc.days_overdue },
    {
      key: 'amount',
      header: 'Saldo',
      align: 'right',
      cell: (r) => <Money minor={(r.kind === 'cobro' ? 1 : -1) * r.doc.pending_amount} currency={r.doc.currency} className={clsx('font-semibold', r.kind === 'cobro' ? 'text-ok' : 'text-ink')} />,
      sortValue: (r) => (r.kind === 'cobro' ? 1 : -1) * r.doc.pending_amount,
    },
  ]
  const filters: ListFilter<DueRow>[] = [
    {
      type: 'select',
      key: 'horizon',
      label: 'Horizonte',
      options: [
        { value: 'vencidos', label: 'Solo vencidos' },
        { value: '7', label: 'Próximos 7 días (incluye vencidos)' },
        { value: '30', label: 'Próximos 30 días (incluye vencidos)' },
        { value: '90', label: 'Próximos 90 días (incluye vencidos)' },
      ],
      defaultValue: '30',
      match: (r, v) => {
        if (v === 'vencidos') return r.doc.payment_status === 'vencido'
        const limit = addDays(today, Number(v))
        const date = r.doc.scheduled_payment_date ?? r.doc.due_date
        return (!!r.doc.due_date && r.doc.due_date <= limit) || (!!date && date <= limit)
      },
    },
    { type: 'select', key: 'kind', label: 'Tipo', options: [{ value: 'cobro', label: 'Por cobrar' }, { value: 'pago', label: 'Por pagar' }], match: (r, v) => r.kind === v },
    { type: 'select', key: 'currency', label: 'Moneda', options: [...new Set(rows.map((r) => r.doc.currency))].map((c) => ({ value: c, label: c })), match: (r, v) => r.doc.currency === v },
  ]
  const list = useListState({
    rows,
    rowKey: (r) => r.doc.id,
    columns,
    filters,
    searchText: (r) => `${r.doc.counterparty_name} ${r.doc.folio}`,
    storageKey: 'treasury-due',
    defaultSort: { key: 'due', dir: 'asc' },
  })
  return (
    <ListView
      state={list}
      columns={columns}
      rowKey={(r) => r.doc.id}
      filters={filters}
      loading={loading}
      searchPlaceholder="Buscar contraparte o folio…"
      onRowClick={(r) => navigate(r.kind === 'cobro' ? '/cxc/documentos' : '/cxp/documentos')}
      empty={<EmptyState title="Nada por vencer en este horizonte" description="Amplía el horizonte o limpia los filtros." />}
    />
  )
}
