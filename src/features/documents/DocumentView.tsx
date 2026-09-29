// Página de detalle de un documento (CxP y CxC): encabezado con acciones, actividad
// (notas internas y mensajes con la contraparte), detalles, archivos, pagos/cobros
// y asignación contable.
import {
  ArrowLeft,
  Banknote,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  FileDown,
  Globe,
  Link2,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Split,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useCategories,
  useCommentMutations,
  useComments,
  useCostCenters,
  useCreatePaymentLink,
  useDocumentAllocations,
  useDocuments,
  useIntegration,
  usePayments,
  usePortalAccess,
  useSaveDocument,
  useSetApproval,
  useSetDocumentAllocations,
  useSetPaymentStage,
  useUploadAttachment,
} from '../../app/queries'
import { useSession } from '../../app/session'
import { useCurrentTenant } from '../../app/tenant'
import type { AllocationLine, DocumentInput, DocumentRow } from '../../data'
import { formatDate, formatTimestamp } from '../../domain/dates'
import { documentTypeLabel, TAX_LABEL } from '../../domain/documents'
import { formatMoney } from '../../domain/money'
import { formatTaxId } from '../../domain/taxId'
import { Badge, Button, cn, Drawer, EmptyState, Field, FormError, Input, Textarea } from '../../ui'
import { RowAction } from '../../ui/list'
import { PaymentDrawer } from '../payments/PaymentsPage'
import { errorMessage, minorToInput, Money, parseMoneyInput, StatusBadge } from '../shared'
import { AttachmentsPanel, DocumentDrawer, sectionCopy, useDocumentActions } from './DocumentsPage'
import { readDocumentOrder } from './documentOrder'

function Card({ title, actions, children, className }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-line bg-white', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
}

export function DocumentView({ direction }: { direction: 'payable' | 'receivable' }) {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const copy = sectionCopy(direction)
  const documents = useDocuments(direction)
  const listPath = `${copy.base}/documentos`

  const all = documents.data ?? []
  const doc = all.find((d) => d.id === id)
  const order = useMemo(() => {
    const saved = readDocumentOrder(direction)?.filter((x) => all.some((d) => d.id === x))
    return saved?.includes(id) ? saved : all.map((d) => d.id)
  }, [all, direction, id])
  const index = order.indexOf(id)

  if (documents.isLoading) return <div className="py-20 text-center text-sm text-faint">Cargando documento…</div>
  if (!doc) {
    return (
      <EmptyState
        title="Documento no encontrado"
        description="Puede que haya sido eliminado."
        action={<Button onClick={() => navigate(listPath)}>Volver a documentos</Button>}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate(listPath)} aria-label="Volver a la lista" className="-ml-2"><ArrowLeft size={16} /> <span className="hidden sm:inline">{copy.title}</span></Button>
        <div className="ml-auto flex items-center gap-1 text-sm text-muted">
          {index >= 0 && <span className="mr-1 tabular">{index + 1} de {order.length}</span>}
          <Button size="sm" disabled={index <= 0} onClick={() => navigate(`${listPath}/${order[index - 1]}`)} aria-label="Documento anterior"><ChevronLeft size={16} /><span className="hidden sm:inline">Anterior</span></Button>
          <Button size="sm" disabled={index < 0 || index >= order.length - 1} onClick={() => navigate(`${listPath}/${order[index + 1]}`)} aria-label="Documento siguiente"><span className="hidden sm:inline">Siguiente</span><ChevronRight size={16} /></Button>
        </div>
      </div>
      <DocumentWorkspace key={doc.id} doc={doc} documents={all} onDeleted={() => navigate(listPath)} />
    </div>
  )
}

function DocumentWorkspace({ doc, documents, onDeleted }: { doc: DocumentRow; documents: DocumentRow[]; onDeleted: () => void }) {
  const { canWrite } = useCurrentTenant()
  const copy = sectionCopy(doc.direction)
  const isPayable = doc.direction === 'payable'
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const approval = useSetApproval()
  const actions = useDocumentActions(setError)
  const integration = useIntegration('mercadopago')
  const createLink = useCreatePaymentLink()
  const [link, setLink] = useState<string | null>(null)
  const isVoid = doc.status === 'void'
  const canPay = canWrite && doc.pending_amount > 0 && doc.approval_status !== 'rejected'

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])

  async function approve() {
    setError(null)
    try {
      await approval.mutateAsync({ id: doc.id, status: 'approved' })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function resetApproval() {
    setError(null)
    try {
      await approval.mutateAsync({ id: doc.id, status: 'pending' })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function generateLink() {
    setError(null)
    try {
      const res = await createLink.mutateAsync(doc.id)
      setLink(res.url)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const menuItems: { label: string; icon: React.ReactNode; onClick: () => void; tone?: 'danger'; hidden?: boolean }[] = [
    { label: 'Descargar ficha PDF', icon: <FileDown size={16} />, onClick: () => actions.downloadPdf(doc) },
    { label: 'Editar documento', icon: <Pencil size={16} />, onClick: () => setEditing(true), hidden: !canWrite || isVoid },
    { label: 'Volver a pendiente de aprobación', icon: <RotateCcw size={16} />, onClick: resetApproval, hidden: !canWrite || !isPayable || doc.approval_status === 'pending' || doc.paid_amount > 0 },
    { label: doc.paid_amount > 0 || doc.credits_amount > 0 ? 'Anular documento' : 'Eliminar documento', icon: <Trash2 size={16} />, tone: 'danger', onClick: async () => (await actions.remove(doc)) && (doc.paid_amount > 0 || doc.credits_amount > 0 ? undefined : onDeleted()), hidden: !canWrite || (isVoid && doc.paid_amount > 0) },
  ]

  return (
    <>
      {/* Encabezado */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-white px-4 py-3">
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-full bg-head text-sm font-semibold text-navy-900 sm:flex">{initials(doc.counterparty_name) || '?'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
            <h1 className="truncate text-[14px] font-semibold text-ink">{doc.counterparty_name}</h1>
            <span className="truncate text-xs text-faint">{documentTypeLabel(doc.doc_type)} N° {doc.folio}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold tracking-tight text-ink"><span className="mr-1 text-xs font-medium text-muted">{doc.currency}</span><Money minor={doc.total_amount} currency={doc.currency} /></span>
            <StatusBadge status={doc.payment_status} daysOverdue={doc.days_overdue} />
            {isPayable && !isVoid && <ApprovalBadge doc={doc} />}
          </div>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto [&>button]:flex-1 sm:[&>button]:flex-none">
          {isPayable && canWrite && !isVoid && doc.approval_status === 'pending' && (
            <>
              <Button variant="danger" onClick={() => setRejecting(true)}><CircleX size={16} /> Rechazar</Button>
              <Button variant="primary" onClick={approve} disabled={approval.isPending}><CircleCheck size={16} /> Aprobar</Button>
            </>
          )}
          {!isPayable && canWrite && doc.pending_amount > 0 && integration.data?.status === 'active' && (
            <Button onClick={generateLink} disabled={createLink.isPending}><Link2 size={16} /> {createLink.isPending ? 'Generando…' : 'Link de pago'}</Button>
          )}
          {canPay && (!isPayable || doc.approval_status === 'approved') && (
            <Button variant="primary" onClick={() => setPaying(true)}><Banknote size={16} /> {copy.pay}</Button>
          )}
          <div className="relative">
            <button
              type="button"
              aria-label="Más acciones"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((o) => !o)
              }}
              className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
            >
              <MoreVertical size={18} />
            </button>
            {menuOpen && (
              <div className="absolute top-full right-0 z-30 mt-1 min-w-60 rounded-lg border border-line bg-white p-1 shadow-xl">
                {menuItems.filter((m) => !m.hidden).map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      m.onClick()
                    }}
                    className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm', m.tone === 'danger' ? 'text-bad hover:bg-bad-bg' : 'text-ink hover:bg-subtle')}
                  >
                    {m.icon} {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {doc.approval_status === 'rejected' && doc.rejection_reason && (
          <p className="w-full rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
            <b>Rechazado:</b> {doc.rejection_reason}
          </p>
        )}
        {isPayable && doc.approval_status === 'pending' && doc.pending_amount > 0 && !isVoid && (
          <p className="w-full rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">Apruébalo para poder registrar su pago.</p>
        )}
        {link && (
          <div className="flex w-full items-center gap-2">
            <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" onClick={() => navigator.clipboard?.writeText(link)}>Copiar</Button>
          </div>
        )}
      </section>
      <FormError error={error} />

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="order-2 min-w-0 lg:order-1 lg:col-span-4">
          <ActivityPanel doc={doc} />
        </div>
        <div className="order-1 flex min-w-0 flex-col gap-5 lg:order-2 lg:col-span-8">
          <div className="grid gap-5 xl:grid-cols-5">
            <DetailsCard doc={doc} className="xl:col-span-3" onEdit={canWrite && !isVoid ? () => setEditing(true) : undefined} />
            <FilesCard doc={doc} className="xl:col-span-2" onError={setError} />
          </div>
          <PaymentsCard doc={doc} onPay={canPay && (!isPayable || doc.approval_status === 'approved') ? () => setPaying(true) : undefined} />
          <AllocationCard doc={doc} />
        </div>
      </div>

      <DocumentDrawer key={editing ? 'edit' : 'closed'} open={editing} direction={doc.direction} doc={doc} documents={documents} onClose={() => setEditing(false)} />
      {paying && <PaymentDrawer open direction={isPayable ? 'out' : 'in'} presets={[doc]} onClose={() => setPaying(false)} />}
      {rejecting && (
        <RejectDrawer
          onClose={() => setRejecting(false)}
          onConfirm={async (reason) => {
            await approval.mutateAsync({ id: doc.id, status: 'rejected', reason })
            setRejecting(false)
          }}
        />
      )}
    </>
  )
}

function ApprovalBadge({ doc }: { doc: DocumentRow }) {
  const { tenant } = useCurrentTenant()
  if (doc.approval_status === 'approved') {
    return (
      <span title={doc.approved_at ? `Aprobado el ${formatTimestamp(doc.approved_at, tenant.timezone)}` : undefined}>
        <Badge tone="solid"><Check size={13} className="mr-1" /> Aprobado</Badge>
      </span>
    )
  }
  if (doc.approval_status === 'rejected') return <Badge tone="bad">Rechazado</Badge>
  return <Badge tone="warn">Por aprobar</Badge>
}

function RejectDrawer({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const QUICK = ['Monto no corresponde', 'Falta orden de compra', 'Servicio no recibido', 'Documento duplicado', 'Datos del emisor incorrectos']
  return (
    <Drawer
      open
      title="Rechazar documento"
      subtitle="El motivo queda registrado y el documento no se podrá pagar mientras esté rechazado."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="danger"
            disabled={loading || !reason.trim()}
            onClick={async () => {
              setError(null)
              setLoading(true)
              try {
                await onConfirm(reason.trim())
              } catch (err) {
                setError(errorMessage(err))
              } finally {
                setLoading(false)
              }
            }}
          >
            <CircleX size={16} /> Rechazar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <button key={q} type="button" onClick={() => setReason(q)} className={cn('rounded-full border px-3 py-1 text-sm', reason === q ? 'border-navy-900 bg-head text-ink' : 'border-line text-muted hover:bg-subtle')}>
              {q}
            </button>
          ))}
        </div>
        <Field label="Motivo">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={500} />}</Field>
      </div>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Actividad: notas internas, mensajes a la contraparte y eventos
// ---------------------------------------------------------------------------
interface TimelineItem {
  id: string
  at: string
  kind: 'internal' | 'shared-out' | 'shared-in' | 'event'
  author: string
  body: string
  canDelete?: boolean
}

function ActivityPanel({ doc }: { doc: DocumentRow }) {
  const { tenant, canAdmin } = useCurrentTenant()
  const { session } = useSession()
  const comments = useComments(doc.id)
  const payments = usePayments(doc.direction === 'payable' ? 'out' : 'in')
  const portal = usePortalAccess()
  const { add, remove } = useCommentMutations(doc.id)
  const [mode, setMode] = useState<'internal' | 'shared'>('internal')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const counterpartyWord = doc.direction === 'payable' ? 'proveedor' : 'cliente'
  const hasPortal = tenant.portal_enabled && (portal.data ?? []).some((a) => a.counterparty_id === doc.counterparty_id && a.enabled)
  const endRef = useRef<HTMLDivElement>(null)

  const items = useMemo<TimelineItem[]>(() => {
    const list: TimelineItem[] = [
      { id: 'created', at: doc.created_at, kind: 'event', author: 'Sistema', body: `Documento registrado por ${formatMoney(doc.total_amount, doc.currency)}.` },
    ]
    if (doc.approved_at && doc.approval_status !== 'pending') {
      list.push({
        id: 'approval',
        at: doc.approved_at,
        kind: 'event',
        author: 'Aprobación',
        body: doc.approval_status === 'approved' ? 'Documento aprobado para pago.' : `Documento rechazado: ${doc.rejection_reason ?? ''}`,
      })
    }
    for (const p of payments.data ?? []) {
      const alloc = p.allocations.find((a) => a.document_id === doc.id)
      if (!alloc || p.status !== 'confirmed') continue
      list.push({
        id: `pay-${p.id}`,
        at: p.created_at ?? `${p.paid_on}T12:00:00Z`,
        kind: 'event',
        author: doc.direction === 'payable' ? 'Pago' : 'Cobro',
        body: `${doc.direction === 'payable' ? 'Pago' : 'Cobro'} de ${formatMoney(alloc.amount, p.currency)} con fecha ${formatDate(p.paid_on)} (${p.method.startsWith('mercadopago') ? 'MercadoPago' : p.method}${p.reference ? ` · ${p.reference}` : ''}).`,
      })
    }
    for (const c of comments.data ?? []) {
      list.push({
        id: c.id,
        at: c.created_at,
        kind: c.visibility === 'internal' ? 'internal' : c.author_kind === 'counterparty' ? 'shared-in' : 'shared-out',
        author: c.author_name || (c.author_kind === 'counterparty' ? counterpartyWord : 'Equipo'),
        body: c.body,
        canDelete: c.author_kind === 'member' && (c.author_id === session?.userId || canAdmin),
      })
    }
    return list.sort((a, b) => a.at.localeCompare(b.at))
  }, [doc, payments.data, comments.data, counterpartyWord, session?.userId, canAdmin])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [items.length])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setError(null)
    try {
      await add.mutateAsync({ body, visibility: mode })
      setBody('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="flex h-full min-h-96 flex-col rounded-xl border border-line bg-white">
      <div className="flex overflow-x-auto border-b border-line px-2 pt-2">
        {([
          ['internal', 'Nota interna', <Lock key="i" size={15} />],
          ['shared', `Mensaje al ${counterpartyWord}`, <Globe key="g" size={15} />],
        ] as const).map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={cn('-mb-px flex min-w-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap', mode === key ? 'border-brand-600 font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}
          >
            {icon} {label}
          </button>
        ))}
      </div>
      <form onSubmit={send} className="border-b border-line p-3">
        <div className={cn('flex items-end gap-2 rounded-lg border p-2', mode === 'shared' ? 'border-brand-600/30 bg-brand-50/40' : 'border-line')}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e)
            }}
            rows={2}
            maxLength={4000}
            placeholder={mode === 'internal' ? 'Escribe una nota para tu equipo…' : `Escribe un mensaje al ${counterpartyWord}…`}
            className="min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-faint focus:outline-none"
            aria-label={mode === 'internal' ? 'Nota interna' : `Mensaje al ${counterpartyWord}`}
          />
          <button type="submit" disabled={!body.trim() || add.isPending} aria-label="Enviar" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-navy-900 text-white hover:bg-navy-800 disabled:opacity-40">
            <Send size={16} />
          </button>
        </div>
        <p className="mt-1.5 text-xs text-faint">
          {mode === 'internal'
            ? 'Solo la ve tu equipo.'
            : hasPortal
              ? `El ${counterpartyWord} lo verá en su portal financiero y podrá responder.`
              : `El ${counterpartyWord} aún no tiene acceso al portal: dáselo en Configuración › Portal financiero para que pueda verlo.`}
        </p>
        <FormError error={error} />
      </form>
      <ol className="flex-1 space-y-4 overflow-y-auto p-4" aria-label="Actividad">
        {items.map((item) => (
          <li key={item.id} className={cn('flex flex-col gap-1', item.kind === 'shared-in' && 'items-start', item.kind === 'shared-out' && 'items-end')}>
            <div className="flex items-center gap-2 text-xs text-faint">
              {item.kind === 'internal' && <Lock size={12} />}
              {(item.kind === 'shared-in' || item.kind === 'shared-out') && <Globe size={12} />}
              <span className="font-medium text-muted">{item.author}</span>
              <span>{formatTimestamp(item.at, tenant.timezone)}</span>
              {item.canDelete && (
                <button type="button" onClick={() => window.confirm('¿Eliminar este mensaje?') && remove.mutate(item.id)} className="text-faint hover:text-bad" aria-label="Eliminar mensaje">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            <p
              className={cn(
                'max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                item.kind === 'event' && 'w-full bg-subtle text-muted',
                item.kind === 'internal' && 'w-full bg-warn-bg/60 text-ink',
                item.kind === 'shared-out' && 'bg-navy-900 text-white',
                item.kind === 'shared-in' && 'border border-line bg-white text-ink',
              )}
            >
              {item.body}
            </p>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Detalles y archivos
// ---------------------------------------------------------------------------
function DetailsCard({ doc, className, onEdit }: { doc: DocumentRow; className?: string; onEdit?: () => void }) {
  const { tenant } = useCurrentTenant()
  const rows: [string, React.ReactNode][] = [
    ['Tipo de documento', documentTypeLabel(doc.doc_type)],
    ['Folio', doc.folio],
    [doc.direction === 'payable' ? 'Proveedor' : 'Cliente', <span key="cp">{doc.counterparty_name}{doc.counterparty_tax_id && <span className="block text-xs text-faint">{formatTaxId(doc.counterparty_tax_id, tenant.country)}</span>}</span>],
    ['Fecha de emisión', formatDate(doc.issue_date)],
    ['Fecha de vencimiento', formatDate(doc.due_date)],
  ]
  if (doc.purchase_order_id) {
    rows.push([
      'Orden de compra',
      <Link key="po" to={`${doc.direction === 'payable' ? '/cxp' : '/cxc'}/ordenes?id=${doc.purchase_order_id}`} className="font-medium text-brand-600 hover:underline">
        N° {doc.purchase_order_number}
      </Link>,
    ])
  }
  if (doc.net_amount) rows.push(['Neto', <Money key="n" minor={doc.net_amount} currency={doc.currency} />])
  if (doc.exempt_amount) rows.push(['Exento', <Money key="e" minor={doc.exempt_amount} currency={doc.currency} />])
  if (doc.tax_amount) rows.push([TAX_LABEL[tenant.country], <Money key="t" minor={doc.tax_amount} currency={doc.currency} />])
  if (doc.detraction_amount) rows.push([`Detracción ${doc.detraction_rate}%`, <span key="d"><Money minor={doc.detraction_amount} currency={doc.currency} /> <span className="text-xs text-faint">({doc.detraction_status})</span></span>])
  rows.push(['Glosa', doc.description ? <span key="g" className="whitespace-pre-wrap">{doc.description}</span> : <span key="g" className="text-faint">Sin información</span>])
  return (
    <Card title="Detalles del documento" className={className} actions={onEdit && <RowAction label="Editar documento" onClick={onEdit}><Pencil size={16} /></RowAction>}>
      <dl className="-my-2 divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6 py-2 text-[12px]">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function FilesCard({ doc, className, onError }: { doc: DocumentRow; className?: string; onError: (m: string | null) => void }) {
  const { canWrite } = useCurrentTenant()
  const upload = useUploadAttachment()
  const inputRef = useRef<HTMLInputElement>(null)
  const editable = canWrite && doc.status !== 'void'
  async function onFiles(files: FileList | null) {
    if (!files) return
    onError(null)
    try {
      for (const file of Array.from(files)) await upload.mutateAsync({ documentId: doc.id, file })
    } catch (err) {
      onError(errorMessage(err))
    }
  }
  return (
    <Card
      title="Documentos adjuntos"
      className={className}
      actions={
        editable && (
          <>
            <RowAction label="Subir archivo" onClick={() => inputRef.current?.click()}>
              <Upload size={16} />
            </RowAction>
            <input ref={inputRef} type="file" multiple className="sr-only" onChange={(e) => onFiles(e.target.files)} />
          </>
        )
      }
    >
      <div
        onDragOver={(e) => editable && e.preventDefault()}
        onDrop={(e) => {
          if (!editable) return
          e.preventDefault()
          onFiles(e.dataTransfer.files)
        }}
      >
        {upload.isPending && <p className="mb-2 text-xs text-muted">Subiendo…</p>}
        <AttachmentsPanel documentId={doc.id} editable={editable} onError={onError} />
        {editable && <p className="mt-2 text-xs text-faint">Arrastra archivos aquí o usa el ícono de subir.</p>}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Pagos / cobros
// ---------------------------------------------------------------------------
const MANAGEMENT_STEPS = [
  { key: 'approved', label: 'Aprobado' },
  { key: 'requested', label: 'Pago solicitado' },
  { key: 'scheduled', label: 'Pago programado' },
  { key: 'paid', label: 'Pago realizado' },
] as const

function ManagementStepper({ doc, onError }: { doc: DocumentRow; onError: (m: string | null) => void }) {
  const { canWrite } = useCurrentTenant()
  const stage = useSetPaymentStage()
  const current = doc.payment_management === 'paid' ? 3 : doc.payment_management === 'scheduled' ? 2 : doc.payment_management === 'requested' ? 1 : doc.approval_status === 'approved' ? 0 : -1
  const run = async (fn: () => Promise<unknown>) => {
    onError(null)
    try {
      await fn()
    } catch (err) {
      onError(errorMessage(err))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <ol className="grid grid-cols-4 gap-1" aria-label="Gestión de pago">
        {MANAGEMENT_STEPS.map((step, i) => (
          <li key={step.key} className="flex flex-col gap-1">
            <span className={cn('h-1.5 rounded-full', i <= current ? (current === 3 ? 'bg-ok' : 'bg-brand-500') : 'bg-subtle')} />
            <span className={cn('text-[11px]', i === current ? 'font-semibold text-ink' : i < current ? 'text-muted' : 'text-faint')}>
              {step.label}
              {step.key === 'scheduled' && doc.scheduled_payment_date && i <= current && current < 3 ? ` · ${formatDate(doc.scheduled_payment_date)}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {canWrite && doc.status === 'open' && current >= 0 && current < 3 && (
        <div className="flex flex-wrap gap-1.5">
          {current === 0 && <Button size="sm" onClick={() => run(() => stage.mutateAsync({ id: doc.id, stage: 'requested' }))}><Send size={13} /> Solicitar pago</Button>}
          {current >= 1 && <Button size="sm" variant="ghost" onClick={() => run(() => stage.mutateAsync({ id: doc.id, stage: current === 2 ? 'requested' : null }))}><RotateCcw size={13} /> {current === 2 ? 'Quitar programación' : 'Quitar solicitud'}</Button>}
        </div>
      )}
      {current === -1 && doc.approval_status === 'pending' && <p className="text-[11px] text-warn">Aprueba el documento para gestionar su pago.</p>}
    </div>
  )
}

function PaymentsCard({ doc, onPay }: { doc: DocumentRow; onPay?: () => void }) {
  const { canWrite } = useCurrentTenant()
  const isPayable = doc.direction === 'payable'
  const payments = usePayments(isPayable ? 'out' : 'in')
  const save = useSaveDocument()
  const stage = useSetPaymentStage()
  const [editingDate, setEditingDate] = useState(false)
  const [date, setDate] = useState(doc.scheduled_payment_date ?? '')
  const [error, setError] = useState<string | null>(null)
  const related = (payments.data ?? []).filter((p) => p.status === 'confirmed' && p.allocations.some((a) => a.document_id === doc.id))
  const payable = Math.max(0, doc.net_total - doc.detraction_amount)
  const pct = payable ? Math.min(100, Math.round((doc.paid_amount / payable) * 100)) : 100

  async function saveDate() {
    setError(null)
    const input: DocumentInput = {
      direction: doc.direction, counterparty_id: doc.counterparty_id, doc_type: doc.doc_type, folio: doc.folio, currency: doc.currency,
      net_amount: doc.net_amount, exempt_amount: doc.exempt_amount, tax_amount: doc.tax_amount, total_amount: doc.total_amount,
      issue_date: doc.issue_date, due_date: doc.due_date, status: doc.status, applies_to_id: doc.applies_to_id,
      detraction_rate: doc.detraction_rate, detraction_amount: doc.detraction_amount, detraction_status: doc.detraction_status,
      description: doc.description, scheduled_payment_date: date || null, purchase_order_id: doc.purchase_order_id,
    }
    try {
      // En CxP aprobadas, fijar la fecha deja el pago como programado.
      if (isPayable && doc.approval_status === 'approved' && date) await stage.mutateAsync({ id: doc.id, stage: 'scheduled', scheduledDate: date })
      else await save.mutateAsync({ input, id: doc.id })
      setEditingDate(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Card
      title={isPayable ? 'Pago' : 'Cobro'}
      actions={
        onPay && (
          <>
            <Button size="sm" variant="ghost" onClick={onPay}><Plus size={15} /> Registrar abono</Button>
            <Button size="sm" onClick={onPay}><Check size={15} /> {isPayable ? 'Marcar como pagada' : 'Marcar como cobrada'}</Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        {isPayable && doc.status === 'open' && doc.doc_type !== 'nota_credito' && <ManagementStepper doc={doc} onError={setError} />}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted">{isPayable ? 'Pagado' : 'Cobrado'}</div>
            <div className="text-lg font-semibold text-ink"><Money minor={doc.paid_amount} currency={doc.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{isPayable ? 'Saldo por pagar' : 'Saldo por cobrar'}</div>
            <div className={cn('text-lg font-semibold', doc.pending_amount ? 'text-ink' : 'text-ok')}><Money minor={doc.pending_amount} currency={doc.currency} /></div>
          </div>
          <div>
            <div className="text-xs text-muted">{isPayable ? 'Pago programado' : 'Cobro comprometido'}</div>
            {editingDate ? (
              <div className="mt-0.5 flex items-center gap-1">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8" aria-label="Fecha agendada" />
                <Button size="sm" variant="primary" onClick={saveDate} disabled={save.isPending}>OK</Button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!canWrite || doc.pending_amount === 0}
                onClick={() => setEditingDate(true)}
                className="group mt-0.5 inline-flex items-center gap-1.5 text-lg font-semibold text-ink disabled:cursor-default"
              >
                <CalendarClock size={17} className="text-brand-600" />
                {doc.scheduled_payment_date ? formatDate(doc.scheduled_payment_date) : <span className="text-sm font-normal text-faint">Sin agendar</span>}
                {canWrite && doc.pending_amount > 0 && <Pencil size={13} className="text-faint opacity-0 group-hover:opacity-100" />}
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>{pct}% {isPayable ? 'pagado' : 'cobrado'}</span>
            <span>de <Money minor={payable} currency={doc.currency} />{doc.detraction_amount ? ' (sin detracción)' : ''}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-subtle">
            <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-ok' : 'bg-brand-500')} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {related.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-faint">
            {isPayable ? 'Aún no hay pagos ni abonos registrados.' : 'Aún no hay cobros ni abonos registrados.'}
          </p>
        ) : (
          <ol className="divide-y divide-line rounded-lg border border-line">
            {related.map((p, i) => {
              const alloc = p.allocations.find((a) => a.document_id === doc.id)!
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-[12px]">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">{i + 1}</span>
                  <span className="min-w-36 flex-1">
                    <span className="block truncate text-ink">{p.counterparty_name ?? doc.counterparty_name}</span>
                    <span className="text-xs text-faint">{isPayable ? 'Beneficiario' : 'Pagador'}</span>
                  </span>
                  <span className="min-w-28">
                    <span className="block text-ink">{formatDate(p.paid_on)}</span>
                    <span className="text-xs text-faint">{p.method.startsWith('mercadopago') ? 'MercadoPago' : p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
                  </span>
                  <span className="ml-auto text-right">
                    <Money minor={alloc.amount} currency={p.currency} className="block font-semibold text-ink" />
                    <span className="text-xs text-faint">{alloc.amount < p.amount ? `de ${formatMoney(p.amount, p.currency)}` : 'Monto'}</span>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Asignación contable
// ---------------------------------------------------------------------------
interface DraftLine {
  key: string
  category_id: string
  cost_center_id: string
  description: string
  amountText: string
}

function AllocationCard({ doc }: { doc: DocumentRow }) {
  const { canWrite } = useCurrentTenant()
  const categories = useCategories()
  const costCenters = useCostCenters()
  const allocations = useDocumentAllocations(doc.id)
  const saveLines = useSetDocumentAllocations(doc.id)
  const [editing, setEditing] = useState(false)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const base = doc.allocation_base
  const kind = doc.direction === 'payable' ? 'expense' : 'income'
  const catOptions = (categories.data ?? []).filter((c) => c.active && (c.kind === kind || c.kind === 'both'))
  const ccOptions = (costCenters.data ?? []).filter((c) => c.active)
  const catName = (id: string) => {
    const c = (categories.data ?? []).find((x) => x.id === id)
    return c ? `${c.code ? `${c.code} · ` : ''}${c.name}` : '—'
  }
  const ccName = (id: string | null) => (id ? (costCenters.data ?? []).find((x) => x.id === id)?.name ?? '—' : '—')
  const saved = allocations.data ?? []

  const newLine = (amount = 0): DraftLine => ({ key: crypto.randomUUID(), category_id: catOptions[0]?.id ?? '', cost_center_id: '', description: '', amountText: amount ? minorToInput(amount, doc.currency) : '' })

  function startEdit() {
    setError(null)
    setLines(
      saved.length
        ? saved.map((l) => ({ key: crypto.randomUUID(), category_id: l.category_id, cost_center_id: l.cost_center_id ?? '', description: l.description ?? '', amountText: minorToInput(l.amount, doc.currency) }))
        : [newLine(base)],
    )
    setEditing(true)
  }

  const amounts = lines.map((l) => parseMoneyInput(l.amountText || '0', doc.currency))
  const draftTotal = amounts.reduce<number>((s, a) => s + (a ?? 0), 0)
  const total = editing ? draftTotal : doc.allocated_amount
  const remaining = base - total
  const pctOf = (amount: number) => (base ? Math.round((amount / base) * 1000) / 10 : 0)

  function setLine(key: string, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function setPercent(key: string, text: string) {
    const pct = Number(text.replace(',', '.'))
    if (!Number.isFinite(pct)) return
    setLine(key, { amountText: minorToInput(Math.round((base * Math.min(100, Math.max(0, pct))) / 100), doc.currency) })
  }

  function splitEvenly() {
    const n = lines.length || 1
    const each = Math.floor(base / n)
    setLines((ls) => ls.map((l, i) => ({ ...l, amountText: minorToInput(i === ls.length - 1 ? base - each * (n - 1) : each, doc.currency) })))
  }

  async function save() {
    setError(null)
    if (amounts.some((a) => a === null)) return setError('Hay un monto con formato inválido')
    if (lines.some((l) => !l.category_id)) return setError('Cada línea necesita una categoría')
    if (draftTotal > base) return setError(`La distribución supera el monto a distribuir por ${formatMoney(draftTotal - base, doc.currency)}`)
    const payload: AllocationLine[] = lines
      .map((l, i) => ({ category_id: l.category_id, cost_center_id: l.cost_center_id || null, description: l.description.trim() || null, amount: amounts[i] ?? 0 }))
      .filter((l) => l.amount > 0)
    try {
      await saveLines.mutateAsync(payload)
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const header = (
    <span className="flex items-center gap-2">
      Asignación contable
      {!editing && base > 0 && (doc.allocated_amount === base ? <Badge tone="ok">Completa</Badge> : doc.allocated_amount > 0 ? <Badge tone="warn">Parcial</Badge> : <Badge>Sin asignar</Badge>)}
    </span>
  )

  return (
    <Card
      title={header}
      actions={
        canWrite && doc.status !== 'void' && !editing && (
          <Button size="sm" onClick={startEdit} disabled={!catOptions.length}><Pencil size={15} /> {saved.length ? 'Editar' : 'Asignar'}</Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Distribuye <b className="text-ink"><Money minor={base} currency={doc.currency} /></b>
          {doc.tax_amount > 0 ? ' (neto + exento, sin impuesto)' : ''} entre categorías y centros de costos.
        </p>
        <FormError error={error} />
        {!catOptions.length && <p className="text-sm text-warn">No hay categorías {kind === 'expense' ? 'de gasto' : 'de ingreso'} activas. Créalas en Configuración › Contabilidad.</p>}
        {/* Celular: líneas como tarjetas */}
        <div className="flex flex-col gap-2 md:hidden">
          {!editing && saved.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-sm text-faint">Sin distribución contable.</p>}
          {!editing &&
            saved.map((l, i) => (
              <div key={i} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium text-ink">{catName(l.category_id)}</span>
                  <Money minor={l.amount} currency={doc.currency} className="font-semibold text-ink" />
                </div>
                <div className="mt-1 text-xs text-muted">{pctOf(l.amount)}% · {ccName(l.cost_center_id)}{l.description ? ` · ${l.description}` : ''}</div>
              </div>
            ))}
          {editing &&
            lines.map((l, i) => (
              <div key={l.key} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <select aria-label="Categoría" value={l.category_id} onChange={(e) => setLine(l.key, { category_id: e.target.value })} className="h-9 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-sm">
                    {catOptions.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ''}{c.name}</option>)}
                  </select>
                  <RowAction label="Quitar línea" tone="danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 size={15} /></RowAction>
                </div>
                <select aria-label="Centro de costos" value={l.cost_center_id} onChange={(e) => setLine(l.key, { cost_center_id: e.target.value })} className="h-9 rounded-md border border-line bg-white px-2 text-sm">
                  <option value="">Sin centro de costos</option>
                  {ccOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input aria-label="Detalle" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Detalle (opcional)" className="h-9 rounded-md border border-line px-2 text-sm" />
                <div className="flex gap-2">
                  <input aria-label="Porcentaje" inputMode="decimal" key={`m-${l.key}-${l.amountText}`} defaultValue={amounts[i] !== null ? pctOf(amounts[i] ?? 0) : ''} onBlur={(e) => setPercent(l.key, e.target.value)} placeholder="%" className="h-9 w-20 rounded-md border border-line px-2 text-right text-sm tabular" />
                  <input aria-label="Monto" inputMode="decimal" value={l.amountText} onChange={(e) => setLine(l.key, { amountText: e.target.value })} placeholder="Monto" className={cn('h-9 min-w-0 flex-1 rounded-md border px-2 text-right text-sm tabular', amounts[i] === null ? 'border-bad' : 'border-line')} />
                </div>
              </div>
            ))}
        </div>

        {/* Escritorio: tabla */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-left text-[10px] font-semibold tracking-wider text-ink/70 uppercase">
                <th className="h-10 rounded-l-lg bg-head px-3">Categoría</th>
                <th className="h-10 w-20 bg-head px-3 text-right">%</th>
                <th className="h-10 bg-head px-3">Centro de costos</th>
                <th className="h-10 bg-head px-3">Detalle</th>
                <th className="h-10 bg-head px-3 text-right">Monto</th>
                <th className={cn('h-10 w-10 bg-head', 'rounded-r-lg')}><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {!editing &&
                saved.map((l, i) => (
                  <tr key={i}>
                    <td className="border-b border-line px-3 py-2.5 font-medium text-ink">{catName(l.category_id)}</td>
                    <td className="border-b border-line px-3 py-2.5 text-right tabular text-muted">{pctOf(l.amount)}%</td>
                    <td className="border-b border-line px-3 py-2.5 text-ink/80">{ccName(l.cost_center_id)}</td>
                    <td className="border-b border-line px-3 py-2.5 text-ink/80">{l.description ?? ''}</td>
                    <td className="border-b border-line px-3 py-2.5 text-right"><Money minor={l.amount} currency={doc.currency} className="text-ink" /></td>
                    <td className="border-b border-line" />
                  </tr>
                ))}
              {!editing && saved.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-faint">Sin distribución contable.</td>
                </tr>
              )}
              {editing &&
                lines.map((l, i) => (
                  <tr key={l.key}>
                    <td className="border-b border-line py-2 pr-2">
                      <select aria-label="Categoría" value={l.category_id} onChange={(e) => setLine(l.key, { category_id: e.target.value })} className="h-9 w-full min-w-44 rounded-md border border-line bg-white px-2 text-sm">
                        {catOptions.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ''}{c.name}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-line py-2 pr-2">
                      <input aria-label="Porcentaje" inputMode="decimal" key={`${l.key}-${l.amountText}`} defaultValue={amounts[i] !== null ? pctOf(amounts[i] ?? 0) : ''} onBlur={(e) => setPercent(l.key, e.target.value)} className="h-9 w-20 rounded-md border border-line px-2 text-right text-sm tabular" />
                    </td>
                    <td className="border-b border-line py-2 pr-2">
                      <select aria-label="Centro de costos" value={l.cost_center_id} onChange={(e) => setLine(l.key, { cost_center_id: e.target.value })} className="h-9 w-full min-w-36 rounded-md border border-line bg-white px-2 text-sm">
                        <option value="">Sin centro</option>
                        {ccOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-line py-2 pr-2">
                      <input aria-label="Detalle" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Opcional" className="h-9 w-full min-w-32 rounded-md border border-line px-2 text-sm" />
                    </td>
                    <td className="border-b border-line py-2 pr-2">
                      <input aria-label="Monto" inputMode="decimal" value={l.amountText} onChange={(e) => setLine(l.key, { amountText: e.target.value })} className={cn('h-9 w-32 rounded-md border px-2 text-right text-sm tabular', amounts[i] === null ? 'border-bad' : 'border-line')} />
                    </td>
                    <td className="border-b border-line py-2 text-center">
                      <RowAction label="Quitar línea" tone="danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 size={15} /></RowAction>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {editing && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, newLine(Math.max(0, remaining))])}><Split size={15} /> Agregar división</Button>
                {lines.length > 1 && <Button size="sm" variant="ghost" onClick={splitEvenly}>Repartir en partes iguales</Button>}
              </>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm">
            {remaining !== 0 && (
              <span className={remaining < 0 ? 'font-medium text-bad' : 'text-warn'}>
                {remaining < 0 ? 'Excede en ' : 'Falta asignar '}<Money minor={Math.abs(remaining)} currency={doc.currency} />
              </span>
            )}
            <span className="text-ink">Total: <Money minor={total} currency={doc.currency} className="font-semibold" /></span>
          </div>
        </div>
        {editing && (
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button onClick={() => setEditing(false)}>Cancelar</Button>
            <Button variant="primary" onClick={save} disabled={saveLines.isPending}>{saveLines.isPending ? 'Guardando…' : 'Guardar distribución'}</Button>
          </div>
        )}
      </div>
    </Card>
  )
}
