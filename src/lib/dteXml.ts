// Lectura de documentos tributarios electrónicos en XML:
//   Chile: DTE del SII (EnvioDTE, EnvioBOLETA o DTE suelto; un archivo puede traer varios).
//   Perú:  comprobantes UBL 2.1 de SUNAT (Invoice, CreditNote, DebitNote).
// Solo se leen los datos; la firma digital no se valida (el estado en el SII lo informa Fintoc).
import type { DocumentTypeCode as DocumentType } from '../domain/documents'
import { CURRENCY_DECIMALS, type Currency } from '../domain/money'

export interface ParsedXmlDocument {
  key: string
  fileName: string
  country: 'CL' | 'PE'
  /** Código del tipo (DTE 33, 61… / SUNAT 01, 03, 07, 08). */
  type_code: string
  type_label: string
  /** null: el tipo no se registra como documento (guías, liquidaciones…). */
  doc_type: DocumentType | null
  folio: string
  issue_date: string
  due_date: string | null
  currency: Currency
  net_amount: number
  exempt_amount: number
  tax_amount: number
  total_amount: number
  issuer_tax_id: string
  issuer_name: string
  receiver_tax_id: string
  receiver_name: string
  reference_folio: string | null
  /** Factura de compra (DTE 46): la emite el comprador. */
  buyer_issued?: boolean
  detraction_rate?: number
  detraction_amount?: number
  description: string
  /** XML de este documento (para adjuntarlo como respaldo). */
  xml: string
}

export interface XmlParseResult {
  documents: ParsedXmlDocument[]
  errors: { fileName: string; reason: string }[]
}

const CL_TYPES: Record<string, { label: string; doc: DocumentType | null; buyerIssued?: boolean }> = {
  '33': { label: 'Factura electrónica', doc: 'factura' },
  '34': { label: 'Factura exenta electrónica', doc: 'factura_exenta' },
  '39': { label: 'Boleta electrónica', doc: 'boleta' },
  '41': { label: 'Boleta exenta electrónica', doc: 'boleta' },
  '43': { label: 'Liquidación factura', doc: null },
  '46': { label: 'Factura de compra electrónica', doc: 'factura', buyerIssued: true },
  '52': { label: 'Guía de despacho', doc: null },
  '56': { label: 'Nota de débito electrónica', doc: 'nota_debito' },
  '61': { label: 'Nota de crédito electrónica', doc: 'nota_credito' },
  '110': { label: 'Factura de exportación', doc: 'invoice' },
  '111': { label: 'Nota de débito de exportación', doc: 'nota_debito' },
  '112': { label: 'Nota de crédito de exportación', doc: 'nota_credito' },
}

const PE_TYPES: Record<string, { label: string; doc: DocumentType }> = {
  '01': { label: 'Factura electrónica', doc: 'factura' },
  '03': { label: 'Boleta de venta electrónica', doc: 'boleta' },
  '07': { label: 'Nota de crédito electrónica', doc: 'nota_credito' },
  '08': { label: 'Nota de débito electrónica', doc: 'nota_debito' },
}

// Monedas de exportación (TpoMoneda del SII) y códigos ISO.
const CL_CURRENCY: Record<string, Currency> = { 'PESO CL': 'CLP', 'DOLAR USA': 'USD', 'DOLAR ESTADOUNIDENSE': 'USD', EURO: 'EUR' }
const toCurrency = (code: string | null | undefined, fallback: Currency): Currency => {
  const c = (code ?? '').trim().toUpperCase()
  if (!c) return fallback
  if (['CLP', 'PEN', 'USD', 'EUR'].includes(c)) return c as Currency
  return CL_CURRENCY[c] ?? fallback
}
const toMinor = (text: string | null | undefined, currency: Currency) => {
  const value = Number(String(text ?? '').trim().replace(',', '.'))
  return Number.isFinite(value) ? Math.round(value * 10 ** CURRENCY_DECIMALS[currency]) : 0
}

/** Nombre local sin prefijo ("cbc:ID" → "ID"), igual en navegadores y en pruebas. */
const localName = (el: Element) => (el.localName || el.nodeName).replace(/^.*:/, '')

/** Descendientes con ese nombre local (ignora los espacios de nombres y prefijos). */
function children(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => localName(el) === name)
}
function first(root: Element | Document, name: string): Element | null {
  return children(root, name)[0] ?? null
}
function text(root: Element | Document | null, ...path: string[]): string {
  let node: Element | Document | null = root
  for (const p of path) {
    if (!node) return ''
    node = first(node, p)
  }
  return (node?.textContent ?? '').trim()
}

function parseChile(doc: Document, fileName: string, serializer: XMLSerializer): ParsedXmlDocument[] {
  const nodes = children(doc.documentElement, 'DTE')
  // Un DTE suelto como raíz.
  if (!nodes.length && localName(doc.documentElement) === 'DTE') nodes.push(doc.documentElement)
  return nodes.map((dte, i) => {
    const body = first(dte, 'Documento') ?? first(dte, 'Exportaciones') ?? first(dte, 'Liquidacion') ?? dte
    const idDoc = first(body, 'IdDoc')
    const typeCode = text(idDoc, 'TipoDTE')
    const type = CL_TYPES[typeCode]
    const totales = first(body, 'Totales')
    const currency = toCurrency(text(totales, 'TpoMoneda'), 'CLP')
    const ref = children(body as Element, 'Referencia').find((r) => text(r, 'FolioRef') && text(r, 'TpoDocRef') !== 'SET')
    const folio = text(idDoc, 'Folio')
    const issuer = first(body, 'Emisor')
    const receiver = first(body, 'Receptor')
    return {
      key: `${fileName}#${i}`,
      fileName,
      country: 'CL' as const,
      type_code: typeCode,
      type_label: type?.label ?? `DTE ${typeCode || '?'}`,
      doc_type: type?.doc ?? null,
      buyer_issued: type?.buyerIssued,
      folio,
      issue_date: text(idDoc, 'FchEmis'),
      due_date: text(idDoc, 'FchVenc') || null,
      currency,
      net_amount: toMinor(text(totales, 'MntNeto'), currency),
      exempt_amount: toMinor(text(totales, 'MntExe'), currency),
      tax_amount: toMinor(text(totales, 'IVA'), currency),
      total_amount: toMinor(text(totales, 'MntTotal'), currency),
      issuer_tax_id: text(issuer, 'RUTEmisor'),
      issuer_name: text(issuer, 'RznSoc') || text(issuer, 'RznSocEmisor'),
      receiver_tax_id: text(receiver, 'RUTRecep'),
      receiver_name: text(receiver, 'RznSocRecep'),
      reference_folio: ref ? text(ref, 'FolioRef') : null,
      description: `Importado desde XML (${type?.label ?? `DTE ${typeCode}`}).${ref && text(ref, 'RazonRef') ? ` ${text(ref, 'RazonRef')}` : ''}`,
      xml: `<?xml version="1.0" encoding="ISO-8859-1"?>\n${serializer.serializeToString(dte)}`,
    }
  })
}

function parsePeru(doc: Document, fileName: string, xml: string): ParsedXmlDocument[] {
  const root = doc.documentElement
  const kind = localName(root) // Invoice | CreditNote | DebitNote
  const typeCode = kind === 'CreditNote' ? '07' : kind === 'DebitNote' ? '08' : text(root, 'InvoiceTypeCode') || '01'
  const type = PE_TYPES[typeCode]
  const currency = toCurrency(text(root, 'DocumentCurrencyCode'), 'PEN')
  const partyId = (party: Element | null) => text(party, 'PartyIdentification', 'ID') || text(party, 'CompanyID')
  const partyName = (party: Element | null) => text(party, 'PartyLegalEntity', 'RegistrationName') || text(party, 'PartyName', 'Name') || text(party, 'RegistrationName')
  const supplier = first(root, 'AccountingSupplierParty')
  const customer = first(root, 'AccountingCustomerParty')
  // Totales: IGV (1000) grava; exonerado (9997), inafecto (9998) y exportación (9995) no.
  let net = 0
  let exempt = 0
  let tax = 0
  // El TaxTotal del documento (no el de cada línea).
  const taxTotal = Array.from(root.children).find((c) => localName(c) === 'TaxTotal') ?? null
  for (const sub of taxTotal ? children(taxTotal, 'TaxSubtotal') : []) {
    const scheme = text(sub, 'TaxCategory', 'TaxScheme', 'ID')
    const taxable = toMinor(text(sub, 'TaxableAmount'), currency)
    const amount = toMinor(text(sub, 'TaxAmount'), currency)
    if (scheme === '1000' || scheme === '1016') { net += taxable; tax += amount }
    else if (['9995', '9997', '9998'].includes(scheme)) exempt += taxable
    else tax += amount
  }
  const monetary = first(root, 'LegalMonetaryTotal') ?? first(root, 'RequestedMonetaryTotal')
  const total = toMinor(text(monetary, 'PayableAmount'), currency)
  if (!net && !exempt) net = Math.max(0, total - tax)
  // Detracción (SPOT): término de pago "Detraccion" con porcentaje y monto.
  const detraction = children(root, 'PaymentTerms').find((t) => /detrac/i.test(text(t, 'ID')))
  const detractionRate = detraction ? Number(text(detraction, 'PaymentPercent')) || 0 : 0
  const detractionAmount = detraction ? toMinor(text(detraction, 'Amount'), currency) : 0
  const due = text(root, 'DueDate') || children(root, 'PaymentTerms').map((t) => text(t, 'PaymentDueDate')).filter(Boolean).sort().pop() || null
  const reference = text(root, 'BillingReference', 'InvoiceDocumentReference', 'ID') || text(root, 'DiscrepancyResponse', 'ReferenceID') || null
  return [{
    key: `${fileName}#0`,
    fileName,
    country: 'PE',
    type_code: typeCode,
    type_label: type?.label ?? `Comprobante ${typeCode}`,
    doc_type: type?.doc ?? null,
    folio: text(root, 'ID'),
    issue_date: text(root, 'IssueDate'),
    due_date: due,
    currency,
    net_amount: net,
    exempt_amount: exempt,
    tax_amount: tax,
    total_amount: total,
    issuer_tax_id: partyId(supplier),
    issuer_name: partyName(supplier),
    receiver_tax_id: partyId(customer),
    receiver_name: partyName(customer),
    reference_folio: reference,
    detraction_rate: detractionRate,
    detraction_amount: detractionAmount,
    description: `Importado desde XML (${type?.label ?? `comprobante ${typeCode}`}).${text(root, 'DiscrepancyResponse', 'Description') ? ` ${text(root, 'DiscrepancyResponse', 'Description')}` : ''}`,
    xml,
  }]
}

/** Decodifica el archivo respetando su encoding (los DTE del SII suelen venir en ISO-8859-1). */
export function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 200))
  const declared = head.match(/encoding=["']([^"']+)["']/i)?.[1]?.toLowerCase()
  const encoding = declared && /8859|latin|1252/.test(declared) ? 'windows-1252' : 'utf-8'
  return new TextDecoder(encoding).decode(bytes)
}

export function parseXmlDocuments(files: { name: string; text: string }[]): XmlParseResult {
  const documents: ParsedXmlDocument[] = []
  const errors: XmlParseResult['errors'] = []
  const serializer = new XMLSerializer()
  for (const f of files) {
    const doc = new DOMParser().parseFromString(f.text, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) {
      errors.push({ fileName: f.name, reason: 'No es un XML válido' })
      continue
    }
    const root = localName(doc.documentElement)
    const found = ['Invoice', 'CreditNote', 'DebitNote'].includes(root) ? parsePeru(doc, f.name, f.text) : parseChile(doc, f.name, serializer)
    if (!found.length) {
      errors.push({ fileName: f.name, reason: 'No contiene documentos tributarios (¿es un acuse de recibo o un sobre sin DTE?)' })
      continue
    }
    for (const d of found) {
      if (!d.folio || !d.issue_date || !d.total_amount) errors.push({ fileName: f.name, reason: `${d.type_label}${d.folio ? ` N° ${d.folio}` : ''}: faltan folio, fecha o total` })
      else documents.push(d)
    }
  }
  return { documents, errors }
}
