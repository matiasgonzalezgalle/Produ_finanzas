// Conciliar varios movimientos a la vez contra uno o más documentos de una misma contraparte.
// Cada movimiento queda con su pago/cobro; lo asignado se reparte en el orden de los documentos.
import clsx from 'clsx'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useBankMutations, usePaymentMethods } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { BankMovement } from '../../data'
import { formatDate } from '../../domain/dates'
import { documentTypeLabel } from '../../domain/documents'
import { formatMoney } from '../../domain/money'
import { Button, Drawer, FormError, Input, Select } from '../../ui'
import { CounterpartyCombobox } from '../CounterpartyCombobox'
import { errorMessage, minorToInput, Money, parseMoneyInput } from '../shared'
import { allocateFifo, counterpartyFor, openDocumentsFor, type MatchContext } from './matching'

export function ReconcileManyDrawer({ movements, ctx, onClose, onDone }: {
  movements: BankMovement[]
  ctx: MatchContext
  onClose: () => void
  onDone: (message: string) => void
}) {
  const { tenant } = useCurrentTenant()
  const bank = useBankMutations()
  const sorted = [...movements].sort((a, b) => a.post_date.localeCompare(b.post_date))
  const first = sorted[0]
  const isIn = (first?.amount ?? 0) > 0
  const methods = usePaymentMethods(isIn ? 'in' : 'out')
  const problems = [
    ...(movements.some((m) => m.reconciliation_status !== 'pending') ? ['Solo se concilian movimientos "Por conciliar" (quita los conciliados o ignorados de la selección).'] : []),
    ...(new Set(movements.map((m) => Math.sign(m.amount))).size > 1 ? ['No se pueden mezclar abonos y cargos: elige solo abonos (cobros) o solo cargos (pagos).'] : []),
    ...(new Set(movements.map((m) => m.currency)).size > 1 ? ['Los movimientos deben ser de la misma moneda.'] : []),
  ]
  const total = movements.reduce((s, m) => s + Math.abs(m.amount), 0)
  const currency = first?.currency ?? tenant.base_currency

  // Contraparte sugerida: la que más se repite entre los movimientos (por RUT o nombre).
  const suggested = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of movements) {
      const cp = counterpartyFor(m, ctx.counterparties)
      if (cp) counts.set(cp.id, (counts.get(cp.id) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }, [movements, ctx.counterparties])
  const options = ctx.counterparties.filter((c) => (isIn ? c.is_customer : c.is_supplier)).sort((a, b) => a.name.localeCompare(b.name))
  const [counterpartyId, setCounterpartyId] = useState(suggested)
  const [cpQuery, setCpQuery] = useState<string | null>(null)
  const docs = first && counterpartyId ? openDocumentsFor(first, counterpartyId, ctx.documents) : []
  const toInputs = (map: Record<string, number>) => Object.fromEntries(Object.entries(map).map(([id, v]) => [id, minorToInput(v, currency)]))
  const [alloc, setAlloc] = useState<Record<string, string>>(() => toInputs(allocateFifo(total, first && suggested ? openDocumentsFor(first, suggested, ctx.documents) : [])))
  const activeMethods = (methods.data ?? []).filter((m) => m.active)
  const [method, setMethod] = useState('')
  const methodValue = method || activeMethods.find((m) => m.name.toLowerCase().includes('transfer'))?.name || activeMethods.find((m) => m.is_default)?.name || activeMethods[0]?.name || 'Transferencia'
  const [error, setError] = useState<string | null>(null)

  const parsed = docs.map((d) => ({ d, value: alloc[d.id] ? parseMoneyInput(alloc[d.id], currency) : 0 }))
  const allocated = parsed.reduce((s, p) => s + (p.value ?? 0), 0)
  const invalid = parsed.find((p) => p.value === null || (p.value ?? 0) < 0 || (p.value ?? 0) > p.d.pending_amount)
  const left = total - allocated

  const changeCounterparty = (id: string) => {
    setCounterpartyId(id)
    setAlloc(toInputs(allocateFifo(total, first && id ? openDocumentsFor(first, id, ctx.documents) : [])))
  }
  const submit = async () => {
    setError(null)
    if (!counterpartyId) return setError(`Elige el ${isIn ? 'cliente' : 'proveedor'}.`)
    if (invalid) return setError(`Revisa el monto de ${documentTypeLabel(invalid.d.doc_type)} N° ${invalid.d.folio}: no puede superar su saldo.`)
    if (left < 0) return setError('Lo asignado supera el total de los movimientos.')
    try {
      await bank.reconcileMany.mutateAsync({
        movementIds: sorted.map((m) => m.id),
        counterpartyId,
        method: methodValue,
        allocations: parsed.filter((p) => (p.value ?? 0) > 0).map((p) => ({ document_id: p.d.id, amount: p.value! })),
      })
      const n = parsed.filter((p) => (p.value ?? 0) > 0).length
      onDone(`${movements.length} ${movements.length === 1 ? 'movimiento conciliado' : 'movimientos conciliados'}${n ? ` y ${movements.length === 1 ? 'asignado' : 'asignados'} a ${n} ${n === 1 ? 'documento' : 'documentos'}` : ''}.`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer
      open onClose={onClose} width="lg" title={`Conciliar ${movements.length} movimientos`}
      subtitle={`${isIn ? 'Abonos' : 'Cargos'} por ${formatMoney(total, currency)} contra ${isIn ? 'facturas del cliente' : 'documentos del proveedor'}`}
      footer={
        problems.length
          ? <Button onClick={onClose}>Cerrar</Button>
          : <><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={bank.reconcileMany.isPending || !counterpartyId}>{bank.reconcileMany.isPending ? 'Conciliando…' : `Registrar ${isIn ? 'cobros' : 'pagos'} y conciliar`}</Button></>
      }
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        {problems.length > 0 && (
          <div className="flex flex-col gap-1 rounded-lg bg-warn-bg px-3 py-2.5 text-sm text-warn">
            {problems.map((p) => <p key={p} className="flex gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {p}</p>)}
          </div>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-ink">Movimientos</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {sorted.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className={clsx('flex size-6 shrink-0 items-center justify-center rounded-full', m.amount > 0 ? 'bg-ok-bg text-ok' : 'bg-subtle text-muted')}>
                  {m.amount > 0 ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{m.description || (m.amount > 0 ? 'Abono' : 'Cargo')}</span>
                  <span className="block truncate text-xs text-faint">{formatDate(m.post_date)}{m.counterparty_name ? ` · ${m.counterparty_name}` : ''}</span>
                </span>
                <Money minor={Math.abs(m.amount)} currency={m.currency} className="font-medium text-ink" />
              </li>
            ))}
            <li className="flex justify-between bg-subtle px-3 py-2 text-sm font-semibold text-ink"><span>Total</span><Money minor={total} currency={currency} /></li>
          </ul>
        </section>

        {!problems.length && (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <span className="mb-1.5 block text-[12px] font-medium text-ink">{isIn ? 'Cliente' : 'Proveedor'}</span>
                <CounterpartyCombobox
                  options={options}
                  value={{ id: counterpartyId || null, name: cpQuery ?? options.find((c) => c.id === counterpartyId)?.name ?? '' }}
                  onChange={(v) => { setCpQuery(v.id ? null : v.name); if (v.id !== (counterpartyId || null)) changeCounterparty(v.id ?? '') }}
                  country={tenant.country} allowFree={false} placeholder="Busca por nombre o RUT…" ariaLabel={isIn ? 'Cliente' : 'Proveedor'}
                />
              </div>
              <label className="text-sm">
                <span className="mb-1.5 block text-[12px] font-medium text-ink">Forma de pago</span>
                <Select value={methodValue} onChange={(e) => setMethod(e.target.value)}>
                  {(activeMethods.length ? activeMethods.map((m) => m.name) : ['Transferencia']).map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </label>
            </div>

            {counterpartyId && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-ink">Documentos</h3>
                  <Button size="sm" onClick={() => setAlloc(toInputs(allocateFifo(total, docs)))} disabled={!docs.length}>Asignar automático</Button>
                </div>
                {docs.length ? (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox" className="accent-navy-900" aria-label={`Incluir ${d.folio}`}
                          checked={!!alloc[d.id] && (parseMoneyInput(alloc[d.id], currency) ?? 0) > 0}
                          onChange={(e) => setAlloc((a) => ({ ...a, [d.id]: e.target.checked ? minorToInput(Math.min(d.pending_amount, Math.max(0, left)), currency) : '' }))}
                        />
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="truncate text-ink">{documentTypeLabel(d.doc_type)} N° {d.folio}</div>
                          <div className="text-xs text-faint">Vence {formatDate(d.due_date)} · saldo <Money minor={d.pending_amount} currency={d.currency} /></div>
                        </div>
                        <Input className="w-32 text-right tabular" inputMode="decimal" value={alloc[d.id] ?? ''} placeholder="0" onChange={(e) => setAlloc((a) => ({ ...a, [d.id]: e.target.value }))} aria-label={`Monto para ${d.folio}`} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-faint">Sin documentos abiertos en {currency} de esta contraparte: los {isIn ? 'cobros' : 'pagos'} quedarán sin asignar.</p>
                )}
                <div className="mt-2 flex flex-wrap justify-between gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
                  <span className="text-muted">Asignado <Money minor={allocated} currency={currency} className="text-ink" /> de <Money minor={total} currency={currency} /></span>
                  <span className={left < 0 ? 'font-medium text-bad' : 'text-muted'}>{left < 0 ? 'Excede en ' : 'Sin asignar '}<Money minor={Math.abs(left)} currency={currency} /></span>
                </div>
                <p className="mt-2 text-xs text-faint">
                  Cada movimiento queda con su propio {isIn ? 'cobro' : 'pago'}. Lo asignado se reparte en el orden de la lista: el movimiento más antiguo cubre primero el primer documento.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  )
}
