// Cuentas bancarias manuales (offline) e importación de cartolas en Excel o CSV.
import clsx from 'clsx'
import { AlertTriangle, Check, FileSpreadsheet, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useBankImports, useBankMutations } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import type { BankFeedAccount, FeedAccountInput } from '../../data'
import { ACCOUNT_TYPES, BANKS, bankById } from '../../domain/banks'
import { formatDate, formatTimestamp } from '../../domain/dates'
import type { Currency } from '../../domain/money'
import { detectMapping, parseStatement, readStatementFile, type ColumnMapping, type Grid } from '../../lib/statementImport'
import { Badge, Button, Drawer, Field, FormError, Input, Select } from '../../ui'
import { errorMessage, Money } from '../shared'
import { BankLogo } from './BankLogo'

const ACCOUNT_CURRENCIES: Currency[] = ['CLP', 'PEN', 'USD', 'EUR']
const OTHER = '__otro__'

export const accountTitle = (a: BankFeedAccount) => `${a.name ?? 'Cuenta'}${a.number ? ` · ${a.number}` : ''}`

// ---------------------------------------------------------------------------
// Crear / editar cuenta manual
// ---------------------------------------------------------------------------
export function AccountDrawer({ account, hasMovements, onClose }: { account: BankFeedAccount | null; hasMovements: boolean; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const { saveAccount } = useBankMutations()
  const known = account?.institution_id ? bankById(account.institution_id) : null
  const [bankId, setBankId] = useState(account ? (known?.id ?? OTHER) : '')
  const [otherName, setOtherName] = useState(account && !known ? account.institution_name ?? '' : '')
  const [form, setForm] = useState({
    name: account?.name ?? 'Cuenta corriente',
    number: account?.number ?? '',
    type: account?.type && ACCOUNT_TYPES.includes(account.type) ? account.type : 'Cuenta corriente',
    currency: (account?.currency ?? tenant.base_currency) as Currency,
    holder_name: account?.holder_name ?? tenant.legal_name ?? tenant.name,
  })
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  // Primero los bancos del país de la empresa.
  const groups = [tenant.country, tenant.country === 'CL' ? 'PE' : 'CL'].map((c) => ({ country: c, banks: BANKS.filter((b) => b.country === c) }))
  const bank = bankById(bankId)

  const submit = async () => {
    setError(null)
    const institutionName = bankId === OTHER ? otherName.trim() : bank?.name ?? ''
    if (!institutionName) return setError('Elige el banco.')
    const input: FeedAccountInput = {
      institution_id: bankId === OTHER ? null : bankId, institution_name: institutionName, name: form.name.trim() || form.type,
      number: form.number.trim() || null, type: form.type, currency: form.currency, holder_name: form.holder_name.trim() || null,
    }
    try {
      await saveAccount.mutateAsync({ id: account?.id ?? null, input })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer
      open onClose={onClose} width="lg"
      title={account ? 'Editar cuenta bancaria' : 'Nueva cuenta bancaria manual'}
      subtitle="Sus movimientos se cargan importando la cartola en Excel o CSV."
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={saveAccount.isPending}>{saveAccount.isPending ? 'Guardando…' : 'Guardar cuenta'}</Button></>}
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        <Field label="Banco">
          {(id) => (
            <div className="flex items-center gap-3">
              <BankLogo id={bankId === OTHER ? null : bankId} name={bankId === OTHER ? otherName : bank?.name} size={36} />
              <Select id={id} value={bankId} onChange={(e) => setBankId(e.target.value)} className="flex-1">
                <option value="">Selecciona…</option>
                {groups.map((g) => (
                  <optgroup key={g.country} label={g.country === 'CL' ? 'Chile' : 'Perú'}>
                    {g.banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </optgroup>
                ))}
                <option value={OTHER}>Otro banco…</option>
              </Select>
            </div>
          )}
        </Field>
        {bankId === OTHER && <Field label="Nombre del banco">{(id) => <Input id={id} value={otherName} onChange={(e) => setOtherName(e.target.value)} autoFocus />}</Field>}
        {bank?.fintoc && tenant.country === 'CL' && !account && (
          <p className="rounded-md bg-brand-50 px-3 py-2 text-xs text-navy-900">
            {bank.name} también se puede conectar con Fintoc para que los movimientos lleguen solos. La cuenta manual sirve si prefieres importar la cartola.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo de cuenta">
            {(id) => (
              <Select id={id} value={form.type} onChange={(e) => set('type', e.target.value)}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Moneda" hint={hasMovements ? 'No se cambia porque la cuenta ya tiene movimientos.' : undefined}>
            {(id) => (
              <Select id={id} value={form.currency} onChange={(e) => set('currency', e.target.value as Currency)} disabled={hasMovements}>
                {ACCOUNT_CURRENCIES.map((c) => <option key={c} value={c}>{c === 'CLP' ? 'CLP · Peso chileno' : c === 'PEN' ? 'PEN · Sol' : c === 'USD' ? 'USD · Dólar' : 'EUR · Euro'}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Nombre de la cuenta" hint="Cómo la verás en la app.">{(id) => <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
          <Field label="Número de cuenta">{(id) => <Input id={id} value={form.number} onChange={(e) => set('number', e.target.value)} />}</Field>
          <Field label="Titular" className="sm:col-span-2">{(id) => <Input id={id} value={form.holder_name} onChange={(e) => set('holder_name', e.target.value)} />}</Field>
        </div>
      </div>
    </Drawer>
  )
}

// ---------------------------------------------------------------------------
// Importar cartola
// ---------------------------------------------------------------------------
const FIELDS: { key: keyof ColumnMapping; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Fecha', required: true },
  { key: 'description', label: 'Descripción' },
  { key: 'amount', label: 'Monto (con signo)' },
  { key: 'debit', label: 'Cargos' },
  { key: 'credit', label: 'Abonos' },
  { key: 'balance', label: 'Saldo' },
  { key: 'reference', label: 'N° operación / documento' },
]

export function ImportDrawer({ accounts, initialAccountId, onClose }: { accounts: BankFeedAccount[]; initialAccountId: string | null; onClose: () => void }) {
  const { tenant } = useCurrentTenant()
  const { importStatement } = useBankMutations()
  const [accountId, setAccountId] = useState(initialAccountId ?? accounts[0]?.id ?? '')
  const account = accounts.find((a) => a.id === accountId) ?? null
  const [file, setFile] = useState<File | null>(null)
  const [sheets, setSheets] = useState<{ name: string; grid: Grid }[]>([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [done, setDone] = useState<{ inserted: number; duplicates: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const grid = useMemo(() => sheets[sheetIndex]?.grid ?? [], [sheets, sheetIndex])
  const headers = mapping && mapping.headerRow >= 0 ? (grid[mapping.headerRow] ?? []).map((c, i) => (c == null || String(c).trim() === '' ? `Columna ${i + 1}` : String(c))) : []
  const width = Math.max(headers.length, ...grid.slice(0, 50).map((r) => r.length))
  const columnOptions = Array.from({ length: width }, (_, i) => ({ value: i, label: headers[i] ?? `Columna ${i + 1}` }))
  const result = useMemo(() => (mapping && account && mapping.headerRow >= 0 ? parseStatement(grid, mapping, account.currency, tenant.country) : null), [grid, mapping, account, tenant.country])
  const credits = result?.rows.filter((r) => r.amount > 0) ?? []
  const debits = result?.rows.filter((r) => r.amount < 0) ?? []

  const load = async (f: File) => {
    setError(null)
    setDone(null)
    setReading(true)
    try {
      const read = await readStatementFile(f)
      // La hoja con más filas suele ser la de movimientos.
      const best = read.sheets.reduce((bi, s, i, all) => (s.grid.length > all[bi].grid.length ? i : bi), 0)
      setFile(f)
      setSheets(read.sheets)
      setSheetIndex(best)
      setMapping(pickMapping(read.sheets[best].grid))
    } catch (e) {
      setError(`No se pudo leer el archivo: ${errorMessage(e)}`)
    } finally {
      setReading(false)
    }
  }
  // Si la cuenta ya tiene una configuración guardada y calza con el archivo, se reutiliza.
  const pickMapping = (g: Grid): ColumnMapping => {
    const detected = detectMapping(g)
    const saved = account?.import_mapping as Partial<ColumnMapping> | null
    if (saved && typeof saved.headerRow === 'number' && detected.headerRow === saved.headerRow) return { ...detected, ...saved } as ColumnMapping
    return detected
  }
  const setField = (key: keyof ColumnMapping, value: number | null) =>
    setMapping((m) => {
      if (!m) return m
      const next = { ...m, [key]: value }
      // Monto único y cargo/abono son excluyentes.
      if (key === 'amount' && value !== null) Object.assign(next, { debit: null, credit: null })
      if ((key === 'debit' || key === 'credit') && value !== null) next.amount = null
      return next
    })

  const submit = async () => {
    if (!account || !result || !mapping || !file) return
    setError(null)
    if (!result.rows.length) return setError('No encontramos movimientos con fecha y monto. Revisa la asignación de columnas.')
    try {
      const r = await importStatement.mutateAsync({
        accountId: account.id, fileName: file.name, mapping: mapping as unknown as Record<string, unknown>, closingBalance: result.closingBalance,
        rows: result.rows.map(({ line: _line, ...row }) => row),
      })
      setDone(r)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (done) {
    return (
      <Drawer open title="Cartola importada" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Ver movimientos</Button>}>
        <div className="flex flex-col gap-3 text-sm">
          <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-4 text-ok"><Check size={18} className="shrink-0" /> Se agregaron {done.inserted} movimientos a {account ? accountTitle(account) : 'la cuenta'}.</p>
          {done.duplicates > 0 && <p className="text-muted">{done.duplicates} movimientos ya estaban cargados (de una cartola anterior) y no se duplicaron.</p>}
          <p className="text-muted">Las sugerencias de conciliación ya están disponibles: revisa "Conciliar coincidencias".</p>
        </div>
      </Drawer>
    )
  }

  return (
    <Drawer
      open onClose={onClose} width="xl" title="Importar cartola" subtitle="Excel (.xlsx, .xls) o CSV descargado desde el banco."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={!result?.rows.length || importStatement.isPending}>
            {importStatement.isPending ? 'Importando…' : result?.rows.length ? `Importar ${result.rows.length} movimientos` : 'Importar'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <FormError error={error} />
        <Field label="Cuenta">
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => { setAccountId(e.target.value); setMapping(null); setSheets([]); setFile(null) }}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.institution_name} · {accountTitle(a)} ({a.currency})</option>)}
            </Select>
          )}
        </Field>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) load(f) }}
          className={clsx('flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-6 text-center', dragging ? 'border-brand-500 bg-brand-50' : 'border-line')}
        >
          <FileSpreadsheet size={26} className="text-muted" />
          {file ? (
            <p className="text-sm text-ink"><b>{file.name}</b>{sheets.length > 1 && ` · ${sheets.length} hojas`}</p>
          ) : (
            <p className="text-sm text-muted">Arrastra aquí la cartola o elígela desde tu equipo.</p>
          )}
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={reading || !account}><Upload size={15} /> {reading ? 'Leyendo…' : file ? 'Elegir otro archivo' : 'Elegir archivo'}</Button>
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = '' }} />
        </div>

        {mapping && mapping.headerRow < 0 && (
          <p className="flex items-start gap-2 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> No encontramos la fila de encabezados (Fecha, Descripción, Cargo, Abono…). Revisa que el archivo sea la cartola de movimientos.
          </p>
        )}

        {mapping && mapping.headerRow >= 0 && account && (
          <>
            <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Columnas de la cartola</h3>
                <span className="text-xs text-faint">Las detectamos solas; corrígelas si algo no calza. Se recuerdan para la próxima cartola de esta cuenta.</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {sheets.length > 1 && (
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-faint">Hoja</span>
                    <Select value={sheetIndex} onChange={(e) => { const i = Number(e.target.value); setSheetIndex(i); setMapping(pickMapping(sheets[i].grid)) }}>
                      {sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
                    </Select>
                  </label>
                )}
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-faint">Fila de encabezados</span>
                  <Select value={mapping.headerRow} onChange={(e) => setMapping({ ...mapping, headerRow: Number(e.target.value) })}>
                    {grid.slice(0, 40).map((row, i) => <option key={i} value={i}>Fila {i + 1}: {row.filter((c) => c != null && String(c).trim()).slice(0, 3).join(' · ').slice(0, 40) || '(vacía)'}</option>)}
                  </Select>
                </label>
                {FIELDS.map((f) => (
                  <label key={f.key} className="text-sm">
                    <span className="mb-1 block text-xs text-faint">{f.label}{f.required && ' *'}</span>
                    <Select value={mapping[f.key] === null ? '' : String(mapping[f.key])} onChange={(e) => setField(f.key, e.target.value === '' ? null : Number(e.target.value))}>
                      <option value="">—</option>
                      {columnOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </Select>
                  </label>
                ))}
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-faint">Formato de fecha</span>
                  <Select value={mapping.dateOrder} onChange={(e) => setMapping({ ...mapping, dateOrder: e.target.value as ColumnMapping['dateOrder'] })}>
                    <option value="dmy">Día/mes/año</option>
                    <option value="mdy">Mes/día/año</option>
                    <option value="ymd">Año-mes-día</option>
                  </Select>
                </label>
              </div>
              {mapping.amount !== null && (
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={mapping.invertSign} onChange={(e) => setMapping({ ...mapping, invertSign: e.target.checked })} className="accent-navy-900" />
                  Los cargos vienen en positivo (invertir el signo)
                </label>
              )}
            </section>

            {result && (
              <section className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Summary label="Movimientos" value={String(result.rows.length)} detail={result.firstDate ? `${formatDate(result.firstDate)} al ${formatDate(result.lastDate)}` : undefined} />
                  <Summary label="Abonos" value={<Money minor={credits.reduce((s, r) => s + r.amount, 0)} currency={account.currency} />} detail={`${credits.length} movimientos`} />
                  <Summary label="Cargos" value={<Money minor={debits.reduce((s, r) => s + r.amount, 0)} currency={account.currency} />} detail={`${debits.length} movimientos`} />
                  <Summary label="Saldo final" value={result.closingBalance !== null ? <Money minor={result.closingBalance} currency={account.currency} /> : '—'} detail="según la cartola" />
                </div>
                {result.skipped.length > 0 && (
                  <p className="text-xs text-faint">
                    Se omiten {result.skipped.length} filas sin fecha o monto (totales, saldos iniciales, notas): filas {result.skipped.slice(0, 8).map((s) => s.line).join(', ')}{result.skipped.length > 8 ? '…' : ''}.
                  </p>
                )}
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-subtle text-left text-xs text-faint">
                      <tr><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Referencia</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2 text-right">Saldo</th></tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {result.rows.slice(0, 12).map((r) => (
                        <tr key={r.key}>
                          <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(r.post_date)}</td>
                          <td className="max-w-80 truncate px-3 py-1.5">{r.description || '—'}{r.counterparty_tax_id && <Badge tone="info">{r.counterparty_tax_id}</Badge>}</td>
                          <td className="px-3 py-1.5 text-muted">{r.reference ?? ''}</td>
                          <td className={clsx('px-3 py-1.5 text-right font-medium', r.amount > 0 ? 'text-ok' : 'text-ink')}><Money minor={r.amount} currency={account.currency} /></td>
                          <td className="px-3 py-1.5 text-right text-muted">{r.balance !== null ? <Money minor={r.balance} currency={account.currency} /> : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.rows.length > 12 && <p className="border-t border-line px-3 py-2 text-xs text-faint">… y {result.rows.length - 12} movimientos más.</p>}
                </div>
                <p className="text-xs text-faint">Si ya importaste una cartola que se superpone con esta, los movimientos repetidos no se duplican.</p>
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  )
}

function Summary({ label, value, detail }: { label: string; value: React.ReactNode; detail?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-[10px] font-semibold tracking-wider text-faint uppercase">{label}</div>
      <div className="text-[15px] font-semibold text-ink tabular">{value}</div>
      {detail && <div className="text-[11px] text-faint">{detail}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Historial de importaciones
// ---------------------------------------------------------------------------
export function ImportsDrawer({ account, onClose }: { account: BankFeedAccount; onClose: () => void }) {
  const { tenant, canWrite } = useCurrentTenant()
  const imports = useBankImports()
  const { deleteImport } = useBankMutations()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const rows = (imports.data ?? []).filter((i) => i.account_id === account.id)

  const undo = async (id: string, name: string | null) => {
    if (!confirm(`¿Deshacer la importación de ${name ?? 'la cartola'}? Se borran sus movimientos que no estén conciliados.`)) return
    setError(null)
    try {
      const r = await deleteImport.mutateAsync(id)
      setNotice(r.kept ? `Se borraron ${r.deleted} movimientos; ${r.kept} se mantienen porque ya están conciliados.` : `Se borraron ${r.deleted} movimientos.`)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Drawer open onClose={onClose} width="lg" title="Cartolas importadas" subtitle={`${account.institution_name} · ${accountTitle(account)}`}>
      <div className="flex flex-col gap-3">
        <FormError error={error} />
        {notice && <p className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok">{notice}</p>}
        {imports.isLoading && <p className="text-sm text-faint">Cargando…</p>}
        {!imports.isLoading && !rows.length && <p className="text-sm text-faint">Aún no se han importado cartolas en esta cuenta.</p>}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium text-ink">{i.file_name ?? 'Cartola'}</div>
                <div className="text-xs text-faint">
                  {formatTimestamp(i.created_at, tenant.timezone)} · {i.inserted} movimientos{i.duplicates ? ` (${i.duplicates} ya estaban)` : ''}
                  {i.first_date && ` · ${formatDate(i.first_date)} al ${formatDate(i.last_date)}`}
                </div>
              </div>
              {canWrite && <Button size="sm" onClick={() => undo(i.id, i.file_name)} disabled={deleteImport.isPending}>Deshacer</Button>}
            </li>
          ))}
        </ul>
      </div>
    </Drawer>
  )
}
