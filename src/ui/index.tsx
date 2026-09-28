import clsx, { type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { X } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { NavLink } from 'react-router-dom'

/** clsx + resolución de conflictos de Tailwind (ej. w-full vs w-36). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-3.5 text-sm',
          variant === 'primary' && 'bg-navy-900 text-white hover:bg-navy-800',
          variant === 'secondary' && 'border border-line bg-white text-ink shadow-xs hover:bg-subtle',
          variant === 'ghost' && 'text-muted hover:bg-subtle hover:text-ink',
          variant === 'danger' && 'border border-line bg-white text-bad hover:bg-bad-bg',
          className,
        )}
        {...props}
      />
    )
  },
)

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md border border-line bg-white text-muted shadow-xs hover:bg-subtle hover:text-ink',
        className,
      )}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// Encabezado de página con tabs (como en "Empresas > Proveedores | Clientes | Contactos")
// ---------------------------------------------------------------------------
export interface TabItem {
  to: string
  label: string
  badge?: ReactNode
  disabled?: boolean
}

export function PageHeader({ title, tabs, actions }: { title: string; tabs?: TabItem[]; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-line pt-2 md:flex-row md:items-end md:justify-between md:pt-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-1">
        <h1 className="flex items-center gap-2 py-3 text-[17px] font-semibold text-ink">
          {title}
          {tabs && <span aria-hidden className="text-faint">›</span>}
        </h1>
        {tabs && (
          <nav className="-mb-px flex gap-6 overflow-x-auto" aria-label="Secciones">
            {tabs.map((tab) =>
              tab.disabled ? (
                <span key={tab.to} className="flex items-center gap-2 py-3 text-[15px] text-faint">
                  {tab.label}
                  {tab.badge}
                </span>
              ) : (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2 border-b-2 py-3 text-[15px] whitespace-nowrap transition-colors',
                      isActive ? 'border-brand-600 font-medium text-brand-600' : 'border-transparent text-muted hover:text-ink',
                    )
                  }
                >
                  {tab.label}
                  {tab.badge}
                </NavLink>
              ),
            )}
          </nav>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 pb-3">{actions}</div>}
    </header>
  )
}

// ---------------------------------------------------------------------------
// Tabla
// ---------------------------------------------------------------------------
export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: ReactNode
  loading?: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-subtle">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  'h-11 px-4 font-medium whitespace-nowrap text-ink first:rounded-l-md last:rounded-r-md',
                  col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 5 }, (_, i) => (
              <tr key={i} className="border-b border-line">
                {columns.map((col) => (
                  <td key={col.key} className="h-15 px-4">
                    <div className="h-3 w-2/3 animate-pulse rounded bg-subtle" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('border-b border-line text-muted transition-colors', onRowClick && 'cursor-pointer hover:bg-subtle/70')}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'h-15 px-4',
                      col.align === 'right' ? 'text-right tabular' : col.align === 'center' ? 'text-center' : 'text-left',
                      col.className,
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && <div className="py-16 text-center text-sm text-faint">{empty ?? 'Sin registros'}</div>}
    </div>
  )
}

export function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null
  return (
    <nav className="flex items-center justify-center gap-1 py-3" aria-label="Paginación">
      <button type="button" className="size-10 rounded-md text-muted hover:bg-subtle disabled:opacity-40" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Anterior">
        ‹
      </button>
      {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
        <button
          type="button"
          key={n}
          onClick={() => onChange(n)}
          aria-current={n === page ? 'page' : undefined}
          className={cn('size-10 rounded-md text-sm', n === page ? 'bg-subtle font-medium text-ink' : 'text-muted hover:bg-subtle')}
        >
          {n}
        </button>
      ))}
      <button type="button" className="size-10 rounded-md text-muted hover:bg-subtle disabled:opacity-40" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Siguiente">
        ›
      </button>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-subtle text-muted',
        tone === 'ok' && 'bg-ok-bg text-ok',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'bad' && 'bg-bad-bg text-bad',
        tone === 'info' && 'bg-brand-50 text-brand-600',
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------
const controlClass =
  'h-9 w-full rounded-md border border-line bg-white px-3 text-sm text-ink placeholder:text-faint focus:border-brand-500 focus:ring-3 focus:ring-brand-50 focus:outline-none disabled:bg-subtle'

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(controlClass, className)} {...props} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn(controlClass, 'pr-8', className)} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(controlClass, 'h-auto min-h-20 py-2', className)} {...props} />
})

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input type="checkbox" className="size-4 rounded border-line accent-navy-900" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function FormError({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return <div role="alert" className="rounded-md border border-bad/20 bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
}

// ---------------------------------------------------------------------------
// Panel lateral (formularios y detalle)
// ---------------------------------------------------------------------------
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'md',
}: {
  open: boolean
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: 'md' | 'lg'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-navy-950/30" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('relative flex h-full w-full flex-col bg-white shadow-2xl', width === 'lg' ? 'max-w-2xl' : 'max-w-lg')}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-subtle" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Varios
// ---------------------------------------------------------------------------
export function StatCard({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular', tone === 'bad' ? 'text-bad' : tone === 'ok' ? 'text-ok' : 'text-ink')}>{value}</div>
      {detail && <div className="mt-1 text-xs text-faint">{detail}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
      {icon && <div className="flex size-12 items-center justify-center rounded-full bg-subtle text-muted">{icon}</div>}
      <div>
        <p className="font-medium text-ink">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? 'Buscar…'}
      className={cn(controlClass, 'w-72 max-w-full')}
    />
  )
}
