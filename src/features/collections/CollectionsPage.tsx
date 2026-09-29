// Cuentas por cobrar › Cobranza › Cartera: clientes con deuda, antigüedad, promesas y última gestión.
import { CalendarClock, Download, Mail, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useCollectionEvents, useCollectionMutations, useCounterparties, useDocuments, useEmailLog, useMembers, usePayments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { formatDate, formatTimestampDate } from '../../domain/dates'
import { CURRENCY_DECIMALS, formatMoney, sumByCurrency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { csvAmount, downloadCsv, type CsvColumn } from '../../lib/csv'
import { Badge, cn, EmptyState, FormError, PageHeader, StatCard } from '../../ui'
import { BulkButton, ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { sectionTabs } from '../documents/DocumentsPage'
import { errorMessage, MoneyTotals } from '../shared'
import { ACCOUNT_STATUS, AGE_BUCKETS, buildAccounts, type AccountStatus, type CollectionAccount } from './collectionData'

export function CollectionsNav() {
  const item = ({ isActive }: { isActive: boolean }) =>
    cn('rounded-md px-3 py-1.5 text-[13px]', isActive ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')
  return (
    <nav className="inline-flex rounded-lg bg-subtle p-0.5" aria-label="Cobranza">
      <NavLink to="/cxc/cobranza" end className={item}>Cartera</NavLink>
      <NavLink to="/cxc/cobranza/recordatorios" className={item}>Recordatorios</NavLink>
    </nav>
  )
}

/** Barra apilada de antigüedad de la deuda (moneda base). */
export function AgingBar({ account, className }: { account: Pick<CollectionAccount, 'buckets'>; className?: string }) {
  const total = AGE_BUCKETS.reduce((s, b) => s + account.buckets[b.key], 0)
  if (!total) return <span className="text-faint">—</span>
  return (
    <span className={cn('flex h-2 w-32 overflow-hidden rounded-full bg-subtle', className)} title={AGE_BUCKETS.filter((b) => account.buckets[b.key]).map((b) => `${b.label}: ${formatMoney(account.buckets[b.key], 'CLP')}`).join(' · ')}>
      {AGE_BUCKETS.map((b) => (account.buckets[b.key] ? <span key={b.key} style={{ width: `${(account.buckets[b.key] / total) * 100}%`, background: b.color }} /> : null))}
    </span>
  )
}

export function useCollectionAccounts() {
  const { tenant } = useCurrentTenant()
  const counterparties = useCounterparties()
  const documents = useDocuments('receivable')
  const events = useCollectionEvents()
  const emails = useEmailLog()
  const accounts = useMemo(
    () => buildAccounts({ counterparties: counterparties.data ?? [], documents: documents.data ?? [], events: events.data ?? [], emails: emails.data ?? [], baseCurrency: tenant.base_currency }),
    [counterparties.data, documents.data, events.data, emails.data, tenant.base_currency],
  )
  return { accounts, loading: counterparties.isLoading || documents.isLoading }
}

export function CollectionsPage() {
  const { tenant, canWrite, today } = useCurrentTenant()
  const navigate = useNavigate()
  const { accounts, loading } = useCollectionAccounts()
  const members = useMembers()
  const paymentsIn = usePayments('in')
  const collections = useCollectionMutations()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const withDebt = accounts.filter((a) => a.open.length)
  const allOpen = withDebt.flatMap((a) => a.open)
  const overdueDocs = allOpen.filter((d) => d.days_overdue > 0)
  const pick = (d: { currency: typeof tenant.base_currency; pending_amount: number }) => ({ currency: d.currency, amount: d.pending_amount })
  const promises = withDebt.map((a) => a.nextPromise).filter(Boolean)
  const month = today.slice(0, 7)
  const collected = sumByCurrency((paymentsIn.data ?? []).filter((p) => p.status === 'confirmed' && p.paid_on.startsWith(month)), (p) => ({ currency: p.currency, amount: p.amount }))
  const base = tenant.base_currency
  const baseOpen = allOpen.filter((d) => d.currency === base).reduce((s, d) => s + d.pending_amount, 0)
  const baseOverdue = overdueDocs.filter((d) => d.currency === base).reduce((s, d) => s + d.pending_amount, 0)
  const memberName = (id: string | null | undefined) => {
    const m = (members.data ?? []).find((x) => x.user_id === id)
    return m ? m.full_name || m.email || '—' : null
  }

  const columns: ListColumn<CollectionAccount>[] = [
    {
      key: 'cp',
      header: 'Cliente',
      cell: (a) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-medium text-ink">{a.counterparty.name}</span>
          <span className="text-xs text-faint">{a.counterparty.tax_id ? formatTaxId(a.counterparty.tax_id, (a.counterparty.country as Country) ?? tenant.country) : '—'}{memberName(a.counterparty.collection_owner) ? ` · ${memberName(a.counterparty.collection_owner)}` : ''}</span>
        </span>
      ),
      sortValue: (a) => a.counterparty.name,
      className: 'min-w-52',
    },
    { key: 'pending', header: 'Deuda total', align: 'right', cell: (a) => <MoneyTotals totals={a.pending} empty="—" />, sortValue: (a) => a.pending[base] ?? 0 },
    { key: 'overdue', header: 'Vencido', align: 'right', cell: (a) => (a.overdue[base] || Object.keys(a.overdue).length ? <span className="font-semibold text-bad"><MoneyTotals totals={a.overdue} empty="—" /></span> : <span className="text-faint">—</span>), sortValue: (a) => a.overdue[base] ?? 0 },
    { key: 'aging', mobileHidden: true, header: 'Antigüedad', cell: (a) => <AgingBar account={a} />, sortValue: (a) => a.maxDaysOverdue },
    { key: 'days', header: 'Máx. atraso', align: 'right', cell: (a) => (a.maxDaysOverdue ? <span className={cn('tabular', a.maxDaysOverdue > 60 ? 'font-semibold text-bad' : 'text-ink')}>{a.maxDaysOverdue} d</span> : <span className="text-faint">—</span>), sortValue: (a) => a.maxDaysOverdue },
    {
      key: 'next',
      mobileHidden: true,
      header: 'Próxima acción',
      cell: (a) =>
        a.nextPromise ? (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink">
            <CalendarClock size={14} className={a.nextPromise.promised_date! < today ? 'text-bad' : 'text-brand-600'} />
            Promesa {formatDate(a.nextPromise.promised_date)}
            {a.nextPromise.promised_amount ? <span className="text-faint">· {formatMoney(a.nextPromise.promised_amount, a.nextPromise.currency ?? base)}</span> : null}
          </span>
        ) : a.lastActivityAt ? (
          <span className="text-muted">Última gestión {formatTimestampDate(a.lastActivityAt, tenant.timezone)}</span>
        ) : (
          <span className="text-faint">Sin gestiones</span>
        ),
      sortValue: (a) => a.nextPromise?.promised_date ?? a.lastActivityAt ?? '',
    },
    { key: 'status', mobileBadge: true, header: 'Estado', cell: (a) => <Badge tone={ACCOUNT_STATUS[a.status].tone}>{ACCOUNT_STATUS[a.status].label}</Badge>, sortValue: (a) => a.status },
  ]

  const tags = [...new Set(accounts.flatMap((a) => a.counterparty.tags))].sort()
  const owners = [...new Set(accounts.map((a) => a.counterparty.collection_owner).filter(Boolean) as string[])]
  const filters: ListFilter<CollectionAccount>[] = [
    {
      type: 'select',
      key: 'debt',
      label: 'Deuda',
      options: [{ value: 'con', label: 'Con deuda' }, { value: 'vencida', label: 'Con deuda vencida' }, { value: 'd30', label: 'Atraso de más de 30 días' }, { value: 'd90', label: 'Atraso de más de 90 días' }, { value: 'sin', label: 'Sin deuda' }],
      defaultValue: 'con',
      match: (a, v) => (v === 'con' ? a.open.length > 0 : v === 'vencida' ? a.overdueCount > 0 : v === 'd30' ? a.maxDaysOverdue > 30 : v === 'd90' ? a.maxDaysOverdue > 90 : a.open.length === 0),
    },
    { type: 'select', key: 'status', label: 'Estado', options: (Object.keys(ACCOUNT_STATUS) as AccountStatus[]).map((k) => ({ value: k, label: ACCOUNT_STATUS[k].label })), match: (a, v) => a.status === v },
    { type: 'select', key: 'owner', label: 'Responsable', options: [{ value: 'none', label: 'Sin responsable' }, ...owners.map((id) => ({ value: id, label: memberName(id) ?? '—' }))], match: (a, v) => (v === 'none' ? !a.counterparty.collection_owner : a.counterparty.collection_owner === v) },
    { type: 'select', key: 'tag', label: 'Etiqueta', options: tags.map((t) => ({ value: t, label: t })), match: (a, v) => a.counterparty.tags.includes(v) },
  ]
  const list = useListState({
    rows: accounts,
    rowKey: (a) => a.counterparty.id,
    columns,
    filters,
    searchText: (a) => `${a.counterparty.name} ${a.counterparty.legal_name ?? ''} ${a.counterparty.tax_id ?? ''} ${(a.counterparty.tax_id ?? '').replace(/\W/g, '')}`,
    storageKey: 'collections-portfolio',
    defaultSort: { key: 'overdue', dir: 'desc' },
  })
  const csv: CsvColumn<CollectionAccount>[] = [
    { header: 'Cliente', value: (a) => a.counterparty.name },
    { header: 'RUT / RUC', value: (a) => a.counterparty.tax_id ?? '' },
    { header: `Deuda total ${base}`, value: (a) => csvAmount(a.pending[base] ?? 0, CURRENCY_DECIMALS[base]) },
    { header: `Vencido ${base}`, value: (a) => csvAmount(a.overdue[base] ?? 0, CURRENCY_DECIMALS[base]) },
    ...AGE_BUCKETS.map((b) => ({ header: `${b.label} ${base}`, value: (a: CollectionAccount) => csvAmount(a.buckets[b.key], CURRENCY_DECIMALS[base]) })),
    { header: 'Máx. días de atraso', value: (a) => a.maxDaysOverdue },
    { header: 'Estado', value: (a) => ACCOUNT_STATUS[a.status].label },
    { header: 'Promesa', value: (a) => a.nextPromise?.promised_date ?? '' },
  ]

  async function sendStatements(rows: CollectionAccount[]) {
    const targets = rows.filter((a) => a.open.length)
    if (!targets.length) return setError('Ninguno de los clientes seleccionados tiene deuda.')
    if (!window.confirm(`¿Enviar el estado de cuenta a ${targets.length} ${targets.length === 1 ? 'cliente' : 'clientes'}?`)) return
    setError(null)
    setNotice(null)
    let sent = 0
    for (const a of targets) {
      try {
        await collections.sendEmail.mutateAsync({ counterpartyId: a.counterparty.id })
        sent++
      } catch (err) {
        setError(`${a.counterparty.name}: ${errorMessage(err)}`)
      }
    }
    if (sent) setNotice(`Estado de cuenta enviado a ${sent} ${sent === 1 ? 'cliente' : 'clientes'}. Revisa el detalle en Configuración › Notificaciones.`)
    list.clearSelection()
  }

  return (
    <div>
      <PageHeader title="Cuentas por cobrar" tabs={sectionTabs('receivable')} />
      <div className="flex flex-wrap items-center justify-between gap-3 pt-5">
        <CollectionsNav />
      </div>
      <div className="stat-row pt-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Cartera por cobrar" value={<MoneyTotals totals={sumByCurrency(allOpen, pick)} empty="$0" />} detail={`${withDebt.length} clientes`} />
        <StatCard
          label="Vencido"
          tone={overdueDocs.length ? 'bad' : undefined}
          value={<MoneyTotals totals={sumByCurrency(overdueDocs, pick)} empty="$0" />}
          detail={baseOpen ? `${Math.round((baseOverdue / baseOpen) * 100)}% de la cartera` : undefined}
        />
        <StatCard label="Promesas de pago" hint="Promesas vigentes registradas en la actividad de cada cliente" value={String(promises.length)} detail={promises.length ? `próxima ${formatDate(promises.map((p) => p!.promised_date!).sort()[0])}` : 'sin promesas'} />
        <StatCard label="Cobrado este mes" tone="ok" value={<MoneyTotals totals={collected} empty="$0" />} />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <FormError error={error} />
        {notice && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">{notice}</p>}
        <ListView
          state={list}
          columns={columns}
          rowKey={(a) => a.counterparty.id}
          filters={filters}
          loading={loading}
          searchPlaceholder="Buscar cliente o RUT…"
          onRowClick={(a) => navigate(`/cxc/cobranza/${a.counterparty.id}`)}
          toolbarExtra={
            <button type="button" onClick={() => downloadCsv('cartera-cobranza.csv', list.filtered, csv)} disabled={!list.total} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-white px-2.5 text-[12px] text-ink hover:bg-subtle disabled:opacity-50">
              <Download size={14} /> Exportar
            </button>
          }
          bulkActions={(rows) => (
            <>
              <BulkButton onClick={() => downloadCsv('cartera-seleccion.csv', rows, csv)}><Download size={15} /> Exportar</BulkButton>
              {canWrite && <BulkButton onClick={() => sendStatements(rows)}><Mail size={15} /> Enviar estado de cuenta</BulkButton>}
            </>
          )}
          rowActions={(a) =>
            canWrite && a.open.length ? (
              <RowAction label="Enviar estado de cuenta" onClick={() => sendStatements([a])}><Mail size={16} /></RowAction>
            ) : null
          }
          empty={<EmptyState icon={<Users size={20} />} title="Sin clientes para estos filtros" description="Cuando registres documentos por cobrar, aquí verás la deuda de cada cliente." />}
        />
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
          {AGE_BUCKETS.map((b) => (
            <span key={b.key} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: b.color }} />{b.label}</span>
          ))}
          <span>Antigüedad en {base}.</span>
        </p>
      </div>
    </div>
  )
}
