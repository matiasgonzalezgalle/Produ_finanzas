import clsx from 'clsx'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Building2,
  Check,
  ChevronDown,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Plus,
  Wallet,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../data'
import { formatTaxId } from '../domain/taxId'
import { useSession } from '../app/session'
import { useCurrentTenant } from '../app/tenant'

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside()
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onOutside])
  return ref
}

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link to="/" className="flex flex-col items-center leading-none text-white" aria-label="Produ Finanzas">
      <span className="text-[26px] font-bold tracking-tight">
        {collapsed ? 'p' : 'produ'}
        <span className="text-brand-500">.</span>
      </span>
      {!collapsed && <span className="mt-1 text-[11px] font-medium tracking-wide text-white/75">Finanzas</span>}
    </Link>
  )
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
}

const FLAG: Record<string, string> = { CL: '🇨🇱', PE: '🇵🇪' }

function TenantSwitcher({ collapsed }: { collapsed: boolean }) {
  const { tenant, tenants, selectTenant } = useCurrentTenant()
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const navigate = useNavigate()
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx(
          'flex w-full items-center gap-3 rounded-lg border border-white/15 bg-white/8 text-left text-white hover:bg-white/12',
          collapsed ? 'justify-center p-2' : 'px-3 py-2.5',
        )}
      >
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[13px] font-semibold text-navy-900">
          {initials(tenant.name)}
          <span className="absolute -right-1 -bottom-1 text-[13px] leading-none">{FLAG[tenant.country]}</span>
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold">{tenant.name}</span>
              {tenant.tax_id && <span className="block truncate text-[13px] text-white/70">{formatTaxId(tenant.tax_id, tenant.country)}</span>}
            </span>
            <ChevronDown size={16} className="shrink-0 text-white/70" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-64 rounded-lg border border-line bg-white p-1 text-ink shadow-xl">
          <div className="px-3 py-2 text-xs font-medium text-faint">Tus empresas</div>
          {tenants.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                selectTenant(t.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-subtle"
            >
              <span className="flex-1 truncate">{t.name}</span>
              {t.id === tenant.id && <Check size={16} className="text-brand-600" />}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/onboarding')
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-brand-600 hover:bg-subtle"
          >
            <Plus size={16} /> Nueva empresa
          </button>
        </div>
      )}
    </div>
  )
}

const CREATE_ACTIONS = [
  { label: 'Cuenta por pagar', to: '/cxp/documentos?nuevo=1' },
  { label: 'Pago a proveedor', to: '/cxp/pagos?nuevo=1' },
  { label: 'Cuenta por cobrar', to: '/cxc/documentos?nuevo=1' },
  { label: 'Cobro de cliente', to: '/cxc/cobros?nuevo=1' },
  { label: 'Proveedor', to: '/empresas/proveedores?nuevo=1' },
  { label: 'Cliente', to: '/empresas/clientes?nuevo=1' },
]

function CreateNewMenu({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const { canWrite } = useCurrentTenant()
  if (!canWrite) return null
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx(
          'flex w-full items-center rounded-lg border border-white/15 bg-white/8 text-[15px] text-white hover:bg-white/12',
          collapsed ? 'justify-center p-2.5' : 'justify-between px-3 py-2.5',
        )}
      >
        {!collapsed && 'Crear nuevo'}
        <Plus size={18} />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-2 w-56 rounded-lg border border-line bg-white p-1 text-ink shadow-xl">
          {CREATE_ACTIONS.map((a) => (
            <Link key={a.to} to={a.to} onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm hover:bg-subtle">
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

interface NavEntry {
  label: string
  icon: ReactNode
  to?: string
  base?: string
  children?: { label: string; to: string }[]
}

const NAV: NavEntry[] = [
  {
    label: 'Cuentas por pagar',
    icon: <ArrowUpFromLine size={20} />,
    base: '/cxp',
    children: [
      { label: 'Documentos', to: '/cxp/documentos' },
      { label: 'Pagos', to: '/cxp/pagos' },
    ],
  },
  {
    label: 'Cuentas por cobrar',
    icon: <ArrowDownToLine size={20} />,
    base: '/cxc',
    children: [
      { label: 'Documentos', to: '/cxc/documentos' },
      { label: 'Cobros', to: '/cxc/cobros' },
    ],
  },
  { label: 'Tesorería', icon: <Wallet size={20} />, to: '/tesoreria' },
  { label: 'Empresas', icon: <Building2 size={20} />, to: '/empresas/proveedores', base: '/empresas' },
]

function NavItem({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  const { pathname } = useLocation()
  const inSection = !!entry.base && pathname.startsWith(entry.base)
  const [expanded, setExpanded] = useState(inSection)
  useEffect(() => {
    if (inSection) setExpanded(true)
  }, [inSection])

  const itemClass = (active: boolean) =>
    clsx(
      'flex w-full items-center gap-3 rounded-lg text-[15px] transition-colors',
      collapsed ? 'justify-center p-2.5' : 'px-3 py-2.5',
      active ? 'bg-white/12 font-medium text-white' : 'text-white/90 hover:bg-white/8 hover:text-white',
    )

  if (!entry.children || collapsed) {
    const to = entry.to ?? entry.children![0].to
    return (
      <NavLink to={to} title={collapsed ? entry.label : undefined} className={({ isActive }) => itemClass(isActive || inSection)}>
        {entry.icon}
        {!collapsed && <span>{entry.label}</span>}
      </NavLink>
    )
  }
  return (
    <div>
      <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className={itemClass(false)}>
        {entry.icon}
        <span className="flex-1 text-left">{entry.label}</span>
        <ChevronDown size={16} className={clsx('text-white/60 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="mt-1 mb-1 ml-[22px] flex flex-col border-l border-white/15 pl-3">
          {entry.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              className={({ isActive }) =>
                clsx('rounded-md px-3 py-2 text-sm', isActive ? 'bg-white/12 font-medium text-white' : 'text-white/75 hover:bg-white/8 hover:text-white')
              }
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { session } = useSession()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const name = session?.fullName || session?.email || 'Usuario'
  return (
    <div ref={ref} className="relative border-t border-white/12 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx('flex w-full items-center gap-3 rounded-lg text-white hover:bg-white/8', collapsed ? 'justify-center p-2' : 'px-2 py-2')}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-600 text-sm font-semibold">{initials(name)}</span>
        {!collapsed && <span className="flex-1 truncate text-left text-[15px] font-semibold">{name}</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-lg border border-line bg-white p-1 text-ink shadow-xl">
          <div className="truncate px-3 py-2 text-xs text-faint">{session?.email}</div>
          <button type="button" onClick={async () => {
              await api.signOut()
              qc.clear()
            }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-subtle">
            <LogOut size={16} /> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  )
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { pathname } = useLocation()
  return (
    <div className={clsx('flex h-full flex-col gap-4 bg-navy-900 px-4 pt-6 pb-4', collapsed ? 'w-20' : 'w-72')}>
      <div className={clsx('flex items-center', collapsed ? 'flex-col gap-3' : 'justify-between pl-14')}>
        <Logo collapsed={collapsed} />
        <button type="button" onClick={onToggle} className="hidden rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white md:block" aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
      <TenantSwitcher collapsed={collapsed} />
      <CreateNewMenu collapsed={collapsed} />
      <nav className="mt-2 flex flex-col gap-1" aria-label="Principal">
        {NAV.map((entry) => (
          <NavItem key={entry.label} entry={entry} collapsed={collapsed} />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-1">
        <NavLink
          to="/configuracion/empresa"
          title={collapsed ? 'Configuración' : undefined}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 rounded-lg text-[15px]',
              collapsed ? 'justify-center p-2.5' : 'justify-between px-3 py-2.5',
              isActive || pathname.startsWith('/configuracion') ? 'bg-white/12 text-white' : 'text-white/90 hover:bg-white/8',
            )
          }
        >
          {!collapsed && 'Configuración'}
          <Settings size={18} />
        </NavLink>
        <UserMenu collapsed={collapsed} />
      </div>
    </div>
  )
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setMobileOpen(false), [pathname])

  return (
    <div className="flex min-h-full">
      <div className="hidden shrink-0 bg-navy-900 md:block">
        <div className="sticky top-0 h-dvh">
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-navy-950/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <div className="relative h-full w-72">
            <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-navy-900 px-4 py-3 md:hidden">
          <button type="button" onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-white" aria-label="Abrir menú">
            <Menu size={22} />
          </button>
          <span className="text-lg font-bold text-white">
            produ<span className="text-brand-500">.</span> <span className="text-sm font-medium text-white/75">Finanzas</span>
          </span>
        </div>
        <main className="min-w-0 flex-1 px-4 pb-10 md:px-6">
          <Suspense fallback={<div className="py-20 text-center text-sm text-faint">Cargando…</div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
