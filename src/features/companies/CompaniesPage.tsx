import { Check, Copy, SlidersHorizontal, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSaveContact, useSaveCounterparty, useContacts, useCounterparties } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { Contact, Counterparty, CounterpartyInput } from '../../data'
import { CURRENCIES, type Currency } from '../../domain/money'
import { formatTaxId, isValidTaxId, normalizeTaxId, TAX_ID_LABEL, type Country } from '../../domain/taxId'
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  FormError,
  IconButton,
  Input,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Textarea,
  type Column,
} from '../../ui'
import { errorMessage, normalizeSearch, paginate, useNewParam } from '../shared'

export type CompaniesTab = 'proveedores' | 'clientes' | 'contactos'

const TABS = [
  { to: '/empresas/proveedores', label: 'Proveedores' },
  { to: '/empresas/clientes', label: 'Clientes' },
  { to: '/empresas/contactos', label: 'Contactos' },
]

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="rounded-md p-2 text-faint hover:bg-subtle hover:text-ink"
    >
      {copied ? <Check size={18} className="text-ok" /> : <Copy size={18} />}
    </button>
  )
}

function counterpartyKind(cp: Counterparty, tenantCountry: Country) {
  if (cp.country !== tenantCountry) return 'Internacional'
  if (cp.is_supplier && cp.is_customer) return 'Proveedor y cliente'
  return cp.is_supplier ? 'Proveedor' : 'Cliente'
}

export function CompaniesPage({ tab }: { tab: CompaniesTab }) {
  const { tenant, canWrite } = useCurrentTenant()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [newOpen, setNewOpen] = useNewParam()
  const [editing, setEditing] = useState<Counterparty | null>(null)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const counterparties = useCounterparties()
  const contacts = useContacts()

  const filtered = useMemo(() => {
    const q = normalizeSearch(search)
    const list = (counterparties.data ?? []).filter((c) => (tab === 'proveedores' ? c.is_supplier : c.is_customer))
    if (!q) return list
    return list.filter((c) => normalizeSearch(`${c.name} ${c.legal_name ?? ''} ${c.tax_id ?? ''} ${c.tags.join(' ')}`).includes(q))
  }, [counterparties.data, search, tab])

  const filteredContacts = useMemo(() => {
    const q = normalizeSearch(search)
    const list = contacts.data ?? []
    if (!q) return list
    return list.filter((c) => normalizeSearch(`${c.name} ${c.email ?? ''} ${c.counterparty_name ?? ''}`).includes(q))
  }, [contacts.data, search])

  const isContacts = tab === 'contactos'
  const createLabel = isContacts ? 'Crear contacto' : tab === 'proveedores' ? 'Crear proveedor' : 'Crear cliente'

  const columns: Column<Counterparty>[] = [
    { key: 'name', header: 'Nombre', cell: (c) => <span className="text-ink/85">{c.name}</span>, className: 'w-[45%]' },
    { key: 'tax', header: TAX_ID_LABEL[tenant.country], cell: (c) => (c.tax_id ? formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country) : '') },
    { key: 'kind', header: 'Tipo', cell: (c) => counterpartyKind(c, tenant.country) },
    {
      key: 'tags',
      header: 'Etiquetas',
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'copy',
      header: <span className="pr-2">Copiar</span>,
      align: 'center',
      className: 'w-24',
      cell: (c) => (c.tax_id ? <CopyButton value={formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country)} label={`Copiar ${TAX_ID_LABEL[tenant.country]}`} /> : null),
    },
  ]

  const contactColumns: Column<Contact>[] = [
    { key: 'name', header: 'Nombre', cell: (c) => <span className="text-ink/85">{c.name}</span> },
    { key: 'company', header: 'Empresa', cell: (c) => c.counterparty_name ?? '—' },
    { key: 'position', header: 'Cargo', cell: (c) => c.position ?? '' },
    { key: 'email', header: 'Correo', cell: (c) => c.email ?? '' },
    { key: 'phone', header: 'Teléfono', cell: (c) => c.phone ?? '' },
  ]

  const paged = paginate(filtered, page)
  const pagedContacts = paginate(filteredContacts, page)

  return (
    <div>
      <PageHeader
        title="Empresas"
        tabs={TABS}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}>{createLabel}</Button>}
      />
      <div className="flex items-center justify-between gap-3 py-4">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder={isContacts ? 'Buscar contacto…' : 'Buscar por nombre, RUT o etiqueta…'} />
        <IconButton label="Filtros"><SlidersHorizontal size={18} /></IconButton>
      </div>

      {isContacts ? (
        <>
          <DataTable
            columns={contactColumns}
            rows={pagedContacts.rows}
            rowKey={(c) => c.id}
            loading={contacts.isLoading}
            onRowClick={canWrite ? setEditingContact : undefined}
            empty={<EmptyState icon={<Users size={20} />} title="Sin contactos" description="Agrega las personas con las que coordinas pagos y cobranza." />}
          />
          <Pagination page={pagedContacts.page} pages={pagedContacts.pages} onChange={setPage} />
        </>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={paged.rows}
            rowKey={(c) => c.id}
            loading={counterparties.isLoading}
            onRowClick={canWrite ? setEditing : undefined}
            empty={
              <EmptyState
                icon={<Users size={20} />}
                title={tab === 'proveedores' ? 'Aún no tienes proveedores' : 'Aún no tienes clientes'}
                description="Regístralos para asociarles documentos, pagos y cobros."
              />
            }
          />
          <Pagination page={paged.page} pages={paged.pages} onChange={setPage} />
        </>
      )}

      {!isContacts && (
        <CounterpartyDrawer
          key={editing?.id ?? (newOpen ? 'new' : 'closed')}
          open={newOpen || !!editing}
          counterparty={editing}
          defaultRole={tab === 'proveedores' ? 'supplier' : 'customer'}
          onClose={() => {
            setEditing(null)
            setNewOpen(false)
          }}
        />
      )}
      {isContacts && (
        <ContactDrawer
          key={editingContact?.id ?? (newOpen ? 'new' : 'closed')}
          open={newOpen || !!editingContact}
          contact={editingContact}
          counterparties={counterparties.data ?? []}
          onClose={() => {
            setEditingContact(null)
            setNewOpen(false)
          }}
        />
      )}
    </div>
  )
}

const OTHER_COUNTRIES = [
  { code: 'AR', name: 'Argentina' },
  { code: 'BR', name: 'Brasil' },
  { code: 'CO', name: 'Colombia' },
  { code: 'ES', name: 'España' },
  { code: 'MX', name: 'México' },
  { code: 'US', name: 'Estados Unidos' },
]

export function CounterpartyDrawer({
  open,
  counterparty,
  defaultRole,
  onClose,
  onSaved,
}: {
  open: boolean
  counterparty: Counterparty | null
  defaultRole: 'supplier' | 'customer'
  onClose: () => void
  onSaved?: (cp: Counterparty) => void
}) {
  const { tenant } = useCurrentTenant()
  const save = useSaveCounterparty()
  const [form, setForm] = useState<CounterpartyInput>(() =>
    counterparty
      ? { ...counterparty }
      : {
          name: '', legal_name: '', country: tenant.country, tax_id: '', is_supplier: defaultRole === 'supplier',
          is_customer: defaultRole === 'customer', tags: [], email: '', phone: '', address: '', default_currency: null,
          payment_terms_days: 30, notes: '',
        },
  )
  const [tagsText, setTagsText] = useState(counterparty?.tags.join(', ') ?? '')
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof CounterpartyInput>(key: K, value: CounterpartyInput[K]) => setForm((f) => ({ ...f, [key]: value }))

  const localCountry = form.country === 'CL' || form.country === 'PE' ? (form.country as Country) : null
  const taxIdError =
    form.tax_id && localCountry && !isValidTaxId(form.tax_id, localCountry) ? `${TAX_ID_LABEL[localCountry]} inválido` : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name.trim()) return setError('El nombre es obligatorio')
    if (!form.is_supplier && !form.is_customer) return setError('Marca si es proveedor, cliente o ambos')
    if (taxIdError) return setError(taxIdError)
    const input: CounterpartyInput = {
      ...form,
      name: form.name.trim(),
      tax_id: form.tax_id ? (localCountry ? normalizeTaxId(form.tax_id, localCountry) : form.tax_id.trim()) : null,
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      email: form.email?.trim() || null,
      phone: form.phone?.trim() || null,
      address: form.address?.trim() || null,
      legal_name: form.legal_name?.trim() || null,
      notes: form.notes?.trim() || null,
    }
    try {
      const saved = await save.mutateAsync({ input, id: counterparty?.id })
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const title = counterparty ? 'Editar empresa' : defaultRole === 'supplier' ? 'Nuevo proveedor' : 'Nuevo cliente'
  return (
    <Drawer
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="counterparty-form" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form id="counterparty-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />}</Field>
        <Field label="Razón social">{(id) => <Input id={id} value={form.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="País">
            {(id) => (
              <Select id={id} value={form.country} onChange={(e) => set('country', e.target.value)}>
                <option value="CL">Chile</option>
                <option value="PE">Perú</option>
                {OTHER_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={localCountry ? TAX_ID_LABEL[localCountry] : 'Identificador tributario'} error={taxIdError}>
            {(id) => (
              <Input
                id={id}
                value={form.tax_id ?? ''}
                onChange={(e) => set('tax_id', e.target.value)}
                onBlur={() => form.tax_id && localCountry && isValidTaxId(form.tax_id, localCountry) && set('tax_id', formatTaxId(form.tax_id, localCountry))}
                placeholder={localCountry === 'CL' ? '76.123.456-7' : localCountry === 'PE' ? '20123456789' : ''}
              />
            )}
          </Field>
        </div>
        <div className="flex gap-6">
          <Checkbox label="Proveedor" checked={form.is_supplier} onChange={(v) => set('is_supplier', v)} />
          <Checkbox label="Cliente" checked={form.is_customer} onChange={(v) => set('is_customer', v)} />
        </div>
        <Field label="Etiquetas" hint="Separadas por coma">{(id) => <Input id={id} value={tagsText} onChange={(e) => setTagsText(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Correo">{(id) => <Input id={id} type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />}</Field>
          <Field label="Teléfono">{(id) => <Input id={id} value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />}</Field>
        </div>
        <Field label="Dirección">{(id) => <Input id={id} value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Plazo de pago (días)">
            {(id) => (
              <Input id={id} type="number" min={0} max={365} value={form.payment_terms_days ?? ''} onChange={(e) => set('payment_terms_days', e.target.value === '' ? null : Number(e.target.value))} />
            )}
          </Field>
          <Field label="Moneda habitual">
            {(id) => (
              <Select id={id} value={form.default_currency ?? ''} onChange={(e) => set('default_currency', (e.target.value || null) as Currency | null)}>
                <option value="">—</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notas">{(id) => <Textarea id={id} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />}</Field>
      </form>
    </Drawer>
  )
}

function ContactDrawer({ open, contact, counterparties, onClose }: { open: boolean; contact: Contact | null; counterparties: Counterparty[]; onClose: () => void }) {
  const save = useSaveContact()
  const [form, setForm] = useState({
    counterparty_id: contact?.counterparty_id ?? counterparties[0]?.id ?? '',
    name: contact?.name ?? '',
    position: contact?.position ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.name.trim() || !form.counterparty_id) return setError('Nombre y empresa son obligatorios')
    try {
      await save.mutateAsync({
        input: { counterparty_id: form.counterparty_id, name: form.name.trim(), position: form.position || null, email: form.email || null, phone: form.phone || null },
        id: contact?.id,
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open={open}
      title={contact ? 'Editar contacto' : 'Nuevo contacto'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="contact-form" disabled={save.isPending}>Guardar</Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Empresa">
          {(id) => (
            <Select id={id} value={form.counterparty_id} onChange={(e) => setForm({ ...form, counterparty_id: e.target.value })}>
              {counterparties.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Cargo">{(id) => <Input id={id} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Correo">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label="Teléfono">{(id) => <Input id={id} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        </div>
      </form>
    </Drawer>
  )
}
