import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useSession } from './app/session'
import { TenantProvider, useCurrentTenant, useTenant } from './app/tenant'
import { moduleLabel } from './app/modules'
import type { ModuleKey } from './data'
import { LoginPage, NewPasswordPage, RecoverPasswordPage, SignupPage } from './features/auth/AuthPages'
import { AppLayout } from './layout/AppLayout'

const CompaniesPage = lazy(() => import('./features/companies/CompaniesPage').then((m) => ({ default: m.CompaniesPage })))
const DocumentsPage = lazy(() => import('./features/documents/DocumentsPage').then((m) => ({ default: m.DocumentsPage })))
const DocumentView = lazy(() => import('./features/documents/DocumentView').then((m) => ({ default: m.DocumentView })))
const PurchaseOrdersPage = lazy(() => import('./features/purchaseOrders/PurchaseOrdersPage').then((m) => ({ default: m.PurchaseOrdersPage })))
const CollectionsPage = lazy(() => import('./features/collections/CollectionsPage').then((m) => ({ default: m.CollectionsPage })))
const CollectionAccountPage = lazy(() => import('./features/collections/CollectionAccountPage').then((m) => ({ default: m.CollectionAccountPage })))
const CollectionRulesPage = lazy(() => import('./features/collections/CollectionRulesPage').then((m) => ({ default: m.CollectionRulesPage })))
const PaymentManagementPage = lazy(() => import('./features/payables/PaymentManagementPage').then((m) => ({ default: m.PaymentManagementPage })))
const OnboardingPage = lazy(() => import('./features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })))
const PaymentsPage = lazy(() => import('./features/payments/PaymentsPage').then((m) => ({ default: m.PaymentsPage })))
const PortalApp = lazy(() => import('./features/portal/PortalApp').then((m) => ({ default: m.PortalApp })))
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const AdminApp = lazy(() => import('./features/admin/AdminApp').then((m) => ({ default: m.AdminApp })))
const ReconciliationPage = lazy(() => import('./features/reconciliation/ReconciliationPage').then((m) => ({ default: m.ReconciliationPage })))
const TreasuryPage = lazy(() => import('./features/treasury/TreasuryPage').then((m) => ({ default: m.TreasuryPage })))

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="size-8 animate-spin rounded-full border-2 border-line border-t-navy-900" aria-label="Cargando" />
    </div>
  )
}

function RequireSession() {
  const { session, loading } = useSession()
  if (loading) return <FullPageSpinner />
  if (!session) return <Navigate to="/login" replace />
  // Entró con una contraseña temporal que le dio un administrador: debe cambiarla primero.
  if (session.mustChangePassword) return <Navigate to="/nueva-contrasena?temporal=1" replace />
  return (
    <TenantProvider key={session.userId}>
      <Outlet />
    </TenantProvider>
  )
}

function RequireTenant() {
  const { tenant, loading } = useTenant()
  if (loading) return <FullPageSpinner />
  if (!tenant) return <Navigate to="/onboarding" replace />
  return <AppLayout />
}

const HOME_BY_MODULE: [ModuleKey, string][] = [
  ['tesoreria', '/tesoreria'],
  ['cuentas_por_pagar', '/cxp/documentos'],
  ['cuentas_por_cobrar', '/cxc/documentos'],
  ['conciliacion', '/conciliacion'],
]

function HomeRedirect() {
  const { hasModule } = useCurrentTenant()
  const target = HOME_BY_MODULE.find(([m]) => hasModule(m))?.[1] ?? '/empresas/proveedores'
  return <Navigate to={target} replace />
}

/** Pantalla de un módulo: si la empresa no lo tiene activo, se explica en vez de mostrarla. */
function RequireModule({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { hasModule } = useCurrentTenant()
  if (hasModule(module)) return <>{children}</>
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-line bg-white p-8 text-center">
      <p className="text-[15px] font-semibold text-ink">El módulo {moduleLabel(module)} no está activo</p>
      <p className="mt-2 text-sm text-muted">Tu empresa no tiene este módulo contratado. Pide al administrador de Produ Finanzas que lo active.</p>
    </div>
  )
}

function GuestOnly() {
  const { session, loading } = useSession()
  if (loading) return <FullPageSpinner />
  if (session) return <Navigate to="/" replace />
  return <Outlet />
}

export default function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
    <Routes>
      <Route path="/portal/*" element={<PortalApp />} />
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/registro" element={<SignupPage />} />
        <Route path="/recuperar" element={<RecoverPasswordPage />} />
      </Route>
      {/* Fuera de los guardias: llega con la sesión del enlace del correo. */}
      <Route path="/nueva-contrasena" element={<NewPasswordPage />} />
      <Route element={<RequireSession />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/admin/*" element={<AdminApp />} />
        <Route element={<RequireTenant />}>
          <Route index element={<HomeRedirect />} />
          <Route path="/tesoreria" element={<RequireModule module="tesoreria"><TreasuryPage /></RequireModule>} />
          <Route path="/conciliacion" element={<RequireModule module="conciliacion"><ReconciliationPage /></RequireModule>} />
          <Route path="/cxp" element={<Navigate to="/cxp/documentos" replace />} />
          <Route path="/cxp/ordenes" element={<RequireModule module="ordenes_compra"><PurchaseOrdersPage key="po-payable" direction="payable" /></RequireModule>} />
          <Route path="/cxp/documentos" element={<RequireModule module="cuentas_por_pagar"><DocumentsPage key="payable" direction="payable" /></RequireModule>} />
          <Route path="/cxp/documentos/:id" element={<RequireModule module="cuentas_por_pagar"><DocumentView key="payable-view" direction="payable" /></RequireModule>} />
          <Route path="/cxp/sii" element={<Navigate to="/cxp/documentos?sii=1" replace />} />
          <Route path="/cxp/gestion" element={<RequireModule module="cuentas_por_pagar"><PaymentManagementPage /></RequireModule>} />
          <Route path="/cxp/pagos" element={<RequireModule module="cuentas_por_pagar"><PaymentsPage key="out" direction="out" /></RequireModule>} />
          <Route path="/cxc" element={<Navigate to="/cxc/documentos" replace />} />
          <Route path="/cxc/ordenes" element={<RequireModule module="ordenes_compra"><PurchaseOrdersPage key="po-receivable" direction="receivable" /></RequireModule>} />
          <Route path="/cxc/documentos" element={<RequireModule module="cuentas_por_cobrar"><DocumentsPage key="receivable" direction="receivable" /></RequireModule>} />
          <Route path="/cxc/documentos/:id" element={<RequireModule module="cuentas_por_cobrar"><DocumentView key="receivable-view" direction="receivable" /></RequireModule>} />
          <Route path="/cxc/sii" element={<Navigate to="/cxc/documentos?sii=1" replace />} />
          <Route path="/cxc/cobranza" element={<RequireModule module="cobranza"><CollectionsPage /></RequireModule>} />
          <Route path="/cxc/cobranza/recordatorios" element={<RequireModule module="cobranza"><CollectionRulesPage /></RequireModule>} />
          <Route path="/cxc/cobranza/:id" element={<RequireModule module="cobranza"><CollectionAccountPage /></RequireModule>} />
          <Route path="/cxc/cobros" element={<RequireModule module="cuentas_por_cobrar"><PaymentsPage key="in" direction="in" /></RequireModule>} />
          <Route path="/empresas" element={<Navigate to="/empresas/proveedores" replace />} />
          <Route path="/empresas/proveedores" element={<CompaniesPage key="proveedores" tab="proveedores" />} />
          <Route path="/empresas/clientes" element={<CompaniesPage key="clientes" tab="clientes" />} />
          <Route path="/empresas/contactos" element={<CompaniesPage key="contactos" tab="contactos" />} />
          <Route path="/configuracion" element={<Navigate to="/configuracion/empresa" replace />} />
          <Route path="/configuracion/empresa" element={<SettingsPage key="empresa" tab="empresa" />} />
          <Route path="/configuracion/usuarios" element={<SettingsPage key="usuarios" tab="usuarios" />} />
          <Route path="/configuracion/contabilidad" element={<Navigate to="/configuracion/cuentas-por-pagar" replace />} />
          <Route path="/configuracion/cuentas-por-pagar" element={<RequireModule module="cuentas_por_pagar"><SettingsPage key="cxp" tab="cxp" /></RequireModule>} />
          <Route path="/configuracion/cuentas-por-cobrar" element={<RequireModule module="cuentas_por_cobrar"><SettingsPage key="cxc" tab="cxc" /></RequireModule>} />
          <Route path="/configuracion/integraciones" element={<SettingsPage key="integraciones" tab="integraciones" />} />
          <Route path="/configuracion/notificaciones" element={<SettingsPage key="notificaciones" tab="notificaciones" />} />
          <Route path="/configuracion/portal" element={<RequireModule module="portal"><SettingsPage key="portal" tab="portal" /></RequireModule>} />
          <Route path="/integraciones" element={<Navigate to="/configuracion/integraciones" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
