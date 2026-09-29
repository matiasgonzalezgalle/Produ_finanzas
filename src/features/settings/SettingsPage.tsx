import { Check, Copy, ExternalLink, Mail, Plus, Power, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCatalogMutations, useCategories, useCostCenters, useContacts, useCounterparties, useMemberMutations, useMembers, usePortalAccess, usePortalAccessMutations, useUpdateTenant } from '../../app/queries'
import { useSession } from '../../app/session'
import { useCurrentTenant } from '../../app/tenant'
import type { AccountingCategory, Member, MemberRole, PortalAccess } from '../../data'
import { formatTimestampDate } from '../../domain/dates'
import { formatTaxId, isValidTaxId, normalizeTaxId, TAX_ID_LABEL } from '../../domain/taxId'
import { Badge, Button, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, Textarea } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { IntegrationsSettings } from '../integrations/IntegrationsPage'
import { errorMessage, useNewParam } from '../shared'

export type SettingsTab = 'empresa' | 'usuarios' | 'contabilidad' | 'integraciones' | 'portal'

const TABS = [
  { to: '/configuracion/empresa', label: 'Empresa' },
  { to: '/configuracion/usuarios', label: 'Usuarios' },
  { to: '/configuracion/contabilidad', label: 'Contabilidad' },
  { to: '/configuracion/integraciones', label: 'Integraciones' },
  { to: '/configuracion/portal', label: 'Portal financiero' },
]

export const ROLE_LABEL: Record<MemberRole, string> = { owner: 'Dueño', admin: 'Administrador', finance: 'Finanzas', viewer: 'Solo lectura' }
const ROLE_HINT: Record<Exclude<MemberRole, 'owner'>, string> = {
  admin: 'Todo, incluida la configuración, usuarios, integraciones y portal.',
  finance: 'Registra y edita documentos, pagos, cobros y contrapartes.',
  viewer: 'Solo consulta. No puede crear ni modificar nada.',
}

function portalUrl(slug?: string | null) {
  return `${window.location.origin}/portal${slug ? `/${slug}` : ''}`
}

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  return (
    <div>
      <PageHeader title="Configuración" tabs={TABS} />
      <div className="pt-6">
        {tab === 'empresa' && <CompanySettings />}
        {tab === 'usuarios' && <UsersSettings />}
        {tab === 'contabilidad' && <AccountingSettings />}
        {tab === 'integraciones' && <IntegrationsSettings />}
        {tab === 'portal' && <PortalSettings />}
      </div>
    </div>
  )
}

function Section({ title, description, children, actions }: { title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Empresa
// ---------------------------------------------------------------------------
function CompanySettings() {
  const { tenant, canAdmin } = useCurrentTenant()
  const update = useUpdateTenant()
  const [name, setName] = useState(tenant.name)
  const [legalName, setLegalName] = useState(tenant.legal_name ?? '')
  const [taxId, setTaxId] = useState(tenant.tax_id ? formatTaxId(tenant.tax_id, tenant.country) : '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const taxLabel = TAX_ID_LABEL[tenant.country]
  const taxError = taxId && !isValidTaxId(taxId, tenant.country) ? `${taxLabel} inválido` : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (!name.trim()) return setError('El nombre es obligatorio')
    if (taxError) return setError(taxError)
    try {
      await update.mutateAsync({
        name: name.trim(),
        legal_name: legalName.trim() || null,
        tax_id: taxId ? normalizeTaxId(taxId, tenant.country) : null,
        portal_enabled: tenant.portal_enabled,
        portal_message: tenant.portal_message,
      })
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="max-w-3xl">
      <Section title="Datos de la empresa" description="Aparecen en el portal financiero y en los PDF.">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FormError error={error} />
          {saved && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Cambios guardados.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre de fantasía">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} />}</Field>
            <Field label="Razón social">{(id) => <Input id={id} value={legalName} onChange={(e) => setLegalName(e.target.value)} disabled={!canAdmin} />}</Field>
            <Field label={taxLabel} error={taxError}>{(id) => <Input id={id} value={taxId} onChange={(e) => setTaxId(e.target.value)} disabled={!canAdmin} />}</Field>
            <Field label="País" hint="Define la moneda base, el impuesto y la zona horaria. No se puede cambiar.">
              {(id) => <Input id={id} value={tenant.country === 'CL' ? 'Chile' : 'Perú'} disabled />}
            </Field>
            <Field label="Moneda base">{(id) => <Input id={id} value={tenant.base_currency} disabled />}</Field>
            <Field label="Zona horaria" hint="Se usa para calcular vencimientos.">{(id) => <Input id={id} value={tenant.timezone} disabled />}</Field>
          </div>
          {canAdmin && (
            <div className="flex justify-end">
              <Button variant="primary" type="submit" disabled={update.isPending}>{update.isPending ? 'Guardando…' : 'Guardar cambios'}</Button>
            </div>
          )}
        </form>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
function UsersSettings() {
  const { tenant, canAdmin } = useCurrentTenant()
  const { session } = useSession()
  const members = useMembers()
  const { setRole, remove } = useMemberMutations()
  const [inviteOpen, setInviteOpen] = useNewParam()
  const [error, setError] = useState<string | null>(null)
  const rows = members.data ?? []

  const columns: ListColumn<Member>[] = [
    { key: 'name', header: 'Nombre', cell: (m) => m.full_name || '—', sortValue: (m) => m.full_name ?? '' },
    { key: 'email', header: 'Correo', cell: (m) => m.email ?? '—', sortValue: (m) => m.email ?? '' },
    {
      key: 'role',
      header: 'Rol',
      cell: (m) =>
        canAdmin && m.role !== 'owner' && m.user_id !== session?.userId ? (
          <select
            aria-label={`Rol de ${m.email}`}
            value={m.role}
            onClick={(e) => e.stopPropagation()}
            onChange={async (e) => {
              setError(null)
              try {
                await setRole.mutateAsync({ userId: m.user_id, role: e.target.value as Exclude<MemberRole, 'owner'> })
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
            className="h-8 rounded-md border border-line bg-white px-2 text-sm"
          >
            <option value="admin">{ROLE_LABEL.admin}</option>
            <option value="finance">{ROLE_LABEL.finance}</option>
            <option value="viewer">{ROLE_LABEL.viewer}</option>
          </select>
        ) : (
          <Badge tone={m.role === 'owner' ? 'solid' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
        ),
      sortValue: (m) => ['owner', 'admin', 'finance', 'viewer'].indexOf(m.role),
    },
    { key: 'since', header: 'Desde', cell: (m) => formatTimestampDate(m.created_at, tenant.timezone), sortValue: (m) => m.created_at },
  ]
  const filters: ListFilter<Member>[] = [
    { type: 'select', key: 'role', label: 'Rol', options: (Object.keys(ROLE_LABEL) as MemberRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] })), match: (m, v) => m.role === v },
  ]
  const list = useListState({
    rows,
    rowKey: (m) => m.user_id,
    columns,
    filters,
    searchText: (m) => `${m.full_name ?? ''} ${m.email ?? ''}`,
    storageKey: 'members',
    defaultSort: { key: 'role', dir: 'asc' },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Cada usuario entra con su propio correo y ve solo esta empresa, según su rol.</p>
        {canAdmin && <Button variant="primary" onClick={() => setInviteOpen(true)}><UserPlus size={16} /> Invitar usuario</Button>}
      </div>
      <FormError error={error} />
      <ListView
        state={list}
        columns={columns}
        rowKey={(m) => m.user_id}
        filters={filters}
        loading={members.isLoading}
        searchPlaceholder="Buscar por nombre o correo…"
        rowActions={(m) =>
          canAdmin && m.role !== 'owner' && m.user_id !== session?.userId ? (
            <RowAction
              label="Quitar de la empresa"
              tone="danger"
              onClick={async () => {
                if (!window.confirm(`¿Quitar a ${m.email ?? 'este usuario'} de la empresa? Perderá el acceso de inmediato.`)) return
                setError(null)
                try {
                  await remove.mutateAsync(m.user_id)
                } catch (err) {
                  setError(errorMessage(err))
                }
              }}
            >
              <Trash2 size={17} />
            </RowAction>
          ) : null
        }
        empty={<EmptyState icon={<Users size={20} />} title="Sin usuarios" />}
      />
      {inviteOpen && <InviteDrawer onClose={() => setInviteOpen(false)} />}
    </div>
  )
}

function InviteDrawer({ onClose }: { onClose: () => void }) {
  const { invite } = useMemberMutations()
  const [email, setEmail] = useState('')
  const [role, setRoleValue] = useState<Exclude<MemberRole, 'owner'>>('finance')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const res = await invite.mutateAsync({ email: email.trim(), role })
      setDone(res.invited ? `Enviamos una invitación a ${email}. Al aceptarla, entrará directo a esta empresa.` : `${email} ya tenía cuenta y fue agregado a la empresa.`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open
      title="Invitar usuario"
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>Listo</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" type="submit" form="invite-form" disabled={invite.isPending}>{invite.isPending ? 'Invitando…' : 'Invitar'}</Button>
          </>
        )
      }
    >
      {done ? (
        <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-4 text-sm text-ok"><Check size={18} className="shrink-0" /> {done}</p>
      ) : (
        <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4">
          <FormError error={error} />
          <Field label="Correo">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium text-ink">Rol</legend>
            {(['admin', 'finance', 'viewer'] as const).map((r) => (
              <label key={r} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${role === r ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle'}`}>
                <input type="radio" name="role" checked={role === r} onChange={() => setRoleValue(r)} className="mt-0.5 accent-navy-900" />
                <span>
                  <span className="block text-sm font-medium text-ink">{ROLE_LABEL[r]}</span>
                  <span className="block text-xs text-muted">{ROLE_HINT[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </form>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Portal financiero
// ---------------------------------------------------------------------------
interface AccessRow extends PortalAccess {
  counterparty_name: string
  kind: string
  slug: string | null
}

function PortalSettings() {
  const { tenant, canAdmin } = useCurrentTenant()
  const update = useUpdateTenant()
  const access = usePortalAccess()
  const counterparties = useCounterparties()
  const { setEnabled, remove, regenerate } = usePortalAccessMutations()
  const [addOpen, setAddOpen] = useNewParam()
  const [message, setMessage] = useState(tenant.portal_message ?? '')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const cpById = useMemo(() => new Map((counterparties.data ?? []).map((c) => [c.id, c])), [counterparties.data])
  const rows: AccessRow[] = (access.data ?? []).map((a) => {
    const cp = cpById.get(a.counterparty_id)
    return {
      ...a,
      counterparty_name: cp?.name ?? '—',
      kind: cp ? (cp.is_supplier && cp.is_customer ? 'Proveedor y cliente' : cp.is_supplier ? 'Proveedor' : 'Cliente') : '—',
      slug: cp?.portal_slug ?? null,
    }
  })

  async function savePortal(enabled: boolean) {
    setError(null)
    try {
      await update.mutateAsync({ name: tenant.name, legal_name: tenant.legal_name, tax_id: tenant.tax_id, portal_enabled: enabled, portal_message: message.trim() || null })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  function invitationText(row: AccessRow) {
    return `Hola, ${tenant.legal_name ?? tenant.name} te dio acceso a su portal financiero, donde puedes revisar documentos, pagos y descargar archivos de ${row.counterparty_name}.\n\nEntra en ${portalUrl(row.slug)} con tu correo ${row.email}: te enviaremos un código para ingresar.`
  }

  const columns: ListColumn<AccessRow>[] = [
    { key: 'cp', header: 'Contraparte', cell: (r) => r.counterparty_name, sortValue: (r) => r.counterparty_name },
    { key: 'kind', header: 'Tipo', cell: (r) => r.kind, sortValue: (r) => r.kind },
    { key: 'email', header: 'Correo autorizado', cell: (r) => r.email, sortValue: (r) => r.email },
    {
      key: 'link',
      header: 'Link del portal',
      cell: (r) =>
        r.slug ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              copy(portalUrl(r.slug), `link-${r.id}`)
            }}
            title={portalUrl(r.slug)}
            className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink hover:bg-subtle"
          >
            {copied === `link-${r.id}` ? <Check size={13} className="text-ok" /> : <Copy size={13} className="text-faint" />}
            <span className="truncate">/portal/{r.slug}</span>
          </button>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: 'status', header: 'Acceso', cell: (r) => (r.enabled ? <Badge tone="ok">Activo</Badge> : <Badge>Pausado</Badge>), sortValue: (r) => (r.enabled ? 0 : 1) },
    { key: 'last', header: 'Último ingreso', cell: (r) => (r.last_access_at ? formatTimestampDate(r.last_access_at, tenant.timezone) : <span className="text-faint">Nunca</span>), sortValue: (r) => r.last_access_at },
  ]
  const filters: ListFilter<AccessRow>[] = [
    { type: 'select', key: 'kind', label: 'Tipo', options: ['Cliente', 'Proveedor', 'Proveedor y cliente'].map((k) => ({ value: k, label: k })), match: (r, v) => r.kind === v },
    { type: 'select', key: 'status', label: 'Acceso', options: [{ value: 'on', label: 'Activo' }, { value: 'off', label: 'Pausado' }], match: (r, v) => r.enabled === (v === 'on') },
  ]
  const list = useListState({
    rows,
    rowKey: (r) => r.id,
    columns,
    filters,
    searchText: (r) => `${r.counterparty_name} ${r.email}`,
    storageKey: 'portal-access',
    defaultSort: { key: 'cp', dir: 'asc' },
  })

  return (
    <div className="flex flex-col gap-5">
      <FormError error={error} />
      <Section
        title="Portal financiero"
        description="Tus clientes y proveedores revisan sus documentos, pagos, fechas de pago agendadas y archivos, sin pedírtelos por correo."
        actions={
          <div className="flex items-center gap-3">
            {tenant.portal_enabled ? <Badge tone="ok">Activo</Badge> : <Badge>Desactivado</Badge>}
            {canAdmin && (
              <Button variant={tenant.portal_enabled ? 'secondary' : 'primary'} onClick={() => savePortal(!tenant.portal_enabled)} disabled={update.isPending}>
                <Power size={16} /> {tenant.portal_enabled ? 'Desactivar' : 'Activar portal'}
              </Button>
            )}
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-ink">Acceso general</span>
            <div className="flex gap-2">
              <Input readOnly value={portalUrl()} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => copy(portalUrl(), 'url')}>{copied === 'url' ? <Check size={16} /> : <Copy size={16} />}</Button>
              <a href="/portal" target="_blank" rel="noopener" className="inline-flex h-9 items-center rounded-md border border-line px-3 text-muted hover:bg-subtle" aria-label="Abrir portal">
                <ExternalLink size={16} />
              </a>
            </div>
            <p className="text-xs text-muted">
              Cada cliente y proveedor tiene además su propio link (columna "Link del portal"), que muestra su nombre al ingresar. En ambos casos se entra con el correo autorizado y un código de un solo uso: el link por sí solo no da acceso a nada.
            </p>
          </div>
          <Field label="Mensaje de bienvenida" hint="Opcional. Se muestra arriba en el portal (ej. a quién escribir por dudas).">
            {(id) => (
              <div className="flex flex-col gap-2">
                <Textarea id={id} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!canAdmin} maxLength={400} />
                {canAdmin && message !== (tenant.portal_message ?? '') && (
                  <Button size="sm" className="self-end" onClick={() => savePortal(tenant.portal_enabled)}>Guardar mensaje</Button>
                )}
              </div>
            )}
          </Field>
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">Accesos</h2>
        {canAdmin && <Button variant="primary" onClick={() => setAddOpen(true)}><Plus size={16} /> Dar acceso</Button>}
      </div>
      <ListView
        state={list}
        columns={columns}
        rowKey={(r) => r.id}
        filters={filters}
        loading={access.isLoading}
        searchPlaceholder="Buscar contraparte o correo…"
        rowActions={(r) => (
          <>
            <RowAction label="Copiar invitación" onClick={() => copy(invitationText(r), r.id)}>
              {copied === r.id ? <Check size={17} className="text-ok" /> : <Mail size={17} />}
            </RowAction>
            {canAdmin && (
              <RowAction
                label="Regenerar link"
                onClick={() =>
                  window.confirm(`¿Crear un link nuevo para ${r.counterparty_name}? El link actual dejará de funcionar para todos sus correos.`) &&
                  regenerate.mutate(r.counterparty_id)
                }
              >
                <RefreshCw size={17} />
              </RowAction>
            )}
            {canAdmin && (
              <RowAction label={r.enabled ? 'Pausar acceso' : 'Reactivar acceso'} onClick={() => setEnabled.mutate({ id: r.id, enabled: !r.enabled })}>
                <Power size={17} className={r.enabled ? '' : 'text-ok'} />
              </RowAction>
            )}
            {canAdmin && (
              <RowAction
                label="Quitar acceso"
                tone="danger"
                onClick={() => window.confirm(`¿Quitar el acceso de ${r.email}?`) && remove.mutate(r.id)}
              >
                <Trash2 size={17} />
              </RowAction>
            )}
          </>
        )}
        empty={
          <EmptyState
            icon={<Users size={20} />}
            title="Nadie tiene acceso todavía"
            description="Da acceso a los correos de tus clientes o proveedores para que vean sus documentos y pagos."
          />
        }
      />
      {!tenant.portal_enabled && rows.length > 0 && (
        <p className="text-sm text-warn">El portal está desactivado: los accesos quedan guardados, pero nadie puede entrar hasta que lo actives.</p>
      )}
      {addOpen && <AddAccessDrawer onClose={() => setAddOpen(false)} />}
    </div>
  )
}

function AddAccessDrawer({ onClose }: { onClose: () => void }) {
  const counterparties = useCounterparties()
  const contacts = useContacts()
  const { add } = usePortalAccessMutations()
  const [counterpartyId, setCounterpartyId] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cp = (counterparties.data ?? []).find((c) => c.id === counterpartyId)
  const suggestions = [
    ...(cp?.email ? [{ email: cp.email, label: 'Correo de la empresa' }] : []),
    ...(contacts.data ?? []).filter((c) => c.counterparty_id === counterpartyId && c.email).map((c) => ({ email: c.email!, label: `${c.name}${c.position ? ` · ${c.position}` : ''}` })),
  ]

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!counterpartyId) return setError('Elige la contraparte')
    try {
      await add.mutateAsync({ counterpartyId, email })
      onClose()
    } catch (err) {
      setError(errorMessage(err).includes('duplicado') ? 'Ese correo ya tiene acceso a esta contraparte.' : errorMessage(err))
    }
  }

  return (
    <Drawer
      open
      title="Dar acceso al portal"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="access-form" disabled={add.isPending}>Dar acceso</Button>
        </>
      }
    >
      <form id="access-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Cliente o proveedor">
          {(id) => (
            <Select id={id} value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} autoFocus>
              <option value="">Selecciona…</option>
              {(counterparties.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Correo autorizado" hint="Recibirá un código para entrar. Puedes dar acceso a varios correos por contraparte.">
          {(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        {suggestions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Correos conocidos</span>
            {suggestions.map((s) => (
              <button
                key={s.email}
                type="button"
                onClick={() => setEmail(s.email)}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${email === s.email ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle'}`}
              >
                <span className="text-ink">{s.email}</span>
                <span className="text-xs text-faint">{s.label}</span>
              </button>
            ))}
          </div>
        )}
      </form>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Contabilidad: categorías (plan de cuentas simplificado) y centros de costos
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<AccountingCategory['kind'], string> = { expense: 'Gasto', income: 'Ingreso', both: 'Gasto e ingreso' }

type CatalogRow = { id: string; code: string | null; name: string; active: boolean; kind?: AccountingCategory['kind'] }

function AccountingSettings() {
  const categories = useCategories()
  const costCenters = useCostCenters()
  const { saveCategory, saveCostCenter } = useCatalogMutations()
  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-3xl text-sm text-muted">
        Se usan en la asignación contable de cada documento. Los gastos aparecen en cuentas por pagar y los ingresos en cuentas por cobrar.
        Desactivar una opción la oculta para nuevas asignaciones sin afectar las existentes.
      </p>
      <CatalogList
        title="Categorías contables"
        storageKey="categories"
        rows={categories.data ?? []}
        loading={categories.isLoading}
        withKind
        onSave={(input, id) => saveCategory.mutateAsync({ input: { code: input.code, name: input.name, active: input.active, kind: input.kind ?? 'expense' }, id })}
      />
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
  onSave,
}: {
  title: string
  storageKey: string
  rows: CatalogRow[]
  loading: boolean
  withKind?: boolean
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
    ...(withKind ? [{ type: 'select' as const, key: 'kind', label: 'Tipo', options: (Object.keys(KIND_LABEL) as AccountingCategory['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] })), match: (r: CatalogRow, v: string) => r.kind === v }] : []),
    { type: 'select', key: 'active', label: 'Estado', options: [{ value: 'on', label: 'Activas' }, { value: 'off', label: 'Inactivas' }], match: (r, v) => r.active === (v === 'on') },
  ]
  const list = useListState({ rows, rowKey: (r) => r.id, columns, filters, searchText: (r) => `${r.code ?? ''} ${r.name}`, storageKey, defaultSort: { key: 'code', dir: 'asc' } })
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
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

function CatalogDrawer({ title, row, withKind, onClose, onSave }: { title: string; row: CatalogRow | null; withKind?: boolean; onClose: () => void; onSave: (input: Omit<CatalogRow, 'id'>) => Promise<void> }) {
  const [code, setCode] = useState(row?.code ?? '')
  const [name, setName] = useState(row?.name ?? '')
  const [kind, setKind] = useState<AccountingCategory['kind']>(row?.kind ?? 'expense')
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
          <Field label="Tipo">
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
