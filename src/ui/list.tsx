// Listas estándar de la app: buscador, filtros, orden por columna, selección múltiple,
// acciones masivas y paginación con filas por página. Todas las vistas de listas usan esto.
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from './index'

// ---------------------------------------------------------------------------
// Definiciones
// ---------------------------------------------------------------------------
export interface ListColumn<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Si se define, la columna se puede ordenar. */
  sortValue?: (row: T) => string | number | null
  align?: 'left' | 'right' | 'center'
  className?: string
}

export type ListFilter<T> =
  | {
      type: 'select'
      key: string
      label: string
      options: { value: string; label: string }[]
      match: (row: T, value: string) => boolean
      defaultValue?: string
    }
  | {
      type: 'dateRange'
      key: string
      label: string
      getDate: (row: T) => string | null
    }

type FilterValues = Record<string, string>

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

const PAGE_SIZES = [10, 20, 50, 100]

function readPageSize(storageKey: string): number {
  try {
    const value = Number(localStorage.getItem(`produ-finanzas:page-size:${storageKey}`))
    return PAGE_SIZES.includes(value) ? value : 20
  } catch {
    return 20
  }
}

function defaultFilterValues<T>(filters: ListFilter<T>[]): FilterValues {
  const values: FilterValues = {}
  for (const f of filters) if (f.type === 'select' && f.defaultValue) values[f.key] = f.defaultValue
  return values
}

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

// ---------------------------------------------------------------------------
// Estado de la lista
// ---------------------------------------------------------------------------
export function useListState<T>({
  rows,
  rowKey,
  columns,
  filters = [],
  searchText,
  storageKey,
  defaultSort,
}: {
  rows: T[]
  rowKey: (row: T) => string
  columns: ListColumn<T>[]
  filters?: ListFilter<T>[]
  searchText: (row: T) => string
  storageKey: string
  defaultSort?: SortState
}) {
  const [query, setQueryState] = useState('')
  const [filterValues, setFilterValues] = useState<FilterValues>(() => defaultFilterValues(filters))
  const [sort, setSort] = useState<SortState | undefined>(defaultSort)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(() => readPageSize(storageKey))
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = normalize(query.trim())
    let list = rows
    if (q) list = list.filter((row) => normalize(searchText(row)).includes(q))
    for (const f of filters) {
      const value = filterValues[f.key]
      if (!value) continue
      if (f.type === 'select') list = list.filter((row) => f.match(row, value))
      else {
        const [from, to] = value.split('|')
        list = list.filter((row) => {
          const d = f.getDate(row)
          if (!d) return false
          return (!from || d >= from) && (!to || d <= to)
        })
      }
    }
    const column = sort && columns.find((c) => c.key === sort.key)
    if (sort && column?.sortValue) {
      const get = column.sortValue
      const dir = sort.dir === 'asc' ? 1 : -1
      list = [...list].sort((a, b) => {
        const va = get(a)
        const vb = get(b)
        if (va === vb) return 0
        if (va === null || va === '') return 1
        if (vb === null || vb === '') return -1
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')) * dir
      })
    }
    return list
  }, [rows, query, filters, filterValues, sort, columns, searchText])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  // La selección solo conserva filas que siguen existiendo.
  const rowIds = useMemo(() => new Set(rows.map(rowKey)), [rows, rowKey])
  const selectedIds = useMemo(() => new Set([...selected].filter((id) => rowIds.has(id))), [selected, rowIds])
  const selectedRows = rows.filter((r) => selectedIds.has(rowKey(r)))
  const pageIds = pageRows.map(rowKey)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id))
  const somePageSelected = pageIds.some((id) => selectedIds.has(id))

  const activeFilterCount = filters.filter((f) => {
    const v = filterValues[f.key]
    return v && v !== '|' && !(f.type === 'select' && f.defaultValue === v)
  }).length

  return {
    query,
    setQuery: (q: string) => {
      setQueryState(q)
      setPage(1)
    },
    filterValues,
    setFilter: (key: string, value: string) => {
      setFilterValues((prev) => ({ ...prev, [key]: value }))
      setPage(1)
    },
    clearFilters: () => {
      setFilterValues(defaultFilterValues(filters))
      setQueryState('')
      setPage(1)
    },
    activeFilterCount,
    sort,
    toggleSort: (key: string) =>
      setSort((prev) => (prev?.key === key ? (prev.dir === 'asc' ? { key, dir: 'desc' } : undefined) : { key, dir: 'asc' })),
    page: safePage,
    setPage,
    pages,
    pageSize,
    setPageSize: (size: number) => {
      setPageSizeState(size)
      setPage(1)
      try {
        localStorage.setItem(`produ-finanzas:page-size:${storageKey}`, String(size))
      } catch {
        // ignorar
      }
    },
    filtered,
    pageRows,
    total: filtered.length,
    selectedIds,
    selectedRows,
    allPageSelected,
    somePageSelected,
    toggleRow: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    togglePage: () =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (allPageSelected) pageIds.forEach((id) => next.delete(id))
        else pageIds.forEach((id) => next.add(id))
        return next
      }),
    selectAllFiltered: () => setSelected(new Set(filtered.map(rowKey))),
    clearSelection: () => setSelected(new Set()),
  }
}

export type ListState<T> = ReturnType<typeof useListState<T>>

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------
function Check({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="size-[18px] cursor-pointer rounded border-line accent-navy-900"
    />
  )
}

function FilterControl<T>({ filter, value, onChange }: { filter: ListFilter<T>; value: string; onChange: (v: string) => void }) {
  const control = 'h-9 rounded-md border border-line bg-white px-2.5 text-sm text-ink focus:border-brand-500 focus:ring-3 focus:ring-brand-50 focus:outline-none'
  if (filter.type === 'select') {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">{filter.label}</span>
        <select className={cn(control, 'min-w-40 pr-8')} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Todos</option>
          {filter.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
    )
  }
  const [from = '', to = ''] = value.split('|')
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{filter.label}</legend>
      <div className="flex items-center gap-1.5">
        <input type="date" aria-label={`${filter.label} desde`} className={control} value={from} onChange={(e) => onChange(`${e.target.value}|${to}`)} />
        <span className="text-faint">–</span>
        <input type="date" aria-label={`${filter.label} hasta`} className={control} value={to} min={from || undefined} onChange={(e) => onChange(`${from}|${e.target.value}`)} />
      </div>
    </fieldset>
  )
}

function filterChipLabel<T>(filter: ListFilter<T>, value: string) {
  if (filter.type === 'select') return `${filter.label}: ${filter.options.find((o) => o.value === value)?.label ?? value}`
  const [from, to] = value.split('|')
  const fmt = (iso: string) => iso.split('-').reverse().join('/')
  return `${filter.label}: ${from ? fmt(from) : '…'} – ${to ? fmt(to) : '…'}`
}

export function ListView<T>({
  state,
  columns,
  rowKey,
  filters = [],
  loading,
  searchPlaceholder = 'Buscar…',
  onRowClick,
  rowActions,
  bulkActions,
  empty,
  toolbarExtra,
}: {
  state: ListState<T>
  columns: ListColumn<T>[]
  rowKey: (row: T) => string
  filters?: ListFilter<T>[]
  loading?: boolean
  searchPlaceholder?: string
  onRowClick?: (row: T) => void
  rowActions?: (row: T) => ReactNode
  /** Si se define, aparece la columna de selección. */
  bulkActions?: (rows: T[]) => ReactNode
  empty?: ReactNode
  toolbarExtra?: ReactNode
}) {
  const [showFilters, setShowFilters] = useState(false)
  const selectable = !!bulkActions
  const s = state
  const colCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)

  useEffect(() => {
    if (s.activeFilterCount > 0) setShowFilters(true)
    // solo al montar: si hay filtros por defecto activos, mostrar el panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeChips = filters.filter((f) => {
    const v = s.filterValues[f.key]
    return v && v !== '|'
  })

  return (
    <div className="flex flex-col gap-3">
      {/* Barra de herramientas */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Buscar"
            className="h-10 w-full rounded-lg border border-line bg-white pr-3 pl-9 text-sm text-ink placeholder:text-faint focus:border-brand-500 focus:ring-3 focus:ring-brand-50 focus:outline-none"
          />
        </div>
        {filters.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium',
              showFilters || s.activeFilterCount ? 'border-navy-900/20 bg-head text-navy-900' : 'border-line bg-white text-ink hover:bg-subtle',
            )}
          >
            <SlidersHorizontal size={16} /> Filtros
            {s.activeFilterCount > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-navy-900 text-[11px] text-white">{s.activeFilterCount}</span>}
          </button>
        )}
        {toolbarExtra}
        <span className="ml-auto text-sm text-muted tabular">
          {loading ? 'Cargando…' : `${s.total} ${s.total === 1 ? 'resultado' : 'resultados'}`}
        </span>
      </div>

      {showFilters && filters.length > 0 && (
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-subtle/60 p-4">
          {filters.map((f) => (
            <FilterControl key={f.key} filter={f} value={s.filterValues[f.key] ?? ''} onChange={(v) => s.setFilter(f.key, v)} />
          ))}
          <button type="button" onClick={s.clearFilters} className="h-9 rounded-md px-3 text-sm text-brand-600 hover:bg-white">
            Limpiar filtros
          </button>
        </div>
      )}

      {!showFilters && activeChips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeChips.map((f) => (
            <span key={f.key} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-white pr-1.5 pl-3 text-xs text-ink">
              {filterChipLabel(f, s.filterValues[f.key])}
              <button type="button" aria-label={`Quitar filtro ${f.label}`} onClick={() => s.setFilter(f.key, '')} className="rounded-full p-0.5 text-faint hover:bg-subtle hover:text-ink">
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Acciones masivas */}
      {selectable && s.selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-navy-900 px-4 py-2.5 text-sm text-white">
          <span className="font-medium">{s.selectedIds.size} seleccionados</span>
          {s.selectedIds.size < s.total && (
            <button type="button" onClick={s.selectAllFiltered} className="text-white/80 underline-offset-2 hover:underline">
              Seleccionar los {s.total}
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {bulkActions(s.selectedRows)}
            <button type="button" onClick={s.clearSelection} className="rounded-md px-2 py-1 text-white/80 hover:bg-white/10 hover:text-white">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Tabla */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="h-12 w-11 rounded-l-xl bg-head pl-4 text-left">
                  <Check checked={s.allPageSelected} indeterminate={s.somePageSelected} onChange={s.togglePage} label="Seleccionar página" />
                </th>
              )}
              {columns.map((col, i) => {
                const sorted = s.sort?.key === col.key ? s.sort.dir : null
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'h-12 bg-head px-3 text-[11px] font-semibold tracking-wider whitespace-nowrap text-ink/80 uppercase',
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                      i === 0 && !selectable && 'rounded-l-xl',
                      i === columns.length - 1 && !rowActions && 'rounded-r-xl',
                      col.className,
                    )}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => s.toggleSort(col.key)}
                        className={cn('inline-flex items-center gap-1 uppercase hover:text-ink', col.align === 'right' && 'flex-row-reverse')}
                      >
                        {col.header}
                        {sorted === 'asc' ? <ArrowUp size={13} /> : sorted === 'desc' ? <ArrowDown size={13} /> : <ArrowDown size={13} className="opacity-0" />}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
              {rowActions && <th scope="col" className="h-12 rounded-r-xl bg-head px-2"><span className="sr-only">Acciones</span></th>}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>
                  {Array.from({ length: colCount }, (_, j) => (
                    <td key={j} className="h-14 border-b border-line px-4">
                      <div className="h-3 w-3/4 animate-pulse rounded bg-subtle" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              s.pageRows.map((row) => {
                const id = rowKey(row)
                const isSelected = s.selectedIds.has(id)
                return (
                  <tr
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn('group transition-colors', onRowClick && 'cursor-pointer', isSelected ? 'bg-brand-50/60' : 'hover:bg-subtle/70')}
                  >
                    {selectable && (
                      <td className="h-14 border-b border-line pl-4">
                        <Check checked={isSelected} onChange={() => s.toggleRow(id)} label="Seleccionar fila" />
                      </td>
                    )}
                    {columns.map((col, i) => (
                      <td
                        key={col.key}
                        className={cn(
                          'h-14 border-b border-line px-3 text-ink/80',
                          i === 0 && 'font-semibold text-ink',
                          col.align === 'right' ? 'text-right tabular' : col.align === 'center' ? 'text-center' : 'text-left',
                          col.className,
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="h-14 border-b border-line px-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center">{rowActions(row)}</div>
                      </td>
                    )}
                  </tr>
                )
              })}
          </tbody>
        </table>
        {!loading && s.pageRows.length === 0 && (
          <div className="py-4">
            {empty}
            {(s.query || s.activeFilterCount > 0) && (
              <div className="text-center">
                <button type="button" onClick={s.clearFilters} className="text-sm text-brand-600 hover:underline">
                  Limpiar búsqueda y filtros
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ListPagination state={s} />
    </div>
  )
}

export function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pages - 1, page + 1)
  if (start > 2) out.push('…')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < pages - 1) out.push('…')
  out.push(pages)
  return out
}

export function ListPagination<T>({ state: s }: { state: ListState<T> }) {
  if (s.total === 0) return null
  const from = (s.page - 1) * s.pageSize + 1
  const to = Math.min(s.total, s.page * s.pageSize)
  const btn = 'flex size-9 items-center justify-center rounded-lg text-sm'
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-sm text-muted">
      <span className="tabular">
        Mostrando <b className="font-medium text-ink">{from}–{to}</b> de <b className="font-medium text-ink">{s.total}</b>
      </span>
      <nav className="flex items-center gap-1" aria-label="Paginación">
        <button type="button" className={cn(btn, 'hover:bg-subtle disabled:opacity-40')} disabled={s.page <= 1} onClick={() => s.setPage(s.page - 1)} aria-label="Página anterior">
          <ChevronLeft size={18} />
        </button>
        {pageList(s.page, s.pages).map((n, i) =>
          n === '…' ? (
            <span key={`e${i}`} className="px-1 text-faint">…</span>
          ) : (
            <button
              type="button"
              key={n}
              onClick={() => s.setPage(n)}
              aria-current={n === s.page ? 'page' : undefined}
              className={cn(btn, n === s.page ? 'bg-navy-900 font-semibold text-white' : 'text-ink hover:bg-subtle')}
            >
              {n}
            </button>
          ),
        )}
        <button type="button" className={cn(btn, 'hover:bg-subtle disabled:opacity-40')} disabled={s.page >= s.pages} onClick={() => s.setPage(s.page + 1)} aria-label="Página siguiente">
          <ChevronRight size={18} />
        </button>
      </nav>
      <label className="flex items-center gap-2">
        Filas por página
        <select
          value={s.pageSize}
          onChange={(e) => s.setPageSize(Number(e.target.value))}
          className="h-9 rounded-md border border-line bg-white px-2 text-sm text-ink focus:outline-none"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** Ícono de acción por fila (ver, editar, pagar, anular…). */
export function RowAction({ label, onClick, children, tone }: { label: string; onClick: () => void; children: ReactNode; tone?: 'danger' }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'flex size-7 items-center justify-center rounded-md transition-colors',
        tone === 'danger' ? 'text-bad/80 hover:bg-bad-bg hover:text-bad' : 'text-muted hover:bg-subtle hover:text-navy-900',
      )}
    >
      {children}
    </button>
  )
}

/** Botón para la barra de acciones masivas (fondo azul marino). */
export function BulkButton({ onClick, children, tone }: { onClick: () => void; children: ReactNode; tone?: 'danger' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium',
        tone === 'danger' ? 'bg-white/10 text-red-200 hover:bg-white/15' : 'bg-white text-navy-900 hover:bg-white/90',
      )}
    >
      {children}
    </button>
  )
}

/** Menú desplegable de acciones por fila (para acciones secundarias). */
export function RowMenu({ label, icon, items }: { label: string; icon: ReactNode; items: { label: string; onClick: () => void; tone?: 'danger'; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])
  return (
    <div className="relative">
      <RowAction label={label} onClick={() => setOpen((o) => !o)}>{icon}</RowAction>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 min-w-48 rounded-lg border border-line bg-white p-1 text-left shadow-xl">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                item.onClick()
              }}
              className={cn(
                'block w-full truncate rounded-md px-3 py-2 text-left text-sm disabled:opacity-40',
                item.tone === 'danger' ? 'text-bad hover:bg-bad-bg' : 'text-ink hover:bg-subtle',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
