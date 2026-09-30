// Editor de correo por bloques: texto con formato, ficha/tabla de documentos, botón de pago y
// separadores. Los bloques se reordenan arrastrando (o con las flechas).
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Bold, CreditCard, GripVertical, Heading, Italic, Link2, List, ListOrdered, Minus, Plus, Table2, Trash2, Type, Underline } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EmailBlock } from '../../data'
import { sanitizeEmailHtml } from '../../lib/emailBlocks'

export type EditorBlock = EmailBlock & { id: string }

let seq = 0
export const withIds = (blocks: EmailBlock[]): EditorBlock[] => blocks.map((b) => ({ ...b, id: `b${++seq}` }))
export const withoutIds = (blocks: EditorBlock[]): EmailBlock[] =>
  blocks.map(({ id: _id, ...b }) => (b.type === 'text' ? { type: 'text', html: sanitizeEmailHtml(b.html) } : b) as EmailBlock)

const LABEL: Record<EmailBlock['type'], string> = { text: 'Texto', documents: 'Documentos', button: 'Botón', divider: 'Separador' }

export function EmailBlocksEditor({ blocks, onChange, perDocument, onTextFocus }: {
  blocks: EditorBlock[]
  onChange: (blocks: EditorBlock[]) => void
  perDocument: boolean
  /** El editor de texto con foco (para insertar variables desde afuera). */
  onTextFocus: (insert: ((text: string) => void) | null) => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const has = (t: EmailBlock['type']) => blocks.some((b) => b.type === t)

  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return
    const next = [...blocks]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }
  const add = (type: EmailBlock['type']) => {
    const block = (type === 'text' ? { type, html: '<p></p>' } : { type }) as EmailBlock
    onChange([...blocks, ...withIds([block])])
    setAdding(false)
  }

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => (
        <div
          key={b.id}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(b.id) } }}
          onDragLeave={() => setOver((o) => (o === b.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault()
            const from = blocks.findIndex((x) => x.id === dragging)
            if (from >= 0) move(from, i)
            setDragging(null)
            setOver(null)
          }}
          className={clsx('group rounded-lg border bg-white transition-shadow', over === b.id && dragging !== b.id ? 'border-brand-500 shadow-[0_-3px_0_0_var(--color-brand-500)]' : 'border-line', dragging === b.id && 'opacity-40')}
        >
          <div className="flex items-center gap-1 border-b border-line bg-subtle/60 px-1.5 py-1">
            <span
              draggable
              onDragStart={(e) => { setDragging(b.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id) }}
              onDragEnd={() => { setDragging(null); setOver(null) }}
              className="cursor-grab rounded p-1 text-faint hover:bg-white hover:text-ink active:cursor-grabbing"
              title="Arrastra para mover" aria-label={`Mover bloque ${LABEL[b.type]}`}
            >
              <GripVertical size={15} />
            </span>
            <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">{LABEL[b.type]}</span>
            <span className="ml-auto flex items-center">
              <IconBtn label="Subir" onClick={() => move(i, i - 1)} disabled={i === 0}><ArrowUp size={14} /></IconBtn>
              <IconBtn label="Bajar" onClick={() => move(i, i + 1)} disabled={i === blocks.length - 1}><ArrowDown size={14} /></IconBtn>
              <IconBtn label="Quitar bloque" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}><Trash2 size={14} /></IconBtn>
            </span>
          </div>
          {b.type === 'text' ? (
            <RichText
              html={b.html}
              onChange={(html) => onChange(blocks.map((x) => (x.id === b.id ? { ...x, html } : x)))}
              onFocus={onTextFocus}
            />
          ) : b.type === 'documents' ? (
            <div className="flex items-center gap-3 px-3 py-3 text-sm text-muted">
              <Table2 size={18} className="shrink-0 text-brand-600" />
              {perDocument ? 'Ficha del documento: número, emisión, vencimiento (con días de atraso) y saldo por pagar.' : 'Tabla de documentos con saldo: número, vencimiento y saldo, con el total.'}
            </div>
          ) : b.type === 'button' ? (
            <div className="flex items-center gap-3 px-3 py-3 text-sm text-muted">
              <CreditCard size={18} className="shrink-0 text-brand-600" />
              {perDocument ? 'Botón "Pagar $saldo" con el link de MercadoPago (o "Ver en el portal" si no hay).' : 'Botón "Ver en el portal".'}
            </div>
          ) : (
            <div className="px-3 py-3"><div className="border-t border-line" /></div>
          )}
        </div>
      ))}
      {!blocks.length && <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-faint">El correo está vacío: agrega un bloque de texto.</p>}

      <div className="relative self-start">
        <button type="button" onClick={() => setAdding((a) => !a)} className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line px-3 py-1.5 text-[13px] text-muted hover:border-navy-900/40 hover:text-ink">
          <Plus size={14} /> Agregar bloque
        </button>
        {adding && (
          <div className="absolute top-full left-0 z-30 mt-1 w-64 rounded-lg border border-line bg-white p-1 shadow-xl" onMouseLeave={() => setAdding(false)}>
            <AddItem icon={<Type size={15} />} label="Texto" onClick={() => add('text')} />
            <AddItem icon={<Table2 size={15} />} label={perDocument ? 'Ficha del documento' : 'Tabla de documentos'} onClick={() => add('documents')} disabled={has('documents')} />
            <AddItem icon={<CreditCard size={15} />} label="Botón de pago / portal" onClick={() => add('button')} disabled={has('button')} />
            <AddItem icon={<Minus size={15} />} label="Separador" onClick={() => add('divider')} />
          </div>
        )}
      </div>
    </div>
  )
}

function AddItem({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-subtle disabled:opacity-40">
      <span className="text-muted">{icon}</span> {label}{disabled && <span className="ml-auto text-[11px] text-faint">ya está</span>}
    </button>
  )
}

function IconBtn({ label, onClick, disabled, children, active }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button" title={label} aria-label={label} disabled={disabled}
      // Mantiene la selección del texto al usar la barra de formato.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('rounded p-1 text-muted hover:bg-white hover:text-ink disabled:opacity-30', active && 'bg-white text-ink')}
    >
      {children}
    </button>
  )
}

/** Texto con formato (contentEditable). El HTML se limpia con la misma lista blanca del servidor. */
function RichText({ html, onChange, onFocus }: { html: string; onChange: (html: string) => void; onFocus: (insert: ((text: string) => void) | null) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const lastEmitted = useRef<string | null>(null)
  // Editor no controlado (para no mover el cursor): solo se reescribe si el contenido cambió desde afuera.
  useEffect(() => {
    if (ref.current && html !== lastEmitted.current) {
      ref.current.innerHTML = sanitizeEmailHtml(html) || '<p><br></p>'
      lastEmitted.current = html
    }
  }, [html])
  const emit = () => {
    if (!ref.current) return
    const clean = sanitizeEmailHtml(ref.current.innerHTML)
    lastEmitted.current = clean
    onChange(clean)
  }
  const exec = (command: string, value?: string) => {
    ref.current?.focus()
    document.execCommand(command, false, value)
    emit()
  }
  const insertText = (text: string) => {
    ref.current?.focus()
    document.execCommand('insertText', false, text)
    emit()
  }
  const link = () => {
    const url = window.prompt('URL del enlace (https://…). También puedes usar {{link_pago}} o {{link_portal}}.', 'https://')
    if (!url || url === 'https://') return
    if (!/^(https?:\/\/|mailto:)/i.test(url) && !/^\{\{\s*[a-z_]+\s*\}\}$/.test(url.trim())) return window.alert('El enlace debe empezar con https:// o ser una variable como {{link_pago}}.')
    exec('createLink', url.trim())
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
        <IconBtn label="Negrita" onClick={() => exec('bold')}><Bold size={14} /></IconBtn>
        <IconBtn label="Cursiva" onClick={() => exec('italic')}><Italic size={14} /></IconBtn>
        <IconBtn label="Subrayado" onClick={() => exec('underline')}><Underline size={14} /></IconBtn>
        <span className="mx-1 h-4 w-px bg-line" />
        <IconBtn label="Título" onClick={() => exec('formatBlock', 'h3')}><Heading size={14} /></IconBtn>
        <IconBtn label="Párrafo" onClick={() => exec('formatBlock', 'p')}><Type size={14} /></IconBtn>
        <IconBtn label="Lista" onClick={() => exec('insertUnorderedList')}><List size={14} /></IconBtn>
        <IconBtn label="Lista numerada" onClick={() => exec('insertOrderedList')}><ListOrdered size={14} /></IconBtn>
        <IconBtn label="Enlace" onClick={link}><Link2 size={14} /></IconBtn>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Texto del correo"
        onInput={emit}
        onFocus={() => onFocus(insertText)}
        onPaste={(e) => {
          // Se pega como texto plano (evita estilos y etiquetas de otras apps).
          e.preventDefault()
          insertText(e.clipboardData.getData('text/plain'))
        }}
        className="min-h-24 px-3 py-2.5 text-[14px] leading-[22px] text-muted outline-none [&_a]:text-brand-600 [&_a]:underline [&_b]:text-ink [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-ink [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  )
}
