// Gestión de usuarios de una empresa: crear (invitación o contraseña temporal), editar nombre y rol,
// definir contraseña, enviar correo de acceso, quitar de la empresa y eliminar la cuenta.
// Se usa en Configuración › Usuarios y en el administrador de empresas (superadministrador).
import clsx from 'clsx'
import { Check, Copy, EllipsisVertical, KeyRound, Mail, RefreshCw, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { useTenantUserMutations, useTenantUsers } from '../../app/queries'
import { useSession } from '../../app/session'
import type { MemberRole, TenantUser } from '../../data'
import { formatTimestamp, formatTimestampDate } from '../../domain/dates'
import { Badge, Button, Drawer, EmptyState, Field, FormError, Input, type Tone } from '../../ui'
import { ListView, RowMenu, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { errorMessage } from '../shared'
import { ROLE_HINT, ROLE_LABEL } from './roles'

type AssignableRole = Exclude<MemberRole, 'owner'>
const ASSIGNABLE: AssignableRole[] = ['admin', 'finance', 'viewer']

function userStatus(u: TenantUser): { label: string; tone: Tone } {
  if (u.blocked) return { label: 'Bloqueado', tone: 'bad' }
  if (u.must_change_password) return { label: 'Contraseña temporal', tone: 'warn' }
  if (u.pending) return { label: 'Pendiente de activar', tone: 'warn' }
  return { label: 'Activo', tone: 'ok' }
}

/** Contraseña temporal legible (sin caracteres ambiguos). */
export function generatePassword(length = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

const initials = (text: string) => text.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

interface Props {
  tenantId: string
  tenantName: string
  timezone: string
  /** Dueño/administrador de la empresa o superadministrador. */
  canManage: boolean
  /** Quien gestiona es superadministrador (puede controlar cuentas que están en varias empresas). */
  platformAdmin?: boolean
}

export function UserManagement({ tenantId, tenantName, timezone, canManage, platformAdmin = false }: Props) {
  const { session } = useSession()
  const users = useTenantUsers(tenantId)
  const m = useTenantUserMutations(tenantId)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const rows = users.data ?? []
  const me = rows.find((u) => u.user_id === session?.userId)
  const callerIsOwner = me?.role === 'owner'

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (ok) setNotice(ok)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const sendReset = (u: TenantUser) => run(() => m.sendReset.mutateAsync(u.user_id), `Enviamos a ${u.email} un correo para crear su contraseña.`)
  const removeFromTenant = (u: TenantUser) => {
    if (!confirm(`¿Quitar a ${u.full_name || u.email} de ${tenantName}? Perderá el acceso de inmediato.`)) return
    run(() => m.remove.mutateAsync(u.user_id), `${u.full_name || u.email} ya no tiene acceso a la empresa.`)
  }
  const destroy = (u: TenantUser) => {
    if (!confirm(`¿Eliminar a ${u.full_name || u.email}? Perderá el acceso de inmediato. Si registró información, la cuenta queda bloqueada para conservar el historial.`)) return
    run(async () => {
      const r = await m.destroy.mutateAsync(u.user_id)
      setOpenId(null)
      setNotice(r.result === 'deleted' ? 'Usuario eliminado.' : r.result === 'blocked' ? 'Usuario eliminado de la empresa. Su cuenta quedó bloqueada para conservar el historial.' : 'El usuario está en otras empresas: se quitó solo de esta.')
    })
  }

  const columns: ListColumn<TenantUser>[] = [
    {
      key: 'name', header: 'Usuario', sortValue: (u) => (u.full_name || u.email || '').toLowerCase(), className: 'min-w-56',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-muted">{initials(u.full_name || u.email || '')}</span>
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{u.full_name || 'Sin nombre'}{u.user_id === session?.userId && <span className="ml-1.5 text-xs font-normal text-faint">(tú)</span>}</div>
            <div className="truncate text-xs text-faint">{u.email}</div>
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Rol', sortValue: (u) => ['owner', 'admin', 'finance', 'viewer'].indexOf(u.role), cell: (u) => <Badge tone={u.role === 'owner' ? 'solid' : 'neutral'}>{ROLE_LABEL[u.role]}</Badge> },
    { key: 'status', header: 'Estado', mobileBadge: true, sortValue: (u) => userStatus(u).label, cell: (u) => <Badge tone={userStatus(u).tone}>{userStatus(u).label}</Badge> },
    { key: 'last', header: 'Último acceso', mobileHidden: true, sortValue: (u) => u.last_sign_in_at ?? '', cell: (u) => <span className="text-sm text-muted">{u.last_sign_in_at ? formatTimestamp(u.last_sign_in_at, timezone) : 'Nunca'}</span> },
    { key: 'since', header: 'En la empresa desde', mobileHidden: true, sortValue: (u) => u.created_at, cell: (u) => formatTimestampDate(u.created_at, timezone) },
  ]
  const filters: ListFilter<TenantUser>[] = [
    { type: 'select', key: 'role', label: 'Rol', options: (Object.keys(ROLE_LABEL) as MemberRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] })), match: (u, v) => u.role === v },
    { type: 'select', key: 'status', label: 'Estado', options: ['Activo', 'Pendiente de activar', 'Contraseña temporal', 'Bloqueado'].map((l) => ({ value: l, label: l })), match: (u, v) => userStatus(u).label === v },
  ]
  const list = useListState({
    rows, rowKey: (u) => u.user_id, columns, filters,
    searchText: (u) => `${u.full_name ?? ''} ${u.email ?? ''}`,
    storageKey: 'tenant-users', defaultSort: { key: 'role', dir: 'asc' },
  })

  const selected = rows.find((u) => u.user_id === openId) ?? null
  const canControlAccount = (u: TenantUser) =>
    u.user_id !== session?.userId && (platformAdmin || (u.other_tenants === 0 && (u.role !== 'owner' || callerIsOwner)))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Cada usuario entra con su propio correo y ve solo las empresas a las que pertenece, según su rol.</p>
        {canManage && <Button variant="primary" onClick={() => setCreating(true)}><UserPlus size={16} /> Crear usuario</Button>}
      </div>
      <FormError error={error ?? (users.error ? errorMessage(users.error) : null)} />
      {notice && <p className="flex items-center gap-2 rounded-md bg-ok-bg px-3 py-2 text-sm text-ok"><Check size={16} /> {notice}</p>}
      <ListView
        state={list}
        columns={columns}
        rowKey={(u) => u.user_id}
        filters={filters}
        loading={users.isLoading}
        searchPlaceholder="Buscar por nombre o correo…"
        onRowClick={canManage ? (u) => setOpenId(u.user_id) : undefined}
        rowActions={canManage ? (u) => (
          <RowMenu
            label="Acciones"
            icon={<EllipsisVertical size={16} />}
            items={[
              { label: 'Editar', onClick: () => setOpenId(u.user_id) },
              { label: u.pending ? 'Reenviar correo de acceso' : 'Enviar correo para restablecer contraseña', onClick: () => sendReset(u), disabled: u.blocked },
              ...(canControlAccount(u) ? [{ label: 'Definir contraseña temporal', onClick: () => setOpenId(u.user_id) }] : []),
              ...(u.role !== 'owner' && u.user_id !== session?.userId ? [{ label: 'Quitar de la empresa', tone: 'danger' as const, onClick: () => removeFromTenant(u) }] : []),
              ...(u.role !== 'owner' && canControlAccount(u) ? [{ label: 'Eliminar usuario', tone: 'danger' as const, onClick: () => destroy(u) }] : []),
            ]}
          />
        ) : undefined}
        empty={<EmptyState icon={<Users size={20} />} title="Sin usuarios" />}
      />
      {creating && <CreateUserDrawer tenantId={tenantId} tenantName={tenantName} onClose={() => setCreating(false)} />}
      {selected && (
        <UserDrawer
          key={selected.user_id}
          tenantId={tenantId}
          user={selected}
          timezone={timezone}
          isMe={selected.user_id === session?.userId}
          canControlAccount={canControlAccount(selected)}
          platformAdmin={platformAdmin}
          onSendReset={() => sendReset(selected)}
          onRemove={() => { removeFromTenant(selected); setOpenId(null) }}
          onDelete={() => destroy(selected)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}

function RoleRadios({ value, onChange }: { value: AssignableRole; onChange: (r: AssignableRole) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[12px] font-medium text-ink">Rol</legend>
      {ASSIGNABLE.map((r) => (
        <label key={r} className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', value === r ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
          <input type="radio" checked={value === r} onChange={() => onChange(r)} className="mt-0.5 accent-navy-900" />
          <span>
            <span className="block text-sm font-medium text-ink">{ROLE_LABEL[r]}</span>
            <span className="block text-xs text-muted">{ROLE_HINT[r]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Field label="Contraseña temporal" hint="Mínimo 10 caracteres. Se le pedirá cambiarla al entrar.">
      {(id) => (
        <div className="flex gap-2">
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" autoComplete="off" />
          <Button type="button" onClick={() => onChange(generatePassword())} title="Generar otra"><RefreshCw size={15} /></Button>
          <Button type="button" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }} title="Copiar">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
      )}
    </Field>
  )
}

function CreateUserDrawer({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  const { create } = useTenantUserMutations(tenantId)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AssignableRole>('finance')
  const [mode, setMode] = useState<'invite' | 'password'>('invite')
  const [password, setPassword] = useState(generatePassword)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'invited' | 'password' | 'existing' | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!fullName.trim()) return setError('Indica el nombre y apellido del usuario.')
    if (mode === 'password' && password.length < 10) return setError('La contraseña temporal debe tener al menos 10 caracteres.')
    try {
      const r = await create.mutateAsync({ email: email.trim(), fullName: fullName.trim(), role, mode, password: mode === 'password' ? password : undefined })
      setDone(r.created)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  const instructions = `Hola ${fullName.trim()}, te creamos un usuario en Produ Finanzas para ${tenantName}.\n\nEntra en ${window.location.origin}/login\nCorreo: ${email.trim()}\nContraseña temporal: ${password}\n\nAl entrar te pediremos definir una contraseña propia.`

  if (done) {
    return (
      <Drawer open title="Usuario creado" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
        {done === 'password' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink">Comparte estos datos con <b>{fullName}</b> por un canal seguro. <b>La contraseña no se volverá a mostrar.</b></p>
            <pre className="rounded-lg bg-subtle p-3 text-xs whitespace-pre-wrap text-ink">{instructions}</pre>
            <Button onClick={() => { navigator.clipboard?.writeText(instructions); setCopied(true) }}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copiado' : 'Copiar instrucciones'}</Button>
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-4 text-sm text-ok">
            <Check size={18} className="shrink-0" />
            {done === 'invited'
              ? `Enviamos una invitación a ${email}. Al aceptarla creará su contraseña y entrará directo a ${tenantName}.`
              : `${email} ya tenía cuenta: quedó agregado a ${tenantName} con su nombre y contraseña actuales.`}
          </p>
        )}
      </Drawer>
    )
  }

  return (
    <Drawer
      open title="Crear usuario" onClose={onClose} width="lg"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" type="submit" form="create-user-form" disabled={create.isPending}>{create.isPending ? 'Creando…' : 'Crear usuario'}</Button></>}
    >
      <form id="create-user-form" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre y apellido">{(id) => <Input id={id} required value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus autoComplete="off" />}</Field>
          <Field label="Correo">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}</Field>
        </div>
        <RoleRadios value={role} onChange={setRole} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] font-medium text-ink">Acceso</legend>
          {([
            ['invite', 'Enviar invitación por correo', 'Recibe un enlace para crear su propia contraseña.', Mail],
            ['password', 'Definir contraseña temporal', 'Tú le entregas la contraseña; al entrar deberá cambiarla.', KeyRound],
          ] as const).map(([value, label, hint, Icon]) => (
            <label key={value} className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', mode === value ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
              <input type="radio" checked={mode === value} onChange={() => setMode(value)} className="mt-0.5 accent-navy-900" />
              <Icon size={16} className="mt-0.5 shrink-0 text-muted" />
              <span>
                <span className="block text-sm font-medium text-ink">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === 'password' && <PasswordField value={password} onChange={setPassword} />}
        <p className="text-xs text-faint">Si el correo ya tiene cuenta en Produ Finanzas, se agrega a la empresa con su nombre y contraseña actuales.</p>
      </form>
    </Drawer>
  )
}

function UserDrawer({
  tenantId, user: u, timezone, isMe, canControlAccount, platformAdmin, onSendReset, onRemove, onDelete, onClose,
}: {
  tenantId: string
  user: TenantUser
  timezone: string
  isMe: boolean
  canControlAccount: boolean
  platformAdmin: boolean
  onSendReset: () => void
  onRemove: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const m = useTenantUserMutations(tenantId)
  const [fullName, setFullName] = useState(u.full_name ?? '')
  const [role, setRole] = useState<MemberRole>(u.role)
  const [password, setPassword] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [passwordDone, setPasswordDone] = useState(false)
  const status = userStatus(u)
  const roleEditable = u.role !== 'owner' && !isMe

  const save = async () => {
    setError(null)
    if (!fullName.trim()) return setError('Indica el nombre del usuario.')
    try {
      await m.update.mutateAsync({ userId: u.user_id, fullName: fullName.trim(), role })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const savePassword = async () => {
    if (!password) return
    setError(null)
    if (password.length < 10) return setError('La contraseña temporal debe tener al menos 10 caracteres.')
    try {
      await m.setPassword.mutateAsync({ userId: u.user_id, password })
      setPasswordDone(true)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer
      open title={u.full_name || u.email || 'Usuario'} subtitle={u.email} onClose={onClose} width="lg"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save} disabled={m.update.isPending}>{m.update.isPending ? 'Guardando…' : 'Guardar cambios'}</Button></>}
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span>Último acceso: {u.last_sign_in_at ? formatTimestamp(u.last_sign_in_at, timezone) : 'nunca'}</span>
          {u.other_tenants > 0 && <span>También en {u.other_tenants} {u.other_tenants === 1 ? 'otra empresa' : 'otras empresas'}</span>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre y apellido">{(id) => <Input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
          <Field label="Correo" hint="El correo es el usuario de ingreso y no se cambia.">{(id) => <Input id={id} value={u.email ?? ''} disabled />}</Field>
        </div>
        {roleEditable ? (
          <RoleRadios value={role as AssignableRole} onChange={setRole} />
        ) : (
          <p className="text-sm text-muted">Rol: <b className="text-ink">{ROLE_LABEL[u.role]}</b>{u.role === 'owner' ? ' (el dueño no cambia de rol)' : isMe ? ' (no puedes cambiar tu propio rol)' : ''}</p>
        )}

        <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
          <h3 className="text-sm font-semibold text-ink">Contraseña y acceso</h3>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onSendReset} disabled={m.sendReset.isPending || u.blocked}><Mail size={15} /> {u.pending ? 'Reenviar correo de acceso' : 'Enviar correo para restablecer'}</Button>
            {canControlAccount && password === null && !passwordDone && (
              <Button onClick={() => setPassword(generatePassword())}><KeyRound size={15} /> Definir contraseña temporal</Button>
            )}
          </div>
          {password !== null && !passwordDone && (
            <div className="flex flex-col gap-2">
              <PasswordField value={password} onChange={setPassword} />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setPassword(null)}>Cancelar</Button>
                <Button size="sm" variant="primary" onClick={savePassword} disabled={m.setPassword.isPending}>{m.setPassword.isPending ? 'Guardando…' : 'Guardar contraseña'}</Button>
              </div>
            </div>
          )}
          {passwordDone && password && (
            <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">Contraseña temporal guardada: <b className="font-mono">{password}</b>. Compártela por un canal seguro; no se volverá a mostrar.</p>
          )}
          {!canControlAccount && !isMe && (
            <p className="text-xs text-faint">
              {u.other_tenants > 0 && !platformAdmin
                ? 'Este usuario también está en otras empresas: solo él o un superadministrador puede definir su contraseña. Puedes enviarle el correo para restablecerla.'
                : u.role === 'owner' ? 'Solo el dueño puede definir la contraseña del dueño.' : ''}
            </p>
          )}
          {isMe && <p className="text-xs text-faint">Para cambiar tu propia contraseña usa "Enviar correo para restablecer".</p>}
        </section>

        {u.role !== 'owner' && !isMe && (
          <section className="flex flex-col gap-2 rounded-lg border border-bad/30 p-4">
            <h3 className="text-sm font-semibold text-bad">Quitar acceso</h3>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onRemove}>Quitar de la empresa</Button>
              {canControlAccount && <Button variant="danger" onClick={onDelete}>Eliminar usuario</Button>}
            </div>
            <p className="text-xs text-faint">Quitar mantiene su cuenta (puede estar en otras empresas). Eliminar borra la cuenta; si registró información, queda bloqueada para conservar el historial.</p>
          </section>
        )}
      </div>
    </Drawer>
  )
}
