// Administradores de cuentas por pagar y por cobrar (Configuración).
//   CxP: preferencias, tipos de documento, categorías de gasto, centros de costos y formas de pago.
//   CxC: preferencias, tipos de documento, formas de cobro y categorías de ingreso.
import { Plus, Power, Star } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  useCatalogMutations,
  useCategories,
  useCostCenters,
  useDocumentTypeSettings,
  useModuleSettings,
  usePaymentMethods,
  useSaveDocumentTypeSetting,
  useSaveModuleSettings,
  useSavePaymentMethod,
} from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { AccountingCategory, ModuleSettings, PaymentMethod } from '../../data'
import { DOCUMENT_TYPES, type DocumentDirection, type DocumentTypeCode } from '../../domain/documents'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, Select } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage } from '../shared'
import { Section } from './parts'

type SectionKey = 'preferencias' | 'documentos' | 'categorias' | 'centros' | 'formas'

const SECTIONS: Record<DocumentDirection, { key: SectionKey; label: string }[]> = {
  payable: [
    { key: 'preferencias', label: 'Preferencias' },
    { key: 'documentos', label: 'Tipos de documento' },
    { key: 'categorias', label: 'Categorías' },
    { key: 'centros', label: 'Centros de costos' },
    { key: 'formas', label: 'Formas de pago' },
  ],
  receivable: [
    { key: 'preferencias', label: 'Preferencias' },
    { key: 'documentos', label: 'Documentos' },
    { key: 'formas', label: 'Formas de pago' },
    { key: 'categorias', label: 'Categorías' },
  ],
}

export function ModuleAdmin({ direction }: { direction: DocumentDirection }) {
  const [params, setParams] = useSearchParams()
  const sections = SECTIONS[direction]
  const current = (sections.find((s) => s.key === params.get('seccion'))?.key ?? 'preferencias') as SectionKey
  const select = (key: SectionKey) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (key === 'preferencias') next.delete('seccion')
        else next.set('seccion', key)
        return next
      },
      { replace: true },
    )

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <nav className="flex shrink-0 gap-1 overflow-x-auto lg:w-52 lg:flex-col" aria-label={direction === 'payable' ? 'Administrador de cuentas por pagar' : 'Administrador de cuentas por cobrar'}>
        <p className="hidden px-3 pb-1 text-[10px] font-semibold tracking-wider text-faint uppercase lg:block">
          {direction === 'payable' ? 'Administrador CxP' : 'Administrador CxC'}
        </p>
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => select(s.key)}
            aria-current={current === s.key ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-left text-[13px] whitespace-nowrap',
              current === s.key ? 'bg-head font-medium text-ink' : 'text-muted hover:bg-subtle hover:text-ink',
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {current === 'preferencias' && <PreferencesSection key={direction} direction={direction} />}
        {current === 'documentos' && <DocumentTypesSection direction={direction} />}
        {current === 'categorias' && <CategoriesSection direction={direction} />}
        {current === 'centros' && <CostCentersSection />}
        {current === 'formas' && <PaymentMethodsSection direction={direction} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preferencias
// ---------------------------------------------------------------------------
function ToggleRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('flex items-start justify-between gap-4 py-3', disabled ? 'cursor-default' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-[12px] text-muted">{description}</span>
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-faint/35 transition-colors peer-checked:bg-navy-900 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 peer-disabled:opacity-60" />
        <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  )
}

function PreferencesSection({ direction }: { direction: DocumentDirection }) {
  const settings = useModuleSettings(direction)
  if (settings.isLoading || !settings.data) return <p className="text-sm text-faint">Cargando preferencias…</p>
  return <PreferencesForm direction={direction} initial={settings.data} />
}

function PreferencesForm({ direction, initial }: { direction: DocumentDirection; initial: ModuleSettings }) {
  const { canAdmin } = useCurrentTenant()
  const save = useSaveModuleSettings(direction)
  const [form, setForm] = useState(() => ({ ...initial, default_due_days: initial.default_due_days != null ? String(initial.default_due_days) : '', po_next_number: String(initial.po_next_number) }))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setSaved(false)
    setForm((f) => ({ ...f, [key]: value }))
  }
  const isPayable = direction === 'payable'
  const dirty = JSON.stringify(form) !== JSON.stringify({ ...initial, default_due_days: initial.default_due_days != null ? String(initial.default_due_days) : '', po_next_number: String(initial.po_next_number) })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const days = form.default_due_days.trim() ? Number(form.default_due_days) : null
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) return setError('El plazo por defecto debe estar entre 0 y 365 días')
    const next = Number(form.po_next_number)
    if (!Number.isInteger(next) || next < 1) return setError('El próximo número de OC debe ser un entero mayor a cero')
    if (form.po_prefix.length > 12) return setError('El prefijo admite hasta 12 caracteres')
    try {
      await save.mutateAsync({
        require_approval: form.require_approval,
        require_allocation: form.require_allocation,
        require_purchase_order: form.require_purchase_order,
        allow_partial_payments: form.allow_partial_payments,
        default_due_days: days,
        po_prefix: form.po_prefix,
        po_next_number: next,
        po_approval_admin_only: form.po_approval_admin_only,
      })
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-5">
      <FormError error={error} />
      {saved && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Preferencias guardadas.</p>}
      <Section
        title={isPayable ? 'Documentos y pagos' : 'Documentos y cobros'}
        description={isPayable ? 'Reglas que se aplican a las cuentas por pagar de la empresa.' : 'Reglas que se aplican a las cuentas por cobrar de la empresa.'}
      >
        <div className="-my-3 divide-y divide-line">
          {isPayable && (
            <ToggleRow
              label="Aprobación de documentos"
              description="Los documentos quedan por aprobar al registrarse y no se pueden pagar hasta aprobarlos. Si se desactiva, entran aprobados."
              checked={form.require_approval}
              disabled={!canAdmin}
              onChange={(v) => set('require_approval', v)}
            />
          )}
          {isPayable && (
            <ToggleRow
              label="Exigir distribución contable para aprobar"
              description="Antes de aprobar, el documento debe tener asignado a categorías el total a distribuir."
              checked={form.require_allocation}
              disabled={!canAdmin}
              onChange={(v) => set('require_allocation', v)}
            />
          )}
          <ToggleRow
            label={isPayable ? 'Exigir orden de compra' : 'Exigir orden de compra del cliente'}
            description={
              isPayable
                ? 'Un documento solo se aprueba si está asociado a una orden de compra aprobada.'
                : 'Los documentos solo se registran asociados a una orden de compra aceptada del cliente.'
            }
            checked={form.require_purchase_order}
            disabled={!canAdmin}
            onChange={(v) => set('require_purchase_order', v)}
          />
          <ToggleRow
            label={isPayable ? 'Permitir pagos parciales' : 'Permitir cobros parciales'}
            description={isPayable ? 'Si se desactiva, cada pago debe saldar completo el documento al que se asigna.' : 'Si se desactiva, cada cobro debe saldar completo el documento al que se asigna.'}
            checked={form.allow_partial_payments}
            disabled={!canAdmin}
            onChange={(v) => set('allow_partial_payments', v)}
          />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Plazo de vencimiento por defecto (días)" hint={`Se usa cuando el ${isPayable ? 'proveedor' : 'cliente'} no tiene un plazo propio.`}>
            {(id) => <Input id={id} inputMode="numeric" value={form.default_due_days} onChange={(e) => set('default_due_days', e.target.value.replace(/\D/g, ''))} placeholder="Ej: 30" disabled={!canAdmin} />}
          </Field>
        </div>
      </Section>

      {isPayable && (
        <Section title="Órdenes de compra" description="Numeración y aprobación de las órdenes que se emiten a proveedores.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Prefijo">{(id) => <Input id={id} value={form.po_prefix} onChange={(e) => set('po_prefix', e.target.value.toUpperCase())} maxLength={12} disabled={!canAdmin} />}</Field>
            <Field label="Próximo número">{(id) => <Input id={id} inputMode="numeric" value={form.po_next_number} onChange={(e) => set('po_next_number', e.target.value.replace(/\D/g, ''))} disabled={!canAdmin} />}</Field>
            <Field label="Vista previa">{(id) => <Input id={id} value={`${form.po_prefix}${String(Number(form.po_next_number) || 1).padStart(5, '0')}`} disabled />}</Field>
          </div>
          <div className="mt-2 divide-y divide-line">
            <ToggleRow
              label="Solo administradores aprueban órdenes de compra"
              description="Los usuarios de Finanzas crean órdenes y las envían a aprobación; un Dueño o Administrador las aprueba."
              checked={form.po_approval_admin_only}
              disabled={!canAdmin}
              onChange={(v) => set('po_approval_admin_only', v)}
            />
          </div>
        </Section>
      )}

      {canAdmin && (
        <div className="flex justify-end">
          <Button variant="primary" type="submit" disabled={save.isPending || !dirty}>{save.isPending ? 'Guardando…' : 'Guardar preferencias'}</Button>
        </div>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Tipos de documento
// ---------------------------------------------------------------------------
function DocumentTypesSection({ direction }: { direction: DocumentDirection }) {
  const { tenant, canAdmin } = useCurrentTenant()
  const settings = useDocumentTypeSettings(direction)
  const save = useSaveDocumentTypeSetting(direction)
  const [error, setError] = useState<string | null>(null)
  const types = DOCUMENT_TYPES.filter((t) => t.countries.includes(tenant.country))
  const isPayable = direction === 'payable'
  const settingOf = (code: DocumentTypeCode) => settings.data?.find((s) => s.doc_type === code) ?? { doc_type: code, can_create: true, can_pay: true }

  async function toggle(code: DocumentTypeCode, key: 'can_create' | 'can_pay', value: boolean) {
    setError(null)
    try {
      await save.mutateAsync({ ...settingOf(code), [key]: value })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Section
      title="Tipos de documento"
      description={
        isPayable
          ? 'Qué documentos se pueden registrar en cuentas por pagar y cuáles se pagan desde el módulo. Los documentos existentes no cambian.'
          : 'Qué documentos se pueden registrar en cuentas por cobrar y cuáles se cobran desde el módulo. Los documentos existentes no cambian.'
      }
    >
      <FormError error={error} />
      <div className="-mx-5 -mb-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-line bg-head text-left text-[11px] font-semibold tracking-wide text-faint uppercase">
              <th className="px-5 py-2 font-semibold">Tipo</th>
              <th className="px-3 py-2 text-center font-semibold">Se registra</th>
              <th className="px-5 py-2 text-center font-semibold">{isPayable ? 'Se paga' : 'Se cobra'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {types.map((t) => {
              const s = settingOf(t.code)
              return (
                <tr key={t.code}>
                  <td className="px-5 py-2.5">
                    <span className="block font-medium text-ink">{t.label}</span>
                    {t.isCredit && <span className="text-[12px] text-faint">Resta del saldo del documento al que se aplica.</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <input type="checkbox" className="size-4 accent-navy-900" aria-label={`${t.label}: se registra`} checked={s.can_create} disabled={!canAdmin || save.isPending} onChange={(e) => toggle(t.code, 'can_create', e.target.checked)} />
                  </td>
                  <td className="px-5 py-2.5 text-center">
                    {t.isCredit ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <input type="checkbox" className="size-4 accent-navy-900" aria-label={`${t.label}: ${isPayable ? 'se paga' : 'se cobra'}`} checked={s.can_pay} disabled={!canAdmin || save.isPending} onChange={(e) => toggle(t.code, 'can_pay', e.target.checked)} />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Categorías y centros de costos
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<AccountingCategory['kind'], string> = { expense: 'Gasto', income: 'Ingreso', both: 'Gasto e ingreso' }

type CatalogRow = { id: string; code: string | null; name: string; active: boolean; kind?: AccountingCategory['kind'] }

function CategoriesSection({ direction }: { direction: DocumentDirection }) {
  const categories = useCategories()
  const { saveCategory } = useCatalogMutations()
  const own: AccountingCategory['kind'] = direction === 'payable' ? 'expense' : 'income'
  const rows = (categories.data ?? []).filter((c) => c.kind === own || c.kind === 'both')
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-3xl text-sm text-muted">
        {direction === 'payable'
          ? 'Categorías de gasto para la distribución contable de facturas y órdenes de compra. Las marcadas “Gasto e ingreso” aparecen en ambos módulos.'
          : 'Categorías de ingreso para la distribución contable de los documentos emitidos. Los centros de costos se administran en Cuentas por pagar y se usan en ambos módulos.'}
        {' '}Desactivar una opción la oculta para nuevas asignaciones sin afectar las existentes.
      </p>
      <CatalogList
        title={direction === 'payable' ? 'Categorías de gasto' : 'Categorías de ingreso'}
        storageKey={`categories-${direction}`}
        rows={rows}
        loading={categories.isLoading}
        withKind
        defaultKind={own}
        onSave={(input, id) => saveCategory.mutateAsync({ input: { code: input.code, name: input.name, active: input.active, kind: input.kind ?? own }, id })}
      />
    </div>
  )
}

function CostCentersSection() {
  const costCenters = useCostCenters()
  const { saveCostCenter } = useCatalogMutations()
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-3xl text-sm text-muted">Se usan en la distribución contable y en las órdenes de compra de ambos módulos.</p>
      <CatalogList
        title="Centros de costos"
        storageKey="cost-centers"
        rows={costCenters.data ?? []}
        loading={costCenters.isLoading}
        onSave={(input, id) => saveCostCenter.mutateAsync({ input: { code: input.code, name: input.name, active: input.active }, id })}
      />
    </div>
  )
}

function CatalogList({
  title,
  storageKey,
  rows,
  loading,
  withKind,
  defaultKind = 'expense',
  onSave,
}: {
  title: string
  storageKey: string
  rows: CatalogRow[]
  loading: boolean
  withKind?: boolean
  defaultKind?: AccountingCategory['kind']
  onSave: (input: Omit<CatalogRow, 'id'>, id?: string) => Promise<unknown>
}) {
  const { canAdmin } = useCurrentTenant()
  const [editing, setEditing] = useState<CatalogRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const columns: ListColumn<CatalogRow>[] = [
    { key: 'code', header: 'Código', cell: (r) => r.code ?? '—', sortValue: (r) => r.code ?? '' },
    { key: 'name', header: 'Nombre', cell: (r) => r.name, sortValue: (r) => r.name },
    ...(withKind ? [{ key: 'kind', header: 'Tipo', cell: (r: CatalogRow) => KIND_LABEL[r.kind ?? 'expense'], sortValue: (r: CatalogRow) => r.kind ?? '' }] : []),
    { key: 'active', header: 'Estado', cell: (r) => (r.active ? <Badge tone="ok">Activa</Badge> : <Badge>Inactiva</Badge>), sortValue: (r) => (r.active ? 0 : 1) },
  ]
  const filters: ListFilter<CatalogRow>[] = [
    { type: 'select', key: 'active', label: 'Estado', options: [{ value: 'on', label: 'Activas' }, { value: 'off', label: 'Inactivas' }], match: (r, v) => r.active === (v === 'on') },
  ]
  const list = useListState({ rows, rowKey: (r) => r.id, columns, filters, searchText: (r) => `${r.code ?? ''} ${r.name}`, storageKey, defaultSort: { key: 'code', dir: 'asc' } })
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {canAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} /> Agregar</Button>}
      </div>
      <FormError error={error} />
      <ListView
        state={list}
        columns={columns}
        rowKey={(r) => r.id}
        filters={filters}
        loading={loading}
        searchPlaceholder="Buscar por código o nombre…"
        onRowClick={canAdmin ? setEditing : undefined}
        rowActions={(r) =>
          canAdmin ? (
            <RowAction
              label={r.active ? 'Desactivar' : 'Activar'}
              onClick={async () => {
                setError(null)
                try {
                  await onSave({ code: r.code, name: r.name, kind: r.kind, active: !r.active }, r.id)
                } catch (err) {
                  setError(errorMessage(err))
                }
              }}
            >
              <Power size={17} className={r.active ? '' : 'text-ok'} />
            </RowAction>
          ) : null
        }
        empty={<EmptyState title="Sin registros" />}
      />
      {editing && (
        <CatalogDrawer
          title={title}
          row={editing === 'new' ? null : editing}
          withKind={withKind}
          defaultKind={defaultKind}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await onSave(input, editing === 'new' ? undefined : editing.id)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

function CatalogDrawer({
  title,
  row,
  withKind,
  defaultKind,
  onClose,
  onSave,
}: {
  title: string
  row: CatalogRow | null
  withKind?: boolean
  defaultKind: AccountingCategory['kind']
  onClose: () => void
  onSave: (input: Omit<CatalogRow, 'id'>) => Promise<void>
}) {
  const [code, setCode] = useState(row?.code ?? '')
  const [name, setName] = useState(row?.name ?? '')
  const [kind, setKind] = useState<AccountingCategory['kind']>(row?.kind ?? defaultKind)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('El nombre es obligatorio')
    setError(null)
    setSaving(true)
    try {
      await onSave({ code: code.trim() || null, name: name.trim(), kind: withKind ? kind : undefined, active: row?.active ?? true })
    } catch (err) {
      setError(errorMessage(err).includes('duplicado') || errorMessage(err).includes('duplicate') ? 'Ya existe uno con ese nombre.' : errorMessage(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Drawer
      open
      title={row ? `Editar · ${title}` : `Agregar · ${title}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="catalog-form" disabled={saving}>Guardar</Button>
        </>
      }
    >
      <form id="catalog-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid grid-cols-3 gap-4">
          <Field label="Código" className="col-span-1">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Opcional" />}</Field>
          <Field label="Nombre" className="col-span-2">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        </div>
        {withKind && (
          <Field label="Uso">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as AccountingCategory['kind'])}>
                <option value="expense">Gasto (cuentas por pagar)</option>
                <option value="income">Ingreso (cuentas por cobrar)</option>
                <option value="both">Ambos</option>
              </Select>
            )}
          </Field>
        )}
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Formas de pago
// ---------------------------------------------------------------------------
function PaymentMethodsSection({ direction }: { direction: DocumentDirection }) {
  const { canAdmin } = useCurrentTenant()
  const paymentDirection = direction === 'payable' ? 'out' : 'in'
  const methods = usePaymentMethods(paymentDirection)
  const save = useSavePaymentMethod()
  const [editing, setEditing] = useState<PaymentMethod | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rows = methods.data ?? []
  const isPayable = direction === 'payable'

  async function update(m: PaymentMethod, patch: Partial<PaymentMethod>) {
    setError(null)
    try {
      await save.mutateAsync({ input: { direction: m.direction, name: m.name, active: m.active, is_default: m.is_default, position: m.position, ...patch }, id: m.id })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const columns: ListColumn<PaymentMethod>[] = [
    {
      key: 'name',
      header: 'Forma de pago',
      cell: (m) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-ink">{m.name}</span>
          {m.is_default && <Badge tone="info">Predeterminada</Badge>}
        </span>
      ),
      sortValue: (m) => m.name,
    },
    { key: 'active', mobileBadge: true, header: 'Estado', cell: (m) => (m.active ? <Badge tone="ok">Activa</Badge> : <Badge>Inactiva</Badge>), sortValue: (m) => (m.active ? 0 : 1) },
  ]
  const filters: ListFilter<PaymentMethod>[] = [
    { type: 'select', key: 'active', label: 'Estado', options: [{ value: 'on', label: 'Activas' }, { value: 'off', label: 'Inactivas' }], match: (m, v) => m.active === (v === 'on') },
  ]
  const list = useListState({ rows, rowKey: (m) => m.id, columns, filters, searchText: (m) => m.name, storageKey: `payment-methods-${direction}` })

  return (
    <section className="flex flex-col gap-3">
      <p className="max-w-3xl text-sm text-muted">
        {isPayable
          ? 'Formas disponibles al registrar pagos a proveedores y en las órdenes de compra. La predeterminada aparece seleccionada.'
          : 'Formas disponibles al registrar cobros a clientes. La predeterminada aparece seleccionada. Los cobros por MercadoPago se registran solos.'}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-ink">{isPayable ? 'Formas de pago' : 'Formas de cobro'}</h2>
        {canAdmin && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} /> Agregar</Button>}
      </div>
      <FormError error={error} />
      <ListView
        state={list}
        columns={columns}
        rowKey={(m) => m.id}
        filters={filters}
        loading={methods.isLoading}
        searchPlaceholder="Buscar forma de pago…"
        onRowClick={canAdmin ? setEditing : undefined}
        rowActions={(m) =>
          canAdmin ? (
            <>
              {m.active && !m.is_default && (
                <RowAction label="Marcar como predeterminada" onClick={() => update(m, { is_default: true })}><Star size={16} /></RowAction>
              )}
              <RowAction label={m.active ? 'Desactivar' : 'Activar'} onClick={() => update(m, { active: !m.active, is_default: m.active ? false : m.is_default })}>
                <Power size={17} className={m.active ? '' : 'text-ok'} />
              </RowAction>
            </>
          ) : null
        }
        empty={<EmptyState title="Sin formas de pago" description="Agrega al menos una para poder registrar movimientos." />}
      />
      {editing && (
        <PaymentMethodDrawer
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (name, active, isDefault) => {
            const input = editing === 'new'
              ? { direction: paymentDirection as PaymentMethod['direction'], name, active, is_default: isDefault, position: Math.max(0, ...rows.map((r) => r.position)) + 1 }
              : { direction: editing.direction, name, active, is_default: isDefault, position: editing.position }
            await save.mutateAsync({ input, id: editing === 'new' ? undefined : editing.id })
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

function PaymentMethodDrawer({ row, onClose, onSave }: { row: PaymentMethod | null; onClose: () => void; onSave: (name: string, active: boolean, isDefault: boolean) => Promise<void> }) {
  const [name, setName] = useState(row?.name ?? '')
  const [active, setActive] = useState(row?.active ?? true)
  const [isDefault, setIsDefault] = useState(row?.is_default ?? false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('El nombre es obligatorio')
    if (isDefault && !active) return setError('Una forma de pago inactiva no puede ser la predeterminada')
    setError(null)
    setSaving(true)
    try {
      await onSave(name.trim(), active, isDefault)
    } catch (err) {
      setError(errorMessage(err).includes('duplicado') ? 'Ya existe una forma de pago con ese nombre.' : errorMessage(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Drawer
      open
      title={row ? `Editar · ${row.name}` : 'Agregar forma de pago'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="method-form" disabled={saving}>Guardar</Button>
        </>
      }
    >
      <form id="method-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Nombre" hint="Ej: Transferencia, Cheque, Webpay, Yape.">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />}</Field>
        <div className="divide-y divide-line rounded-lg border border-line px-4">
          <ToggleRow label="Activa" description="Solo las activas se pueden elegir al registrar movimientos." checked={active} onChange={(v) => { setActive(v); if (!v) setIsDefault(false) }} />
          <ToggleRow label="Predeterminada" description="Aparece seleccionada al registrar un movimiento." checked={isDefault} disabled={!active} onChange={setIsDefault} />
        </div>
      </form>
    </Drawer>
  )
}
