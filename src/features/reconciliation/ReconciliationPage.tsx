// Conciliación bancaria: cartolas de las cuentas de la empresa (Fintoc o importadas en Excel/CSV) conciliadas contra
// los pagos (CxP) y cobros (CxC). Cada movimiento queda conciliado, ignorado o por conciliar.
import clsx from 'clsx'
import { ArrowDownLeft, ArrowUpRight, CheckCheck, ChevronDown, EllipsisVertical, FileSpreadsheet, Landmark, Link2, Plus, RefreshCw, Sparkles, Undo2, Unplug, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useBankConnections, useBankFeedAccounts, useBankMovements, useBankMutations, useCounterparties, useDocuments, usePaymentMethods, usePayments,
} from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api, type BankConnection, type BankFeedAccount, type BankMovement, type Counterparty, type DocumentRow, type Payment } from '../../data'
import { formatDate, formatTimestamp } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { sumByCurrency } from '../../domain/money'
import { formatTaxId } from '../../domain/taxId'
import { openMovementsWidget } from '../../lib/fintocWidget'
import { Badge, Button, Drawer, EmptyState, FormError, Input, PageHeader, Select, StatCard, type Tone } from '../../ui'
import { BulkButton, ListView, RowMenu, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage, minorToInput, Money, MoneyTotals, parseMoneyInput } from '../shared'
import { BankLogo } from './BankLogo'
import { CounterpartyCombobox } from '../CounterpartyCombobox'
import { ReconcileManyDrawer } from './ReconcileManyDrawer'
import { AccountDrawer, BalanceDrawer, ImportDrawer, ImportsDrawer, MovementFormDrawer } from './ManualAccounts'
import { manualAccountBalance } from './balances'
import { allocateFifo, counterpartyFor, isAutomatic, movementDirection, openDocumentsFor, paymentCandidates, suggest, type MatchContext, type Suggestion } from './matching'

const STALE_MS = 6 * 60 * 60 * 1000
const IGNORE_REASONS = ['Comisión o cargo bancario', 'Traspaso entre cuentas propias', 'Impuestos', 'Remuneraciones', 'Préstamo o inversión']

type Institution = { id: string | null | undefined; name: string | null | undefined }
type Row = BankMovement & { suggestion: Suggestion; account: BankFeedAccount | undefined; connection: BankConnection | undefined; institution: Institution }

/** Banco de la cuenta: el de la conexión de Fintoc o el elegido en la cuenta manual. */
export const institutionOf = (a: BankFeedAccount | undefined, c: BankConnection | undefined): Institution =>
  a?.source === 'manual' ? { id: a.institution_id, name: a.institution_name } : { id: c?.institution_id, name: c?.institution_name }

const STATUS: Record<BankMovement['reconciliation_status'], { label: string; tone: Tone }> = {
  pending: { label: 'Por conciliar', tone: 'warn' },
  reconciled: { label: 'Conciliado', tone: 'ok' },
  ignored: { label: 'Ignorado', tone: 'neutral' },
}

function suggestionLabel(s: Suggestion): { label: string; tone: Tone } | null {
  if (s.kind === 'payment') return { label: `Coincide con ${s.candidate.payment.direction === 'in' ? 'un cobro' : 'un pago'}`, tone: 'info' }
  if (s.kind === 'documents' && s.exact) return { label: s.documents.length === 1 ? 'Calza con un documento' : `Calza con ${s.documents.length} documentos`, tone: 'info' }
  if (s.kind === 'documents') return { label: 'Contraparte con documentos abiertos', tone: 'neutral' }
  return null
}

const accountLabel = (a: BankFeedAccount | undefined) => (a ? `${a.name ?? 'Cuenta'} ···${(a.number ?? '').slice(-4)}` : '—')

export function ReconciliationPage() {
  const { tenant, today, canWrite, canAdmin, hasModule } = useCurrentTenant()
  const connections = useBankConnections()
  const accounts = useBankFeedAccounts()
  const movements = useBankMovements()
  const counterparties = useCounterparties()
  const payIn = usePayments('in')
  const payOut = usePayments('out')
  const docsIn = useDocuments('receivable')
  const docsOut = useDocuments('payable')
  const bank = useBankMutations()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [accountDrawer, setAccountDrawer] = useState<BankFeedAccount | 'new' | null>(null)
  const [importFor, setImportFor] = useState<string | 'any' | null>(null)
  const [historyFor, setHistoryFor] = useState<BankFeedAccount | null>(null)
  const [movementForm, setMovementForm] = useState<{ movement: BankMovement | null; accountId: string | null } | null>(null)
  const [balanceFor, setBalanceFor] = useState<BankFeedAccount | null>(null)
  const [manyRows, setManyRows] = useState<Row[] | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const bankAccounts = (accounts.data ?? []).filter((a) => !a.removed)
  const manualAccounts = bankAccounts.filter((a) => a.source === 'manual')
  const deleteAccount = async (a: BankFeedAccount) => {
    const count = (movements.data ?? []).filter((m) => m.account_id === a.id).length
    if (!confirm(`¿Eliminar la cuenta ${a.institution_name} · ${a.name}? Se borran sus ${count} movimientos importados. Los pagos y cobros ya registrados se mantienen.`)) return
    setError(null)
    try {
      await bank.deleteAccount.mutateAsync(a.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const active = (connections.data ?? []).filter((c) => c.status !== 'disconnected')
  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data])
  const connectionById = useMemo(() => new Map((connections.data ?? []).map((c) => [c.id, c])), [connections.data])

  const ctx: MatchContext = useMemo(() => {
    const all = movements.data ?? []
    return {
      counterparties: counterparties.data ?? [],
      payments: [...(hasModule('cuentas_por_cobrar') ? payIn.data ?? [] : []), ...(hasModule('cuentas_por_pagar') ? payOut.data ?? [] : [])],
      documents: [...(hasModule('cuentas_por_cobrar') ? docsIn.data ?? [] : []), ...(hasModule('cuentas_por_pagar') ? docsOut.data ?? [] : [])],
      linkedPaymentIds: new Set(all.map((m) => m.payment_id).filter((id): id is string => !!id)),
    }
  }, [movements.data, counterparties.data, payIn.data, payOut.data, docsIn.data, docsOut.data, hasModule])

  const rows: Row[] = useMemo(
    () =>
      (movements.data ?? []).map((m) => ({
        ...m,
        account: accountById.get(m.account_id),
        connection: connectionById.get(accountById.get(m.account_id)?.connection_id ?? ''),
        institution: institutionOf(accountById.get(m.account_id), connectionById.get(accountById.get(m.account_id)?.connection_id ?? '')),
        suggestion: m.reconciliation_status === 'pending' ? suggest(m, ctx) : { kind: 'none' as const },
      })),
    [movements.data, accountById, connectionById, ctx],
  )

  // Sincroniza al entrar si la última actualización tiene más de 6 horas.
  const autoSynced = useRef(false)
  useEffect(() => {
    if (autoSynced.current || !canWrite || !active.length) return
    const last = Math.max(...active.map((c) => (c.last_sync_at ? new Date(c.last_sync_at).getTime() : 0)))
    if (Date.now() - last < STALE_MS) return
    autoSynced.current = true
    bank.sync.mutate()
  }, [active, canWrite, bank.sync])

  const connect = async () => {
    setError(null)
    setNotice(null)
    setConnecting(true)
    try {
      const { publicKey, widgetToken } = await bank.start.mutateAsync()
      // En modo demo no hay widget: se simula la conexión.
      const exchangeToken = api.mode === 'demo' ? 'demo' : await openMovementsWidget({ publicKey, widgetToken })
      if (!exchangeToken) return
      const r = await bank.exchange.mutateAsync(exchangeToken)
      setNotice(`Banco conectado. Trajimos ${r.fetched} movimientos.`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setConnecting(false)
    }
  }
  const sync = async () => {
    setError(null)
    setNotice(null)
    try {
      const r = await bank.sync.mutateAsync()
      setNotice(r.errors.length ? `Actualizado con avisos: ${r.errors.join(' · ')}` : `Cartolas actualizadas (${r.fetched} movimientos nuevos o modificados).`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const disconnect = async (c: BankConnection) => {
    if (!confirm(`¿Desconectar ${c.institution_name ?? 'el banco'}? Los movimientos ya traídos y sus conciliaciones se conservan.`)) return
    try {
      await bank.disconnect.mutateAsync(c.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  // Conciliación automática: solo las sugerencias sin ambigüedad.
  const [autoRunning, setAutoRunning] = useState(false)
  const runAutomatic = async (targets: Row[]) => {
    const auto = targets.filter((r) => r.reconciliation_status === 'pending' && isAutomatic(r.suggestion))
    if (!auto.length) return setNotice('No hay movimientos con una coincidencia exacta para conciliar automáticamente.')
    if (!confirm(`¿Conciliar ${auto.length} movimientos con su coincidencia exacta?`)) return
    setAutoRunning(true)
    setError(null)
    let ok = 0
    const failed: string[] = []
    for (const r of auto) {
      try {
        const s = r.suggestion
        if (s.kind === 'payment') await bank.reconcile.mutateAsync({ movementId: r.id, paymentId: s.candidate.payment.id })
        else if (s.kind === 'documents') {
          await bank.createPayment.mutateAsync({
            movementId: r.id,
            input: { counterparty_id: s.counterparty.id, method: '', notes: null, allocations: s.documents.map((d) => ({ document_id: d.id, amount: d.pending_amount })) },
          })
        }
        ok++
      } catch (e) {
        failed.push(`${r.description ?? formatDate(r.post_date)}: ${errorMessage(e)}`)
      }
    }
    setAutoRunning(false)
    setNotice(`${ok} movimientos conciliados.`)
    if (failed.length) setError(failed.join('\n'))
  }

  const columns: ListColumn<Row>[] = [
    { key: 'date', header: 'Fecha', sortValue: (r) => r.post_date, cell: (r) => <span className="whitespace-nowrap">{formatDate(r.post_date)}</span> },
    {
      key: 'description', header: 'Movimiento', sortValue: (r) => (r.description ?? '').toLowerCase(),
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-full', r.amount > 0 ? 'bg-ok-bg text-ok' : 'bg-subtle text-muted')}>
            {r.amount > 0 ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{r.description || (r.amount > 0 ? 'Abono' : 'Cargo')}</div>
            <div className="truncate text-xs text-faint">
              {r.counterparty_name ?? 'Sin contraparte'}
              {r.counterparty_tax_id && ` · ${formatTaxId(r.counterparty_tax_id, 'CL')}`}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'account', header: 'Cuenta', mobileHidden: true,
      cell: (r) => (
        <span className="flex items-center gap-2 text-sm whitespace-nowrap text-muted" title={r.institution.name ?? undefined}>
          <BankLogo id={r.institution.id} name={r.institution.name} size={20} />
          {accountLabel(r.account)}
        </span>
      ),
    },
    {
      key: 'amount', header: 'Monto', align: 'right', sortValue: (r) => r.amount,
      cell: (r) => <Money minor={r.amount} currency={r.currency} className={clsx('font-medium', r.amount > 0 ? 'text-ok' : 'text-ink')} />,
    },
    {
      key: 'status', header: 'Estado', mobileBadge: true, sortValue: (r) => r.reconciliation_status,
      cell: (r) => {
        const hint = r.reconciliation_status === 'pending' ? suggestionLabel(r.suggestion) : null
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS[r.reconciliation_status].tone}>{STATUS[r.reconciliation_status].label}</Badge>
            {hint && <span className={clsx('inline-flex items-center gap-1 text-xs', hint.tone === 'info' ? 'text-brand-600' : 'text-faint')}><Sparkles size={12} />{hint.label}</span>}
            {r.bank_status === 'reversed' && <Badge tone="bad">Reversado</Badge>}
          </div>
        )
      },
    },
  ]
  const filters: ListFilter<Row>[] = [
    {
      type: 'select', key: 'status', label: 'Estado', defaultValue: 'pending',
      options: [{ value: 'pending', label: 'Por conciliar' }, { value: 'suggested', label: 'Con sugerencia' }, { value: 'reconciled', label: 'Conciliados' }, { value: 'ignored', label: 'Ignorados' }],
      match: (r, v) => (v === 'suggested' ? r.reconciliation_status === 'pending' && !!suggestionLabel(r.suggestion) : r.reconciliation_status === v),
    },
    { type: 'select', key: 'kind', label: 'Tipo', options: [{ value: 'in', label: 'Abonos' }, { value: 'out', label: 'Cargos' }], match: (r, v) => movementDirection(r) === v },
    { type: 'select', key: 'account', label: 'Cuenta', options: (accounts.data ?? []).map((a) => ({ value: a.id, label: accountLabel(a) })), match: (r, v) => r.account_id === v },
    { type: 'dateRange', key: 'date', label: 'Fecha', getDate: (r) => r.post_date },
  ]
  const list = useListState({
    rows, rowKey: (r) => r.id, columns, filters,
    searchText: (r) => `${r.description ?? ''} ${r.comment ?? ''} ${r.counterparty_name ?? ''} ${r.counterparty_tax_id ?? ''} ${r.reference_id ?? ''} ${Math.abs(r.amount)}`,
    storageKey: 'bank-movements', defaultSort: { key: 'date', dir: 'desc' },
  })

  const pending = rows.filter((r) => r.reconciliation_status === 'pending')
  const month = today.slice(0, 7)
  const reconciledThisMonth = rows.filter((r) => r.reconciliation_status === 'reconciled' && (r.reconciled_at ?? '').startsWith(month))
  const automatic = pending.filter((r) => isAutomatic(r.suggestion))
  const loading = connections.isLoading || movements.isLoading || accounts.isLoading
  const selected = rows.find((r) => r.id === openId) ?? null
  const lastSync = active.map((c) => c.last_sync_at).filter(Boolean).sort().pop() ?? null

  const header = (
    <PageHeader
      title="Conciliación bancaria"
      actions={
        <>
          {active.length > 0 && canWrite && (
            <Button onClick={sync} disabled={bank.sync.isPending}><RefreshCw size={16} className={clsx(bank.sync.isPending && 'animate-spin')} /> {bank.sync.isPending ? 'Actualizando…' : 'Actualizar'}</Button>
          )}
          {canWrite && manualAccounts.length > 0 && (
            <>
              <Button onClick={() => setMovementForm({ movement: null, accountId: null })}><Plus size={16} /> Nuevo movimiento</Button>
              <Button onClick={() => setImportFor('any')}><Upload size={16} /> Importar cartola</Button>
            </>
          )}
          {canAdmin && (
            <div className="relative">
              <Button variant={bankAccounts.length ? 'secondary' : 'primary'} onClick={() => setAddOpen((o) => !o)} disabled={connecting}>
                <Plus size={16} /> {connecting ? 'Conectando…' : 'Agregar cuenta'} <ChevronDown size={14} />
              </Button>
              {addOpen && (
                <div className="absolute top-full right-0 z-30 mt-1 w-80 rounded-lg border border-line bg-white p-1 shadow-xl" onMouseLeave={() => setAddOpen(false)}>
                  {tenant.country === 'CL' && (
                    <button type="button" onClick={() => { setAddOpen(false); connect() }} className="flex w-full gap-3 rounded-md px-3 py-2.5 text-left hover:bg-subtle">
                      <Link2 size={17} className="mt-0.5 shrink-0 text-brand-600" />
                      <span><span className="block text-sm font-medium text-ink">Conectar con Fintoc</span><span className="block text-xs text-muted">Los movimientos llegan solos. Bancos de Chile.</span></span>
                    </button>
                  )}
                  <button type="button" onClick={() => { setAddOpen(false); setAccountDrawer('new') }} className="flex w-full gap-3 rounded-md px-3 py-2.5 text-left hover:bg-subtle">
                    <FileSpreadsheet size={17} className="mt-0.5 shrink-0 text-brand-600" />
                    <span><span className="block text-sm font-medium text-ink">Cuenta manual</span><span className="block text-xs text-muted">Importas la cartola en Excel o CSV. Cualquier banco y moneda.</span></span>
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      }
    />
  )

  const drawers = (
    <>
      {accountDrawer && (
        <AccountDrawer
          account={accountDrawer === 'new' ? null : accountDrawer}
          hasMovements={accountDrawer !== 'new' && (movements.data ?? []).some((m) => m.account_id === accountDrawer.id)}
          onClose={() => setAccountDrawer(null)}
        />
      )}
      {importFor && manualAccounts.length > 0 && <ImportDrawer accounts={manualAccounts} initialAccountId={importFor === 'any' ? null : importFor} onClose={() => setImportFor(null)} />}
      {historyFor && <ImportsDrawer account={historyFor} onClose={() => setHistoryFor(null)} />}
      {movementForm && manualAccounts.length > 0 && (
        <MovementFormDrawer
          key={movementForm.movement?.id ?? 'new'} accounts={manualAccounts} movement={movementForm.movement}
          initialAccountId={movementForm.accountId} onClose={() => setMovementForm(null)}
        />
      )}
      {balanceFor && <BalanceDrawer account={balanceFor} movements={movements.data ?? []} onClose={() => setBalanceFor(null)} />}
    </>
  )

  if (!loading && !bankAccounts.length && !rows.length) {
    return (
      <>
        {header}
        <div className="pt-5"><FormError error={error} /></div>
        <EmptyState
          icon={<Landmark size={22} />}
          title="Agrega las cuentas bancarias de la empresa"
          description="Concilia cada movimiento del banco con sus pagos y cobros. Las cuentas se conectan con Fintoc (bancos de Chile) o se cargan importando la cartola en Excel o CSV (cualquier banco de Chile o Perú, en pesos, soles o dólares)."
          action={
            canAdmin ? (
              <div className="flex flex-wrap justify-center gap-2">
                {tenant.country === 'CL' && <Button variant="primary" onClick={connect} disabled={connecting}><Link2 size={16} /> {connecting ? 'Conectando…' : 'Conectar con Fintoc'}</Button>}
                <Button variant={tenant.country === 'CL' ? 'secondary' : 'primary'} onClick={() => setAccountDrawer('new')}><FileSpreadsheet size={16} /> Crear cuenta manual</Button>
              </div>
            ) : undefined
          }
        />
        {drawers}
      </>
    )
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-4 pt-5">
        <FormError error={error} />
        {notice && <div className="rounded-md bg-brand-50 px-3 py-2 text-sm text-navy-900">{notice}</div>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bankAccounts.map((a) => {
            const conn = (connections.data ?? []).find((c) => c.id === a.connection_id)
            return (
              <AccountCard
                key={a.id} account={a} connection={conn} canAdmin={canAdmin} canWrite={canWrite}
                onDisconnect={() => conn && disconnect(conn)}
                onImport={() => setImportFor(a.id)}
                onEdit={() => setAccountDrawer(a)}
                onHistory={() => setHistoryFor(a)}
                onDelete={() => deleteAccount(a)}
                onNewMovement={() => setMovementForm({ movement: null, accountId: a.id })}
                onBalance={() => setBalanceFor(a)}
                movements={movements.data ?? []}
              />
            )
          })}
        </div>

        <div className="stat-row sm:grid-cols-4">
          <StatCard label="Por conciliar" value={pending.length} detail={<MoneyTotals totals={sumByCurrency(pending, (r) => ({ currency: r.currency, amount: Math.abs(r.amount) }))} empty="—" />} tone={pending.length ? undefined : 'ok'} />
          <StatCard label="Con coincidencia exacta" value={automatic.length} detail="listos para conciliar" />
          <StatCard label="Conciliados este mes" value={reconciledThisMonth.length} tone="ok" />
          <StatCard label="Última actualización" value={<span className="text-[14px]">{lastSync ? formatTimestamp(lastSync, tenant.timezone) : '—'}</span>} />
        </div>

        <ListView
          state={list}
          columns={columns}
          rowKey={(r) => r.id}
          filters={filters}
          loading={loading}
          searchPlaceholder="Buscar por descripción, contraparte, RUT, referencia o monto…"
          onRowClick={(r) => setOpenId(r.id)}
          rowActions={(r) => {
            const editable = canWrite && (r.source === 'manual' || r.source === 'import') && r.reconciliation_status !== 'reconciled'
            return (
              <RowMenu
                label="Acciones"
                icon={<EllipsisVertical size={16} />}
                items={[
                  { label: r.reconciliation_status === 'pending' ? 'Conciliar' : 'Ver detalle', onClick: () => setOpenId(r.id) },
                  ...(editable && r.source === 'manual' ? [{ label: 'Editar movimiento', onClick: () => setMovementForm({ movement: r, accountId: r.account_id }) }] : []),
                  ...(editable ? [{
                    label: 'Eliminar movimiento', tone: 'danger' as const,
                    onClick: () => {
                      if (!confirm(`¿Eliminar el movimiento "${r.description ?? ''}"?`)) return
                      bank.deleteMovement.mutateAsync(r.id).catch((e) => setError(errorMessage(e)))
                    },
                  }] : []),
                ]}
              />
            )
          }}
          toolbarExtra={
            canWrite && automatic.length > 0 ? (
              <Button size="sm" variant="primary" onClick={() => runAutomatic(automatic)} disabled={autoRunning}>
                <CheckCheck size={16} /> {autoRunning ? 'Conciliando…' : `Conciliar coincidencias (${automatic.length})`}
              </Button>
            ) : undefined
          }
          bulkActions={canWrite ? (sel) => (
            <>
              <BulkButton onClick={() => setManyRows(sel)}><Link2 size={16} /> Conciliar con documentos</BulkButton>
              <BulkButton onClick={() => runAutomatic(sel)}><CheckCheck size={16} /> Conciliar coincidencias</BulkButton>
              <BulkButton onClick={async () => {
                const targets = sel.filter((r) => r.reconciliation_status === 'pending')
                if (!targets.length || !confirm(`¿Ignorar ${targets.length} movimientos?`)) return
                for (const r of targets) await bank.setStatus.mutateAsync({ movementId: r.id, status: 'ignored', reason: null }).catch((e) => setError(errorMessage(e)))
              }}>Ignorar</BulkButton>
            </>
          ) : undefined}
          empty="No hay movimientos con estos filtros."
        />
      </div>
      {selected && (
        <MovementDrawer
          key={selected.id} row={selected} ctx={ctx} onClose={() => setOpenId(null)}
          onEdit={selected.source === 'manual' ? () => { setOpenId(null); setMovementForm({ movement: selected, accountId: selected.account_id }) } : undefined}
        />
      )}
      {manyRows && (
        <ReconcileManyDrawer
          movements={manyRows} ctx={ctx} onClose={() => setManyRows(null)}
          onDone={(message) => { setManyRows(null); list.clearSelection(); setNotice(message) }}
        />
      )}
      {drawers}
    </>
  )
}

function AccountCard({ account: a, connection, canAdmin, canWrite, movements, onDisconnect, onImport, onEdit, onHistory, onDelete, onNewMovement, onBalance }: {
  account: BankFeedAccount; connection: BankConnection | undefined; canAdmin: boolean; canWrite: boolean; movements: BankMovement[]
  onDisconnect: () => void; onImport: () => void; onEdit: () => void; onHistory: () => void; onDelete: () => void; onNewMovement: () => void; onBalance: () => void
}) {
  const { tenant } = useCurrentTenant()
  const manual = a.source === 'manual'
  const disconnected = connection?.status === 'disconnected'
  const institution = institutionOf(a, connection)
  const mb = manual ? manualAccountBalance(a, movements) : null
  const menu = manual
    ? [
        ...(canWrite ? [{ label: 'Nuevo movimiento', onClick: onNewMovement }, { label: 'Cargar saldo', onClick: onBalance }, { label: 'Importar cartola', onClick: onImport }] : []),
        { label: 'Cartolas importadas', onClick: onHistory },
        ...(canAdmin ? [{ label: 'Editar cuenta', onClick: onEdit }, { label: 'Eliminar cuenta', tone: 'danger' as const, onClick: onDelete }] : []),
      ]
    : canAdmin && connection && !disconnected ? [{ label: 'Desconectar banco', tone: 'danger' as const, onClick: onDisconnect }] : []
  return (
    <div className={clsx('rounded-lg border bg-white px-4 py-3', connection?.status === 'error' ? 'border-amber-300' : 'border-line', disconnected && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <BankLogo id={institution.id} name={institution.name} size={36} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-xs text-faint">
              {institution.name ?? 'Banco'}{connection?.mode === 'test' && ' · prueba'}
              {a.currency !== tenant.base_currency && <span className="rounded bg-subtle px-1 py-px text-[10px] font-medium text-muted">{a.currency}</span>}
            </div>
            <div className="truncate text-sm font-medium text-ink">{a.name ?? 'Cuenta'}{a.number ? ` · ${a.number}` : ''}</div>
          </div>
        </div>
        {menu.length > 0 && <RowMenu label="Opciones" icon={<EllipsisVertical size={16} />} items={menu} />}
      </div>
      {manual ? (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-[18px] font-semibold text-ink tabular">{mb && mb.balance !== null ? <Money minor={mb.balance} currency={a.currency} /> : '—'}</span>
            {mb?.difference != null && (
              <span className="text-xs text-warn" title="El saldo final de la última cartola no calza con el saldo inicial más los movimientos">
                Cartola: <Money minor={mb.statement!} currency={a.currency} />
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-faint">
            {mb?.computed != null
              ? `Saldo calculado al ${formatDate(mb.asOf)}${mb.difference != null ? ' · no calza con la cartola' : ''}`
              : mb?.statement != null
                ? `Según la última cartola${a.refreshed_at ? ` (${formatTimestamp(a.refreshed_at, tenant.timezone)})` : ''}`
                : canWrite
                  ? <span className="flex gap-3"><button type="button" onClick={onBalance} className="font-medium text-brand-600 hover:underline">Cargar saldo</button><button type="button" onClick={onImport} className="font-medium text-brand-600 hover:underline">Importar cartola</button></span>
                  : 'Sin saldo'}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-[18px] font-semibold text-ink tabular">{a.balance_current != null ? <Money minor={a.balance_current} currency={a.currency} /> : '—'}</span>
            {a.balance_available != null && a.balance_available !== a.balance_current && (
              <span className="text-xs text-faint">Disponible <Money minor={a.balance_available} currency={a.currency} /></span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-faint">
            {disconnected ? 'Desconectado' : connection?.status === 'error' ? <span className="text-amber-700">{connection.last_error ?? 'Error de conexión'}</span> : a.refreshed_at ? `Saldo al ${formatTimestamp(a.refreshed_at, tenant.timezone)}` : 'Sin actualizar'}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detalle y conciliación de un movimiento
// ---------------------------------------------------------------------------
function MovementDrawer({ row, ctx, onClose, onEdit }: { row: Row; ctx: MatchContext; onClose: () => void; onEdit?: () => void }) {
  const { canWrite, hasModule } = useCurrentTenant()
  const bank = useBankMutations()
  const [error, setError] = useState<string | null>(null)
  const direction = movementDirection(row)
  const isIn = direction === 'in'
  const moduleOk = hasModule(isIn ? 'cuentas_por_cobrar' : 'cuentas_por_pagar')
  const linked = row.payment_id ? ctx.payments.find((p) => p.id === row.payment_id) ?? null : null
  const candidates = row.reconciliation_status === 'pending' ? paymentCandidates(row, ctx) : []

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const details: [string, React.ReactNode][] = [
    ['Fecha contable', formatDate(row.post_date)],
    ['Cuenta', <span key="a" className="inline-flex items-center gap-2"><BankLogo id={row.institution.id} name={row.institution.name} size={20} />{row.institution.name ? `${row.institution.name} · ` : ''}{accountLabel(row.account)}</span>],
    [isIn ? 'Enviado por' : 'Pagado a', row.counterparty_name ? (
      <span key="c" className="flex items-start gap-2">
        {row.counterparty_bank && <BankLogo name={row.counterparty_bank} size={20} className="mt-0.5" />}
        <span>{row.counterparty_name}{row.counterparty_tax_id && <span className="block text-xs text-faint">{formatTaxId(row.counterparty_tax_id, 'CL')}{row.counterparty_bank && ` · ${row.counterparty_bank}`}</span>}</span>
      </span>
    ) : '—'],
    ['Referencia', row.reference_id ?? row.document_number ?? '—'],
  ]
  if (row.comment) details.push(['Comentario', row.comment])

  return (
    <Drawer
      open onClose={onClose} width="lg" title="Movimiento bancario"
      header={
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs text-faint">{isIn ? 'Abono' : 'Cargo'} · {row.type === 'transfer' ? 'Transferencia' : row.type === 'check' ? 'Cheque' : 'Otro'}</div>
            <div className={clsx('text-[22px] font-semibold tabular', isIn ? 'text-ok' : 'text-ink')}><Money minor={row.amount} currency={row.currency} /></div>
            <div className="truncate text-sm text-muted">{row.description}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={STATUS[row.reconciliation_status].tone}>{STATUS[row.reconciliation_status].label}</Badge>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-subtle" aria-label="Cerrar">✕</button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {details.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-faint">{k}</dt><dd className="min-w-0 text-ink">{v}</dd></div>
          ))}
        </dl>
        {canWrite && (row.source === 'manual' || row.source === 'import') && row.reconciliation_status !== 'reconciled' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
            <span>{row.source === 'manual' ? 'Movimiento creado a mano.' : 'Movimiento importado desde una cartola.'}</span>
            {onEdit && <Button size="sm" variant="ghost" onClick={onEdit}>Editar</Button>}
            <Button size="sm" variant="ghost" onClick={() => { if (confirm('¿Eliminar este movimiento?')) run(() => bank.deleteMovement.mutateAsync(row.id)) }}>Eliminar</Button>
          </div>
        )}
        {row.bank_status === 'reversed' && <p className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad">El banco reversó este movimiento. Revisa si corresponde deshacer la conciliación.</p>}

        {row.reconciliation_status === 'reconciled' && (
          <Section title={isIn ? 'Cobro conciliado' : 'Pago conciliado'}>
            {linked ? <PaymentSummary payment={linked} /> : <p className="text-sm text-faint">El pago no está disponible.</p>}
            {canWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => run(() => bank.setStatus.mutateAsync({ movementId: row.id, status: 'pending' }))}><Undo2 size={16} /> Deshacer conciliación</Button>
                <p className="w-full text-xs text-faint">El {isIn ? 'cobro' : 'pago'} se mantiene registrado; solo se quita el vínculo con el movimiento.</p>
              </div>
            )}
          </Section>
        )}

        {row.reconciliation_status === 'ignored' && (
          <Section title="Movimiento ignorado">
            <p className="text-sm text-muted">{row.ignored_reason ?? 'Sin motivo'}</p>
            {canWrite && <Button className="mt-3" onClick={() => run(() => bank.setStatus.mutateAsync({ movementId: row.id, status: 'pending' }))}><Undo2 size={16} /> Volver a por conciliar</Button>}
          </Section>
        )}

        {row.reconciliation_status === 'pending' && canWrite && (
          <>
            {candidates.length > 0 && (
              <Section title={`${isIn ? 'Cobros' : 'Pagos'} registrados con el mismo monto`}>
                <div className="divide-y divide-line rounded-lg border border-line">
                  {candidates.map((c) => (
                    <div key={c.payment.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0 text-sm">
                        <div className="truncate text-ink">{c.payment.counterparty_name ?? 'Sin contraparte'}{c.sameCounterparty && <Badge tone="info">Mismo RUT</Badge>}</div>
                        <div className="truncate text-xs text-faint">{formatDate(c.payment.paid_on)} · {c.payment.method}{c.payment.reference && ` · ${c.payment.reference}`}{c.payment.allocations.length > 0 && ` · ${c.payment.allocations.map((a) => a.folio).filter(Boolean).join(', ')}`}</div>
                      </div>
                      <Button size="sm" variant={c === candidates[0] ? 'primary' : 'secondary'} disabled={bank.reconcile.isPending} onClick={() => run(() => bank.reconcile.mutateAsync({ movementId: row.id, paymentId: c.payment.id }))}>
                        <Link2 size={15} /> Vincular
                      </Button>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {moduleOk ? (
              <CreatePaymentSection row={row} ctx={ctx} onDone={onClose} onError={setError} />
            ) : (
              <p className="text-sm text-faint">Para registrar {isIn ? 'cobros' : 'pagos'} activa el módulo de {isIn ? 'cuentas por cobrar' : 'cuentas por pagar'}.</p>
            )}
            <IgnoreSection onIgnore={(reason) => run(() => bank.setStatus.mutateAsync({ movementId: row.id, status: 'ignored', reason }))} pending={bank.setStatus.isPending} />
          </>
        )}
      </div>
    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold text-ink">{title}</h3>
      {children}
    </section>
  )
}

function PaymentSummary({ payment: p }: { payment: Payment }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink">{p.counterparty_name ?? 'Sin contraparte'}</span>
        <Money minor={p.amount} currency={p.currency} className="font-medium" />
      </div>
      <div className="text-xs text-faint">{formatDate(p.paid_on)} · {p.method}{p.reference && ` · ${p.reference}`}</div>
      {p.allocations.length > 0 && <div className="mt-1 text-xs text-muted">Documentos: {p.allocations.map((a) => a.folio ?? '—').join(', ')}</div>}
      <Link to={p.direction === 'in' ? '/cxc/cobros' : '/cxp/pagos'} className="mt-1 inline-block text-xs font-medium text-brand-600 hover:underline">Ver en {p.direction === 'in' ? 'cobros' : 'pagos'}</Link>
    </div>
  )
}

function CreatePaymentSection({ row, ctx, onDone, onError }: { row: Row; ctx: MatchContext; onDone: () => void; onError: (e: string | null) => void }) {
  const bank = useBankMutations()
  const isIn = row.amount > 0
  const methods = usePaymentMethods(isIn ? 'in' : 'out')
  const amount = Math.abs(row.amount)
  const initialCp = row.suggestion.kind === 'documents' || row.suggestion.kind === 'counterparty' ? row.suggestion.counterparty : counterpartyFor(row, ctx.counterparties)
  const [counterpartyId, setCounterpartyId] = useState(initialCp?.id ?? '')
  // Texto de búsqueda mientras no se elige una contraparte (null = mostrar la elegida).
  const [cpQuery, setCpQuery] = useState<string | null>(null)
  const { tenant } = useCurrentTenant()
  const options: Counterparty[] = ctx.counterparties.filter((c) => (isIn ? c.is_customer : c.is_supplier) || c.id === initialCp?.id).sort((a, b) => a.name.localeCompare(b.name))
  const open: DocumentRow[] = counterpartyId ? openDocumentsFor(row, counterpartyId, ctx.documents) : []
  const [alloc, setAlloc] = useState<Record<string, string>>(() => toInputs(row.suggestion.kind === 'documents' && row.suggestion.exact
    ? Object.fromEntries(row.suggestion.documents.map((d) => [d.id, d.pending_amount]))
    : allocateFifo(amount, initialCp ? openDocumentsFor(row, initialCp.id, ctx.documents) : [])))
  const activeMethods = (methods.data ?? []).filter((m) => m.active)
  const [method, setMethod] = useState('')
  const methodValue = method || activeMethods.find((m) => m.name.toLowerCase().includes('transfer'))?.name || activeMethods.find((m) => m.is_default)?.name || activeMethods[0]?.name || 'Transferencia'

  function toInputs(map: Record<string, number>) {
    return Object.fromEntries(Object.entries(map).map(([id, v]) => [id, minorToInput(v, row.currency)]))
  }
  const parsed = open.map((d) => ({ d, value: alloc[d.id] ? parseMoneyInput(alloc[d.id], row.currency) : 0 }))
  const allocated = parsed.reduce((s, p) => s + (p.value ?? 0), 0)
  const invalid = parsed.some((p) => p.value === null || (p.value ?? 0) < 0 || (p.value ?? 0) > p.d.pending_amount)

  const changeCounterparty = (id: string) => {
    setCounterpartyId(id)
    setAlloc(toInputs(allocateFifo(amount, id ? openDocumentsFor(row, id, ctx.documents) : [])))
  }
  const submit = async () => {
    onError(null)
    if (invalid) return onError('Revisa los montos asignados: no pueden superar el saldo de cada documento.')
    if (allocated > amount) return onError('Lo asignado supera el monto del movimiento.')
    try {
      await bank.createPayment.mutateAsync({
        movementId: row.id,
        input: {
          counterparty_id: counterpartyId || null, method: methodValue, notes: null,
          allocations: parsed.filter((p) => (p.value ?? 0) > 0).map((p) => ({ document_id: p.d.id, amount: p.value! })),
        },
      })
      onDone()
    } catch (e) {
      onError(errorMessage(e))
    }
  }

  return (
    <Section title={`Registrar ${isIn ? 'cobro' : 'pago'} y conciliar`}>
      <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-faint">{isIn ? 'Cliente' : 'Proveedor'}</span>
            <CounterpartyCombobox
              options={options}
              value={{ id: counterpartyId || null, name: cpQuery ?? options.find((c) => c.id === counterpartyId)?.name ?? '' }}
              onChange={(v) => { setCpQuery(v.id ? null : v.name); if (v.id !== (counterpartyId || null)) changeCounterparty(v.id ?? '') }}
              country={tenant.country} allowFree={false} placeholder="Busca por nombre o RUT…" ariaLabel={isIn ? 'Cliente' : 'Proveedor'}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-faint">Forma de pago</span>
            <Select value={methodValue} onChange={(e) => setMethod(e.target.value)}>
              {(activeMethods.length ? activeMethods.map((m) => m.name) : ['Transferencia']).map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
        </div>
        {counterpartyId && (
          open.length ? (
            <div className="divide-y divide-line rounded-md border border-line">
              {open.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <div className="truncate text-ink">{documentTypeLabel(d.doc_type)} N° {d.folio}</div>
                    <div className="text-xs text-faint">Vence {formatDate(d.due_date)} · saldo <Money minor={d.pending_amount} currency={d.currency} /></div>
                  </div>
                  <Input className="w-32 text-right" inputMode="decimal" value={alloc[d.id] ?? ''} placeholder="0" onChange={(e) => setAlloc((a) => ({ ...a, [d.id]: e.target.value }))} aria-label={`Monto para ${d.folio}`} />
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-faint">Sin documentos abiertos en {row.currency} para esta contraparte: quedará como {isIn ? 'cobro' : 'pago'} sin asignar.</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className={clsx(allocated > amount ? 'text-bad' : 'text-muted')}>
            Asignado <Money minor={allocated} currency={row.currency} /> de <Money minor={amount} currency={row.currency} />
            {allocated < amount && allocated > 0 && <> · queda <Money minor={amount - allocated} currency={row.currency} /> sin asignar</>}
          </span>
          <Button variant="primary" onClick={submit} disabled={bank.createPayment.isPending}>{bank.createPayment.isPending ? 'Registrando…' : `Registrar ${isIn ? 'cobro' : 'pago'} y conciliar`}</Button>
        </div>
      </div>
    </Section>
  )
}

function IgnoreSection({ onIgnore, pending }: { onIgnore: (reason: string | null) => void; pending: boolean }) {
  const [reason, setReason] = useState('')
  return (
    <Section title="No corresponde a un pago ni a un cobro">
      <div className="flex flex-wrap gap-1.5">
        {IGNORE_REASONS.map((r) => (
          <button key={r} type="button" onClick={() => setReason(r)} className={clsx('rounded-full border px-2.5 py-1 text-xs', reason === r ? 'border-brand-600 bg-brand-50 text-brand-600' : 'border-line text-muted hover:text-ink')}>{r}</button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input placeholder="Motivo (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
        <Button onClick={() => onIgnore(reason.trim() || null)} disabled={pending}><Unplug size={15} /> Ignorar</Button>
      </div>
    </Section>
  )
}
