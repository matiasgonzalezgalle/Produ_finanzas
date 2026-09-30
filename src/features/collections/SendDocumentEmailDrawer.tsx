// Enviar un correo de cobranza (plantilla o estado de cuenta) con vista previa exacta del HTML
// que se enviará, destinatarios editables (Para) y copia (CC).
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, CreditCard, Mail, Pencil, RefreshCw, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useCollectionMutations, useCollectionRules } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api, type DocumentRow } from '../../data'
import { documentTypeLabel } from '../../domain/documents'
import { formatMoney } from '../../domain/money'
import { blocksOf, legacyBlocks } from '../../lib/emailBlocks'
import { Button, Drawer, FormError, Input, Select } from '../../ui'
import { errorMessage } from '../shared'
import { TEMPLATE_VARIABLES } from './collectionData'
import { EmailBlocksEditor, withIds, withoutIds, type EditorBlock } from './EmailBlocksEditor'

export const PAYMENT_LINK_TEMPLATE = 'Cobro con link de pago'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATEMENT = 'statement'
/** Contenido del estado de cuenta (no tiene plantilla guardada), para editarlo en un envío. */
const STATEMENT_DEFAULT = {
  subject: 'Estado de cuenta de {{cliente}} con {{empresa}}',
  blocks: legacyBlocks('Hola {{cliente}},\nte compartimos el detalle de tus documentos con saldo pendiente con {{empresa}} al {{hoy}}.\nTotal vencido: {{total_vencido}}.', true),
}

/** Desde un documento: el cobro con link de pago de ese documento. */
export function SendDocumentEmailDrawer({ document: d, onClose }: { document: DocumentRow; onClose: () => void }) {
  return (
    <SendCollectionEmailDrawer
      counterpartyId={d.counterparty_id} counterpartyName={d.counterparty_name} documents={[d]} initialDocumentId={d.id} allowStatement={false} onClose={onClose}
    />
  )
}

export function SendCollectionEmailDrawer({ counterpartyId, counterpartyName, documents, initialDocumentId, allowStatement, onClose }: {
  counterpartyId: string
  counterpartyName: string
  /** Documentos con saldo del cliente (para plantillas de un documento). */
  documents: DocumentRow[]
  initialDocumentId?: string | null
  allowStatement: boolean
  onClose: () => void
}) {
  const { tenant } = useCurrentTenant()
  const rules = useCollectionRules()
  const { sendEmail } = useCollectionMutations()
  const templates = (rules.data ?? []).filter((r) => r.trigger !== 'statement')
  const preferred = initialDocumentId || !allowStatement
    ? (templates.find((r) => r.name === PAYMENT_LINK_TEMPLATE) ?? templates.find((r) => r.include_payment_link) ?? templates[0])?.id
    : STATEMENT
  const [picked, setPicked] = useState<string | null>(null)
  const choice = picked ?? preferred ?? (allowStatement ? STATEMENT : '')
  const rule = templates.find((r) => r.id === choice) ?? null
  const needsDoc = choice !== STATEMENT
  const [documentId, setDocumentId] = useState(initialDocumentId ?? documents[0]?.id ?? '')
  const [toEdited, setTo] = useState<string[] | null>(null)
  const [cc, setCc] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string[] | null>(null)
  // Edición solo para este envío (null = se usa la plantilla tal cual).
  const [edit, setEdit] = useState<{ subject: string; blocks: EditorBlock[] } | null>(null)
  const [focus, setFocus] = useState<'subject' | 'body'>('body')
  const insertInText = useRef<((text: string) => void) | null>(null)
  const subjectRef = useRef<HTMLInputElement>(null)

  const startEditing = () => {
    const base = rule ? { subject: rule.subject, blocks: blocksOf(rule) } : STATEMENT_DEFAULT
    setEdit({ subject: base.subject, blocks: withIds(base.blocks) })
  }
  const pick = (id: string) => {
    if (edit && id !== choice && !confirm('Al cambiar de plantilla se descartan los cambios del mensaje. ¿Continuar?')) return
    setEdit(null)
    setPicked(id)
  }
  const insertVariable = (key: string) => {
    if (!edit) return
    const token = `{{${key}}}`
    if (focus === 'body' && insertInText.current) return insertInText.current(token)
    const el = subjectRef.current
    const start = el?.selectionStart ?? edit.subject.length
    const end = el?.selectionEnd ?? edit.subject.length
    setEdit({ ...edit, subject: `${edit.subject.slice(0, start)}${token}${edit.subject.slice(end)}` })
  }

  const override = edit ? { subject: edit.subject, blocks: withoutIds(edit.blocks) } : {}
  const previewInput = { counterpartyId, ruleId: choice === STATEMENT ? null : choice, documentId: needsDoc ? documentId || null : null, ...override }
  // Mientras se edita, la vista previa se actualiza medio segundo después del último cambio.
  const key = JSON.stringify(previewInput)
  const [debouncedKey, setDebouncedKey] = useState(key)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(key), edit ? 500 : 0)
    return () => clearTimeout(t)
  }, [key, edit])
  const preview = useQuery({
    queryKey: ['collection-email-preview', tenant.id, debouncedKey],
    queryFn: () => api.previewCollectionEmail(tenant.id, JSON.parse(debouncedKey)),
    placeholderData: (prev) => prev,
    enabled: !!choice && (!needsDoc || !!documentId),
    staleTime: 60_000,
  })
  const data = preview.data && !('skip' in preview.data) ? preview.data : null
  const skip = preview.data && 'skip' in preview.data ? preview.data.skip : null
  const to = toEdited ?? data?.to ?? []

  const send = async () => {
    setError(null)
    if (!to.length) return setError('Agrega al menos un destinatario en "Para".')
    if (edit && !edit.subject.trim()) return setError('El asunto no puede quedar vacío.')
    try {
      await sendEmail.mutateAsync({ ...previewInput, to, cc })
      setSent(to)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (sent) {
    return (
      <Drawer open onClose={onClose} title="Correo enviado" footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
        <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-4 text-sm text-ok">
          <Check size={18} className="shrink-0" />
          <span>Enviado a {sent.join(', ')}{cc.length ? ` (copia a ${cc.join(', ')})` : ''}. Lo verás en la actividad del cliente y en Configuración › Notificaciones.</span>
        </p>
      </Drawer>
    )
  }

  return (
    <Drawer
      open onClose={onClose} width="xl" title="Enviar correo de cobranza" subtitle={counterpartyName}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={send} disabled={sendEmail.isPending || !data || !to.length}><Mail size={15} /> {sendEmail.isPending ? 'Enviando…' : 'Enviar ahora'}</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <FormError error={error} />
          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-medium text-ink">Plantilla</h3>
            {allowStatement && (
              <Option active={choice === STATEMENT} onClick={() => pick(STATEMENT)} title="Estado de cuenta" hint="Todos los documentos con saldo, con el total vencido." />
            )}
            {templates.map((r) => (
              <Option
                key={r.id} active={choice === r.id} onClick={() => pick(r.id)} disabled={!documents.length}
                title={<>{r.name}{r.include_payment_link && <CreditCard size={14} className="text-brand-600" aria-label="Incluye botón de pago" />}</>}
                hint={r.subject}
              />
            ))}
            {rules.isLoading && <p className="text-sm text-faint">Cargando plantillas…</p>}
          </section>

          {needsDoc && documents.length > 1 && (
            <label className="text-sm">
              <span className="mb-1 block text-[12px] font-medium text-ink">Documento</span>
              <Select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>{documentTypeLabel(d.doc_type)} N° {d.folio} · {formatMoney(d.pending_amount, d.currency)}{d.days_overdue > 0 ? ` · ${d.days_overdue} d de atraso` : ''}</option>
                ))}
              </Select>
            </label>
          )}

          {choice && (
            edit ? (
              <section className="flex flex-col gap-3 rounded-lg border border-brand-500/40 bg-brand-50/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[12px] font-semibold text-ink">Mensaje de este envío</h3>
                  <button type="button" onClick={() => setEdit(null)} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"><Undo2 size={13} /> Usar la plantilla</button>
                </div>
                <label className="text-sm">
                  <span className="mb-1 block text-[12px] text-muted">Asunto</span>
                  <Input ref={subjectRef} value={edit.subject} maxLength={200} onFocus={() => setFocus('subject')} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
                </label>
                <EmailBlocksEditor
                  blocks={edit.blocks}
                  onChange={(blocks) => setEdit({ ...edit, blocks })}
                  perDocument={needsDoc}
                  onTextFocus={(fn) => { insertInText.current = fn; setFocus('body') }}
                />
                <div className="flex flex-wrap gap-1.5">
                  {TEMPLATE_VARIABLES.filter((v) => needsDoc || !v.docOnly).map((v) => (
                    <button key={v.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVariable(v.key)} className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] text-ink hover:bg-subtle">{v.label}</button>
                  ))}
                </div>
                <p className="text-[11px] text-faint">Estos cambios se usan solo en este envío; la plantilla no cambia.</p>
              </section>
            ) : (
              <Button size="sm" className="self-start" onClick={startEditing} disabled={!data}><Pencil size={14} /> Editar mensaje</Button>
            )
          )}

          <section className="flex flex-col gap-3">
            <EmailListInput label="Para" values={to} onChange={setTo} placeholder={preview.isLoading ? 'Cargando…' : 'correo@cliente.cl'} />
            <EmailListInput label="CC" values={cc} onChange={setCc} placeholder="Opcional" />
            {toEdited && data && toEdited.join() !== data.to.join() && (
              <button type="button" onClick={() => setTo(null)} className="self-start text-xs text-brand-600 hover:underline">Volver a los correos de cobranza del cliente</button>
            )}
            <p className="text-xs text-faint">Por defecto: el correo del cliente, sus contactos de cobranza y quienes tienen acceso al portal. Las respuestas llegan al correo de respuesta configurado en Notificaciones.</p>
          </section>
        </div>

        <section className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-line bg-subtle">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-white px-4 py-2.5">
            <div className="min-w-0 text-sm">
              <span className="text-faint">Asunto: </span>
              <span className="font-medium text-ink">{data?.subject ?? (preview.isLoading ? 'Cargando…' : '—')}</span>
            </div>
            <button type="button" onClick={() => preview.refetch()} className="shrink-0 rounded-md p-1.5 text-muted hover:bg-subtle" aria-label="Actualizar vista previa" title="Actualizar vista previa">
              <RefreshCw size={15} className={clsx(preview.isFetching && 'animate-spin')} />
            </button>
          </div>
          {preview.error ? (
            <p className="p-4 text-sm text-bad">{errorMessage(preview.error)}</p>
          ) : skip ? (
            <p className="p-4 text-sm text-warn">No se puede enviar: {skip}.</p>
          ) : data ? (
            <iframe title="Vista previa del correo" sandbox="" srcDoc={data.html} className="h-[600px] w-full flex-1 bg-white" />
          ) : (
            <p className="p-4 text-sm text-faint">{rule || choice === STATEMENT ? 'Armando la vista previa…' : 'Elige una plantilla.'}</p>
          )}
        </section>
      </div>
    </Drawer>
  )
}

function Option({ active, onClick, title, hint, disabled }: { active: boolean; onClick: () => void; title: React.ReactNode; hint: string; disabled?: boolean }) {
  return (
    <label className={clsx('flex cursor-pointer gap-3 rounded-lg border p-3', active ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="radio" checked={active} onChange={onClick} disabled={disabled} className="mt-0.5 accent-navy-900" />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">{title}</span>
        <span className="block truncate text-[12px] text-muted">{hint}</span>
      </span>
    </label>
  )
}

/** Lista de correos como etiquetas: Enter, coma o salir del campo agregan; Backspace quita el último. */
function EmailListInput({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const commit = (text: string) => {
    const parts = text.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean)
    if (!parts.length) return
    const bad = parts.filter((p) => !EMAIL_RE.test(p))
    const good = parts.filter((p) => EMAIL_RE.test(p))
    if (good.length) onChange([...new Set([...values, ...good])].slice(0, 10))
    setInvalid(bad.length ? `Correo inválido: ${bad.join(', ')}` : null)
    setDraft(bad.join(' '))
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1))
    }
  }
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-ink">{label}</span>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1.5 focus-within:border-brand-500">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-0.5 text-[13px] text-ink">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-faint hover:text-ink" aria-label={`Quitar ${v}`}><X size={12} /></button>
          </span>
        ))}
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => commit(draft)}
          placeholder={values.length ? '' : placeholder} aria-label={label}
          className="min-w-32 flex-1 border-0 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-bad">{invalid}</p>}
    </div>
  )
}
