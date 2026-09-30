// Cobranza › Recordatorios: reglas que envían correos personalizados de forma programada.
import { BellRing, Copy, Mail, Pencil, Plus, Trash2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCollectionMutations, useCollectionRules, useCounterparties, useEmailLog } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api, type CollectionRule, type CollectionRuleInput, type CollectionTrigger } from '../../data'
import { formatTimestamp } from '../../domain/dates'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, PageHeader, Select } from '../../ui'
import { blocksOf, blocksToPlain } from '../../lib/emailBlocks'
import { EmailBlocksEditor, withIds, withoutIds } from './EmailBlocksEditor'
import { sectionTabs } from '../documents/DocumentsPage'
import { errorMessage } from '../shared'
import { ruleWhen, TEMPLATE_VARIABLES, unknownVariables, WEEKDAY_LABEL } from './collectionData'
import { CollectionsNav } from './CollectionsPage'

const TRIGGERS: { key: CollectionTrigger; label: string; hint: string }[] = [
  { key: 'before_due', label: 'Antes del vencimiento', hint: 'Un aviso preventivo, por documento.' },
  { key: 'on_due', label: 'El día del vencimiento', hint: 'Por documento, el mismo día en que vence.' },
  { key: 'after_due', label: 'Después del vencimiento', hint: 'Cobranza de documentos vencidos, por documento.' },
  { key: 'statement', label: 'Resumen semanal', hint: 'Estado de cuenta con todo lo pendiente, a clientes con deuda vencida.' },
  { key: 'new_document', label: 'Al emitir un documento', hint: 'Aviso de nuevo documento por cobrar.' },
  { key: 'manual', label: 'Solo manual', hint: 'Plantilla para enviar desde la ficha del cliente.' },
]

const EMPTY: CollectionRuleInput = {
  name: '',
  trigger: 'after_due',
  offset_days: 3,
  weekday: 1,
  send_hour: 9,
  subject: 'Tu {{documento}} está vencida',
  body: 'Hola {{cliente}},\n\nla {{documento}} por {{saldo}} venció el {{vencimiento}}.\n\nSaludos,\n{{empresa}}',
  include_documents: true,
  include_payment_link: true,
  audience: 'all',
  audience_tags: [],
  audience_ids: [],
  active: true,
}

export function CollectionRulesPage() {
  const { tenant, canWrite } = useCurrentTenant()
  const rules = useCollectionRules()
  const emails = useEmailLog()
  const m = useCollectionMutations()
  const [editing, setEditing] = useState<{ rule: CollectionRule | null; input: CollectionRuleInput } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rows = rules.data ?? []
  const stats = useMemo(() => {
    const map = new Map<string, { count: number; last: string | null }>()
    for (const e of emails.data ?? []) {
      if (!e.rule_id || e.status !== 'sent') continue
      const cur = map.get(e.rule_id) ?? { count: 0, last: null }
      const at = e.sent_at ?? e.created_at
      map.set(e.rule_id, { count: cur.count + 1, last: !cur.last || at > cur.last ? at : cur.last })
    }
    return map
  }, [emails.data])

  async function toggle(r: CollectionRule) {
    setError(null)
    const { id: _id, created_at: _c, ...input } = r
    void _id
    void _c
    try {
      await m.saveRule.mutateAsync({ input: { ...input, active: !r.active }, id: r.id })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const audienceLabel = (r: CollectionRule) => (r.audience === 'all' ? 'Todos los clientes' : r.audience === 'tags' ? `Etiquetas: ${r.audience_tags.join(', ') || '—'}` : `${r.audience_ids.length} clientes elegidos`)

  return (
    <div>
      <PageHeader title="Cuentas por cobrar" tabs={sectionTabs('receivable')} />
      <div className="flex flex-wrap items-center justify-between gap-3 pt-5">
        <CollectionsNav />
        {canWrite && <Button variant="primary" onClick={() => setEditing({ rule: null, input: { ...EMPTY } })}><Plus size={16} /> Nuevo recordatorio</Button>}
      </div>
      <p className="mt-3 max-w-3xl text-sm text-muted">
        Cada recordatorio envía un correo personalizado a los clientes que correspondan, a la hora elegida (hora de {tenant.timezone.split('/').pop()?.replace('_', ' ')}).
        Se revisan cada 15 minutos y cada documento recibe el mismo recordatorio una sola vez. Clientes pausados o con el recordatorio desactivado en su ficha no lo reciben.
      </p>
      <FormError error={error} />
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {rules.isLoading && <p className="text-sm text-faint">Cargando…</p>}
        {!rules.isLoading && rows.length === 0 && (
          <div className="rounded-lg border border-line bg-white lg:col-span-2">
            <EmptyState icon={<BellRing size={20} />} title="Aún no hay recordatorios" description="Crea el primero: por ejemplo, un aviso 3 días antes del vencimiento." />
          </div>
        )}
        {rows.map((r) => {
          const st = stats.get(r.id)
          return (
            <article key={r.id} className={cn('flex flex-col gap-3 rounded-lg border bg-white p-4', r.active ? 'border-line' : 'border-dashed border-line opacity-80')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">{r.name}{!r.active && <Badge>Inactivo</Badge>}</h3>
                  <span className="mt-1 inline-block rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">{ruleWhen(r)}</span>
                </div>
                <label className={cn('relative inline-flex shrink-0', canWrite ? 'cursor-pointer' : '')}>
                  <input type="checkbox" aria-label={`Activar ${r.name}`} className="peer sr-only" checked={r.active} disabled={!canWrite} onChange={() => toggle(r)} />
                  <span className="h-5 w-9 rounded-full bg-faint/35 transition-colors peer-checked:bg-navy-900 peer-disabled:opacity-60" />
                  <span className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                </label>
              </div>
              <div className="rounded-md bg-subtle px-3 py-2 text-[12px]">
                <p className="truncate font-medium text-ink"><Mail size={12} className="mr-1 inline text-faint" />{r.subject}</p>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-muted">{r.body}</p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
                <span>{audienceLabel(r)} · {st ? `${st.count} enviados · último ${formatTimestamp(st.last, tenant.timezone)}` : 'Sin envíos aún'}</span>
                {canWrite && (
                  <span className="flex gap-1">
                    <Button size="sm" onClick={() => { const { id: _i, created_at: _c, ...input } = r; void _i; void _c; setEditing({ rule: r, input }) }}><Pencil size={13} /> Editar</Button>
                    <Button size="sm" onClick={() => { const { id: _i, created_at: _c, ...input } = r; void _i; void _c; setEditing({ rule: null, input: { ...input, name: `${r.name} (copia)`, active: false } }) }} title="Duplicar"><Copy size={13} /></Button>
                    <Button size="sm" title="Eliminar" onClick={async () => { if (!window.confirm(`¿Eliminar "${r.name}"? El historial de envíos se conserva.`)) return; try { await m.deleteRule.mutateAsync(r.id) } catch (err) { setError(errorMessage(err)) } }}><Trash2 size={13} className="text-bad" /></Button>
                  </span>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {editing && <RuleEditor key={editing.rule?.id ?? 'new'} rule={editing.rule} initial={editing.input} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RuleEditor({ rule, initial, onClose }: { rule: CollectionRule | null; initial: CollectionRuleInput; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const counterparties = useCounterparties()
  const m = useCollectionMutations()
  const [form, setForm] = useState<CollectionRuleInput>(initial)
  const [tagsText, setTagsText] = useState(initial.audience_tags.join(', '))
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState<'subject' | 'body'>('body')
  const [blocks, setBlocks] = useState(() => withIds(blocksOf(initial)))
  const insertInText = useRef<((text: string) => void) | null>(null)
  const subjectRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof CollectionRuleInput>(k: K, v: CollectionRuleInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const customers = (counterparties.data ?? []).filter((c) => c.is_customer).sort((a, b) => a.name.localeCompare(b.name))
  const perDocument = ['before_due', 'on_due', 'after_due', 'new_document', 'manual'].includes(form.trigger)
  const plainBody = blocksToPlain(withoutIds(blocks))
  const unknown = unknownVariables(`${form.subject} ${plainBody}`)
  const docOnlyUsed = !perDocument ? TEMPLATE_VARIABLES.filter((v) => v.docOnly && new RegExp(`\\{\\{\\s*${v.key}\\s*\\}\\}`).test(`${form.subject} ${plainBody}`)) : []
  const hasButton = blocks.some((b) => b.type === 'button')

  function insert(key: string) {
    const token = `{{${key}}}`
    if (focus === 'body') {
      if (insertInText.current) return insertInText.current(token)
      // Sin un texto con foco: se agrega al último bloque de texto.
      const last = [...blocks].reverse().find((b) => b.type === 'text')
      if (last && last.type === 'text') setBlocks(blocks.map((b) => (b.id === last.id && b.type === 'text' ? { ...b, html: `${b.html}<p>${token}</p>` } : b)))
      return
    }
    const el = subjectRef.current
    const value = form.subject
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    set('subject', `${value.slice(0, start)}${token}${value.slice(end)}`)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  // Vista previa exacta (la arma el servidor), 500 ms después del último cambio.
  const draft = JSON.stringify({ subject: form.subject, blocks: withoutIds(blocks), trigger: form.trigger, includePaymentLink: form.include_payment_link })
  const [debounced, setDebounced] = useState(draft)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft), 500)
    return () => clearTimeout(t)
  }, [draft])
  const preview = useQuery({
    queryKey: ['template-preview', tenant.id, debounced],
    queryFn: () => api.previewTemplate(tenant.id, JSON.parse(debounced)),
    placeholderData: (prev) => prev,
  })

  async function submit() {
    setError(null)
    if (!form.name.trim()) return setError('Ponle un nombre al recordatorio')
    if (!form.subject.trim()) return setError('Completa el asunto')
    if (!plainBody.trim() && !blocks.length) return setError('Agrega al menos un bloque al correo')
    if (unknown.length) return setError(`Variables desconocidas: ${unknown.map((u) => `{{${u}}}`).join(', ')}`)
    const audience_tags = [...new Set(tagsText.split(',').map((t) => t.trim()).filter(Boolean))]
    if (form.audience === 'tags' && !audience_tags.length) return setError('Indica al menos una etiqueta')
    if (form.audience === 'selected' && !form.audience_ids.length) return setError('Elige al menos un cliente')
    try {
      await m.saveRule.mutateAsync({
        input: {
          ...form,
          name: form.name.trim(),
          subject: form.subject.trim(),
          blocks: withoutIds(blocks),
          body: (plainBody || form.subject.trim()).slice(0, 5000),
          include_documents: blocks.some((b) => b.type === 'documents'),
          offset_days: form.trigger === 'before_due' || form.trigger === 'after_due' ? Math.max(0, Math.min(365, Math.round(form.offset_days))) : 0,
          weekday: form.trigger === 'statement' ? form.weekday ?? 1 : null,
          audience_tags: form.audience === 'tags' ? audience_tags : [],
          audience_ids: form.audience === 'selected' ? form.audience_ids : [],
        },
        id: rule?.id,
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Drawer
      open
      width="xl"
      title={rule ? `Editar · ${rule.name}` : 'Nuevo recordatorio'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={m.saveRule.isPending}>{m.saveRule.isPending ? 'Guardando…' : 'Guardar recordatorio'}</Button></>}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <FormError error={error} />
          <Field label="Nombre">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ej: Aviso 3 días antes" autoFocus />}</Field>

          <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <h4 className="text-[12px] font-semibold tracking-wide text-faint uppercase">Cuándo se envía</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TRIGGERS.map((t) => (
                <label key={t.key} className={cn('flex cursor-pointer gap-2 rounded-md border px-2.5 py-2', form.trigger === t.key ? 'border-navy-900 bg-head' : 'border-line hover:bg-subtle')}>
                  <input type="radio" name="trigger" checked={form.trigger === t.key} onChange={() => set('trigger', t.key)} className="mt-0.5 accent-navy-900" />
                  <span><span className="block text-[13px] font-medium text-ink">{t.label}</span><span className="block text-[11px] text-muted">{t.hint}</span></span>
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {(form.trigger === 'before_due' || form.trigger === 'after_due') && (
                <Field label="Días">{(id) => <Input id={id} inputMode="numeric" value={String(form.offset_days)} onChange={(e) => set('offset_days', Number(e.target.value.replace(/\D/g, '') || 0))} />}</Field>
              )}
              {form.trigger === 'statement' && (
                <Field label="Día">
                  {(id) => (
                    <Select id={id} value={String(form.weekday ?? 1)} onChange={(e) => set('weekday', Number(e.target.value))}>
                      {WEEKDAY_LABEL.map((d, i) => <option key={d} value={i}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
                    </Select>
                  )}
                </Field>
              )}
              {!['new_document', 'manual'].includes(form.trigger) && (
                <Field label="Hora">
                  {(id) => (
                    <Select id={id} value={String(form.send_hour)} onChange={(e) => set('send_hour', Number(e.target.value))}>
                      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </div>
            <p className="text-[12px] text-muted">{ruleWhen(form)}</p>
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <h4 className="text-[12px] font-semibold tracking-wide text-faint uppercase">A quién</h4>
            <div className="inline-flex self-start rounded-lg bg-subtle p-0.5 text-[12px]">
              {([['all', 'Todos los clientes'], ['tags', 'Por etiqueta'], ['selected', 'Clientes elegidos']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => set('audience', k)} className={cn('rounded-md px-2.5 py-1', form.audience === k ? 'bg-white font-medium text-ink shadow-xs' : 'text-muted hover:text-ink')}>{label}</button>
              ))}
            </div>
            {form.audience === 'tags' && <Field label="Etiquetas" hint="Separadas por coma. Se define en la ficha de cada cliente.">{(id) => <Input id={id} value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="VIP, Medios" />}</Field>}
            {form.audience === 'selected' && (
              <div className="max-h-44 overflow-y-auto rounded-md border border-line">
                {customers.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-0">
                    <input type="checkbox" className="accent-navy-900" checked={form.audience_ids.includes(c.id)} onChange={(e) => set('audience_ids', e.target.checked ? [...form.audience_ids, c.id] : form.audience_ids.filter((x) => x !== c.id))} />
                    {c.name}
                  </label>
                ))}
                {!customers.length && <p className="px-3 py-2 text-[12px] text-faint">Sin clientes.</p>}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <h4 className="text-[12px] font-semibold tracking-wide text-faint uppercase">Correo</h4>
            <Field label="Asunto">{(id) => <Input id={id} ref={subjectRef} value={form.subject} onFocus={() => setFocus('subject')} onChange={(e) => set('subject', e.target.value)} maxLength={200} />}</Field>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink">Contenido</span>
                <span className="text-[11px] text-faint">Arrastra los bloques para ordenarlos</span>
              </div>
              <EmailBlocksEditor
                blocks={blocks}
                onChange={setBlocks}
                perDocument={perDocument}
                onTextFocus={(fn) => { insertInText.current = fn; setFocus('body') }}
              />
            </div>
            <div>
              <p className="mb-1.5 text-[11px] text-muted">Insertar variable en el {focus === 'subject' ? 'asunto' : 'texto'} (donde está el cursor):</p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES.filter((v) => perDocument || !v.docOnly).map((v) => (
                  <button key={v.key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v.key)} className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] text-ink hover:border-navy-900/40 hover:bg-subtle">{v.label}</button>
                ))}
              </div>
              {docOnlyUsed.length > 0 && <p className="mt-2 text-[11px] text-warn">En el resumen semanal no hay un documento específico: {docOnlyUsed.map((v) => v.label.toLowerCase()).join(', ')} quedarán sin reemplazar.</p>}
            </div>
            {perDocument && hasButton && <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="accent-navy-900" checked={form.include_payment_link} onChange={(e) => set('include_payment_link', e.target.checked)} /> El botón cobra con MercadoPago ("Pagar $saldo"); si no, lleva al portal</label>}
            <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" className="accent-navy-900" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Recordatorio activo</label>
          </section>
        </div>

        <aside className="min-w-0">
          <div className="sticky top-0 flex flex-col gap-2">
            <p className="text-[12px] font-semibold tracking-wide text-faint uppercase">Vista previa</p>
            <div className="overflow-hidden rounded-xl border border-line bg-subtle">
              <div className="border-b border-line bg-white px-3 py-2 text-[12px] text-muted">
                <p>De: <span className="text-ink">{tenant.name} &lt;avisos@finanzas.produ.cl&gt;</span></p>
                <p>Asunto: <span className="font-medium text-ink">{preview.data?.subject ?? '—'}</span></p>
              </div>
              {preview.error
                ? <p className="p-3 text-sm text-bad">{errorMessage(preview.error)}</p>
                : preview.data
                  ? <iframe title="Vista previa del correo" sandbox="" srcDoc={preview.data.html} className={cn('h-[620px] w-full bg-white transition-opacity', preview.isFetching && 'opacity-70')} />
                  : <p className="p-3 text-sm text-faint">Armando la vista previa…</p>}
            </div>
            <p className="text-[11px] text-faint">Así se verá el correo, con datos de ejemplo. Al enviar se usan los del cliente y del documento.</p>
          </div>
        </aside>
      </div>
    </Drawer>
  )
}
