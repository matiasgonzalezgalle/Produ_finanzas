import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useSession } from './app/session'
import { TenantProvider, useTenant } from './app/tenant'
import { LoginPage, SignupPage } from './features/auth/AuthPages'
import { CompaniesPage } from './features/companies/CompaniesPage'
import { DocumentsPage } from './features/documents/DocumentsPage'
import { IntegrationsPage } from './features/integrations/IntegrationsPage'
import { OnboardingPage } from './features/onboarding/OnboardingPage'
import { PaymentsPage } from './features/payments/PaymentsPage'
import { TreasuryPage } from './features/treasury/TreasuryPage'
import { AppLayout } from './layout/AppLayout'

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
    <Routes>
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
          <Route path="/cxp/documentos" element={<DocumentsPage key="payable" direction="payable" />} />
          <Route path="/cxp/pagos" element={<PaymentsPage key="out" direction="out" />} />
          <Route path="/cxc" element={<Navigate to="/cxc/documentos" replace />} />
          <Route path="/cxc/documentos" element={<DocumentsPage key="receivable" direction="receivable" />} />
          <Route path="/cxc/cobros" element={<PaymentsPage key="in" direction="in" />} />
          <Route path="/empresas" element={<Navigate to="/empresas/proveedores" replace />} />
          <Route path="/empresas/proveedores" element={<CompaniesPage key="proveedores" tab="proveedores" />} />
          <Route path="/empresas/clientes" element={<CompaniesPage key="clientes" tab="clientes" />} />
          <Route path="/empresas/contactos" element={<CompaniesPage key="contactos" tab="contactos" />} />
          <Route path="/integraciones" element={<IntegrationsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
