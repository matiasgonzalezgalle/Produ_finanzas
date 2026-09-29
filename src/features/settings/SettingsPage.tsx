import { Check, Copy, ExternalLink, KeyRound, Mail, Plus, Power, RefreshCw, Trash2, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useContacts, useCounterparties, usePortalAccess, usePortalAccessMutations, useUpdateTenant } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { ModuleKey, PortalAccess } from '../../data'
import { formatTimestampDate } from '../../domain/dates'
import { formatTaxId, isValidTaxId, normalizeTaxId, TAX_ID_LABEL } from '../../domain/taxId'
import { Badge, Button, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select, Textarea } from '../../ui'
import { ListView, RowAction, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { IntegrationsSettings } from '../integrations/IntegrationsPage'
import { ModuleAdmin } from './ModuleAdmin'
import { NotificationsSettings } from './NotificationsSettings'
import { Section } from './parts'
import { UserManagement } from '../users/UserManagement'
import { errorMessage, useNewParam } from '../shared'

export type SettingsTab = 'empresa' | 'usuarios' | 'cxp' | 'cxc' | 'integraciones' | 'notificaciones' | 'portal'

const TABS: { to: string; label: string; module?: ModuleKey }[] = [
  { to: '/configuracion/empresa', label: 'Empresa' },
  { to: '/configuracion/usuarios', label: 'Usuarios' },
  { to: '/configuracion/cuentas-por-pagar', label: 'Cuentas por pagar', module: 'cuentas_por_pagar' },
  { to: '/configuracion/cuentas-por-cobrar', label: 'Cuentas por cobrar', module: 'cuentas_por_cobrar' },
  { to: '/configuracion/integraciones', label: 'Integraciones' },
  { to: '/configuracion/notificaciones', label: 'Notificaciones' },
  { to: '/configuracion/portal', label: 'Portal financiero', module: 'portal' },
]

export { ROLE_LABEL } from '../users/roles'

function portalUrl(slug?: string | null) {
  return `${window.location.origin}/portal${slug ? `/${slug}` : ''}`
}

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const { hasModule } = useCurrentTenant()
  return (
    <div>
      <PageHeader title="Configuración" tabs={TABS.filter((t) => !t.module || hasModule(t.module))} />
      <div className="pt-6">
        {tab === 'empresa' && <CompanySettings />}
        {tab === 'usuarios' && <UsersSettings />}
        {tab === 'cxp' && <ModuleAdmin direction="payable" />}
        {tab === 'cxc' && <ModuleAdmin direction="receivable" />}
        {tab === 'integraciones' && <IntegrationsSettings />}
        {tab === 'notificaciones' && <NotificationsSettings />}
        {tab === 'portal' && <PortalSettings />}
      </div>
    </div>
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
  return <UserManagement tenantId={tenant.id} tenantName={tenant.name} timezone={tenant.timezone} canManage={canAdmin} />
}

// ---------------------------------------------------------------------------
// Portal financiero
// ---------------------------------------------------------------------------
interface AccessRow extends PortalAccess {
  counterparty_name: string
  counterparty_kind: string
  slug: string | null
}

/** Resultado de generar un código: se muestra una sola vez. */
interface IssuedCode {
  code: string
  link: string
  label: string
  counterparty: string
}

function codeInstructions(tenantName: string, issued: IssuedCode) {
  return `Hola ${issued.label}, ${tenantName} te dio acceso a su portal financiero de ${issued.counterparty}.\n\n1. Entra en ${issued.link}\n2. Elige "Ingresar con código"\n3. Escribe tu código: ${issued.code}\n\nGuárdalo en un lugar seguro: es personal.`
}

function PortalSettings() {
  const { tenant, canAdmin } = useCurrentTenant()
  const update = useUpdateTenant()
  const access = usePortalAccess()
  const counterparties = useCounterparties()
  const { setEnabled, remove, regenerate, regenerateCode } = usePortalAccessMutations()
  const [issued, setIssued] = useState<IssuedCode | null>(null)
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
      counterparty_kind: cp ? (cp.is_supplier && cp.is_customer ? 'Proveedor y cliente' : cp.is_supplier ? 'Proveedor' : 'Cliente') : '—',
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
    if (row.kind === 'code') {
      return `Hola ${row.label}, entra al portal financiero de ${row.counterparty_name} en ${portalUrl(row.slug)} y elige "Ingresar con código". Si no tienes tu código, pídelo a ${tenant.legal_name ?? tenant.name}.`
    }
    return `Hola, ${tenant.legal_name ?? tenant.name} te dio acceso a su portal financiero, donde puedes revisar documentos, pagos y descargar archivos de ${row.counterparty_name}.\n\nEntra en ${portalUrl(row.slug)} con tu correo ${row.email}: te enviaremos un código para ingresar.`
  }

  const columns: ListColumn<AccessRow>[] = [
    { key: 'cp', header: 'Contraparte', cell: (r) => r.counterparty_name, sortValue: (r) => r.counterparty_name },
    { key: 'kind', header: 'Tipo', cell: (r) => r.counterparty_kind, sortValue: (r) => r.counterparty_kind, mobileHidden: true },
    {
      key: 'who',
      header: 'Quién accede',
      cell: (r) =>
        r.kind === 'code' ? (
          <span className="flex flex-col leading-tight">
            <span className="text-ink">{r.label}</span>
            <span className="text-[11px] text-faint">
              Código ••••-••{r.code_hint}
              {r.expires_at ? ` · vence ${formatTimestampDate(r.expires_at, tenant.timezone)}` : ''}
            </span>
          </span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="text-ink">{r.email}</span>
            <span className="text-[11px] text-faint">Correo</span>
          </span>
        ),
      sortValue: (r) => r.email ?? r.label ?? '',
    },
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
    { type: 'select', key: 'kind', label: 'Tipo', options: ['Cliente', 'Proveedor', 'Proveedor y cliente'].map((k) => ({ value: k, label: k })), match: (r, v) => r.counterparty_kind === v },
    { type: 'select', key: 'method', label: 'Forma de ingreso', options: [{ value: 'email', label: 'Correo' }, { value: 'code', label: 'Código' }], match: (r, v) => r.kind === v },
    { type: 'select', key: 'status', label: 'Acceso', options: [{ value: 'on', label: 'Activo' }, { value: 'off', label: 'Pausado' }], match: (r, v) => r.enabled === (v === 'on') },
  ]
  const list = useListState({
    rows,
    rowKey: (r) => r.id,
    columns,
    filters,
    searchText: (r) => `${r.counterparty_name} ${r.email ?? ''} ${r.label ?? ''}`,
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
            <span className="text-[12px] font-medium text-ink">Acceso general</span>
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
            {canAdmin && r.kind === 'code' && (
              <RowAction
                label="Generar nuevo código"
                onClick={async () => {
                  if (!window.confirm(`¿Generar un código nuevo para ${r.label}? El código actual dejará de funcionar y se cerrarán sus sesiones abiertas.`)) return
                  setError(null)
                  try {
                    const res = await regenerateCode.mutateAsync(r.id)
                    setIssued({ code: res.code, link: portalUrl(res.slug), label: r.label ?? '', counterparty: r.counterparty_name })
                  } catch (err) {
                    setError(errorMessage(err))
                  }
                }}
              >
                <KeyRound size={17} />
              </RowAction>
            )}
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
      {addOpen && <AddAccessDrawer onClose={() => setAddOpen(false)} onIssued={setIssued} />}
      {issued && <IssuedCodeDrawer issued={issued} tenantName={tenant.legal_name ?? tenant.name} onClose={() => setIssued(null)} />}
    </div>
  )
}

function IssuedCodeDrawer({ issued, tenantName, onClose }: { issued: IssuedCode; tenantName: string; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string, key: string) =>
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  return (
    <Drawer open title="Código de acceso generado" subtitle={`${issued.label} · ${issued.counterparty}`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Listo, ya lo guardé</Button>}>
      <div className="flex flex-col gap-5">
        <p className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">Copia y entrega este código ahora: por seguridad no se vuelve a mostrar. Si se pierde, genera uno nuevo.</p>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-subtle py-6">
          <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">Código</span>
          <span className="font-mono text-3xl font-semibold tracking-[0.2em] text-ink">{issued.code}</span>
          <Button size="sm" onClick={() => copy(issued.code, 'code')}>{copied === 'code' ? <Check size={14} /> : <Copy size={14} />} Copiar código</Button>
        </div>
        <Field label="Link del portal">
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} readOnly value={issued.link} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => copy(issued.link, 'link')}>{copied === 'link' ? <Check size={14} /> : <Copy size={14} />}</Button>
            </div>
          )}
        </Field>
        <Button onClick={() => copy(codeInstructions(tenantName, issued), 'all')}>
          {copied === 'all' ? <Check size={14} /> : <Mail size={14} />} Copiar instrucciones (link + código) para enviar por WhatsApp u otro medio
        </Button>
      </div>
    </Drawer>
  )
}

const EXPIRY_OPTIONS = [
  { value: '', label: 'Sin vencimiento' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '365', label: '1 año' },
]

function AddAccessDrawer({ onClose, onIssued }: { onClose: () => void; onIssued: (issued: IssuedCode) => void }) {
  const counterparties = useCounterparties()
  const contacts = useContacts()
  const { add, createCode } = usePortalAccessMutations()
  const [method, setMethod] = useState<'email' | 'code'>('email')
  const [counterpartyId, setCounterpartyId] = useState('')
  const [email, setEmail] = useState('')
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cp = (counterparties.data ?? []).find((c) => c.id === counterpartyId)
  const cpContacts = (contacts.data ?? []).filter((c) => c.counterparty_id === counterpartyId)
  const suggestions = [
    ...(cp?.email ? [{ email: cp.email, label: 'Correo de la empresa' }] : []),
    ...cpContacts.filter((c) => c.email).map((c) => ({ email: c.email!, label: `${c.name}${c.position ? ` · ${c.position}` : ''}` })),
  ]
  const pending = add.isPending || createCode.isPending

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!counterpartyId) return setError('Elige la contraparte')
    try {
      if (method === 'email') {
        await add.mutateAsync({ counterpartyId, email })
        onClose()
      } else {
        if (!label.trim()) return setError('Indica a quién corresponde el código (nombre o cargo)')
        const expiresAt = expiry ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() : null
        const res = await createCode.mutateAsync({ counterpartyId, label: label.trim(), expiresAt })
        onIssued({ code: res.code, link: portalUrl(res.slug), label: label.trim(), counterparty: cp?.name ?? '' })
        onClose()
      }
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
          <Button variant="primary" type="submit" form="access-form" disabled={pending}>{method === 'email' ? 'Dar acceso' : 'Generar código'}</Button>
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
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium text-ink">¿Cómo va a ingresar?</legend>
          {([
            ['email', 'Con su correo', 'Recibe un código de un solo uso en su correo cada vez que entra.'],
            ['code', 'Con un código (sin correo)', 'Generas un código personal y se lo entregas tú, junto con el link. Útil para quien no usa correo.'],
          ] as const).map(([key, title, hint]) => (
            <label key={key} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${method === key ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle'}`}>
              <input type="radio" name="method" checked={method === key} onChange={() => setMethod(key)} className="mt-0.5 accent-navy-900" />
              <span>
                <span className="block text-sm font-medium text-ink">{title}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {method === 'email' ? (
          <>
            <Field label="Correo autorizado" hint="Puedes dar acceso a varios correos por contraparte.">
              {(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Correos conocidos</span>
                {suggestions.map((sug) => (
                  <button
                    key={sug.email}
                    type="button"
                    onClick={() => setEmail(sug.email)}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${email === sug.email ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle'}`}
                  >
                    <span className="text-ink">{sug.email}</span>
                    <span className="text-xs text-faint">{sug.label}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="¿Para quién es?" hint="Nombre o cargo, para reconocer el acceso (ej. Juan Pérez · bodega).">
              {(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} list="contact-names" />}
            </Field>
            <datalist id="contact-names">
              {cpContacts.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
            <Field label="Vigencia">
              {(id) => (
                <Select id={id} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              )}
            </Field>
            <p className="text-xs text-muted">Al generar, verás el código y el link una sola vez para copiarlos y entregarlos.</p>
          </>
        )}
      </form>
    </Drawer>
  )
}
