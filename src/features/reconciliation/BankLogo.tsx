// Logo del banco según la institución de Fintoc (id como cl_banco_santander o su nombre).
// Los bancos sin logo muestran un ícono genérico.
import clsx from 'clsx'
import { Landmark } from 'lucide-react'

// Orden importante: "Banco de Chile" va al final porque otros nombres pueden incluir "Chile".
const LOGOS: [string, string][] = [
  ['estado', 'estado'],
  ['santander', 'santander'],
  ['scotiabank', 'scotiabank'],
  ['itau', 'itau'],
  ['bice', 'bice'],
  ['security', 'security'],
  ['bci', 'bci'],
  ['credito e inversiones', 'bci'],
  ['de chile', 'banco-de-chile'],
  ['edwards', 'banco-de-chile'],
]

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_-]+/g, ' ').toLowerCase()

export function bankLogoFile(institution: { id?: string | null; name?: string | null }): string | null {
  const text = normalize(`${institution.id ?? ''} ${institution.name ?? ''}`)
  if (!text.trim()) return null
  return LOGOS.find(([key]) => text.includes(key))?.[1] ?? null
}

export function BankLogo({ id, name, size = 32, className }: { id?: string | null; name?: string | null; size?: number; className?: string }) {
  const file = bankLogoFile({ id, name })
  if (file) {
    return <img src={`/banks/${file}.png`} alt={name ?? 'Banco'} width={size} height={size} className={clsx('shrink-0 rounded-md', className)} style={{ width: size, height: size }} />
  }
  return (
    <span className={clsx('flex shrink-0 items-center justify-center rounded-md bg-subtle text-muted', className)} style={{ width: size, height: size }} aria-hidden>
      <Landmark size={Math.round(size * 0.5)} />
    </span>
  )
}
