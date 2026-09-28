import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../data'
import { Button, Field, FormError, Input } from '../../ui'
import { errorMessage } from '../shared'

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full">
      <div className="hidden w-[42%] flex-col justify-between bg-navy-900 p-12 text-white lg:flex">
        <div className="text-3xl font-bold tracking-tight">
          produ<span className="text-brand-500">.</span>
          <span className="ml-2 text-base font-medium text-white/75">Finanzas</span>
        </div>
        <div>
          <p className="max-w-md text-3xl leading-tight font-semibold">Cuentas por pagar, por cobrar y tesorería en un solo lugar.</p>
          <p className="mt-4 max-w-md text-white/70">Para empresas en Chile y Perú. Multimoneda, detracciones y cobros con MercadoPago.</p>
        </div>
        <p className="text-sm text-white/50">© {new Date().getFullYear()} Produ</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {api.mode === 'demo' && (
            <p className="mt-6 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-600">
              Modo demo: sin Supabase configurado. Cualquier correo entra y los datos quedan en este navegador.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.signIn(email.trim(), password)
      navigate('/')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="Ingresa a tu cuenta" subtitle={<>¿No tienes cuenta? <Link to="/registro" className="text-brand-600 hover:underline">Regístrate</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Correo">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Contraseña">{(id) => <Input id={id} type="password" autoComplete="current-password" required={api.mode !== 'demo'} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button variant="primary" type="submit" disabled={loading} className="mt-2">{loading ? 'Ingresando…' : 'Ingresar'}</Button>
      </form>
    </AuthShell>
  )
}

export function SignupPage() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 10) return setError('La contraseña debe tener al menos 10 caracteres')
    setLoading(true)
    try {
      const { needsConfirmation } = await api.signUp(email.trim(), password, fullName.trim())
      if (needsConfirmation) setSent(true)
      else navigate('/onboarding')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <AuthShell title="Revisa tu correo" subtitle={`Te enviamos un enlace a ${email} para confirmar tu cuenta.`}>
        <Link to="/login" className="text-sm text-brand-600 hover:underline">Volver a ingresar</Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Crea tu cuenta" subtitle={<>¿Ya tienes cuenta? <Link to="/login" className="text-brand-600 hover:underline">Ingresa</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Nombre">{(id) => <Input id={id} autoComplete="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
        <Field label="Correo">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Contraseña" hint="Mínimo 10 caracteres">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button variant="primary" type="submit" disabled={loading} className="mt-2">{loading ? 'Creando…' : 'Crear cuenta'}</Button>
      </form>
    </AuthShell>
  )
}
