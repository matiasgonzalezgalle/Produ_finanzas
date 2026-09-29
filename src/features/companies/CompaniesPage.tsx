import { Check, Copy, Download, Eye, Pencil, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSaveContact, useSaveCounterparty, useContacts, useCounterparties } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { Contact, Counterparty, CounterpartyInput } from '../../data'
import { CURRENCIES, type Currency } from '../../domain/money'
import { formatTaxId, isValidTaxId, normalizeTaxId, TAX_ID_LABEL, type Country } from '../../domain/taxId'
import { downloadCsv, type CsvColumn } from '../../lib/csv'
import { Badge, Button, Checkbox, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, Textarea } from '../../ui'
import { BulkButton, ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage, useNewParam } from '../shared'
import { CounterpartyDetail } from './CounterpartyDetail'

export type CompaniesTab = 'proveedores' | 'clientes' | 'contactos'

const TABS = [
  { to: '/empresas/proveedores', label: 'Proveedores' },
  { to: '/empresas/clientes', label: 'Clientes' },
  { to: '/empresas/contactos', label: 'Contactos' },
]

function counterpartyKind(cp: Counterparty, tenantCountry: Country) {
  if (cp.country !== tenantCountry) return 'Internacional'
  if (cp.is_supplier && cp.is_customer) return 'Proveedor y cliente'
  return cp.is_supplier ? 'Proveedor' : 'Cliente'
}

const COUNTRY_NAME: Record<string, string> = { CL: 'Chile', PE: 'Perú', AR: 'Argentina', BR: 'Brasil', CO: 'Colombia', ES: 'España', MX: 'México', US: 'Estados Unidos' }

export function CompaniesPage({ tab }: { tab: CompaniesTab }) {
  const [newOpen, setNewOpen] = useNewParam()
  const { canWrite } = useCurrentTenant()
  const createLabel = tab === 'contactos' ? 'Crear contacto' : tab === 'proveedores' ? 'Crear proveedor' : 'Crear cliente'
  return (
    <div>
      <PageHeader
        title="Empresas"
        tabs={TABS}
        actions={canWrite && <Button variant="primary" onClick={() => setNewOpen(true)}>{createLabel}</Button>}
      />
      <div className="pt-5">
        {tab === 'contactos' ? (
          <ContactsList newOpen={newOpen} setNewOpen={setNewOpen} />
        ) : (
          <CounterpartyList key={tab} role={tab === 'proveedores' ? 'supplier' : 'customer'} newOpen={newOpen} setNewOpen={setNewOpen} />
        )}
      </div>
    </div>
  )
}

function CounterpartyList({ role, newOpen, setNewOpen }: { role: 'supplier' | 'customer'; newOpen: boolean; setNewOpen: (v: boolean) => void }) {
  const { tenant, canWrite } = useCurrentTenant()
  const counterparties = useCounterparties()
  const [editing, setEditing] = useState<Counterparty | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const taxLabel = TAX_ID_LABEL[tenant.country]
  const rows = useMemo(() => (counterparties.data ?? []).filter((c) => (role === 'supplier' ? c.is_supplier : c.is_customer)), [counterparties.data, role])
  const taxOf = (c: Counterparty) => (c.tax_id ? formatTaxId(c.tax_id, (c.country as Country) ?? tenant.country) : '')

  const columns: ListColumn<Counterparty>[] = [
    { key: 'name', header: 'Nombre', cell: (c) => c.name, sortValue: (c) => c.name, className: 'min-w-56' },
    { key: 'tax', header: taxLabel, cell: taxOf, sortValue: (c) => c.tax_id ?? '' },
    { key: 'kind', header: 'Tipo', cell: (c) => counterpartyKind(c, tenant.country), sortValue: (c) => counterpartyKind(c, tenant.country) },
    { key: 'country', header: 'País', cell: (c) => COUNTRY_NAME[c.country] ?? c.country, sortValue: (c) => c.country },
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
    { key: 'terms', header: 'Plazo', align: 'right', cell: (c) => (c.payment_terms_days != null ? `${c.payment_terms_days} días` : '—'), sortValue: (c) => c.payment_terms_days ?? -1 },
  ]

  const allTags = [...new Set(rows.flatMap((c) => c.tags))].sort()
  const allCountries = [...new Set(rows.map((c) => c.country))].sort()
  const filters: ListFilter<Counterparty>[] = [
    {
      type: 'select',
      key: 'kind',
      label: 'Tipo',
      options: [
        { value: 'nacional', label: 'Nacional' },
        { value: 'internacional', label: 'Internacional' },
        { value: 'ambos', label: 'Proveedor y cliente' },
      ],
      match: (c, v) => (v === 'internacional' ? c.country !== tenant.country : v === 'nacional' ? c.country === tenant.country : c.is_supplier && c.is_customer),
    },
    { type: 'select', key: 'country', label: 'País', options: allCountries.map((c) => ({ value: c, label: COUNTRY_NAME[c] ?? c })), match: (c, v) => c.country === v },
    { type: 'select', key: 'tag', label: 'Etiqueta', options: allTags.map((t) => ({ value: t, label: t })), match: (c, v) => c.tags.includes(v) },
  ]

  const list = useListState({
    rows,
    rowKey: (c) => c.id,
    columns,
    filters,
    searchText: (c) => `${c.name} ${c.legal_name ?? ''} ${c.tax_id ?? ''} ${taxOf(c)} ${c.tags.join(' ')} ${c.email ?? ''}`,
    storageKey: `counterparties-${role}`,
    defaultSort: { key: 'name', dir: 'asc' },
  })

  const csvColumns: CsvColumn<Counterparty>[] = [
    { header: 'Nombre', value: (c) => c.name },
    { header: 'Razón social', value: (c) => c.legal_name },
    { header: taxLabel, value: taxOf },
    { header: 'Tipo', value: (c) => counterpartyKind(c, tenant.country) },
    { header: 'País', value: (c) => c.country },
    { header: 'Etiquetas', value: (c) => c.tags.join(', ') },
    { header: 'Correo', value: (c) => c.email },
    { header: 'Teléfono', value: (c) => c.phone },
    { header: 'Plazo (días)', value: (c) => c.payment_terms_days },
  ]
  const label = role === 'supplier' ? 'proveedores' : 'clientes'

  return (
    <>
      <ListView
        state={list}
        columns={columns}
        rowKey={(c) => c.id}
        filters={filters}
        loading={counterparties.isLoading}
        searchPlaceholder={`Buscar por nombre, ${taxLabel} o etiqueta…`}
        onRowClick={(c) => setDetailId(c.id)}
        toolbarExtra={
          <Button size="sm" onClick={() => downloadCsv(`${label}.csv`, list.filtered, csvColumns)} disabled={!list.total}>
            <Download size={16} /> Exportar
          </Button>
        }
        bulkActions={(selected) => (
          <BulkButton onClick={() => downloadCsv(`${label}-seleccion.csv`, selected, csvColumns)}>
            <Download size={15} /> Exportar selección
          </BulkButton>
        )}
        rowActions={(c) => (
          <>
            {c.tax_id && (
              <RowAction
                label={`Copiar ${taxLabel}`}
                onClick={() => navigator.clipboard?.writeText(taxOf(c)).then(() => {
                  setCopied(c.id)
                  setTimeout(() => setCopied(null), 1500)
                })}
              >
                {copied === c.id ? <Check size={17} className="text-ok" /> : <Copy size={17} />}
              </RowAction>
            )}
            <RowAction label="Ver detalle" onClick={() => setDetailId(c.id)}>
              <Eye size={17} />
            </RowAction>
            {canWrite && (
              <RowAction label="Editar" onClick={() => setEditing(c)}>
                <Pencil size={17} />
              </RowAction>
            )}
          </>
        )}
        empty={
          <EmptyState
            icon={<Users size={20} />}
            title={rows.length ? 'Sin resultados' : role === 'supplier' ? 'Aún no tienes proveedores' : 'Aún no tienes clientes'}
            description={rows.length ? 'Prueba con otra búsqueda o filtro.' : 'Regístralos para asociarles documentos, pagos y cobros.'}
          />
        }
      />
      {detailId && rows.find((c) => c.id === detailId) && (
        <CounterpartyDetail
          counterparty={rows.find((c) => c.id === detailId)!}
          role={role}
          onClose={() => setDetailId(null)}
          onEdit={() => setEditing(rows.find((c) => c.id === detailId)!)}
        />
      )}
      <CounterpartyDrawer
        key={editing?.id ?? (newOpen ? 'new' : 'closed')}
        open={newOpen || !!editing}
        counterparty={editing}
        defaultRole={role}
        onClose={() => {
          setEditing(null)
          setNewOpen(false)
        }}
      />
    </>
  )
}

function ContactsList({ newOpen, setNewOpen }: { newOpen: boolean; setNewOpen: (v: boolean) => void }) {
  const { canWrite } = useCurrentTenant()
  const contacts = useContacts()
  const counterparties = useCounterparties()
  const [editing, setEditing] = useState<Contact | null>(null)
  const rows = contacts.data ?? []

  const columns: ListColumn<Contact>[] = [
    { key: 'name', header: 'Nombre', cell: (c) => c.name, sortValue: (c) => c.name },
    { key: 'company', header: 'Empresa', cell: (c) => c.counterparty_name ?? '—', sortValue: (c) => c.counterparty_name ?? '' },
    { key: 'position', header: 'Cargo', cell: (c) => c.position ?? '', sortValue: (c) => c.position ?? '' },
    { key: 'email', header: 'Correo', cell: (c) => (c.email ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">{c.email}</a> : '') },
    { key: 'phone', header: 'Teléfono', cell: (c) => c.phone ?? '' },
  ]
  const filters: ListFilter<Contact>[] = [
    {
      type: 'select',
      key: 'company',
      label: 'Empresa',
      options: (counterparties.data ?? []).filter((cp) => rows.some((c) => c.counterparty_id === cp.id)).map((cp) => ({ value: cp.id, label: cp.name })),
      match: (c, v) => c.counterparty_id === v,
    },
  ]
  const list = useListState({
    rows,
    rowKey: (c) => c.id,
    columns,
    filters,
    searchText: (c) => `${c.name} ${c.email ?? ''} ${c.phone ?? ''} ${c.position ?? ''} ${c.counterparty_name ?? ''}`,
    storageKey: 'contacts',
    defaultSort: { key: 'name', dir: 'asc' },
  })
  const csvColumns: CsvColumn<Contact>[] = [
    { header: 'Nombre', value: (c) => c.name },
    { header: 'Empresa', value: (c) => c.counterparty_name },
    { header: 'Cargo', value: (c) => c.position },
    { header: 'Correo', value: (c) => c.email },
    { header: 'Teléfono', value: (c) => c.phone },
  ]

  return (
    <>
      <ListView
        state={list}
        columns={columns}
        rowKey={(c) => c.id}
        filters={filters}
        loading={contacts.isLoading}
        searchPlaceholder="Buscar por nombre, correo o empresa…"
        onRowClick={canWrite ? setEditing : undefined}
        toolbarExtra={
          <Button size="sm" onClick={() => downloadCsv('contactos.csv', list.filtered, csvColumns)} disabled={!list.total}>
            <Download size={16} /> Exportar
          </Button>
        }
        bulkActions={(selected) => (
          <BulkButton onClick={() => downloadCsv('contactos-seleccion.csv', selected, csvColumns)}>
            <Download size={15} /> Exportar selección
          </BulkButton>
        )}
        rowActions={(c) =>
          canWrite ? (
            <RowAction label="Editar" onClick={() => setEditing(c)}>
              <Pencil size={17} />
            </RowAction>
          ) : null
        }
        empty={<EmptyState icon={<Users size={20} />} title={rows.length ? 'Sin resultados' : 'Sin contactos'} description={rows.length ? 'Prueba con otra búsqueda o filtro.' : 'Agrega las personas con las que coordinas pagos y cobranza.'} />}
      />
      <ContactDrawer
        key={editing?.id ?? (newOpen ? 'new' : 'closed')}
        open={newOpen || !!editing}
        contact={editing}
        counterparties={counterparties.data ?? []}
        onClose={() => {
          setEditing(null)
          setNewOpen(false)
        }}
      />
    </>
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
