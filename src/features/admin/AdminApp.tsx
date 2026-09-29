// Administrador de empresas (superadministrador de la plataforma). Separado de la configuración
// de cada empresa: aquí se crean empresas, se activan sus módulos y se suspenden.
import clsx from 'clsx'
import { ArrowLeft, Building2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { useAdminMutations, useAdminTenants, usePlatformAdmin, usePlatformAdmins } from '../../app/queries'
import { useSession } from '../../app/session'
import { MODULES, moduleLabel, type ModuleInfo } from '../../app/modules'
import type { AdminTenant, ModuleKey } from '../../data'
import type { Country } from '../../domain/taxId'
import { formatTaxId, isValidTaxId } from '../../domain/taxId'
import { Badge, Button, Drawer, Field, FormError, Input, PageHeader, Select, StatCard, Textarea } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage } from '../shared'
import { UserManagement } from '../users/UserManagement'

const DEFAULT_MODULES: ModuleKey[] = ['cuentas_por_pagar', 'cuentas_por_cobrar', 'tesoreria']
const formatTs = (ts: string | null) => (ts ? new Date(ts).toLocaleDateString('es-CL') : '—')

export function AdminApp() {
  const admin = usePlatformAdmin()
  if (admin.isLoading) return <div className="py-20 text-center text-sm text-faint">Cargando…</div>
  if (!admin.data) return <Navigate to="/" replace />
  return (
    <div className="min-h-full bg-canvas">
      <AdminTopBar />
      <main className="mx-auto max-w-7xl px-4 pb-10 md:px-6">
        <Routes>
          <Route index element={<Navigate to="empresas" replace />} />
          <Route path="empresas" element={<TenantsPage />} />
          <Route path="superadministradores" element={<PlatformAdminsPage />} />
          <Route path="*" element={<Navigate to="empresas" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function AdminTopBar() {
  const { session } = useSession()
  const link = ({ isActive }: { isActive: boolean }) =>
    clsx('rounded-md px-3 py-1.5 text-sm transition-colors', isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:text-white')
  return (
    <div className="bg-navy-900">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
        <span className="text-lg font-bold text-white">
          produ<span className="text-brand-500">.</span> <span className="text-sm font-medium text-white/75">Administrador de empresas</span>
        </span>
        <nav className="flex gap-1">
          <NavLink to="/admin/empresas" className={link}>Empresas</NavLink>
          <NavLink to="/admin/superadministradores" className={link}>Superadministradores</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <span className="hidden text-white/60 sm:inline">{session?.email}</span>
          <Link to="/" className="inline-flex items-center gap-1.5 text-white/80 hover:text-white"><ArrowLeft size={16} /> Volver a la app</Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empresas
// ---------------------------------------------------------------------------
function ModuleChips({ modules }: { modules: ModuleKey[] }) {
  const shown = MODULES.filter((m) => modules.includes(m.key))
  if (!shown.length) return <span className="text-faint">Sin módulos</span>
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((m) => (
        <span key={m.key} className="rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{m.label}</span>
      ))}
    </div>
  )
}

function TenantsPage() {
  const tenants = useAdminTenants()
  const [editing, setEditing] = useState<AdminTenant | null>(null)
  const [creating, setCreating] = useState(false)
  const rows = useMemo(() => tenants.data ?? [], [tenants.data])

  const columns: ListColumn<AdminTenant>[] = [
    {
      key: 'name', header: 'Empresa', sortValue: (t) => t.name.toLowerCase(),
      cell: (t) => (
        <div className="min-w-0">
          <div className="font-medium text-ink">{t.name}</div>
          <div className="text-xs text-faint">{t.tax_id ? formatTaxId(t.tax_id, t.country) : 'Sin RUT'} · {t.country === 'CL' ? 'Chile' : 'Perú'}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Estado', mobileBadge: true, sortValue: (t) => t.status, cell: (t) => <Badge tone={t.status === 'active' ? 'ok' : 'warn'}>{t.status === 'active' ? 'Activa' : 'Suspendida'}</Badge> },
    { key: 'modules', header: 'Módulos', cell: (t) => <ModuleChips modules={t.modules} />, className: 'max-w-md' },
    { key: 'owner', header: 'Dueño', mobileHidden: true, cell: (t) => <span className="text-sm">{t.owner_name || t.owner_email || '—'}</span> },
    { key: 'members', header: 'Usuarios', align: 'right', sortValue: (t) => t.member_count, cell: (t) => t.member_count },
    { key: 'docs', header: 'Documentos', align: 'right', sortValue: (t) => t.document_count, cell: (t) => t.document_count },
    { key: 'created', header: 'Creada', mobileHidden: true, sortValue: (t) => t.created_at, cell: (t) => formatTs(t.created_at) },
  ]
  const filters: ListFilter<AdminTenant>[] = [
    { type: 'select', key: 'status', label: 'Estado', options: [{ value: 'active', label: 'Activas' }, { value: 'suspended', label: 'Suspendidas' }], match: (t, v) => t.status === v },
    { type: 'select', key: 'country', label: 'País', options: [{ value: 'CL', label: 'Chile' }, { value: 'PE', label: 'Perú' }], match: (t, v) => t.country === v },
    { type: 'select', key: 'module', label: 'Módulo', options: MODULES.map((m) => ({ value: m.key, label: m.label })), match: (t, v) => t.modules.includes(v as ModuleKey) },
  ]
  const list = useListState({
    rows, rowKey: (t) => t.id, columns, filters,
    searchText: (t) => `${t.name} ${t.legal_name ?? ''} ${t.tax_id ?? ''} ${t.owner_email ?? ''} ${t.owner_name ?? ''}`,
    storageKey: 'admin-tenants', defaultSort: { key: 'created', dir: 'desc' },
  })
  const active = rows.filter((t) => t.status === 'active').length

  return (
    <>
      <PageHeader title="Empresas" actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} /> Nueva empresa</Button>} />
      <div className="stat-row pt-5 sm:grid-cols-3">
        <StatCard label="Empresas" value={rows.length} detail={`${active} activas`} />
        <StatCard label="Suspendidas" value={rows.length - active} tone={rows.length - active ? 'warn' : undefined} />
        <StatCard label="Con conciliación bancaria" value={rows.filter((t) => t.modules.includes('conciliacion')).length} />
      </div>
      <div className="flex flex-col gap-3 pt-5">
        <FormError error={tenants.error ? errorMessage(tenants.error) : null} />
        <ListView
          state={list}
          columns={columns}
          rowKey={(t) => t.id}
          filters={filters}
          loading={tenants.isLoading}
          searchPlaceholder="Buscar por nombre, RUT o dueño…"
          onRowClick={setEditing}
          rowActions={(t) => <RowAction label="Editar" onClick={() => setEditing(t)}><Building2 size={16} /></RowAction>}
          empty="Aún no hay empresas."
        />
      </div>
      {creating && <CreateTenantDrawer onClose={() => setCreating(false)} />}
      {editing && <EditTenantDrawer key={editing.id} tenant={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Selector de módulos agrupado, con dependencias y restricciones por país. */
function ModulePicker({ value, onChange, country }: { value: ModuleKey[]; onChange: (v: ModuleKey[]) => void; country: Country }) {
  const groups = ['Operación', 'Complementos', 'Integraciones'] as const
  const available = (m: ModuleInfo) => !m.country || m.country === country
  const toggle = (m: ModuleInfo, on: boolean) => {
    let next = on ? [...value, m.key, ...(m.requires ?? [])] : value.filter((k) => k !== m.key)
    // Al desactivar un módulo, se desactivan los que dependen de él.
    if (!on) next = next.filter((k) => !MODULES.find((x) => x.key === k)?.requires?.includes(m.key))
    onChange([...new Set(next)])
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1.5 text-xs font-medium tracking-wide text-faint uppercase">{g}</div>
          <div className="divide-y divide-line rounded-lg border border-line">
            {MODULES.filter((m) => m.group === g).map((m) => {
              const on = value.includes(m.key)
              const disabled = !available(m)
              return (
                <label key={m.key} className={clsx('flex cursor-pointer items-start gap-3 px-3 py-2.5', disabled && 'cursor-not-allowed opacity-50')}>
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={on && !disabled} disabled={disabled} onChange={(e) => toggle(m, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{m.label}</span>
                    <span className="block text-xs text-muted">
                      {m.description}
                      {m.requires && ` Requiere ${m.requires.map(moduleLabel).join(', ')}.`}
                      {m.country && ` Solo Chile.`}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

const cleanModules = (modules: ModuleKey[], country: Country) =>
  modules.filter((k) => {
    const m = MODULES.find((x) => x.key === k)
    return m && (!m.country || m.country === country)
  })

function CreateTenantDrawer({ onClose }: { onClose: () => void }) {
  const { create } = useAdminMutations()
  const [form, setForm] = useState({ name: '', legalName: '', taxId: '', country: 'CL' as Country, ownerName: '', ownerEmail: '', notes: '' })
  const [modules, setModules] = useState<ModuleKey[]>(DEFAULT_MODULES)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ invited: boolean } | null>(null)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    setError(null)
    if (!form.name.trim()) return setError('Indica el nombre de la empresa.')
    if (form.taxId.trim() && !isValidTaxId(form.taxId, form.country)) return setError(form.country === 'CL' ? 'El RUT no es válido.' : 'El RUC no es válido.')
    if (!form.ownerName.trim()) return setError('Indica el nombre del dueño.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ownerEmail.trim())) return setError('Indica un correo válido para el dueño.')
    try {
      const r = await create.mutateAsync({
        name: form.name.trim(), legalName: form.legalName.trim() || null, taxId: form.taxId.trim() || null, country: form.country,
        modules: cleanModules(modules, form.country), ownerName: form.ownerName.trim(), ownerEmail: form.ownerEmail.trim(), notes: form.notes.trim() || null,
      })
      setResult(r)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (result) {
    return (
      <Drawer open title="Empresa creada" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
        <p className="text-sm text-ink">
          <strong>{form.name}</strong> quedó creada con {cleanModules(modules, form.country).length} módulos.{' '}
          {result.invited
            ? <>Enviamos una invitación a <strong>{form.ownerEmail}</strong> para que cree su contraseña y entre como dueño.</>
            : <><strong>{form.ownerEmail}</strong> ya tenía cuenta: quedó como dueño y verá la empresa al entrar.</>}
        </p>
      </Drawer>
    )
  }

  return (
    <Drawer
      open title="Nueva empresa" subtitle="El dueño recibe una invitación por correo." onClose={onClose} width="lg"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={create.isPending}>{create.isPending ? 'Creando…' : 'Crear empresa'}</Button></>}
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />}</Field>
          <Field label="País">
            {(id) => (
              <Select id={id} value={form.country} onChange={(e) => set('country', e.target.value as Country)}>
                <option value="CL">Chile</option>
                <option value="PE">Perú</option>
              </Select>
            )}
          </Field>
          <Field label="Razón social">{(id) => <Input id={id} value={form.legalName} onChange={(e) => set('legalName', e.target.value)} />}</Field>
          <Field label={form.country === 'CL' ? 'RUT' : 'RUC'} hint="Opcional">{(id) => <Input id={id} value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del dueño">{(id) => <Input id={id} value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />}</Field>
          <Field label="Correo del dueño" hint="Si no tiene cuenta, se le invita.">
            {(id) => <Input id={id} type="email" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />}
          </Field>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-ink">Módulos</div>
          <ModulePicker value={modules} onChange={setModules} country={form.country} />
        </div>
        <Field label="Notas internas" hint="Solo visibles para superadministradores.">
          {(id) => <Textarea id={id} rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />}
        </Field>
      </div>
    </Drawer>
  )
}

function EditTenantDrawer({ tenant, onClose }: { tenant: AdminTenant; onClose: () => void }) {
  const { update } = useAdminMutations()
  const [form, setForm] = useState({ name: tenant.name, legal_name: tenant.legal_name ?? '', tax_id: tenant.tax_id ?? '', admin_notes: tenant.admin_notes ?? '' })
  const [status, setStatus] = useState(tenant.status)
  const [modules, setModules] = useState<ModuleKey[]>(tenant.modules)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const removed = tenant.modules.filter((m) => !modules.includes(m))

  const submit = async () => {
    setError(null)
    if (!form.name.trim()) return setError('El nombre es obligatorio.')
    if (form.tax_id.trim() && !isValidTaxId(form.tax_id, tenant.country)) return setError(tenant.country === 'CL' ? 'El RUT no es válido.' : 'El RUC no es válido.')
    try {
      await update.mutateAsync({
        id: tenant.id,
        input: {
          name: form.name.trim(), legal_name: form.legal_name.trim() || null, tax_id: form.tax_id.trim() || null,
          modules: cleanModules(modules, tenant.country), status, admin_notes: form.admin_notes.trim() || null,
        },
      })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer
      open title={tenant.name} subtitle={`${tenant.country === 'CL' ? 'Chile' : 'Perú'} · creada el ${formatTs(tenant.created_at)}`} onClose={onClose} width="lg"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={update.isPending}>{update.isPending ? 'Guardando…' : 'Guardar cambios'}</Button></>}
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
          <Field label={tenant.country === 'CL' ? 'RUT' : 'RUC'}>{(id) => <Input id={id} value={form.tax_id} onChange={(e) => set('tax_id', e.target.value)} />}</Field>
          <Field label="Razón social" className="sm:col-span-2">{(id) => <Input id={id} value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} />}</Field>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-ink">Estado</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {([['active', 'Activa', 'Opera con normalidad.'], ['suspended', 'Suspendida', 'Sus usuarios solo pueden consultar; se detienen los recordatorios y el portal.']] as const).map(([v, label, desc]) => (
              <label key={v} className={clsx('flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5', status === v ? 'border-brand-600 bg-brand-50/40' : 'border-line')}>
                <input type="radio" className="mt-0.5 accent-brand-600" checked={status === v} onChange={() => setStatus(v)} />
                <span><span className="block text-sm font-medium text-ink">{label}</span><span className="block text-xs text-muted">{desc}</span></span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-ink">Módulos</div>
          <ModulePicker value={modules} onChange={setModules} country={tenant.country} />
          {removed.length > 0 && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Al desactivar {removed.map(moduleLabel).join(', ')} la empresa deja de ver esas pantallas. Los datos se conservan y vuelven al reactivarlo.
            </p>
          )}
        </div>

        <Field label="Notas internas" hint="Solo visibles para superadministradores.">
          {(id) => <Textarea id={id} rows={3} value={form.admin_notes} onChange={(e) => set('admin_notes', e.target.value)} />}
        </Field>

        <div>
          <div className="mb-2 text-sm font-medium text-ink">Usuarios</div>
          <UserManagement tenantId={tenant.id} tenantName={tenant.name} timezone={tenant.country === 'CL' ? 'America/Santiago' : 'America/Lima'} canManage platformAdmin />
        </div>

        <DeleteTenantSection tenant={tenant} onDeleted={onClose} />
      </div>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Superadministradores
// ---------------------------------------------------------------------------
function PlatformAdminsPage() {
  const { session } = useSession()
  const admins = usePlatformAdmins()
  const { setPlatformAdmin } = useAdminMutations()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    setError(null)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Indica un correo válido.')
    try {
      await setPlatformAdmin.mutateAsync({ email: email.trim(), enabled: true })
      setEmail('')
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const remove = async (target: string) => {
    if (!confirm(`¿Quitar a ${target} como superadministrador?`)) return
    setError(null)
    try {
      await setPlatformAdmin.mutateAsync({ email: target, enabled: false })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <PageHeader title="Superadministradores" />
      <div className="flex max-w-2xl flex-col gap-4 pt-5">
        <p className="text-sm text-muted">Pueden crear empresas, activar módulos y suspender empresas. El usuario debe tener cuenta en Produ Finanzas.</p>
        <FormError error={error ?? (admins.error ? errorMessage(admins.error) : null)} />
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
          <Input type="email" placeholder="correo@empresa.cl" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Correo" />
          <Button variant="primary" type="submit" disabled={setPlatformAdmin.isPending}><Plus size={16} /> Agregar</Button>
        </form>
        <div className="divide-y divide-line rounded-lg border border-line bg-white">
          {admins.isLoading && <div className="px-4 py-3 text-sm text-faint">Cargando…</div>}
          {(admins.data ?? []).map((a) => (
            <div key={a.user_id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <ShieldCheck size={18} className="shrink-0 text-brand-600" />
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{a.full_name || a.email}</div>
                  <div className="truncate text-xs text-faint">{a.full_name ? `${a.email} · ` : ''}desde {formatTs(a.created_at)}</div>
                </div>
              </div>
              {a.email && a.email.toLowerCase() !== session?.email.toLowerCase() && (
                <RowAction label="Quitar" tone="danger" onClick={() => remove(a.email!)}><Trash2 size={16} /></RowAction>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function DeleteTenantSection({ tenant, onDeleted }: { tenant: AdminTenant; onDeleted: () => void }) {
  const { remove } = useAdminMutations()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setError(null)
    try {
      await remove.mutateAsync({ id: tenant.id, confirmName })
      onDeleted()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-bad/30 p-4">
      <div>
        <h3 className="text-sm font-semibold text-bad">Eliminar empresa</h3>
        <p className="mt-1 text-xs text-muted">
          Borra para siempre la empresa y todos sus datos: {tenant.document_count} documentos, pagos, cobros, órdenes de compra, contrapartes, archivos adjuntos,
          cartolas y la configuración. Se desconectan el SII y los bancos. Los usuarios conservan su cuenta. No se puede deshacer.
        </p>
        <p className="mt-1 text-xs text-muted">Si solo quieres cortar el acceso, usa <b>Suspendida</b>.</p>
      </div>
      {!open ? (
        <div><Button variant="danger" onClick={() => setOpen(true)}><Trash2 size={16} /> Eliminar empresa</Button></div>
      ) : (
        <div className="flex flex-col gap-2">
          <FormError error={error} />
          <Field label={`Escribe "${tenant.name}" para confirmar`}>
            {(id) => <Input id={id} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setOpen(false); setConfirmName('') }}>Cancelar</Button>
            <Button variant="danger" onClick={submit} disabled={confirmName.trim() !== tenant.name || remove.isPending}>
              {remove.isPending ? 'Eliminando…' : 'Eliminar definitivamente'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
