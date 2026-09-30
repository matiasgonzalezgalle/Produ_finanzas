// Ficha de cobranza de un cliente: resumen, documentos, contactos, actividad y configuración.
import { ArrowLeft, Banknote, CalendarClock, Check, Copy, FileText, Mail, MessageSquare, Pause, Phone, Plus, ShieldAlert, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useCollectionEvents,
  useCollectionMutations,
  useCollectionRules,
  useContacts,
  useCounterpartyRuleSettings,
  useEmailLog,
  useMembers,
  usePayments,
  useSaveContact,
  useSaveCounterparty,
} from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { CollectionEvent, CollectionEventKind, Counterparty, DocumentRow } from '../../data'
import { addDays, formatDate, formatTimestamp } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { CURRENCIES, formatMoney, sumByCurrency, type Currency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, Textarea } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { sectionTabs } from '../documents/DocumentsPage'
import { rememberDocumentOrder } from '../documents/documentOrder'
import { PaymentDrawer } from '../payments/PaymentsPage'
import { errorMessage, minorToInput, Money, MoneyTotals, parseMoneyInput, StatusBadge } from '../shared'
import { PAYMENT_LINK_TEMPLATE } from './SendDocumentEmailDrawer'
import { ACCOUNT_STATUS, AGE_BUCKETS, ageBucket, ruleAppliesTo, ruleWhen, type CollectionAccount } from './collectionData'
import { AgingBar, useCollectionAccounts } from './CollectionsPage'

type Tab = 'general' | 'documentos' | 'contactos' | 'actividad' | 'configuracion'
const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'documentos', label: 'Documentos' },
  { key: 'contactos', label: 'Contactos' },
  { key: 'actividad', label: 'Actividad' },
  { key: 'configuracion', label: 'Configuración' },
]

export function CollectionAccountPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { accounts, loading } = useCollectionAccounts()
  const [tab, setTab] = useState<Tab>('general')
  const account = accounts.find((a) => a.counterparty.id === id)

  if (loading) return <p className="pt-10 text-center text-sm text-faint">Cargando…</p>
  if (!account) {
    return (
      <div>
        <PageHeader title="Cuentas por cobrar" tabs={sectionTabs('receivable')} />
        <EmptyState title="Cliente no encontrado" action={<Button onClick={() => navigate('/cxc/cobranza')}>Volver a la cartera</Button>} />
      </div>
    )
  }
  return (
    <div>
      <PageHeader title="Cuentas por cobrar" tabs={sectionTabs('receivable')} />
      <div className="pt-4">
        <Link to="/cxc/cobranza" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"><ArrowLeft size={14} /> Cartera</Link>
      </div>
      <AccountHeader account={account} />
      <nav className="mt-4 flex gap-6 overflow-x-auto border-b border-line" aria-label="Secciones del cliente">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn('-mb-px border-b-2 py-2.5 text-[13px] whitespace-nowrap', tab === t.key ? 'border-brand-600 font-medium text-brand-600' : 'border-transparent text-muted hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="pt-5">
        {tab === 'general' && <GeneralTab account={account} />}
        {tab === 'documentos' && <DocumentsTab account={account} />}
        {tab === 'contactos' && <ContactsTab account={account} />}
        {tab === 'actividad' && <ActivityTab account={account} />}
        {tab === 'configuracion' && <SettingsTab key={account.counterparty.id} counterparty={account.counterparty} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Encabezado y acciones
// ---------------------------------------------------------------------------
function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      title={value}
      className="inline-flex max-w-56 items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-[12px] text-ink hover:bg-head"
    >
      <span className="truncate">{label}</span>
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} className="text-faint" />}
    </button>
  )
}

function AccountHeader({ account }: { account: CollectionAccount }) {
  const { tenant, canWrite } = useCurrentTenant()
  const c = account.counterparty
  const [action, setAction] = useState<'event' | 'email' | 'pay' | null>(null)
  const portal = tenant.portal_enabled && c.portal_slug ? `${window.location.origin}/portal/${c.portal_slug}` : null
  const payable = account.open.filter((d) => d.approval_status !== 'rejected')
  return (
    <section className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="truncate text-[15px] font-semibold text-ink">{c.name}</h1>
          {c.tax_id && <span className="text-[13px] text-muted">{formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country)}</span>}
          <Badge tone={ACCOUNT_STATUS[account.status].tone}>{ACCOUNT_STATUS[account.status].label}</Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {c.email && <CopyChip label={c.email} value={c.email} />}
          {portal && <CopyChip label="Link del portal" value={portal} />}
          {c.tags.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAction('event')}><MessageSquare size={15} /> Registrar gestión</Button>
          <Button onClick={() => setAction('email')} disabled={!account.open.length}><Mail size={15} /> Enviar correo</Button>
          <Button variant="primary" onClick={() => setAction('pay')} disabled={!payable.length}><Banknote size={15} /> Registrar cobro</Button>
        </div>
      )}
      {action === 'event' && <EventDrawer account={account} onClose={() => setAction(null)} />}
      {action === 'email' && <EmailDrawer account={account} onClose={() => setAction(null)} />}
      {action === 'pay' && <PaymentDrawer open direction="in" presets={payable} onClose={() => setAction(null)} />}
    </section>
  )
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------
function Summary({ label, tone, totals, count }: { label: string; tone: 'neutral' | 'info' | 'bad'; totals: Partial<Record<Currency, number>>; count: number }) {
  return (
    <div className="rounded-lg border border-line bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', tone === 'bad' ? 'bg-bad-bg text-bad' : tone === 'info' ? 'bg-brand-50 text-brand-600' : 'bg-subtle text-muted')}>{label}</span>
        <span className="text-[11px] text-faint">{count} docs</span>
      </div>
      <div className="mt-1.5 text-[18px] font-semibold text-ink tabular"><MoneyTotals totals={totals} empty="$0" /></div>
    </div>
  )
}

const shortMoney = (minor: number) => {
  if (minor >= 1_000_000) return `$${(minor / 1_000_000).toLocaleString('es-CL', { maximumFractionDigits: 1 })} M`
  if (minor >= 1_000) return `$${Math.round(minor / 1_000)} k`
  return `$${minor}`
}
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

/** Facturación de los últimos 12 meses (moneda base), apilada por estado. */
function BillingChart({ docs }: { docs: DocumentRow[] }) {
  const { tenant, today } = useCurrentTenant()
  const base = tenant.base_currency
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() - (11 - i))
    return d.toISOString().slice(0, 7)
  })
  const data = months.map((m) => {
    const ofMonth = docs.filter((d) => d.issue_date.startsWith(m) && d.currency === base && d.doc_type !== 'nota_credito')
    const paid = ofMonth.reduce((s, d) => s + Math.max(0, d.net_total - d.pending_amount), 0)
    const overdue = ofMonth.filter((d) => d.days_overdue > 0).reduce((s, d) => s + d.pending_amount, 0)
    const notDue = ofMonth.filter((d) => d.days_overdue <= 0).reduce((s, d) => s + d.pending_amount, 0)
    return { m, paid, overdue, notDue, total: paid + overdue + notDue }
  })
  const max = Math.max(1, ...data.map((d) => d.total))
  const H = 150
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Facturación de los últimos 12 meses <span className="font-normal text-faint">· {base}</span></h3>
        <span className="flex gap-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ok" />Pagado</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-brand-500" />Por vencer</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-bad" />Vencido</span>
        </span>
      </div>
      <div className="mt-3 flex items-end gap-1.5 sm:gap-3" style={{ height: H + 22 }}>
        {data.map((d) => (
          <div key={d.m} className="flex flex-1 flex-col items-center gap-1" title={`${MONTHS[Number(d.m.slice(5)) - 1]} ${d.m.slice(0, 4)}: ${formatMoney(d.total, base)}`}>
            <div className="flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t" style={{ height: (d.total / max) * H }}>
              {d.paid > 0 && <span className="bg-ok" style={{ height: `${(d.paid / d.total) * 100}%` }} />}
              {d.notDue > 0 && <span className="bg-brand-500" style={{ height: `${(d.notDue / d.total) * 100}%` }} />}
              {d.overdue > 0 && <span className="bg-bad" style={{ height: `${(d.overdue / d.total) * 100}%` }} />}
            </div>
            <span className="text-[10px] text-faint">{MONTHS[Number(d.m.slice(5)) - 1]}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-right text-[11px] text-faint">Máximo mensual {shortMoney(max === 1 ? 0 : max)}</p>
    </section>
  )
}

function GeneralTab({ account }: { account: CollectionAccount }) {
  const { tenant, today } = useCurrentTenant()
  const base = tenant.base_currency
  const c = account.counterparty
  const notDueDocs = account.open.filter((d) => d.days_overdue <= 0)
  const overdueDocs = account.open.filter((d) => d.days_overdue > 0)
  const baseDebt = account.pending[base] ?? 0
  const limit = c.credit_limit ?? null
  const used = limit ? Math.min(100, Math.round((baseDebt / limit) * 100)) : 0
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Summary label="Deuda total" tone="neutral" totals={account.pending} count={account.open.length} />
        <Summary label="Por vencer" tone="info" totals={account.notDue} count={notDueDocs.length} />
        <Summary label="Vencido" tone="bad" totals={account.overdue} count={overdueDocs.length} />
      </div>
      <BillingChart docs={account.documents} />
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white">
          <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Deuda por antigüedad <span className="font-normal text-faint">· {base}</span></h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {AGE_BUCKETS.map((b) => {
                const n = account.open.filter((d) => d.currency === base && ageBucket(d) === b.key).length
                return (
                  <tr key={b.key}>
                    <td className="px-4 py-2"><span className="inline-flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: b.color }} />{b.label}</span></td>
                    <td className="px-4 py-2 text-right text-faint">{n ? `${n} docs` : ''}</td>
                    <td className="px-4 py-2 text-right font-medium tabular text-ink">{formatMoney(account.buckets[b.key], base)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="px-4 pt-1 pb-3"><AgingBar account={account} className="w-full" /></div>
        </section>
        <section className="flex flex-col gap-4 rounded-lg border border-line bg-white p-4">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">Crédito utilizado</h3>
            {limit ? (
              <>
                <div className="mt-2 flex justify-between text-sm"><Money minor={baseDebt} currency={base} className="font-semibold text-ink" /><span className="text-muted">de <Money minor={limit} currency={base} /></span></div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle"><div className={cn('h-full rounded-full', used >= 100 ? 'bg-bad' : used >= 80 ? 'bg-warn' : 'bg-ok')} style={{ width: `${used}%` }} /></div>
                <p className="mt-1 text-[12px] text-muted">{used >= 100 ? 'Superó el límite de crédito.' : `${used}% del límite · disponible ${formatMoney(Math.max(0, limit - baseDebt), base)}`}</p>
              </>
            ) : (
              <p className="mt-1 text-sm text-faint">Sin límite de crédito. Defínelo en Configuración.</p>
            )}
          </div>
          <div className="border-t border-line pt-3">
            <h3 className="text-[13px] font-semibold text-ink">Promesa de pago</h3>
            {account.nextPromise ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-ink">
                <CalendarClock size={15} className={account.nextPromise.promised_date! < today ? 'text-bad' : 'text-brand-600'} />
                {formatDate(account.nextPromise.promised_date)}
                {account.nextPromise.promised_amount ? ` · ${formatMoney(account.nextPromise.promised_amount, account.nextPromise.currency ?? base)}` : ''}
              </p>
            ) : (
              <p className="mt-1 text-sm text-faint">{account.lastPromiseBroken ? 'La última promesa no se cumplió.' : 'Sin promesas vigentes.'}</p>
            )}
          </div>
          <div className="border-t border-line pt-3 text-sm">
            <h3 className="text-[13px] font-semibold text-ink">Condiciones</h3>
            <p className="mt-1 text-muted">Plazo de pago: <span className="text-ink">{c.payment_terms_days != null ? `${c.payment_terms_days} días` : '—'}</span> · Máx. atraso: <span className="text-ink">{account.maxDaysOverdue ? `${account.maxDaysOverdue} días` : '—'}</span></p>
            {c.collection_paused && <p className="mt-1 flex items-center gap-1.5 text-warn"><Pause size={14} /> Recordatorios automáticos pausados.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------
function DocumentsTab({ account }: { account: CollectionAccount }) {
  const navigate = useNavigate()
  const { canWrite } = useCurrentTenant()
  const [emailDoc, setEmailDoc] = useState<DocumentRow | null>(null)
  const rows = account.documents
  const columns: ListColumn<DocumentRow>[] = [
    {
      key: 'doc',
      header: 'Documento',
      cell: (d) => <span className="flex flex-col leading-tight"><span className="font-medium text-ink">N° {d.folio}</span><span className="text-xs text-faint">{documentTypeLabel(d.doc_type)}</span></span>,
      sortValue: (d) => d.folio.padStart(12, '0'),
    },
    { key: 'issue', header: 'Emisión', cell: (d) => formatDate(d.issue_date), sortValue: (d) => d.issue_date },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date), sortValue: (d) => d.due_date },
    { key: 'total', mobileHidden: true, header: 'Total', align: 'right', cell: (d) => <Money minor={d.doc_type === 'nota_credito' ? -d.total_amount : d.total_amount} currency={d.currency} />, sortValue: (d) => d.total_amount },
    { key: 'pending', header: 'Saldo', align: 'right', cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className={d.pending_amount ? 'font-semibold text-ink' : ''} />, sortValue: (d) => d.pending_amount },
    { key: 'status', mobileBadge: true, header: 'Estado', cell: (d) => <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />, sortValue: (d) => d.days_overdue },
  ]
  const filters: ListFilter<DocumentRow>[] = [
    { type: 'select', key: 'state', label: 'Estado', options: [{ value: 'open', label: 'Con saldo' }, { value: 'overdue', label: 'Vencidos' }, { value: 'paid', label: 'Pagados' }, { value: 'notes', label: 'Notas de crédito/débito' }], defaultValue: 'open', match: (d, v) => (v === 'open' ? d.pending_amount > 0 : v === 'overdue' ? d.days_overdue > 0 : v === 'paid' ? d.payment_status === 'pagado' : ['nota_credito', 'nota_debito'].includes(d.doc_type)) },
    { type: 'dateRange', key: 'due', label: 'Vencimiento', getDate: (d) => d.due_date },
    { type: 'dateRange', key: 'issue', label: 'Emisión', getDate: (d) => d.issue_date },
  ]
  const list = useListState({ rows, rowKey: (d) => d.id, columns, filters, searchText: (d) => d.folio, storageKey: 'collection-docs', defaultSort: { key: 'due', dir: 'asc' } })
  const saldo = sumByCurrency(list.filtered, (d) => ({ currency: d.currency, amount: d.pending_amount }))
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Saldo de la selección: <span className="font-semibold text-ink"><MoneyTotals totals={saldo} empty="$0" /></span></p>
      <ListView
        state={list}
        columns={columns}
        rowKey={(d) => d.id}
        filters={filters}
        searchPlaceholder="Buscar folio…"
        onRowClick={(d) => {
          rememberDocumentOrder('receivable', list.filtered.map((x) => x.id))
          navigate(`/cxc/documentos/${d.id}`)
        }}
        rowActions={(d) => (canWrite && d.pending_amount > 0 ? <RowAction label="Enviar recordatorio" onClick={() => setEmailDoc(d)}><Mail size={16} /></RowAction> : null)}
        empty={<EmptyState icon={<FileText size={20} />} title="Sin documentos para estos filtros" />}
      />
      {emailDoc && <EmailDrawer account={account} document={emailDoc} onClose={() => setEmailDoc(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------
function ContactsTab({ account }: { account: CollectionAccount }) {
  const { canWrite } = useCurrentTenant()
  const contacts = useContacts()
  const save = useSaveContact()
  const saveCp = useSaveCounterparty()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const c = account.counterparty
  const rows = (contacts.data ?? []).filter((x) => x.counterparty_id === c.id)

  async function toggle(contactId: string, value: boolean) {
    const row = rows.find((r) => r.id === contactId)!
    setError(null)
    try {
      await save.mutateAsync({ input: { counterparty_id: row.counterparty_id, name: row.name, position: row.position, email: row.email, phone: row.phone, is_collection_contact: value }, id: row.id })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-muted">
        Los correos de cobranza llegan al correo de la ficha del cliente{c.email ? <> (<b className="text-ink">{c.email}</b>)</> : ' (sin correo registrado)'}, a los correos autorizados en su portal y a los contactos marcados como <b className="text-ink">Recibe cobranza</b>.
      </p>
      <FormError error={error} />
      <div className="divide-y divide-line rounded-lg border border-line bg-white">
        {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-faint">Sin contactos. Agrega a la persona de pagos o tesorería del cliente.</p>}
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-head text-[12px] font-semibold text-navy-900">{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{r.name}{r.position ? <span className="font-normal text-muted"> · {r.position}</span> : null}</span>
              <span className="block text-[12px] text-muted">{[r.email, r.phone].filter(Boolean).join(' · ') || 'Sin correo ni teléfono'}</span>
            </span>
            <label className={cn('inline-flex items-center gap-2 text-[12px]', r.email ? 'text-ink' : 'text-faint')}>
              <input type="checkbox" className="size-4 accent-navy-900" checked={!!r.is_collection_contact} disabled={!canWrite || !r.email || save.isPending} onChange={(e) => toggle(r.id, e.target.checked)} />
              Recibe cobranza
            </label>
          </div>
        ))}
      </div>
      {canWrite && <Button onClick={() => setAdding(true)} className="self-start"><Plus size={15} /> Agregar contacto</Button>}
      {!c.email && canWrite && (
        <QuickEmail
          onSave={async (email) => {
            const { id: _id, tenant_id: _t, portal_slug: _s, ...input } = c
            void _id
            void _t
            void _s
            await saveCp.mutateAsync({ input: { ...input, email }, id: c.id })
          }}
        />
      )}
      {adding && <ContactDrawer counterpartyId={c.id} onClose={() => setAdding(false)} />}
    </div>
  )
}

function QuickEmail({ onSave }: { onSave: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="rounded-lg border border-warn/30 bg-warn-bg p-3">
      <p className="text-[12px] text-ink">El cliente no tiene correo en su ficha. Agrégalo para enviar cobranza:</p>
      <div className="mt-2 flex gap-2">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pagos@cliente.cl" className="max-w-72" />
        <Button
          size="sm"
          onClick={async () => {
            setError(null)
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Correo inválido')
            try {
              await onSave(email.trim().toLowerCase())
            } catch (err) {
              setError(errorMessage(err))
            }
          }}
        >
          Guardar
        </Button>
      </div>
      <FormError error={error} />
    </div>
  )
}

function ContactDrawer({ counterpartyId, onClose }: { counterpartyId: string; onClose: () => void }) {
  const save = useSaveContact()
  const [form, setForm] = useState({ name: '', position: '', email: '', phone: '', is_collection_contact: true })
  const [error, setError] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name.trim()) return setError('El nombre es obligatorio')
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setError('Correo inválido')
    try {
      await save.mutateAsync({ input: { counterparty_id: counterpartyId, name: form.name.trim(), position: form.position.trim() || null, email: form.email.trim().toLowerCase() || null, phone: form.phone.trim() || null, is_collection_contact: !!form.email && form.is_collection_contact } })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Drawer open title="Agregar contacto" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" type="submit" form="contact-form" disabled={save.isPending}>Guardar</Button></>}>
      <form id="contact-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />}</Field>
        <Field label="Cargo">{(id) => <Input id={id} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Ej: Tesorería" />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Correo">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Teléfono">{(id) => <Input id={id} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" className="size-4 accent-navy-900" checked={form.is_collection_contact} onChange={(e) => setForm({ ...form, is_collection_contact: e.target.checked })} /> Recibe los correos de cobranza</label>
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Actividad
// ---------------------------------------------------------------------------
const EVENT_META: Record<CollectionEventKind, { label: string; icon: React.ReactNode }> = {
  note: { label: 'Nota', icon: <MessageSquare size={14} /> },
  call: { label: 'Llamada', icon: <Phone size={14} /> },
  promise: { label: 'Promesa de pago', icon: <CalendarClock size={14} /> },
  dispute: { label: 'Disputa', icon: <ShieldAlert size={14} /> },
}

type TimelineItem =
  | { type: 'event'; at: string; event: CollectionEvent }
  | { type: 'email'; at: string; subject: string; status: string; recipients: string[]; error: string | null }
  | { type: 'payment'; at: string; amount: number; currency: Currency; method: string; folios: string[] }

function ActivityTab({ account }: { account: CollectionAccount }) {
  const { tenant, canWrite, today } = useCurrentTenant()
  const c = account.counterparty
  const events = useCollectionEvents(c.id)
  const emails = useEmailLog()
  const payments = usePayments('in')
  const members = useMembers()
  const m = useCollectionMutations()
  const [kind, setKind] = useState<'all' | 'event' | 'email' | 'payment'>('all')
  const [adding, setAdding] = useState(false)
  const who = (id: string | null) => (members.data ?? []).find((x) => x.user_id === id)?.full_name ?? (id ? 'Usuario' : 'Automático')

  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [
      ...(events.data ?? []).map((e) => ({ type: 'event' as const, at: e.created_at, event: e })),
      ...(emails.data ?? []).filter((e) => e.counterparty_id === c.id).map((e) => ({ type: 'email' as const, at: e.sent_at ?? e.created_at, subject: e.subject ?? 'Correo', status: e.status, recipients: e.recipients, error: e.error })),
      ...(payments.data ?? []).filter((p) => p.counterparty_id === c.id && p.status === 'confirmed').map((p) => ({ type: 'payment' as const, at: p.created_at ?? `${p.paid_on}T12:00:00Z`, amount: p.amount, currency: p.currency, method: p.method, folios: p.allocations.map((a) => a.folio ?? '') })),
    ]
    return out.filter((i) => kind === 'all' || i.type === kind).sort((a, b) => b.at.localeCompare(a.at))
  }, [events.data, emails.data, payments.data, c.id, kind])

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-subtle p-0.5 text-[12px]">
          {([['all', 'Todo'], ['event', 'Gestiones'], ['email', 'Correos'], ['payment', 'Cobros']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cn('rounded-md px-2.5 py-1', kind === k ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}>{label}</button>
          ))}
        </div>
        {canWrite && <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Registrar gestión</Button>}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<MessageSquare size={20} />} title="Sin actividad" description="Registra llamadas, notas y promesas de pago. Los correos y cobros aparecen solos." />
      ) : (
        <ol className="relative flex flex-col gap-4 border-l border-line pl-5">
          {items.map((i, idx) => (
            <li key={idx} className="relative">
              <span className="absolute top-0.5 -left-[27px] flex size-[22px] items-center justify-center rounded-full border border-line bg-white text-muted">
                {i.type === 'event' ? EVENT_META[i.event.kind].icon : i.type === 'email' ? <Mail size={13} /> : <Banknote size={13} />}
              </span>
              {i.type === 'event' && (
                <div className="rounded-lg border border-line bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium text-ink">{EVENT_META[i.event.kind].label}</span>
                    {i.event.kind === 'promise' && (
                      <>
                        <span className="text-ink">para el {formatDate(i.event.promised_date)}{i.event.promised_amount ? ` · ${formatMoney(i.event.promised_amount, i.event.currency ?? tenant.base_currency)}` : ''}</span>
                        <Badge tone={i.event.promise_status === 'kept' ? 'ok' : i.event.promise_status === 'broken' ? 'bad' : i.event.promised_date! < today ? 'warn' : 'info'}>
                          {i.event.promise_status === 'kept' ? 'Cumplida' : i.event.promise_status === 'broken' ? 'Incumplida' : 'Pendiente'}
                        </Badge>
                      </>
                    )}
                    {canWrite && (
                      <span className="ml-auto flex gap-1">
                        {i.event.kind === 'promise' && i.event.promise_status === 'pending' && (
                          <>
                            <RowAction label="Marcar cumplida" onClick={() => m.setPromise.mutate({ id: i.event.id, status: 'kept' })}><Check size={15} className="text-ok" /></RowAction>
                            <RowAction label="Marcar incumplida" onClick={() => m.setPromise.mutate({ id: i.event.id, status: 'broken' })}><X size={15} className="text-bad" /></RowAction>
                          </>
                        )}
                        <RowAction label="Eliminar" tone="danger" onClick={() => window.confirm('¿Eliminar esta gestión?') && m.deleteEvent.mutate(i.event.id)}><Trash2 size={14} /></RowAction>
                      </span>
                    )}
                  </div>
                  {i.event.body && <p className="mt-1 text-sm whitespace-pre-line text-muted">{i.event.body}</p>}
                  <p className="mt-1 text-[11px] text-faint">{who(i.event.created_by)} · {formatTimestamp(i.at, tenant.timezone)}</p>
                </div>
              )}
              {i.type === 'email' && (
                <div className="px-1 text-[13px]">
                  <p className="text-ink"><span className="font-medium">Correo:</span> {i.subject} <Badge tone={i.status === 'sent' ? 'ok' : i.status === 'failed' ? 'bad' : 'neutral'}>{i.status === 'sent' ? 'Enviado' : i.status === 'failed' ? 'Falló' : i.status === 'skipped' ? 'No enviado' : 'Pendiente'}</Badge></p>
                  <p className="text-[11px] text-faint">{i.recipients.join(', ') || i.error || '—'} · {formatTimestamp(i.at, tenant.timezone)}</p>
                </div>
              )}
              {i.type === 'payment' && (
                <div className="px-1 text-[13px]">
                  <p className="text-ink"><span className="font-medium text-ok">Cobro de {formatMoney(i.amount, i.currency)}</span> · {i.method.startsWith('mercadopago') ? 'MercadoPago' : i.method}{i.folios.filter(Boolean).length ? ` · N° ${i.folios.filter(Boolean).join(', ')}` : ''}</p>
                  <p className="text-[11px] text-faint">{formatTimestamp(i.at, tenant.timezone)}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {adding && <EventDrawer account={account} onClose={() => setAdding(false)} />}
    </div>
  )
}

function EventDrawer({ account, onClose }: { account: CollectionAccount; onClose: () => void }) {
  const { tenant, today } = useCurrentTenant()
  const m = useCollectionMutations()
  const [kind, setKind] = useState<CollectionEventKind>('call')
  const [body, setBody] = useState('')
  const [date, setDate] = useState(addDays(today, 7))
  const [currency, setCurrency] = useState<Currency>(tenant.base_currency)
  const [amount, setAmount] = useState(() => minorToInput(account.pending[tenant.base_currency] ?? 0, tenant.base_currency))
  const [documentId, setDocumentId] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (kind !== 'promise' && !body.trim()) return setError('Escribe el detalle de la gestión')
    const amountMinor = kind === 'promise' && amount.trim() ? parseMoneyInput(amount, currency) : null
    if (kind === 'promise' && amount.trim() && (amountMinor === null || amountMinor <= 0)) return setError('Monto inválido')
    if (kind === 'promise' && date < today) return setError('La fecha comprometida no puede ser anterior a hoy')
    try {
      await m.addEvent.mutateAsync({
        counterparty_id: account.counterparty.id,
        document_id: documentId || null,
        kind,
        body: body.trim() || null,
        promised_date: kind === 'promise' ? date : null,
        promised_amount: kind === 'promise' ? amountMinor : null,
        currency: kind === 'promise' ? currency : null,
        promise_status: kind === 'promise' ? 'pending' : null,
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer open title="Registrar gestión" subtitle={account.counterparty.name} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" type="submit" form="event-form" disabled={m.addEvent.isPending}>Guardar</Button></>}>
      <form id="event-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(EVENT_META) as CollectionEventKind[]).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cn('flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[12px]', kind === k ? 'border-navy-900 bg-head font-medium text-ink' : 'border-line text-muted hover:bg-subtle')}>
              {EVENT_META[k].icon}
              {EVENT_META[k].label}
            </button>
          ))}
        </div>
        {kind === 'promise' && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Fecha comprometida">{(id) => <Input id={id} type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Moneda">
              {(id) => (
                <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Monto" hint="Opcional">{(id) => <Input id={id} inputMode="decimal" className="text-right tabular" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          </div>
        )}
        <Field label="Documento" hint="Opcional: si la gestión es sobre un documento en particular.">
          {(id) => (
            <Select id={id} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">Toda la cuenta</option>
              {account.open.map((d) => <option key={d.id} value={d.id}>{documentTypeLabel(d.doc_type)} N° {d.folio} · {formatMoney(d.pending_amount, d.currency)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={kind === 'promise' ? 'Comentario' : 'Detalle'}>
          {(id) => <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={kind === 'call' ? 'Ej: Hablé con Paula de tesorería, paga el viernes.' : kind === 'dispute' ? 'Ej: El cliente reclama diferencia en la factura 1038.' : ''} autoFocus />}
        </Field>
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Enviar correo (plantilla o estado de cuenta)
// ---------------------------------------------------------------------------
function EmailDrawer({ account, document, onClose }: { account: CollectionAccount; document?: DocumentRow; onClose: () => void }) {
  const rules = useCollectionRules()
  const m = useCollectionMutations()
  const [picked, setChoice] = useState<string>('')
  const [documentId, setDocumentId] = useState(document?.id ?? account.open[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const templates = rules.data ?? []
  // Con un documento, por defecto el cobro con link de pago; si no, el estado de cuenta.
  const choice = picked || (document ? templates.find((r) => r.name === PAYMENT_LINK_TEMPLATE)?.id ?? '' : 'statement')
  const selected = templates.find((r) => r.id === choice)
  const needsDoc = !!selected && selected.trigger !== 'statement'

  async function send() {
    setError(null)
    if (!choice) return setError('Elige qué enviar')
    try {
      if (choice === 'statement') await m.sendEmail.mutateAsync({ counterpartyId: account.counterparty.id })
      else await m.sendEmail.mutateAsync({ counterpartyId: account.counterparty.id, ruleId: choice, documentId: needsDoc ? documentId || null : null })
      setSent(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open
      title="Enviar correo de cobranza"
      subtitle={account.counterparty.name}
      onClose={onClose}
      footer={sent ? <Button variant="primary" onClick={onClose}>Listo</Button> : <><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={send} disabled={m.sendEmail.isPending}><Mail size={15} /> {m.sendEmail.isPending ? 'Enviando…' : 'Enviar ahora'}</Button></>}
    >
      {sent ? (
        <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Correo enviado. Aparece en la actividad del cliente.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <FormError error={error} />
          <div className="flex flex-col gap-2">
            <label className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', choice === 'statement' ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
              <input type="radio" name="tpl" checked={choice === 'statement'} onChange={() => setChoice('statement')} className="mt-0.5 accent-navy-900" />
              <span><span className="block text-sm font-medium text-ink">Estado de cuenta</span><span className="block text-[12px] text-muted">Todos los documentos con saldo, con el total vencido.</span></span>
            </label>
            {templates.map((r) => (
              <label key={r.id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', choice === r.id ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
                <input type="radio" name="tpl" checked={choice === r.id} onChange={() => setChoice(r.id)} className="mt-0.5 accent-navy-900" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{r.name}</span>
                  <span className="block truncate text-[12px] text-muted">Plantilla · {r.subject}</span>
                </span>
              </label>
            ))}
          </div>
          {needsDoc && (
            <Field label="Documento">
              {(id) => (
                <Select id={id} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                  {account.open.map((d) => <option key={d.id} value={d.id}>{documentTypeLabel(d.doc_type)} N° {d.folio} · {formatMoney(d.pending_amount, d.currency)}{d.days_overdue ? ` · ${d.days_overdue} d de atraso` : ''}</option>)}
                </Select>
              )}
            </Field>
          )}
          <p className="text-[12px] text-muted">Se envía ahora a los correos de cobranza del cliente. Las plantillas se editan en Cobranza › Recordatorios.</p>
        </div>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Configuración del cliente
// ---------------------------------------------------------------------------
function SettingsTab({ counterparty }: { counterparty: Counterparty }) {
  const { tenant, canWrite } = useCurrentTenant()
  const members = useMembers()
  const save = useSaveCounterparty()
  const rules = useCollectionRules()
  const overrides = useCounterpartyRuleSettings(counterparty.id)
  const m = useCollectionMutations()
  const [form, setForm] = useState(() => ({
    payment_terms_days: counterparty.payment_terms_days != null ? String(counterparty.payment_terms_days) : '',
    credit_limit: counterparty.credit_limit != null ? minorToInput(counterparty.credit_limit, tenant.base_currency) : '',
    collection_owner: counterparty.collection_owner ?? '',
    tags: counterparty.tags.join(', '),
    collection_paused: !!counterparty.collection_paused,
  }))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    const days = form.payment_terms_days.trim() ? Number(form.payment_terms_days) : null
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) return setError('El plazo debe estar entre 0 y 365 días')
    const limit = form.credit_limit.trim() ? parseMoneyInput(form.credit_limit, tenant.base_currency) : null
    if (form.credit_limit.trim() && (limit === null || limit < 0)) return setError('Límite de crédito inválido')
    const { id: _id, tenant_id: _t, portal_slug: _s, ...input } = counterparty
    void _id
    void _t
    void _s
    try {
      await save.mutateAsync({
        input: {
          ...input,
          payment_terms_days: days,
          credit_limit: limit,
          collection_owner: form.collection_owner || null,
          collection_paused: form.collection_paused,
          tags: [...new Set(form.tags.split(',').map((t) => t.trim()).filter(Boolean))],
        },
        id: counterparty.id,
      })
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const settingOf = (ruleId: string) => overrides.data?.find((o) => o.rule_id === ruleId)?.enabled
  const automatic = (rules.data ?? []).filter((r) => r.trigger !== 'manual')

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <form onSubmit={submit} className="rounded-xl border border-line bg-white">
        <h3 className="border-b border-line px-5 py-3 text-[14px] font-semibold text-ink">Información de cobranza</h3>
        <div className="flex flex-col gap-4 p-5">
          <FormError error={error} />
          {saved && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Cambios guardados.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plazo de pago (días)">{(id) => <Input id={id} inputMode="numeric" value={form.payment_terms_days} onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value.replace(/\D/g, '') })} disabled={!canWrite} />}</Field>
            <Field label="Responsable de cobranza">
              {(id) => (
                <Select id={id} value={form.collection_owner} onChange={(e) => setForm({ ...form, collection_owner: e.target.value })} disabled={!canWrite}>
                  <option value="">Sin responsable</option>
                  {(members.data ?? []).map((mm) => <option key={mm.user_id} value={mm.user_id}>{mm.full_name || mm.email}</option>)}
                </Select>
              )}
            </Field>
            <Field label={`Límite de crédito (${tenant.base_currency})`} hint="Para ver el crédito utilizado. No bloquea documentos.">{(id) => <Input id={id} inputMode="decimal" className="tabular" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} placeholder="Sin límite" disabled={!canWrite} />}</Field>
            <Field label="Etiquetas" hint="Separadas por coma. Sirven para dirigir recordatorios.">{(id) => <Input id={id} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="VIP, Medios" disabled={!canWrite} />}</Field>
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-navy-900" checked={form.collection_paused} onChange={(e) => setForm({ ...form, collection_paused: e.target.checked })} disabled={!canWrite} />
            <span><span className="block text-sm font-medium text-ink">Pausar recordatorios automáticos</span><span className="block text-[12px] text-muted">Por ejemplo, durante una negociación. Los envíos manuales siguen disponibles.</span></span>
          </label>
          {canWrite && <div className="flex justify-end"><Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar cambios'}</Button></div>}
        </div>
      </form>

      <section className="rounded-xl border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
          <h3 className="text-[14px] font-semibold text-ink">Recordatorios para este cliente</h3>
          <Link to="/cxc/cobranza/recordatorios" className="text-[12px] text-brand-600 hover:underline">Editar recordatorios</Link>
        </div>
        {automatic.length === 0 ? (
          <p className="px-5 py-6 text-sm text-faint">No hay recordatorios configurados.</p>
        ) : (
          <ul className="divide-y divide-line">
            {automatic.map((r) => {
              const override = settingOf(r.id)
              const effective = r.active && ruleAppliesTo(r, counterparty, override)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">{r.name}{!r.active && <Badge>Regla inactiva</Badge>}{override !== undefined && <Badge tone="info">Ajustado para este cliente</Badge>}</span>
                    <span className="inline-block rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{ruleWhen(r)}</span>
                  </span>
                  {override !== undefined && canWrite && (
                    <button type="button" className="text-[12px] text-brand-600 hover:underline" onClick={() => m.setClientRule.mutate({ counterpartyId: counterparty.id, ruleId: r.id, enabled: null })}>Usar la regla general</button>
                  )}
                  <label className="relative inline-flex shrink-0 cursor-pointer" title={counterparty.collection_paused ? 'Cobranza pausada' : undefined}>
                    <input
                      type="checkbox"
                      aria-label={`${r.name} para este cliente`}
                      className="peer sr-only"
                      checked={effective}
                      disabled={!canWrite || !r.active || !!counterparty.collection_paused}
                      onChange={(e) => m.setClientRule.mutate({ counterpartyId: counterparty.id, ruleId: r.id, enabled: e.target.checked })}
                    />
                    <span className="h-5 w-9 rounded-full bg-faint/35 transition-colors peer-checked:bg-navy-900 peer-disabled:opacity-50" />
                    <span className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
