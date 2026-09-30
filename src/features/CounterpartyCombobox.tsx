// Contraparte: buscar y elegir una registrada o escribir un nombre libre (no registrado).
import clsx from 'clsx'
import { Check, UserPlus, X } from 'lucide-react'
import { useId, useState, type KeyboardEvent } from 'react'
import type { Counterparty } from '../data'
import type { Country } from '../domain/taxId'
import { formatTaxId } from '../domain/taxId'

export interface CounterpartyValue {
  /** null = nombre escrito a mano (no registrado). */
  id: string | null
  name: string
}

const plain = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const digits = (t: string) => t.replace(/[^0-9kK]/g, '').toLowerCase()

export function CounterpartyCombobox({ options, value, onChange, country, placeholder = 'Busca o escribe un nombre…', ariaLabel, allowFree = true }: {
  options: Counterparty[]
  value: CounterpartyValue
  onChange: (v: CounterpartyValue) => void
  country: Country
  placeholder?: string
  ariaLabel?: string
  /** false: solo contrapartes registradas (lo escrito sirve solo para buscar). */
  allowFree?: boolean
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const q = plain(value.name)
  const qd = digits(value.name)
  const matches = options
    .filter((c) => !q || plain(`${c.name} ${c.legal_name ?? ''}`).includes(q) || (qd.length >= 3 && digits(c.tax_id ?? '').includes(qd)))
    .sort((a, b) => Number(plain(b.name).startsWith(q)) - Number(plain(a.name).startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 8)
  const exact = options.find((c) => plain(c.name) === q)
  // Última opción: usar lo escrito sin registrarlo.
  const items: ({ kind: 'cp'; cp: Counterparty } | { kind: 'free' })[] = [...matches.map((cp) => ({ kind: 'cp' as const, cp })), ...(allowFree && q && !exact ? [{ kind: 'free' as const }] : [])]

  const choose = (i: number) => {
    const item = items[i]
    if (!item) return
    onChange(item.kind === 'cp' ? { id: item.cp.id, name: item.cp.name } : { id: null, name: value.name.trim() })
    setOpen(false)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter' && open && items.length) { e.preventDefault(); choose(active) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel}
          value={value.name}
          placeholder={placeholder}
          onChange={(e) => { onChange({ id: null, name: e.target.value }); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          className="h-10 w-full rounded-md border border-line bg-white px-3 pr-16 text-sm text-ink outline-none focus:border-brand-500"
        />
        <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
          {value.name && (
            value.id
              ? <span className="rounded bg-ok-bg px-1.5 py-0.5 text-[10px] font-medium text-ok">Registrado</span>
              : allowFree && <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-muted">Libre</span>
          )}
          {value.name && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange({ id: null, name: '' })} className="rounded p-0.5 text-faint hover:text-ink" aria-label="Borrar">
              <X size={14} />
            </button>
          )}
        </span>
      </div>
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute top-full left-0 z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-xl">
          {items.map((item, i) => (
            <li
              key={item.kind === 'cp' ? item.cp.id : 'free'}
              role="option" aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={clsx('flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm', i === active ? 'bg-subtle' : '', item.kind === 'free' && 'border-t border-line')}
            >
              {item.kind === 'cp' ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{item.cp.name}</span>
                    {item.cp.tax_id && <span className="block truncate text-xs text-faint">{formatTaxId(item.cp.tax_id, country)}</span>}
                  </span>
                  {value.id === item.cp.id && <Check size={15} className="text-brand-600" />}
                </>
              ) : (
                <>
                  <UserPlus size={15} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate text-ink">Usar «{value.name.trim()}» sin registrar</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
