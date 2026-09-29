// Detalle de una empresa (proveedor/cliente): documentos, datos, información de pago y contactos.
import { AlertCircle, ArrowLeft, CircleDollarSign, FileText, Landmark, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useBankAccountMutations, useBankAccounts, useContacts, useDocuments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { BankAccount, BankAccountInput, Counterparty, DocumentRow } from '../../data'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { CURRENCIES, sumByCurrency, type Currency } from '../../domain/money'
import { formatTaxId, isValidTaxId, normalizeTaxId, TAX_ID_LABEL, type Country } from '../../domain/taxId'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, Select } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage, Money, MoneyTotals, StatusBadge } from '../shared'

type Tab = 'documentos' | 'datos' | 'pago' | 'contactos'

const FLAG: Record<string, string> = { CL: '🇨🇱', PE: '🇵🇪', AR: '🇦🇷', BR: '🇧🇷', CO: '🇨🇴', ES: '🇪🇸', MX: '🇲🇽', US: '🇺🇸' }

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
}

export function CounterpartyDetail({
  counterparty,
  role,
  onClose,
  onEdit,
  onOpenDocument,
}: {
  counterparty: Counterparty
  role: 'supplier' | 'customer'
  onClose: () => void
  onEdit: () => void
  onOpenDocument?: (doc: DocumentRow) => void
}) {
  const { tenant } = useCurrentTenant()
  const [tab, setTab] = useState<Tab>('documentos')
  const roleLabel = role === 'supplier' ? 'proveedor' : 'cliente'
  const country = (counterparty.country as Country) ?? tenant.country
  const taxId = counterparty.tax_id ? formatTaxId(counterparty.tax_id, country === 'CL' || country === 'PE' ? country : tenant.country) : null

  const header = (
    <div className="border-b border-line px-6 pt-6">
      <div className="flex items-center gap-4">
        <button type="button" onClick={onClose} aria-label="Volver" className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-ink shadow-xs hover:bg-subtle">
          <ArrowLeft size={18} />
        </button>
        <span className="relative flex size-14 shrink-0 items-center justify-center rounded-full bg-head text-lg font-semibold text-navy-900">
          {initials(counterparty.name) || '?'}
          {FLAG[counterparty.country] && <span className="absolute -right-0.5 -bottom-0.5 text-base leading-none">{FLAG[counterparty.country]}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold text-ink">{counterparty.name}</h2>
          <p className="text-sm text-muted">
            {taxId ?? 'Sin identificador tributario'}
            {counterparty.is_supplier && counterparty.is_customer && <span className="text-faint"> · Proveedor y cliente</span>}
          </p>
        </div>
        <Button onClick={onEdit}><Pencil size={16} /> Editar</Button>
      </div>
      <nav className="mt-5 -mb-px flex gap-7 overflow-x-auto" aria-label="Secciones de la empresa">
        {([
          ['documentos', 'Documentos'],
          ['datos', `Datos del ${roleLabel}`],
          ['pago', 'Información de pago'],
          ['contactos', 'Contactos'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={cn('border-b-2 pb-3 text-[15px] whitespace-nowrap', tab === key ? 'border-brand-600 font-medium text-brand-600' : 'border-transparent text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  )

  return (
    <Drawer open width="xl" title={counterparty.name} onClose={onClose} header={header}>
      {tab === 'documentos' && <DocumentsTab counterparty={counterparty} role={role} onOpenDocument={onOpenDocument} />}
      {tab === 'datos' && <DataTab counterparty={counterparty} taxId={taxId} onEdit={onEdit} />}
      {tab === 'pago' && <PaymentInfoTab counterparty={counterparty} />}
      {tab === 'contactos' && <ContactsTab counterparty={counterparty} />}
    </Drawer>
  )
}

function SummaryCard({ icon, tone, label, value }: { icon: React.ReactNode; tone: 'blue' | 'red'; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(13,14,17,.04)]">
      <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-xl text-white', tone === 'blue' ? 'bg-brand-500' : 'bg-bad')}>{icon}</span>
      <div className="min-w-0">
        <div className="text-sm text-muted">{label}</div>
        <div className="text-xl font-semibold text-ink tabular">{value}</div>
      </div>
    </div>
  )
}

function DocumentsTab({ counterparty, role, onOpenDocument }: { counterparty: Counterparty; role: 'supplier' | 'customer'; onOpenDocument?: (doc: DocumentRow) => void }) {
  const both = counterparty.is_supplier && counterparty.is_customer
  const [direction, setDirection] = useState<'payable' | 'receivable'>(role === 'supplier' ? 'payable' : 'receivable')
  const documents = useDocuments(direction)
  const rows = useMemo(() => (documents.data ?? []).filter((d) => d.counterparty_id === counterparty.id), [documents.data, counterparty.id])
  const open = rows.filter((d) => d.pending_amount > 0)
  const overdue = open.filter((d) => d.payment_status === 'vencido')
  const pick = (d: DocumentRow) => ({ currency: d.currency, amount: d.pending_amount })
  const verb = direction === 'payable' ? 'pagar' : 'cobrar'

  const columns: ListColumn<DocumentRow>[] = [
    { key: 'folio', header: 'Número', cell: (d) => <span className="flex flex-col leading-tight"><span>N° {d.folio}</span><span className="text-xs font-normal text-faint">{documentTypeLabel(d.doc_type)}</span></span>, sortValue: (d) => d.folio.padStart(12, '0') },
    { key: 'issue', mobileHidden: true, header: 'Emisión', cell: (d) => formatDate(d.issue_date), sortValue: (d) => d.issue_date },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date), sortValue: (d) => d.due_date },
    { key: 'total', header: 'Monto', align: 'right', cell: (d) => <Money minor={d.total_amount} currency={d.currency} />, sortValue: (d) => d.total_amount },
    { key: 'pending', header: `Monto a ${verb}`, align: 'right', cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className={d.pending_amount ? 'font-semibold text-ink' : ''} />, sortValue: (d) => d.pending_amount },
    { key: 'status', mobileBadge: true, header: 'Estado', cell: (d) => <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />, sortValue: (d) => d.days_overdue },
  ]
  const filters: ListFilter<DocumentRow>[] = [
    {
      type: 'select',
      key: 'status',
      label: 'Estado del pago',
      options: [
        { value: 'abiertos', label: 'Con saldo pendiente' },
        { value: 'vencido', label: 'Vencidos' },
        { value: 'parcial', label: 'Pago parcial' },
        { value: 'pagado', label: 'Pagados' },
        { value: 'anulado', label: 'Anulados' },
      ],
      match: (d, v) => (v === 'abiertos' ? d.pending_amount > 0 : d.payment_status === v),
    },
    { type: 'dateRange', key: 'due', label: 'Vencimiento', getDate: (d) => d.due_date },
  ]
  const list = useListState({
    rows,
    rowKey: (d) => d.id,
    columns,
    filters,
    searchText: (d) => d.folio,
    storageKey: 'counterparty-documents',
    defaultSort: { key: 'due', dir: 'desc' },
  })

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-ink">Resumen</h3>
        {both && (
          <div className="flex gap-1 rounded-lg bg-subtle p-1 text-sm">
            {(['payable', 'receivable'] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDirection(d)} className={cn('rounded-md px-3 py-1.5', direction === d ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted')}>
                {d === 'payable' ? 'Por pagar' : 'Por cobrar'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="stat-row sm:grid-cols-3 sm:gap-4">
        <SummaryCard icon={<FileText size={22} />} tone="blue" label={`Documentos por ${verb}`} value={open.length} />
        <SummaryCard icon={<CircleDollarSign size={22} />} tone="blue" label={`Monto por ${verb}`} value={<MoneyTotals totals={sumByCurrency(open, pick)} empty="$0" />} />
        <SummaryCard icon={<AlertCircle size={22} />} tone="red" label="Monto atrasado" value={<MoneyTotals totals={sumByCurrency(overdue, pick)} empty="$0" />} />
      </div>
      <ListView
        state={list}
        columns={columns}
        rowKey={(d) => d.id}
        filters={filters}
        loading={documents.isLoading}
        searchPlaceholder="N° Folio"
        onRowClick={onOpenDocument}
        empty={<EmptyState icon={<FileText size={20} />} title={rows.length ? 'Sin documentos para estos filtros' : 'Esta empresa no tiene documentos'} />}
      />
    </div>
  )
}

function DataTab({ counterparty, taxId, onEdit }: { counterparty: Counterparty; taxId: string | null; onEdit: () => void }) {
  const items: [string, React.ReactNode][] = [
    ['Nombre', counterparty.name],
    ['Razón social', counterparty.legal_name || '—'],
    [TAX_ID_LABEL[(counterparty.country as Country)] ?? 'Identificador tributario', taxId ?? '—'],
    ['País', counterparty.country],
    ['Tipo', counterparty.is_supplier && counterparty.is_customer ? 'Proveedor y cliente' : counterparty.is_supplier ? 'Proveedor' : 'Cliente'],
    ['Correo', counterparty.email || '—'],
    ['Teléfono', counterparty.phone || '—'],
    ['Dirección', counterparty.address || '—'],
    ['Plazo de pago', counterparty.payment_terms_days != null ? `${counterparty.payment_terms_days} días` : '—'],
    ['Moneda habitual', counterparty.default_currency ?? '—'],
    ['Etiquetas', counterparty.tags.length ? <span className="flex flex-wrap justify-end gap-1">{counterparty.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : '—'],
  ]
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <dl className="divide-y divide-line rounded-xl border border-line">
        {items.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-6 px-4 py-3 text-sm">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {counterparty.notes && <p className="rounded-xl border border-line p-4 text-sm text-muted">{counterparty.notes}</p>}
      <Button className="self-start" onClick={onEdit}><Pencil size={16} /> Editar datos</Button>
    </div>
  )
}

const ACCOUNT_TYPES = ['Cuenta corriente', 'Cuenta vista', 'Cuenta de ahorro', 'Cuenta RUT', 'Cuenta interbancaria (CCI)', 'Otra']

function PaymentInfoTab({ counterparty }: { counterparty: Counterparty }) {
  const { canWrite } = useCurrentTenant()
  const accounts = useBankAccounts(counterparty.id)
  const { remove } = useBankAccountMutations(counterparty.id)
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = accounts.data ?? []

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Cuentas donde se le paga a esta empresa. Los proveedores las ven en su portal financiero.</p>
        {canWrite && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} /> Agregar cuenta</Button>}
      </div>
      <FormError error={error} />
      {accounts.isLoading ? (
        <p className="text-sm text-faint">Cargando…</p>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-line">
          <EmptyState icon={<Landmark size={20} />} title="Sin cuentas bancarias" description="Agrega la cuenta para tener a mano los datos al momento de pagar." />
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((b) => (
            <li key={b.id} className="rounded-xl border border-line p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-head text-navy-900"><Landmark size={18} /></span>
                  <div>
                    <div className="font-medium text-ink">{b.bank_name}</div>
                    <div className="text-sm text-muted">{b.account_type ?? 'Cuenta'}{b.currency ? ` · ${b.currency}` : ''}</div>
                  </div>
                </div>
                {canWrite && (
                  <div className="flex">
                    <RowAction label="Editar cuenta" onClick={() => setEditing(b)}><Pencil size={16} /></RowAction>
                    <RowAction
                      label="Eliminar cuenta"
                      tone="danger"
                      onClick={async () => {
                        if (!window.confirm(`¿Eliminar la cuenta ${b.bank_name} ${b.account_number}?`)) return
                        setError(null)
                        try {
                          await remove.mutateAsync(b.id)
                        } catch (err) {
                          setError(errorMessage(err))
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </RowAction>
                  </div>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-faint">N° de cuenta</dt>
                <dd className="text-right font-medium tabular text-ink">{b.account_number}</dd>
                <dt className="text-faint">Titular</dt>
                <dd className="truncate text-right text-ink">{b.holder_name || '—'}</dd>
                <dt className="text-faint">RUT/RUC titular</dt>
                <dd className="text-right text-ink">{b.holder_tax_id ? formatTaxId(b.holder_tax_id, counterparty.country === 'PE' ? 'PE' : 'CL') : '—'}</dd>
                <dt className="text-faint">Correo de aviso</dt>
                <dd className="truncate text-right text-ink">{b.email || '—'}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <BankAccountDrawer
          key={editing === 'new' ? 'new' : editing.id}
          counterparty={counterparty}
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function BankAccountDrawer({ counterparty, account, onClose }: { counterparty: Counterparty; account: BankAccount | null; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const { save } = useBankAccountMutations(counterparty.id)
  const [form, setForm] = useState<BankAccountInput>(
    account ?? {
      counterparty_id: counterparty.id,
      bank_name: '',
      account_type: 'Cuenta corriente',
      account_number: '',
      holder_name: counterparty.legal_name || counterparty.name,
      holder_tax_id: counterparty.tax_id,
      email: counterparty.email,
      currency: counterparty.default_currency ?? tenant.base_currency,
    },
  )
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof BankAccountInput>(k: K, v: BankAccountInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const holderCountry: Country = counterparty.country === 'PE' ? 'PE' : 'CL'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.bank_name.trim() || !form.account_number.trim()) return setError('Banco y número de cuenta son obligatorios')
    if (form.holder_tax_id && (counterparty.country === 'CL' || counterparty.country === 'PE') && !isValidTaxId(form.holder_tax_id, holderCountry)) {
      return setError(`${TAX_ID_LABEL[holderCountry]} del titular inválido`)
    }
    try {
      await save.mutateAsync({
        input: {
          ...form,
          bank_name: form.bank_name.trim(),
          account_number: form.account_number.replace(/\s+/g, ''),
          holder_name: form.holder_name?.trim() || null,
          holder_tax_id: form.holder_tax_id ? normalizeTaxId(form.holder_tax_id, holderCountry) : null,
          email: form.email?.trim() || null,
        },
        id: account?.id,
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open
      title={account ? 'Editar cuenta bancaria' : 'Nueva cuenta bancaria'}
      subtitle={counterparty.name}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="bank-form" disabled={save.isPending}>Guardar</Button>
        </>
      }
    >
      <form id="bank-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Banco">{(id) => <Input id={id} value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} placeholder="Ej: Banco de Chile, BCP" autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tipo de cuenta">
            {(id) => (
              <Select id={id} value={form.account_type ?? ''} onChange={(e) => set('account_type', e.target.value || null)}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Moneda">
            {(id) => (
              <Select id={id} value={form.currency ?? ''} onChange={(e) => set('currency', (e.target.value || null) as Currency | null)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="N° de cuenta">{(id) => <Input id={id} value={form.account_number} onChange={(e) => set('account_number', e.target.value)} inputMode="numeric" />}</Field>
        <Field label="Titular">{(id) => <Input id={id} value={form.holder_name ?? ''} onChange={(e) => set('holder_name', e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`${TAX_ID_LABEL[holderCountry]} del titular`}>{(id) => <Input id={id} value={form.holder_tax_id ?? ''} onChange={(e) => set('holder_tax_id', e.target.value)} />}</Field>
          <Field label="Correo de aviso de pago">{(id) => <Input id={id} type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />}</Field>
        </div>
      </form>
    </Drawer>
  )
}

function ContactsTab({ counterparty }: { counterparty: Counterparty }) {
  const contacts = useContacts()
  const list = (contacts.data ?? []).filter((c) => c.counterparty_id === counterparty.id)
  if (contacts.isLoading) return <p className="text-sm text-faint">Cargando…</p>
  if (!list.length) {
    return (
      <div className="rounded-xl border border-line">
        <EmptyState icon={<Users size={20} />} title="Sin contactos" description="Agrégalos desde Empresas › Contactos." />
      </div>
    )
  }
  return (
    <ul className="grid max-w-3xl gap-3 sm:grid-cols-2">
      {list.map((c) => (
        <li key={c.id} className="rounded-xl border border-line p-4 text-sm">
          <div className="font-medium text-ink">{c.name}</div>
          {c.position && <div className="text-muted">{c.position}</div>}
          {c.email && <a href={`mailto:${c.email}`} className="mt-2 block text-brand-600 hover:underline">{c.email}</a>}
          {c.phone && <div className="text-muted">{c.phone}</div>}
        </li>
      ))}
    </ul>
  )
}
