import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useSession } from './app/session'
import { TenantProvider, useTenant } from './app/tenant'
import { LoginPage, SignupPage } from './features/auth/AuthPages'
import { AppLayout } from './layout/AppLayout'

const CompaniesPage = lazy(() => import('./features/companies/CompaniesPage').then((m) => ({ default: m.CompaniesPage })))
const DocumentsPage = lazy(() => import('./features/documents/DocumentsPage').then((m) => ({ default: m.DocumentsPage })))
const DocumentView = lazy(() => import('./features/documents/DocumentView').then((m) => ({ default: m.DocumentView })))
const PurchaseOrdersPage = lazy(() => import('./features/purchaseOrders/PurchaseOrdersPage').then((m) => ({ default: m.PurchaseOrdersPage })))
const PaymentManagementPage = lazy(() => import('./features/payables/PaymentManagementPage').then((m) => ({ default: m.PaymentManagementPage })))
const OnboardingPage = lazy(() => import('./features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })))
const PaymentsPage = lazy(() => import('./features/payments/PaymentsPage').then((m) => ({ default: m.PaymentsPage })))
const PortalApp = lazy(() => import('./features/portal/PortalApp').then((m) => ({ default: m.PortalApp })))
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
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
      </Route>
      <Route element={<RequireSession />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<RequireTenant />}>
          <Route index element={<Navigate to="/tesoreria" replace />} />
          <Route path="/tesoreria" element={<TreasuryPage />} />
          <Route path="/cxp" element={<Navigate to="/cxp/documentos" replace />} />
          <Route path="/cxp/ordenes" element={<PurchaseOrdersPage key="po-payable" direction="payable" />} />
          <Route path="/cxp/documentos" element={<DocumentsPage key="payable" direction="payable" />} />
          <Route path="/cxp/documentos/:id" element={<DocumentView key="payable-view" direction="payable" />} />
          <Route path="/cxp/sii" element={<Navigate to="/cxp/documentos?sii=1" replace />} />
          <Route path="/cxp/gestion" element={<PaymentManagementPage />} />
          <Route path="/cxp/pagos" element={<PaymentsPage key="out" direction="out" />} />
          <Route path="/cxc" element={<Navigate to="/cxc/documentos" replace />} />
          <Route path="/cxc/ordenes" element={<PurchaseOrdersPage key="po-receivable" direction="receivable" />} />
          <Route path="/cxc/documentos" element={<DocumentsPage key="receivable" direction="receivable" />} />
          <Route path="/cxc/documentos/:id" element={<DocumentView key="receivable-view" direction="receivable" />} />
          <Route path="/cxc/sii" element={<Navigate to="/cxc/documentos?sii=1" replace />} />
          <Route path="/cxc/cobros" element={<PaymentsPage key="in" direction="in" />} />
          <Route path="/empresas" element={<Navigate to="/empresas/proveedores" replace />} />
          <Route path="/empresas/proveedores" element={<CompaniesPage key="proveedores" tab="proveedores" />} />
          <Route path="/empresas/clientes" element={<CompaniesPage key="clientes" tab="clientes" />} />
          <Route path="/empresas/contactos" element={<CompaniesPage key="contactos" tab="contactos" />} />
          <Route path="/configuracion" element={<Navigate to="/configuracion/empresa" replace />} />
          <Route path="/configuracion/empresa" element={<SettingsPage key="empresa" tab="empresa" />} />
          <Route path="/configuracion/usuarios" element={<SettingsPage key="usuarios" tab="usuarios" />} />
          <Route path="/configuracion/contabilidad" element={<Navigate to="/configuracion/cuentas-por-pagar" replace />} />
          <Route path="/configuracion/cuentas-por-pagar" element={<SettingsPage key="cxp" tab="cxp" />} />
          <Route path="/configuracion/cuentas-por-cobrar" element={<SettingsPage key="cxc" tab="cxc" />} />
          <Route path="/configuracion/integraciones" element={<SettingsPage key="integraciones" tab="integraciones" />} />
          <Route path="/configuracion/portal" element={<SettingsPage key="portal" tab="portal" />} />
          <Route path="/integraciones" element={<Navigate to="/configuracion/integraciones" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
