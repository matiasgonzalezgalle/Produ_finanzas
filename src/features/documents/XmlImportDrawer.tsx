// Importar documentos tributarios desde su XML (DTE del SII en Chile, UBL de SUNAT en Perú).
// Se leen en el navegador, se muestra la vista previa y al importar se registran y se adjunta el XML.
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, Check, FileCode2, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCounterparties, useDocuments } from '../../app/queries'
import { useCurrentTenant } from '../../app/tenant'
import { api, type XmlImportResult } from '../../data'
import { formatDate } from '../../domain/dates'
import { formatMoney } from '../../domain/money'
import { formatTaxId } from '../../domain/taxId'
import { decodeXml, parseXmlDocuments, type ParsedXmlDocument } from '../../lib/dteXml'
import { Badge, Button, Drawer, FormError, type Tone } from '../../ui'
import { errorMessage } from '../shared'

const key = (v: string | null | undefined) => (v ?? '').replace(/[^0-9kK]/g, '').toUpperCase()
type Status = { label: string; tone: Tone; importable: boolean; direction: 'payable' | 'receivable' | null }

export function XmlImportDrawer({ onClose }: { onClose: () => void }) {
  const { tenant, hasModule } = useCurrentTenant()
  const qc = useQueryClient()
  const payables = useDocuments('payable')
  const receivables = useDocuments('receivable')
  const counterparties = useCounterparties()
  const inputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<{ documents: ParsedXmlDocument[]; errors: { fileName: string; reason: string }[] } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<(XmlImportResult & { doc: ParsedXmlDocument })[] | null>(null)
  const own = key(tenant.tax_id)
  const idLabel = tenant.country === 'PE' ? 'RUC' : 'RUT'

  const load = async (files: FileList | File[]) => {
    setError(null)
    setResults(null)
    const list = Array.from(files).filter((f) => /\.xml$/i.test(f.name))
    if (!list.length) return setError('Elige archivos .xml')
    if (list.length > 200) return setError('Máximo 200 archivos a la vez')
    const read = await Promise.all(list.map(async (f) => ({ name: f.name, text: decodeXml(new Uint8Array(await f.arrayBuffer())) })))
    setParsed(parseXmlDocuments(read))
  }

  // Sentido (venta/compra) y si ya está registrado, como lo decidirá el servidor.
  const statusOf = useMemo(() => {
    const docs = [...(payables.data ?? []), ...(receivables.data ?? [])]
    const cpById = new Map((counterparties.data ?? []).map((c) => [c.id, c]))
    return (d: ParsedXmlDocument): Status => {
      if (!d.doc_type) return { label: 'No se registra', tone: 'neutral', importable: false, direction: null }
      if (d.country !== tenant.country) return { label: `Es de ${d.country === 'PE' ? 'Perú' : 'Chile'}`, tone: 'bad', importable: false, direction: null }
      const issuerIsUs = key(d.issuer_tax_id) === own
      const direction = d.buyer_issued ? (issuerIsUs ? 'payable' : 'receivable') : issuerIsUs ? 'receivable' : key(d.receiver_tax_id) === own ? 'payable' : null
      if (!direction) return { label: `No es de tu ${idLabel}`, tone: 'bad', importable: false, direction: null }
      if (!hasModule(direction === 'payable' ? 'cuentas_por_pagar' : 'cuentas_por_cobrar')) return { label: 'Módulo no activo', tone: 'bad', importable: false, direction }
      const other = key(issuerIsUs ? d.receiver_tax_id : d.issuer_tax_id)
      const exists = docs.some((x) => x.direction === direction && x.doc_type === d.doc_type && x.folio === d.folio && x.status !== 'void' && key(cpById.get(x.counterparty_id)?.tax_id) === other)
      if (exists) return { label: 'Ya registrado', tone: 'neutral', importable: false, direction }
      return { label: 'Nuevo', tone: 'ok', importable: true, direction }
    }
  }, [payables.data, receivables.data, counterparties.data, own, tenant.country, idLabel, hasModule])

  const rows = (parsed?.documents ?? []).map((d) => ({ d, s: statusOf(d) }))
  const importable = rows.filter((r) => r.s.importable)
  const otherParty = (d: ParsedXmlDocument) => (key(d.issuer_tax_id) === own ? { name: d.receiver_name, tax: d.receiver_tax_id } : { name: d.issuer_name, tax: d.issuer_tax_id })

  const submit = async () => {
    if (!importable.length) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.importXmlDocuments(tenant.id, importable.map(({ d }) => ({
        key: d.key, type_code: d.type_code, doc_type: d.doc_type!, folio: d.folio, issue_date: d.issue_date, due_date: d.due_date, currency: d.currency,
        net_amount: d.net_amount, exempt_amount: d.exempt_amount, tax_amount: d.tax_amount, total_amount: d.total_amount,
        issuer_tax_id: d.issuer_tax_id, issuer_name: d.issuer_name, receiver_tax_id: d.receiver_tax_id, receiver_name: d.receiver_name,
        reference_folio: d.reference_folio, buyer_issued: d.buyer_issued, detraction_rate: d.detraction_rate, detraction_amount: d.detraction_amount,
        description: d.description,
      })))
      const byKey = new Map(importable.map(({ d }) => [d.key, d]))
      // El XML de cada documento queda adjunto como respaldo.
      for (const r of res) {
        const doc = byKey.get(r.key)
        if (r.status !== 'imported' || !r.document_id || !doc) continue
        const base = doc.type_label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
        const file = new File([doc.xml], `${base}-${doc.folio.replace(/[^\w-]+/g, '_')}.xml`, { type: 'application/xml' })
        await api.uploadAttachment(tenant.id, r.document_id, file).catch(() => undefined)
      }
      setResults(res.map((r) => ({ ...r, doc: byKey.get(r.key)! })))
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['documents', tenant.id] }),
        qc.invalidateQueries({ queryKey: ['counterparties', tenant.id] }),
        qc.invalidateQueries({ queryKey: ['sii-documents', tenant.id] }),
      ])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (results) {
    const imported = results.filter((r) => r.status === 'imported')
    const failed = results.filter((r) => r.status === 'error')
    return (
      <Drawer open onClose={onClose} width="lg" title="Importación desde XML" footer={<Button variant="primary" onClick={onClose}>Listo</Button>}>
        <div className="flex flex-col gap-3 text-sm">
          {imported.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-ok-bg p-3 text-ok">
              <Check size={18} className="shrink-0" />
              <span>
                Se {imported.length === 1 ? 'registró 1 documento' : `registraron ${imported.length} documentos`} con su XML adjunto
                {' ('}{[
                  imported.filter((r) => r.direction === 'payable').length && `${imported.filter((r) => r.direction === 'payable').length} en Cuentas por pagar`,
                  imported.filter((r) => r.direction === 'receivable').length && `${imported.filter((r) => r.direction === 'receivable').length} en Cuentas por cobrar`,
                ].filter(Boolean).join(' y ')}{').'}
              </span>
            </p>
          )}
          {results.filter((r) => r.status === 'exists').length > 0 && <p className="text-muted">{results.filter((r) => r.status === 'exists').length} ya estaban registrados y no se duplicaron.</p>}
          {failed.length > 0 && (
            <div className="rounded-lg border border-bad/30 p-3">
              <p className="mb-1 font-medium text-bad">No se importaron {failed.length}:</p>
              <ul className="list-disc pl-5 text-muted">
                {failed.map((r) => <li key={r.key}>{r.doc.type_label} N° {r.doc.folio}: {r.reason}</li>)}
              </ul>
            </div>
          )}
        </div>
      </Drawer>
    )
  }

  return (
    <Drawer
      open onClose={onClose} width="xl" title="Importar desde XML"
      subtitle={tenant.country === 'PE' ? 'Comprobantes electrónicos de SUNAT (UBL 2.1): facturas, boletas y notas.' : 'DTE del SII: facturas, notas de crédito y débito, boletas y exportación.'}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={submit} disabled={busy || !importable.length}>{busy ? 'Importando…' : importable.length ? `Importar ${importable.length} documentos` : 'Importar'}</Button></>}
    >
      <div className="flex flex-col gap-4">
        <FormError error={error} />
        {!own && (
          <p className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2.5 text-sm text-warn">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>Para saber si cada documento es una compra o una venta, registra el {idLabel} de tu empresa en <Link to="/configuracion/empresa" className="font-medium underline">Configuración › Empresa</Link>.</span>
          </p>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); load(e.dataTransfer.files) }}
          className={clsx('flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-6 text-center', dragging ? 'border-brand-500 bg-brand-50' : 'border-line')}
        >
          <FileCode2 size={26} className="text-muted" />
          <p className="text-sm text-muted">Arrastra aquí uno o varios XML{tenant.country === 'CL' ? ' (un archivo del SII puede traer varios DTE)' : ''}.</p>
          <Button size="sm" onClick={() => inputRef.current?.click()}><Upload size={15} /> Elegir archivos</Button>
          <input ref={inputRef} type="file" accept=".xml,application/xml,text/xml" multiple className="hidden" onChange={(e) => { if (e.target.files) load(e.target.files); e.target.value = '' }} />
        </div>

        {parsed && (
          <>
            {parsed.errors.length > 0 && (
              <div className="rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
                {parsed.errors.map((e, i) => <p key={i}>{e.fileName}: {e.reason}</p>)}
              </div>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-left text-xs text-faint">
                    <tr><th className="px-3 py-2">Documento</th><th className="px-3 py-2">Emisión</th><th className="px-3 py-2">Contraparte</th><th className="px-3 py-2">Va a</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2">Estado</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map(({ d, s }) => {
                      const other = otherParty(d)
                      return (
                        <tr key={d.key} className={clsx(!s.importable && 'text-muted')}>
                          <td className="px-3 py-2"><span className="block font-medium text-ink">{d.type_label} N° {d.folio}</span><span className="text-xs text-faint">{d.fileName}{d.reference_folio ? ` · ref. N° ${d.reference_folio}` : ''}</span></td>
                          <td className="px-3 py-2 whitespace-nowrap">{formatDate(d.issue_date)}</td>
                          <td className="px-3 py-2"><span className="block text-ink">{other.name || '—'}</span><span className="text-xs text-faint">{other.tax ? formatTaxId(other.tax, tenant.country) : ''}</span></td>
                          <td className="px-3 py-2 whitespace-nowrap">{s.direction === 'payable' ? 'Compra · CxP' : s.direction === 'receivable' ? 'Venta · CxC' : '—'}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">{formatMoney(d.total_amount, d.currency)}{d.detraction_amount ? <span className="block text-xs text-faint">detracción {formatMoney(d.detraction_amount, d.currency)}</span> : null}</td>
                          <td className="px-3 py-2"><Badge tone={s.tone}>{s.label}</Badge></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-faint">
              Se crea el {tenant.country === 'PE' ? 'cliente o proveedor' : 'cliente o proveedor'} si no existe y se adjunta el XML a cada documento. No se valida la firma digital{tenant.country === 'CL' ? ': el estado en el SII (aceptado, reclamado) lo informa la sincronización con Fintoc' : ''}.
            </p>
          </>
        )}
      </div>
    </Drawer>
  )
}
