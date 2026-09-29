import { CheckCircle2, CircleAlert, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useConnectMercadoPago, useIntegration } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api } from '../../data'
import { Badge, Button, Field, FormError, Input } from '../../ui'
import { errorMessage } from '../shared'

function MercadoPagoMark() {
  return (
    <span className="flex size-11 items-center justify-center rounded-lg bg-[#00b1ea]/10 text-[12px] font-bold text-[#0a77c2]" aria-hidden>
      MP
    </span>
  )
}

export function IntegrationsSettings() {
  const { canAdmin } = useCurrentTenant()
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
              <Field label="Access token" hint="En MercadoPago › Tus integraciones › Credenciales de producción (APP_USR-…) o de prueba (TEST-…).">
                {(id) => <Input id={id} type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="APP_USR-…" />}
              </Field>
              <Field label="Clave secreta de webhooks" hint="En Tus integraciones › Webhooks › Clave secreta. Se usa para verificar la firma de cada notificación.">
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

          {webhookUrl && (
            <div className="flex flex-col gap-2 border-t border-line bg-subtle p-5">
              <p className="flex items-center gap-2 text-sm font-medium text-ink"><CheckCircle2 size={16} className="text-ok" /> Último paso: configura el webhook en MercadoPago</p>
              <p className="text-sm text-muted">En Tus integraciones › Webhooks, pega esta URL y activa el evento <b>Pagos</b>:</p>
              <Input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
          {!canAdmin && !connected && <p className="border-t border-line p-5 text-sm text-muted">Solo un administrador de la empresa puede conectar integraciones.</p>}
        </section>

        {api.mode === 'demo' && (
          <p className="mt-4 text-sm text-faint">Modo demo: la conexión se simula en tu navegador y no llama a MercadoPago.</p>
        )}
      </div>
    </div>
  )
}
