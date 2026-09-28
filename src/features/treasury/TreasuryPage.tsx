import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { useDocuments, usePayments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { DocumentRow } from '../../data'
import { addDays, formatDate } from '../../domain/dates'
import { AGING_LABEL, agingBucket, documentTypeLabel, type AgingBucket } from '../../domain/documents'
import { CURRENCIES, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { PageHeader, StatCard } from '../../ui'
import { Money, MoneyTotals, StatusBadge } from '../shared'

const BUCKETS: AgingBucket[] = ['al_dia', '1_30', '31_60', '61_90', 'mas_90']

function AgingTable({ title, docs, currency, to }: { title: string; docs: DocumentRow[]; currency: Currency; to: string }) {
  const inCurrency = docs.filter((d) => d.currency === currency && d.pending_amount > 0)
  const totals = BUCKETS.map((b) => inCurrency.filter((d) => agingBucket(d.days_overdue) === b).reduce((s, d) => s + d.pending_amount, 0))
  const total = totals.reduce((s, v) => s + v, 0)
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
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

  const horizon = addDays(today, 30)
  const upcoming = [...openRec.map((d) => ({ d, sign: 1 })), ...openPay.map((d) => ({ d, sign: -1 }))]
    .filter(({ d }) => d.due_date && d.due_date <= horizon)
    .sort((a, b) => (a.d.due_date ?? '').localeCompare(b.d.due_date ?? ''))
    .slice(0, 12)

  const month = today.slice(0, 7)
  const inMonth = sumByCurrency((paymentsIn.data ?? []).filter((p) => p.paid_on.startsWith(month)), (p) => ({ currency: p.currency, amount: p.amount }))
  const outMonth = sumByCurrency((paymentsOut.data ?? []).filter((p) => p.paid_on.startsWith(month)), (p) => ({ currency: p.currency, amount: p.amount }))

  const currencies = CURRENCIES.filter((c) => recTotals[c] || payTotals[c])
  const main = currencies.includes(tenant.base_currency) ? tenant.base_currency : currencies[0] ?? tenant.base_currency

  return (
    <div>
      <PageHeader title="Tesorería" />
      <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Por cobrar" value={<MoneyTotals totals={recTotals} empty="$0" />} detail={<>Vencido: <MoneyTotals totals={overdueRec} empty="$0" /></>} />
        <StatCard label="Por pagar" value={<MoneyTotals totals={payTotals} empty="$0" />} detail={<>Vencido: <MoneyTotals totals={overduePay} empty="$0" /></>} />
        <StatCard label="Posición neta" value={<MoneyTotals totals={netTotals} empty="$0" />} detail="Por cobrar menos por pagar, por moneda" />
        <StatCard
          label="Flujo del mes"
          value={<MoneyTotals totals={Object.fromEntries(CURRENCIES.filter((c) => inMonth[c] || outMonth[c]).map((c) => [c, (inMonth[c] ?? 0) - (outMonth[c] ?? 0)]))} empty="$0" />}
          detail="Cobros menos pagos registrados este mes"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgingTable title={`Antigüedad por cobrar · ${main}`} docs={receivables.data ?? []} currency={main} to="/cxc/documentos" />
        <AgingTable title={`Antigüedad por pagar · ${main}`} docs={payables.data ?? []} currency={main} to="/cxp/documentos" />
      </div>

      <section className="mt-4 rounded-lg border border-line bg-white">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Próximos 30 días</h2>
          <p className="text-xs text-muted">Incluye documentos vencidos pendientes</p>
        </div>
        {upcoming.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-faint">Nada por vencer en los próximos 30 días.</p>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map(({ d, sign }) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <span className="w-24 shrink-0 text-muted">{formatDate(d.due_date)}</span>
                <span className={clsx('w-20 shrink-0 text-xs font-medium', sign > 0 ? 'text-ok' : 'text-bad')}>{sign > 0 ? 'Cobro' : 'Pago'}</span>
                <span className="min-w-0 flex-1 truncate text-ink/85">
                  {d.counterparty_name} <span className="text-faint">· {documentTypeLabel(d.doc_type)} N° {d.folio}</span>
                </span>
                <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />
                <Money minor={sign * d.pending_amount} currency={d.currency} className={clsx('w-36 text-right font-medium', sign > 0 ? 'text-ok' : 'text-ink')} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
