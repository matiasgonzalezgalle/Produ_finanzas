import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useConnectMercadoPago, useIntegration, useSiiMutations } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api } from '../../data'
import { Badge, Button, Field, FormError, Input } from '../../ui'
import { formatTimestamp } from '../../domain/dates'
import { formatTaxId } from '../../domain/taxId'
import { useSiiSync } from '../sii/SiiInbox'
import { PUBLIC_SUPABASE_URL } from '../../config/public'
import { errorMessage } from '../shared'

function MercadoPagoMark() {
  return (
    <span className="flex size-11 items-center justify-center rounded-lg bg-[#00b1ea]/10 text-[12px] font-bold text-[#0a77c2]" aria-hidden>
      MP
    </span>
  )
}

export function IntegrationsSettings() {
  const { hasModule } = useCurrentTenant()
  const any = hasModule('mercadopago') || hasModule('sii') || hasModule('conciliacion')
  return (
    <div className="max-w-3xl">
      {!any && <p className="text-sm text-muted">Tu empresa no tiene integraciones activas. Pide al administrador de Produ Finanzas que active MercadoPago, Documentos del SII o Conciliación bancaria.</p>}
      {hasModule('mercadopago') && <MercadoPagoIntegration />}
      {hasModule('sii') && <SiiIntegration />}
      {api.mode === 'demo' && any && (
        <p className="mt-4 text-sm text-faint">Modo demo: las conexiones se simulan en tu navegador y no llaman a MercadoPago ni a Fintoc.</p>
      )}
    </div>
  )
}

function MercadoPagoIntegration() {
  const { tenant, canAdmin } = useCurrentTenant()
  const mpPanelUrl = tenant.country === 'PE' ? 'https://www.mercadopago.com.pe/developers/panel/app' : 'https://www.mercadopago.cl/developers/panel/app'
  const integration = useIntegration('mercadopago')
  const connect = useConnectMercadoPago()
  const [editing, setEditing] = useState(false)
  const [accessToken, setAccessToken] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const conn = integration.data
  const connected = conn?.status === 'active'
  const showForm = canAdmin && (!connected || editing)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const res = await connect.mutateAsync({ accessToken: accessToken.trim(), webhookSecret: webhookSecret.trim() })
      setWebhookUrl(res.webhookUrl)
      setAccessToken('')
      setWebhookSecret('')
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="max-w-3xl">
        <section className="rounded-lg border border-line bg-white">
          <div className="flex flex-wrap items-start gap-4 p-5">
            <MercadoPagoMark />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[14px] font-semibold text-ink">MercadoPago</h2>
                {connected ? <Badge tone="ok">Conectado</Badge> : <Badge>No conectado</Badge>}
                {conn?.public_config.sandbox && <Badge tone="warn">Pruebas</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted">
                Cobra tus cuentas por cobrar con un link de pago. Cuando MercadoPago confirma el pago, el cobro se registra y se asigna al documento automáticamente.
              </p>
              {connected && (
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <div><dt className="text-faint">Cuenta</dt><dd className="text-ink">{conn.public_config.nickname}</dd></div>
                  <div><dt className="text-faint">País</dt><dd className="text-ink">{conn.public_config.site_id === 'MPE' ? 'Perú' : 'Chile'}</dd></div>
                  <div><dt className="text-faint">Moneda</dt><dd className="text-ink">{conn.public_config.currency}</dd></div>
                  <div><dt className="text-faint">Token</dt><dd className="text-ink">•••• {conn.public_config.token_last4}</dd></div>
                </dl>
              )}
              {conn?.last_error && (
                <p className="mt-3 flex items-center gap-2 text-sm text-bad"><CircleAlert size={16} /> Último error: {conn.last_error}</p>
              )}
            </div>
            {connected && canAdmin && !editing && <Button onClick={() => setEditing(true)}>Actualizar credenciales</Button>}
          </div>

          {showForm && (
            <form onSubmit={submit} className="flex flex-col gap-4 border-t border-line p-5">
              <FormError error={error} />
              <ol className="flex flex-col gap-2.5 rounded-lg bg-subtle p-4 text-sm text-muted">
                <li>
                  <b className="text-ink">1. Crea una aplicación</b> en el{' '}
                  <a href={mpPanelUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">panel de desarrolladores de MercadoPago</a>{' '}
                  (entra con la cuenta de la empresa → <b>Crear aplicación</b> → pagos online con <b>Checkout Pro</b>). Si ya tienes una, ábrela.
                </li>
                <li>
                  <b className="text-ink">2. Configura el webhook:</b> en el menú de la izquierda de la aplicación, <b>Webhooks › Configurar notificaciones</b>, pestaña <b>Modo productivo</b>.
                  Pega esta URL, marca el evento <b>Pagos</b> y presiona <b>Guardar configuración</b>. Ahí se genera la <b>clave secreta</b>.
                  <Input readOnly className="mt-1.5" value={`${PUBLIC_SUPABASE_URL}/functions/v1/mercadopago-webhook?tenant=${tenant.id}`} onFocus={(e) => e.currentTarget.select()} aria-label="URL del webhook" />
                </li>
                <li>
                  <b className="text-ink">3. Copia las credenciales</b> de esa misma aplicación: <b>Credenciales de producción › Access token</b> (APP_USR-…) y la <b>clave secreta</b> del webhook, y pégalas abajo.
                </li>
              </ol>
              <Field label="Access token" hint="Aplicación › Credenciales de producción (APP_USR-…). Para probar puedes usar las de prueba (TEST-…).">
                {(id) => <Input id={id} type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="APP_USR-…" />}
              </Field>
              <Field label="Clave secreta del webhook" hint="Aplicación › Webhooks › Configurar notificaciones › Clave secreta (aparece al guardar el paso 2).">
                {(id) => <Input id={id} type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />}
              </Field>
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs text-muted">
                  <ShieldCheck size={16} className="text-ok" /> Las credenciales se guardan en el servidor y nunca vuelven al navegador.
                </p>
                <div className="flex gap-2">
                  {editing && <Button onClick={() => setEditing(false)}>Cancelar</Button>}
                  <Button variant="primary" type="submit" disabled={connect.isPending || !accessToken || !webhookSecret}>
                    {connect.isPending ? 'Verificando…' : 'Conectar'}
                  </Button>
                </div>
              </div>
            </form>
          )}

          {(webhookUrl || connected) && canAdmin && (
            <div className="flex flex-col gap-2 border-t border-line bg-subtle p-5">
              {conn?.last_event_at ? (
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  <CheckCircle2 size={16} className="text-ok" /> Webhook funcionando · último aviso de MercadoPago: {formatTimestamp(conn.last_event_at, tenant.timezone)}
                </p>
              ) : (
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  <CircleAlert size={16} className="text-warn" /> {webhookUrl ? 'Último paso: configura el webhook en MercadoPago' : 'Aún no llega ningún aviso de MercadoPago'}
                </p>
              )}
              <p className="text-sm text-muted">
                En el <a href={mpPanelUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">panel de desarrolladores de MercadoPago</a> abre tu aplicación →
                <b> Webhooks › Configurar notificaciones</b> → pestaña <b>Modo {conn?.public_config?.sandbox ? 'de prueba' : 'productivo'}</b>: pega esta URL, marca el evento <b>Pagos</b> y guarda.
                Luego presiona <b>Simular</b>: si la clave secreta cargada aquí es la misma, esta sección mostrará "Webhook funcionando" (recarga la página).
              </p>
              <Input readOnly value={webhookUrl ?? `${PUBLIC_SUPABASE_URL}/functions/v1/mercadopago-webhook?tenant=${tenant.id}`} onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
          {!canAdmin && !connected && <p className="border-t border-line p-5 text-sm text-muted">Solo un administrador de la empresa puede conectar integraciones.</p>}
        </section>

      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SII (Chile) vía Fintoc
// ---------------------------------------------------------------------------
function SiiMark() {
  return (
    <span className="flex size-11 items-center justify-center rounded-lg bg-navy-900/8 text-[12px] font-bold text-navy-900" aria-hidden>
      SII
    </span>
  )
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function SiiIntegration() {
  const { tenant, canAdmin, canWrite } = useCurrentTenant()
  const integration = useIntegration('fintoc_sii')
  const sii = useSiiMutations()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const conn = integration.data
  const connected = conn?.status === 'active'
  const busy = !!step || sii.sync.isPending || sii.disconnect.isPending

  const siiSync = useSiiSync()
  if (tenant.country !== 'CL') return null

  async function connect() {
    setError(null)
    try {
      setStep('Abriendo Fintoc…')
      const startedAt = Date.now()
      const { publicKey, webhookUrl } = await sii.start.mutateAsync()
      if (api.mode !== 'demo') {
        const { openFiscalWidget } = await import('../../lib/fintocWidget')
        setStep('Completa la conexión en la ventana de Fintoc…')
        const done = await openFiscalWidget({ publicKey, webhookUrl })
        if (!done) return
        // Fintoc avisa al servidor cuando crea el link: se espera hasta 1 minuto.
        setStep('Confirmando la conexión…')
        let ready = false
        for (let i = 0; i < 30 && !ready; i++) {
          await wait(2000)
          const current = await api.getIntegration(tenant.id, 'fintoc_sii')
          if (current?.status === 'error') throw new Error(current.last_error ?? 'No se pudo conectar el SII')
          ready = current?.status === 'active' && !!current.public_config.connected_at && Date.parse(current.public_config.connected_at) >= startedAt - 5000
        }
        if (!ready) throw new Error('Fintoc aún no confirma la conexión. Revisa en unos minutos o vuelve a intentarlo.')
      }
      setStep('Trayendo documentos del SII…')
      await sii.sync.mutateAsync()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStep(null)
      qc.invalidateQueries({ queryKey: ['integration', tenant.id] })
    }
  }

  const sync = siiSync.run

  async function disconnect() {
    if (!window.confirm('¿Desconectar el SII? Los documentos ya traídos se conservan, pero no se actualizarán.')) return
    setError(null)
    try {
      await sii.disconnect.mutateAsync()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <SiiMark />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-ink">Documentos tributarios (SII)</h2>
            {connected ? <Badge tone="ok">Conectado</Badge> : conn?.status === 'error' ? <Badge tone="bad">Revisar</Badge> : <Badge>No conectado</Badge>}
            {conn?.public_config.mode === 'test' && api.mode !== 'demo' && <Badge tone="warn">Pruebas</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            Trae del Registro de Compras y Ventas del SII las facturas, notas de crédito y débito y boletas de honorarios que la empresa recibió y emitió,
            con su estado de acuse o reclamo. Luego las importas a cuentas por pagar o por cobrar. La conexión es a través de Fintoc.
          </p>
          {conn && (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <div><dt className="text-faint">RUT conectado</dt><dd className="text-ink">{conn.public_config.holder_id ? formatTaxId(conn.public_config.holder_id, 'CL') : '—'}</dd></div>
              <div><dt className="text-faint">Última sincronización</dt><dd className="text-ink">{conn.public_config.last_sync_at ? formatTimestamp(conn.public_config.last_sync_at, tenant.timezone) : 'Nunca'}</dd></div>
              <div><dt className="text-faint">Documentos</dt><dd><Link to="/cxp/documentos?sii=1" className="text-brand-600 hover:underline">Compras</Link> · <Link to="/cxc/documentos?sii=1" className="text-brand-600 hover:underline">Ventas</Link></dd></div>
            </dl>
          )}
          {conn?.last_error && <p className="mt-3 flex items-center gap-2 text-sm text-bad"><CircleAlert size={16} /> {conn.last_error}</p>}
          {step && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><RefreshCw size={15} className="animate-spin" /> {step}</p>}
          <FormError error={error ?? siiSync.error} />
          {siiSync.notice && <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-navy-900">{siiSync.notice}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {connected && canWrite && <Button onClick={sync} disabled={busy}><RefreshCw size={15} className={sii.sync.isPending ? 'animate-spin' : ''} /> Sincronizar</Button>}
          {canAdmin && !connected && <Button variant="primary" onClick={connect} disabled={busy}>{conn ? 'Volver a conectar' : 'Conectar SII'}</Button>}
          {canAdmin && conn && <Button onClick={disconnect} disabled={busy}><Unplug size={15} /> Desconectar</Button>}
        </div>
      </div>
      {!connected && (
        <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-muted">
          <ShieldCheck size={16} className="shrink-0 text-ok" />
          La clave tributaria se ingresa en la ventana segura de Fintoc; Produ Finanzas nunca la ve ni la guarda. Se conecta el RUT de la empresa ({tenant.tax_id ? formatTaxId(tenant.tax_id, 'CL') : 'regístralo en Empresa'}).
        </p>
      )}
      {!canAdmin && !conn && <p className="border-t border-line p-5 text-sm text-muted">Solo un administrador de la empresa puede conectar el SII.</p>}
    </section>
  )
}
