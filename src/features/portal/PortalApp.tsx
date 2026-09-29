// Portal financiero externo: clientes y proveedores de una empresa ven sus documentos,
// pagos, fechas de pago agendadas y archivos. Entran con su correo + código de un solo uso.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CreditCard, FileDown, LogOut, Mail, MessageSquare, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, type PortalAccount, type PortalDocument, type PortalPayment, type PortalPublicInfo, type PortalSnapshot } from '../../data'
import { DEMO_PORTAL_CODE } from '../../data/demoApi'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { sumByCurrency } from '../../domain/money'
import { formatTaxId, type Country } from '../../domain/taxId'
import { Badge, Button, Drawer, EmptyState, Field, FormError, Input, StatCard, cn } from '../../ui'
import { ListView, RowAction, RowMenu, useListState, type ListColumn, type ListFilter } from '../../ui/list'
import { ApprovalStatusBadge, errorMessage, Money, MoneyTotals, PaymentManagementBadge, StatusBadge } from '../shared'

function PortalShell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="min-h-full bg-subtle/50">
      <header className="bg-navy-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold tracking-tight">produ<span className="text-brand-500">.</span></span>
            <span className="text-sm text-white/75">Portal financiero</span>
          </div>
          {right}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 md:px-6">{children}</main>
    </div>
  )
}

export function PortalApp() {
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const slug = pathname.split('/')[2] || null
  const session = useQuery({ queryKey: ['portal-session'], queryFn: () => api.portalSession() })
  const info = useQuery({ queryKey: ['portal-public', slug], queryFn: () => api.portalPublicInfo(slug!), enabled: !!slug, staleTime: 0, gcTime: 0 })
  const email = session.data ?? null

  useEffect(() => {
    // En Supabase el enlace mágico del correo vuelve con la sesión: refrescar.
    return api.onSessionChange(() => qc.invalidateQueries({ queryKey: ['portal-session'] }))
  }, [qc])

  if (session.isLoading || (slug && info.isLoading)) return <PortalShell><p className="text-center text-muted">Cargando…</p></PortalShell>
  if (slug && !info.data) {
    return (
      <PortalShell>
        <div className="mx-auto mt-6 max-w-md rounded-2xl border border-line bg-white">
          <EmptyState
            icon={<Mail size={20} />}
            title="Este link no está disponible"
            description="Puede que haya sido reemplazado por uno nuevo o que el portal esté desactivado. Pide el link actualizado a la empresa."
            action={<a href="/portal" className="text-sm text-brand-600 hover:underline">Ir al acceso general</a>}
          />
        </div>
      </PortalShell>
    )
  }
  if (!email) return <PortalLogin slug={slug} info={info.data ?? null} onLoggedIn={() => qc.invalidateQueries({ queryKey: ['portal-session'] })} />
  return (
    <PortalHome
      email={email}
      slug={slug}
      info={info.data ?? null}
      onSignOut={async () => {
        await api.portalSignOut()
        qc.removeQueries({ queryKey: ['portal'] })
        await qc.invalidateQueries({ queryKey: ['portal-session'] })
      }}
    />
  )
}

function PortalLogin({ slug, info, onLoggedIn }: { slug: string | null; info: PortalPublicInfo | null; onLoggedIn: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [method, setMethod] = useState<'email' | 'access-code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.portalSendCode(email.trim(), `${window.location.origin}/portal${slug ? `/${slug}` : ''}`)
      setStep('code')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault()
    if (!slug) return
    setError(null)
    setLoading(true)
    try {
      await api.portalRedeemCode(slug, accessCode)
      onLoggedIn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  function formatAccessCode(value: string) {
    const clean = value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.portalVerifyCode(email.trim(), code)
      onLoggedIn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <PortalShell>
      <div className="mx-auto mt-6 max-w-md rounded-2xl border border-line bg-white p-8 shadow-sm">
        {info ? (
          <div className="mb-6">
            <p className="text-sm text-muted">{info.tenant_name}</p>
            <p className="text-lg font-semibold text-ink">Portal de {info.counterparty_name}</p>
            {info.message && <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-navy-900">{info.message}</p>}
          </div>
        ) : (
          <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-head text-navy-900"><Mail size={22} /></div>
        )}
        {slug && step === 'email' && (
          <div className="mb-5 flex gap-1 rounded-lg bg-subtle p-1 text-sm" role="tablist">
            {([
              ['email', 'Con mi correo'],
              ['access-code', 'Con código de acceso'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={method === key}
                onClick={() => {
                  setMethod(key)
                  setError(null)
                }}
                className={cn('flex-1 rounded-md px-3 py-1.5', method === key ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {method === 'access-code' && slug ? (
          <form onSubmit={redeem} className="flex flex-col gap-4">
            <div>
              <h1 className="text-lg font-semibold text-ink">Ingresa con tu código</h1>
              <p className="mt-1 text-sm text-muted">Escribe el código de 8 caracteres que te entregó {info ? info.tenant_name : 'la empresa'}.</p>
            </div>
            <FormError error={error} />
            <Field label="Código de acceso">
              {(id) => (
                <Input
                  id={id}
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={accessCode}
                  onChange={(e) => setAccessCode(formatAccessCode(e.target.value))}
                  placeholder="XXXX-XXXX"
                  className="h-11 text-center font-mono text-lg tracking-[0.25em]"
                  autoFocus
                />
              )}
            </Field>
            <Button variant="primary" type="submit" disabled={loading || accessCode.replace('-', '').length < 8}>{loading ? 'Verificando…' : 'Ingresar'}</Button>
            <p className="text-xs text-faint">¿No tienes código? Pídelo a {info ? info.tenant_name : 'la empresa'}.</p>
          </form>
        ) : step === 'email' ? (
          <form onSubmit={sendCode} className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold text-ink">Ingresa a tu portal</h1>
              <p className="mt-1 text-sm text-muted">Usa el correo que {info ? info.tenant_name : 'la empresa'} autorizó. Te enviaremos un código de un solo uso.</p>
            </div>
            <FormError error={error} />
            <Field label="Correo">{(id) => <Input id={id} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
            <Button variant="primary" type="submit" disabled={loading}>{loading ? 'Enviando…' : 'Enviar código'}</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold text-ink">Revisa tu correo</h1>
              <p className="mt-1 text-sm text-muted">
                Enviamos un código a <b className="text-ink">{email}</b>. También puedes entrar con el enlace del mismo correo.
              </p>
            </div>
            <FormError error={error} />
            <Field label="Código">
              {(id) => (
                <Input id={id} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))} className="text-center text-lg tracking-[0.3em]" autoFocus />
              )}
            </Field>
            <Button variant="primary" type="submit" disabled={loading || code.length < 6}>{loading ? 'Verificando…' : 'Ingresar'}</Button>
            <button type="button" onClick={() => setStep('email')} className="text-sm text-brand-600 hover:underline">Usar otro correo</button>
          </form>
        )}
        {api.mode === 'demo' && (
          <p className="mt-6 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-600">
            Modo demo: entra con <b>pagos@canaluno.example</b> y el código <b>{DEMO_PORTAL_CODE}</b>.
          </p>
        )}
      </div>
    </PortalShell>
  )
}

function PortalHome({ email, slug, info, onSignOut }: { email: string; slug: string | null; info: PortalPublicInfo | null; onSignOut: () => void }) {
  const accounts = useQuery({ queryKey: ['portal', 'accounts', email], queryFn: () => api.portalAccounts(), staleTime: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const all = accounts.data ?? []
  // Con link propio se muestra solo esa cuenta; con el acceso general, todas las del correo.
  const list = slug ? all.filter((a) => a.portal_slug === slug) : all
  const account = list.find((a) => a.access_id === selected) ?? list[0]

  const right = (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-white/75 sm:inline">{email}</span>
      <button type="button" onClick={onSignOut} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-white/90 hover:bg-white/10">
        <LogOut size={16} /> Salir
      </button>
    </div>
  )

  if (accounts.isLoading) return <PortalShell right={right}><p className="text-center text-muted">Cargando…</p></PortalShell>
  if (!account) {
    return (
      <PortalShell right={right}>
        <div className="rounded-2xl border border-line bg-white">
          <EmptyState
            icon={<Mail size={20} />}
            title={info ? `Este correo no tiene acceso al portal de ${info.counterparty_name}` : 'Tu correo no tiene acceso a ningún portal'}
            description={`Pide a ${info?.tenant_name ?? 'la empresa'} que autorice ${email} en su portal financiero, o entra con otro correo.`}
            action={<Button onClick={onSignOut}>Usar otro correo</Button>}
          />
        </div>
      </PortalShell>
    )
  }

  return (
    <PortalShell right={right}>
      {list.length > 1 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Ver como:</span>
          <select
            value={account.access_id}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 rounded-md border border-line bg-white px-3 text-sm"
            aria-label="Empresa y contraparte"
          >
            {list.map((a) => (
              <option key={a.access_id} value={a.access_id}>{a.counterparty_name} en {a.tenant_name}</option>
            ))}
          </select>
        </div>
      )}
      <PortalAccountView key={account.access_id} account={account} />
    </PortalShell>
  )
}

type PortalTab = 'documentos' | 'pagos' | 'cuenta'

function PortalAccountView({ account }: { account: PortalAccount }) {
  const snap = useQuery({
    queryKey: ['portal', 'snapshot', account.tenant_id, account.counterparty_id],
    queryFn: () => api.portalSnapshot(account.tenant_id, account.counterparty_id),
  })
  const [tab, setTab] = useState<PortalTab>('documentos')

  if (snap.isLoading) return <p className="text-center text-muted">Cargando información…</p>
  if (snap.error || !snap.data) return <FormError error={errorMessage(snap.error)} />
  const data = snap.data
  // Para el externo, "por pagar" es lo que la empresa le debe (si es proveedor) o lo que él debe (si es cliente).
  const open = data.documents.filter((d) => d.pending_amount > 0)
  const pick = (d: PortalDocument) => ({ currency: d.currency, amount: d.pending_amount })
  const receivableForHim = open.filter((d) => d.direction === 'payable') // la empresa le paga
  const payableByHim = open.filter((d) => d.direction === 'receivable') // él le paga a la empresa
  const overdue = open.filter((d) => d.payment_status === 'vencido')
  // Próximo pago: el que la empresa programó (CxP) o el que el cliente comprometió (CxC).
  const scheduled = open
    .filter((d) => d.scheduled_payment_date && (d.direction === 'receivable' || d.payment_management === 'scheduled'))
    .sort((a, b) => a.scheduled_payment_date!.localeCompare(b.scheduled_payment_date!))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{data.tenant.name}</p>
          <h1 className="text-2xl font-semibold text-ink">{data.counterparty.name}</h1>
          {data.counterparty.tax_id && <p className="text-sm text-muted">{formatTaxId(data.counterparty.tax_id, (data.counterparty.country as Country) ?? data.tenant.country)}</p>}
        </div>
      </div>
      {data.tenant.message && <div className="rounded-xl border border-brand-600/20 bg-brand-50 px-4 py-3 text-sm text-navy-900">{data.tenant.message}</div>}

      <div className="stat-row sm:grid-cols-2 lg:grid-cols-4">
        {account.is_supplier && <StatCard label={`${data.tenant.name} te debe`} value={<MoneyTotals totals={sumByCurrency(receivableForHim, pick)} empty="$0" />} detail={`${receivableForHim.length} documentos`} />}
        {account.is_customer && <StatCard label="Tu saldo por pagar" value={<MoneyTotals totals={sumByCurrency(payableByHim, pick)} empty="$0" />} detail={`${payableByHim.length} documentos`} />}
        <StatCard label="Vencido" tone={overdue.length ? 'bad' : undefined} value={<MoneyTotals totals={sumByCurrency(overdue, pick)} empty="$0" />} detail={`${overdue.length} documentos`} />
        <StatCard
          label={account.is_supplier ? 'Próximo pago programado' : 'Próximo pago agendado'}
          value={scheduled[0] ? formatDate(scheduled[0].scheduled_payment_date) : '—'}
          detail={scheduled[0] ? <>N° {scheduled[0].folio} · <Money minor={scheduled[0].pending_amount} currency={scheduled[0].currency} /></> : 'Sin pagos agendados'}
        />
      </div>

      <div className="rounded-2xl border border-line bg-white p-4 md:p-5">
        <nav className="-mt-1 mb-4 flex gap-6 border-b border-line" aria-label="Secciones del portal">
          {([
            ['documentos', 'Documentos'],
            ['pagos', 'Pagos'],
            ['cuenta', 'Mi cuenta'],
          ] as [PortalTab, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-current={tab === key ? 'page' : undefined}
              className={cn('-mb-px border-b-2 py-3 text-[13px]', tab === key ? 'border-brand-600 font-medium text-brand-600' : 'border-transparent text-muted hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab === 'documentos' && <PortalDocuments data={data} account={account} />}
        {tab === 'pagos' && <PortalPayments payments={data.payments} account={account} />}
        {tab === 'cuenta' && <PortalAccountInfo data={data} />}
      </div>
    </div>
  )
}

async function openFile(path: string) {
  const url = await api.portalFileUrl(path)
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener'
  a.download = ''
  a.click()
}

function PortalDocuments({ data, account }: { data: PortalSnapshot; account: PortalAccount }) {
  const [error, setError] = useState<string | null>(null)
  const [thread, setThread] = useState<PortalDocument | null>(null)
  const both = account.is_supplier && account.is_customer
  const columns: ListColumn<PortalDocument>[] = [
    { key: 'doc', header: 'Documento', cell: (d) => <span className="flex flex-col leading-tight"><span>N° {d.folio}</span><span className="text-xs font-normal text-faint">{documentTypeLabel(d.doc_type)}</span></span>, sortValue: (d) => d.folio },
    ...(both ? [{ key: 'dir', header: 'Tipo', cell: (d: PortalDocument) => (d.direction === 'payable' ? 'Te pagan' : 'Pagas tú'), sortValue: (d: PortalDocument) => d.direction }] : []),
    { key: 'issue', mobileHidden: true, header: 'Emisión', cell: (d) => formatDate(d.issue_date), sortValue: (d) => d.issue_date },
    { key: 'due', header: 'Vencimiento', cell: (d) => formatDate(d.due_date), sortValue: (d) => d.due_date },
    ...(account.is_supplier
      ? [
          {
            key: 'approval',
            header: 'Aprobación',
            cell: (d: PortalDocument) =>
              d.direction === 'payable' ? (
                <span className="flex flex-col items-start gap-0.5">
                  <ApprovalStatusBadge status={d.approval_status} />
                  {d.approval_status === 'rejected' && d.rejection_reason && <span className="max-w-44 truncate text-[10px] text-bad" title={d.rejection_reason}>{d.rejection_reason}</span>}
                </span>
              ) : (
                <span className="text-faint">—</span>
              ),
            sortValue: (d: PortalDocument) => d.approval_status,
          },
          {
            key: 'management',
            header: 'Gestión de pago',
            cell: (d: PortalDocument) =>
              d.direction === 'payable' && d.approval_status === 'approved' ? (
                <PaymentManagementBadge value={d.payment_management} date={d.scheduled_payment_date} />
              ) : (
                <span className="text-faint">—</span>
              ),
            sortValue: (d: PortalDocument) => d.scheduled_payment_date,
          },
        ]
      : [
          {
            key: 'scheduled',
            header: 'Pago comprometido',
            cell: (d: PortalDocument) =>
              d.scheduled_payment_date && d.pending_amount > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-ink"><CalendarClock size={14} className="text-brand-600" />{formatDate(d.scheduled_payment_date)}</span>
              ) : (
                <span className="text-faint">—</span>
              ),
            sortValue: (d: PortalDocument) => d.scheduled_payment_date,
          },
        ]),
    { key: 'total', header: 'Total', align: 'right', cell: (d) => <Money minor={d.total_amount} currency={d.currency} />, sortValue: (d) => d.total_amount },
    { key: 'pending', header: 'Saldo', align: 'right', cell: (d) => <Money minor={d.pending_amount} currency={d.currency} className={d.pending_amount ? 'font-semibold text-ink' : ''} />, sortValue: (d) => d.pending_amount },
    { key: 'status', mobileBadge: true, header: 'Estado', cell: (d) => <StatusBadge status={d.payment_status} daysOverdue={d.days_overdue} />, sortValue: (d) => d.days_overdue },
  ]
  const filters: ListFilter<PortalDocument>[] = [
    {
      type: 'select',
      key: 'status',
      label: 'Estado',
      options: [
        { value: 'abiertos', label: 'Con saldo pendiente' },
        { value: 'vencido', label: 'Vencidos' },
        { value: 'pagado', label: 'Pagados' },
      ],
      match: (d, v) => (v === 'abiertos' ? d.pending_amount > 0 : d.payment_status === v),
    },
    ...(both ? [{ type: 'select' as const, key: 'dir', label: 'Tipo', options: [{ value: 'payable', label: 'Te pagan' }, { value: 'receivable', label: 'Pagas tú' }], match: (d: PortalDocument, v: string) => d.direction === v }] : []),
    { type: 'dateRange', key: 'due', label: 'Vencimiento', getDate: (d) => d.due_date },
    ...(account.is_supplier
      ? [{
          type: 'select' as const,
          key: 'management',
          label: 'Gestión de pago',
          options: [{ value: 'pending', label: 'En revisión' }, { value: 'requested', label: 'Pago solicitado' }, { value: 'scheduled', label: 'Pago programado' }, { value: 'paid', label: 'Pago realizado' }],
          match: (d: PortalDocument, v: string) => (v === 'pending' ? d.approval_status === 'pending' : d.payment_management === v),
        }]
      : []),
  ]
  const list = useListState({
    rows: data.documents,
    rowKey: (d) => d.id,
    columns,
    filters,
    searchText: (d) => `${d.folio} ${documentTypeLabel(d.doc_type)}`,
    storageKey: 'portal-documents',
    defaultSort: { key: 'due', dir: 'desc' },
  })
  return (
    <div className="flex flex-col gap-3">
      <FormError error={error} />
      <ListView
        state={list}
        columns={columns}
        rowKey={(d) => d.id}
        filters={filters}
        searchPlaceholder="Buscar por folio…"
        onRowClick={setThread}
        rowActions={(d) => (
          <>
            <RowAction label="Mensajes" onClick={() => setThread(d)}>
              <MessageSquare size={17} />
            </RowAction>
            {d.attachments.length > 0 && (
              <RowMenu
                label="Descargar archivos"
                icon={<FileDown size={17} />}
                items={d.attachments.map((f) => ({
                  label: f.file_name,
                  onClick: () => openFile(f.storage_path).catch((err) => setError(errorMessage(err))),
                }))}
              />
            )}
            {d.payment_url && d.pending_amount > 0 && (
              <RowAction label="Pagar con MercadoPago" onClick={() => window.open(d.payment_url!, '_blank', 'noopener')}>
                <CreditCard size={17} className="text-brand-600" />
              </RowAction>
            )}
          </>
        )}
        empty={<EmptyState title="Sin documentos" description="Cuando la empresa registre documentos a tu nombre, aparecerán aquí." />}
      />
      {thread && <PortalThread doc={thread} tenantName={data.tenant.name} onClose={() => setThread(null)} />}
    </div>
  )
}

function PortalThread({ doc, tenantName, onClose }: { doc: PortalDocument; tenantName: string; onClose: () => void }) {
  const qc = useQueryClient()
  const comments = useQuery({ queryKey: ['portal', 'comments', doc.id], queryFn: () => api.portalComments(doc.id), staleTime: 0 })
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setError(null)
    setSending(true)
    try {
      await api.portalAddComment(doc.id, body)
      setBody('')
      await qc.invalidateQueries({ queryKey: ['portal', 'comments', doc.id] })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <Drawer
      open
      title={`${documentTypeLabel(doc.doc_type)} N° ${doc.folio}`}
      subtitle={<>Saldo <Money minor={doc.pending_amount} currency={doc.currency} /> · vence {formatDate(doc.due_date)}</>}
      onClose={onClose}
      footer={
        <form onSubmit={send} className="flex w-full items-end gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={`Escribe un mensaje a ${tenantName}…`}
            aria-label="Mensaje"
            className="min-h-10 flex-1 resize-none rounded-md border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <Button variant="primary" type="submit" disabled={sending || !body.trim()} aria-label="Enviar"><Send size={16} /></Button>
        </form>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        {doc.direction === 'payable' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ApprovalStatusBadge status={doc.approval_status} />
            {doc.approval_status === 'approved' && <PaymentManagementBadge value={doc.payment_management} date={doc.scheduled_payment_date} />}
            {doc.approval_status === 'rejected' && doc.rejection_reason && <span className="text-bad">Motivo: {doc.rejection_reason}</span>}
          </div>
        )}
        {doc.scheduled_payment_date && doc.pending_amount > 0 && (doc.direction === 'receivable' || doc.payment_management === 'scheduled') && (
          <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-navy-900"><CalendarClock size={16} /> Pago agendado para el {formatDate(doc.scheduled_payment_date)}</p>
        )}
        {comments.isLoading ? (
          <p className="text-sm text-faint">Cargando mensajes…</p>
        ) : (comments.data ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-faint">Sin mensajes. Escribe si tienes dudas sobre este documento.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {(comments.data ?? []).map((c) => {
              const mine = c.author_kind === 'counterparty'
              return (
                <li key={c.id} className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
                  <span className="text-xs text-faint">{mine ? 'Tú' : tenantName} · {new Date(c.created_at).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  <p className={cn('max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap', mine ? 'bg-navy-900 text-white' : 'border border-line bg-white text-ink')}>{c.body}</p>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </Drawer>
  )
}

function PortalPayments({ payments, account }: { payments: PortalPayment[]; account: PortalAccount }) {
  const both = account.is_supplier && account.is_customer
  const columns: ListColumn<PortalPayment>[] = [
    { key: 'date', header: 'Fecha', cell: (p) => formatDate(p.paid_on), sortValue: (p) => p.paid_on },
    ...(both ? [{ key: 'dir', header: 'Tipo', cell: (p: PortalPayment) => (p.direction === 'out' ? 'Pago recibido' : 'Pago enviado'), sortValue: (p: PortalPayment) => p.direction }] : []),
    { key: 'method', header: 'Medio', cell: (p) => (p.method.startsWith('mercadopago') ? 'MercadoPago' : p.method.charAt(0).toUpperCase() + p.method.slice(1)), sortValue: (p) => p.method },
    { key: 'ref', header: 'Referencia', cell: (p) => p.reference ?? '—' },
    { key: 'docs', header: 'Documentos', cell: (p) => <span className="flex flex-wrap gap-1">{p.folios.map((f) => <Badge key={f}>N° {f}</Badge>)}</span> },
    { key: 'amount', header: 'Monto', align: 'right', cell: (p) => <Money minor={p.amount} currency={p.currency} className="font-semibold text-ink" />, sortValue: (p) => p.amount },
  ]
  const list = useListState({
    rows: payments,
    rowKey: (p) => p.id,
    columns,
    filters: [{ type: 'dateRange', key: 'date', label: 'Fecha', getDate: (p) => p.paid_on }],
    searchText: (p) => `${p.reference ?? ''} ${p.folios.join(' ')}`,
    storageKey: 'portal-payments',
    defaultSort: { key: 'date', dir: 'desc' },
  })
  return (
    <ListView
      state={list}
      columns={columns}
      rowKey={(p) => p.id}
      filters={[{ type: 'dateRange', key: 'date', label: 'Fecha', getDate: (p) => p.paid_on }]}
      searchPlaceholder="Buscar por referencia o folio…"
      empty={<EmptyState title="Sin pagos registrados" />}
    />
  )
}

function PortalAccountInfo({ data }: { data: PortalSnapshot }) {
  const cp = data.counterparty
  const items = useMemo(
    () =>
      [
        ['Razón social', cp.legal_name ?? cp.name],
        ['Identificador tributario', cp.tax_id ? formatTaxId(cp.tax_id, (cp.country as Country) ?? data.tenant.country) : '—'],
        ['Correo', cp.email ?? '—'],
        ['Teléfono', cp.phone ?? '—'],
        ['Dirección', cp.address ?? '—'],
      ] as [string, string][],
    [cp, data.tenant.country],
  )
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ink">Tus datos registrados</h3>
        <dl className="divide-y divide-line rounded-lg border border-line">
          {items.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-faint">¿Algún dato está mal? Avísale a {data.tenant.name} para corregirlo.</p>
      </section>
      {cp.is_supplier && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink">Cuentas bancarias donde te pagan</h3>
          {data.bank_accounts.length === 0 ? (
            <p className="rounded-lg border border-line p-4 text-sm text-faint">No hay cuentas bancarias registradas.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.bank_accounts.map((b, i) => (
                <li key={i} className="rounded-lg border border-line p-4 text-sm">
                  <div className="font-medium text-ink">{b.bank_name}{b.account_type ? ` · ${b.account_type}` : ''}</div>
                  <div className="text-muted">N° {b.account_number.replace(/.(?=.{4})/g, '•')}</div>
                  {b.holder_name && <div className="text-faint">{b.holder_name}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
