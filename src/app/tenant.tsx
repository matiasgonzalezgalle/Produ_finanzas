import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { api, type Tenant } from '../data'
import { todayIn } from '../domain/dates'
import { useSession } from './session'
import { setActiveModules } from './modules'
import type { ModuleKey } from '../data'

interface TenantState {
  tenants: Tenant[]
  tenant: Tenant | null
  loading: boolean
  selectTenant: (id: string) => void
  /** Fecha de hoy en la zona horaria de la empresa. */
  today: string
  canWrite: boolean
  canAdmin: boolean
  hasModule: (key: ModuleKey) => boolean
  /** Empresa suspendida por el administrador de la plataforma: solo lectura. */
  suspended: boolean
}

const TenantContext = createContext<TenantState | null>(null)
const STORAGE_KEY = 'produ-finanzas:tenant'

function readStoredTenant(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const { session } = useSession()
  const { data: tenants = [], isLoading } = useQuery({ queryKey: ['tenants', session?.userId], queryFn: () => api.listTenants() })
  const [selectedId, setSelectedId] = useState<string | null>(readStoredTenant)

  const value = useMemo<TenantState>(() => {
    const tenant = tenants.find((t) => t.id === selectedId) ?? tenants[0] ?? null
    const modules = tenant?.modules ?? []
    const suspended = tenant?.status === 'suspended'
    setActiveModules(modules)
    return {
      tenants,
      tenant,
      loading: isLoading,
      selectTenant: (id) => {
        setSelectedId(id)
        try {
          localStorage.setItem(STORAGE_KEY, id)
        } catch {
          // ignorar
        }
      },
      today: todayIn(tenant?.timezone ?? 'America/Santiago'),
      canWrite: !!tenant && tenant.role !== 'viewer' && !suspended,
      canAdmin: !!tenant && (tenant.role === 'owner' || tenant.role === 'admin') && !suspended,
      hasModule: (key) => modules.includes(key),
      suspended,
    }
  }, [tenants, selectedId, isLoading])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

export function useTenant() {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant fuera de TenantProvider')
  return ctx
}

/** Para pantallas dentro del layout, donde siempre hay empresa seleccionada. */
export function useCurrentTenant() {
  const ctx = useTenant()
  if (!ctx.tenant) throw new Error('Sin empresa seleccionada')
  return { ...ctx, tenant: ctx.tenant }
}
