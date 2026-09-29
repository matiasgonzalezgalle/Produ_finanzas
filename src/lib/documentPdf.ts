// Ficha PDF de un documento (resumen para compartir o archivar).
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import type { DocumentRow } from '../data'
import { formatDate } from '../domain/dates'
import { documentTypeLabel, TAX_LABEL } from '../domain/documents'
import { formatMoney } from '../domain/money'
import type { Country } from '../domain/taxId'
import { formatTaxId } from '../domain/taxId'

const NAVY = rgb(0.086, 0.094, 0.114)
const MUTED = rgb(0.36, 0.38, 0.46)
const LINE = rgb(0.92, 0.93, 0.95)

/** Las fuentes estándar de PDF solo soportan Latin-1 (WinAnsi): se reemplaza lo demás. */
function safe(text: string): string {
  return text.normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  let t = safe(text)
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`.replace('…', '...'), size) > maxWidth) t = t.slice(0, -1)
  return `${t}...`
}

export async function buildDocumentPdf(params: {
  doc: DocumentRow
  tenantName: string
  country: Country
  attachments: string[]
}): Promise<Uint8Array> {
  const { doc, tenantName, country, attachments } = params
  const pdf = await PDFDocument.create()
  const page: PDFPage = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const left = 48
  const right = 547
  let y = 790

  const text = (value: string, x: number, size = 10, f = font, color = rgb(0.1, 0.12, 0.18), maxWidth = right - x) =>
    page.drawText(fit(value, f, size, maxWidth), { x, y, size, font: f, color })
  const textRight = (value: string, size = 10, f = font) => {
    const t = safe(value)
    page.drawText(t, { x: right - f.widthOfTextAtSize(t, size), y, size, font: f, color: rgb(0.1, 0.12, 0.18) })
  }

  page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: NAVY })
  y = 822
  page.drawText(safe(tenantName), { x: left, y, size: 11, font: bold, color: rgb(1, 1, 1) })

  y = 770
  text(`${documentTypeLabel(doc.doc_type)} N° ${doc.folio}`, left, 18, bold, NAVY)
  y -= 20
  text(doc.direction === 'payable' ? 'Cuenta por pagar' : 'Cuenta por cobrar', left, 10, font, MUTED)

  y -= 34
  text(doc.direction === 'payable' ? 'Proveedor' : 'Cliente', left, 9, font, MUTED)
  y -= 14
  text(doc.counterparty_name, left, 12, bold)
  if (doc.counterparty_tax_id) {
    y -= 14
    text(formatTaxId(doc.counterparty_tax_id, country), left, 10, font, MUTED)
  }

  const rows: [string, string][] = [
    ['Emisión', formatDate(doc.issue_date)],
    ['Vencimiento', formatDate(doc.due_date)],
    ['Pago agendado', formatDate(doc.scheduled_payment_date)],
    ['Moneda', doc.currency],
  ]
  y -= 30
  for (const [label, value] of rows) {
    text(label, left, 10, font, MUTED)
    textRight(value)
    y -= 8
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: LINE })
    y -= 14
  }

  const amounts: [string, number, boolean?][] = []
  if (doc.net_amount) amounts.push(['Neto', doc.net_amount])
  if (doc.exempt_amount) amounts.push(['Exento', doc.exempt_amount])
  if (doc.tax_amount) amounts.push([TAX_LABEL[country], doc.tax_amount])
  amounts.push(['Total', doc.total_amount, true])
  if (doc.credits_amount) amounts.push(['Notas de crédito', -doc.credits_amount])
  if (doc.detraction_amount) amounts.push([`Detracción ${doc.detraction_rate}%`, -doc.detraction_amount])
  amounts.push([doc.direction === 'payable' ? 'Pagado' : 'Cobrado', -doc.paid_amount])
  amounts.push(['Saldo pendiente', doc.pending_amount, true])

  y -= 12
  for (const [label, value, strong] of amounts) {
    text(label, left, strong ? 11 : 10, strong ? bold : font, strong ? NAVY : MUTED)
    textRight(formatMoney(value, doc.currency), strong ? 11 : 10, strong ? bold : font)
    y -= 8
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: LINE })
    y -= 14
  }

  if (doc.description) {
    y -= 10
    text('Descripción', left, 9, font, MUTED)
    y -= 14
    const words = safe(doc.description).split(/\s+/)
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(next, 10) > right - left) {
        text(line, left)
        y -= 14
        line = w
        if (y < 80) break
      } else line = next
    }
    if (line && y >= 80) text(line, left)
    y -= 14
  }

  if (attachments.length && y > 100) {
    y -= 10
    text('Archivos adjuntos', left, 9, font, MUTED)
    for (const name of attachments.slice(0, 10)) {
      y -= 14
      text(`- ${name}`, left)
    }
  }

  y = 40
  text(`Generado el ${new Date().toLocaleString('es-CL')} · Produ Finanzas`, left, 8, font, MUTED)
  return pdf.save()
}

export function downloadBlob(bytes: Uint8Array | Blob, filename: string, type = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
