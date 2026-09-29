// PDF de una orden de compra (para enviar al proveedor o archivar la OC del cliente).
import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib'
import type { PurchaseOrderLine, PurchaseOrderRow } from '../data'

/** Lo que necesita el PDF (sirve para la vista interna y para el portal). */
export type PurchaseOrderPdfData = Pick<
  PurchaseOrderRow,
  'direction' | 'number' | 'counterparty_name' | 'counterparty_tax_id' | 'issue_date' | 'delivery_date' | 'currency' | 'payment_terms_days' |
  'payment_method' | 'requester' | 'description' | 'net_amount' | 'exempt_amount' | 'tax_amount' | 'total_amount' | 'notes'
>
import { formatDate } from '../domain/dates'
import { TAX_LABEL } from '../domain/documents'
import { formatMoney } from '../domain/money'
import { formatTaxId, type Country } from '../domain/taxId'

const NAVY = rgb(0.086, 0.094, 0.114)
const INK = rgb(0.1, 0.12, 0.18)
const MUTED = rgb(0.36, 0.38, 0.46)
const LINE = rgb(0.92, 0.93, 0.95)
const HEAD = rgb(0.965, 0.969, 0.976)

function safe(text: string): string {
  return text.normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  let t = safe(text)
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxWidth) t = t.slice(0, -1)
  return `${t}...`
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of safe(text).split(/\n+/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
        lines.push(line)
        line = word
      } else line = next
    }
    if (line) lines.push(line)
  }
  return lines
}

const quantityText = (q: number) => q.toLocaleString('es-CL', { maximumFractionDigits: 4 })

export async function buildPurchaseOrderPdf(params: {
  order: PurchaseOrderPdfData
  lines: PurchaseOrderLine[]
  tenant: { name: string; taxId: string | null; country: Country }
  statusLabel: string
}): Promise<Uint8Array> {
  const { order, lines, tenant, statusLabel } = params
  const isPayable = order.direction === 'payable'
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const left = 48
  const right = 547
  let page = pdf.addPage([595, 842])
  let y = 0

  const text = (value: string, x: number, size = 10, f = font, color = INK, maxWidth = right - x) =>
    page.drawText(fit(value, f, size, maxWidth), { x, y, size, font: f, color })
  const textRight = (value: string, xRight: number, size = 10, f = font, color = INK) => {
    const t = safe(value)
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f, color })
  }
  const rule = () => page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: LINE })

  function header() {
    page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: NAVY })
    y = 822
    page.drawText(safe(tenant.name), { x: left, y, size: 11, font: bold, color: rgb(1, 1, 1) })
    if (tenant.taxId) {
      const t = safe(formatTaxId(tenant.taxId, tenant.country))
      page.drawText(t, { x: right - font.widthOfTextAtSize(t, 9), y, size: 9, font, color: rgb(1, 1, 1) })
    }
  }
  header()

  y = 770
  text(isPayable ? 'Orden de compra' : 'Orden de compra del cliente', left, 10, font, MUTED)
  textRight(statusLabel, right, 10, bold, MUTED)
  y -= 22
  text(`N° ${order.number}`, left, 20, bold, NAVY)

  // Contraparte y datos de la orden en dos columnas.
  y -= 34
  const top = y
  text(isPayable ? 'Proveedor' : 'Cliente', left, 9, font, MUTED)
  y -= 14
  text(order.counterparty_name, left, 12, bold, INK, 250)
  if (order.counterparty_tax_id) {
    y -= 14
    text(formatTaxId(order.counterparty_tax_id, tenant.country), left, 10, font, MUTED)
  }
  const leftBottom = y

  y = top
  const facts: [string, string][] = [
    ['Emisión', formatDate(order.issue_date)],
    ['Entrega', formatDate(order.delivery_date)],
    ['Moneda', order.currency],
  ]
  if (order.payment_terms_days != null) facts.push(['Plazo de pago', `${order.payment_terms_days} días`])
  if (order.payment_method) facts.push(['Forma de pago', order.payment_method])
  if (isPayable && order.requester) facts.push(['Solicitante', order.requester])
  for (const [label, value] of facts) {
    text(label, 330, 9, font, MUTED)
    textRight(value, right, 9)
    y -= 15
  }
  y = Math.min(leftBottom, y) - 18

  if (order.description) {
    text(order.description, left, 11, bold, INK)
    y -= 20
  }

  // Detalle
  const cols = { desc: left + 8, qty: 350, price: 430, disc: 485, amount: right - 8 }
  const tableHeader = () => {
    page.drawRectangle({ x: left, y: y - 6, width: right - left, height: 20, color: HEAD })
    y += 1
    text('Descripción', cols.desc, 8, bold, MUTED)
    textRight('Cant.', cols.qty, 8, bold, MUTED)
    textRight('Precio unit.', cols.price, 8, bold, MUTED)
    textRight('Desc.', cols.disc, 8, bold, MUTED)
    textRight('Subtotal', cols.amount, 8, bold, MUTED)
    y -= 22
  }
  if (lines.length) {
    tableHeader()
    for (const line of lines) {
      const descLines = wrap(line.description, font, 9, cols.qty - cols.desc - 60)
      if (y - descLines.length * 12 < 170) {
        page = pdf.addPage([595, 842])
        header()
        y = 780
        tableHeader()
      }
      textRight(quantityText(line.quantity), cols.qty, 9)
      textRight(formatMoney(line.unit_price, order.currency), cols.price, 9)
      textRight(line.discount ? formatMoney(line.discount, order.currency) : '-', cols.disc, 9)
      textRight(formatMoney(line.amount, order.currency), cols.amount, 9)
      for (const [i, l] of descLines.entries()) {
        if (i) y -= 12
        text(l, cols.desc, 9)
      }
      y -= 8
      rule()
      y -= 14
    }
  }

  // Totales
  y -= 6
  const totals: [string, number, boolean?][] = []
  if (order.net_amount) totals.push([order.tax_amount ? 'Neto' : 'Subtotal', order.net_amount])
  if (order.exempt_amount) totals.push(['Exento', order.exempt_amount])
  if (order.tax_amount) totals.push([TAX_LABEL[tenant.country], order.tax_amount])
  totals.push(['Total', order.total_amount, true])
  for (const [label, value, strong] of totals) {
    text(label, 360, strong ? 11 : 10, strong ? bold : font, strong ? NAVY : MUTED)
    textRight(formatMoney(value, order.currency), right, strong ? 11 : 10, strong ? bold : font)
    y -= 18
  }

  if (order.notes) {
    y -= 10
    text('Observaciones', left, 9, font, MUTED)
    for (const l of wrap(order.notes, font, 9, right - left).slice(0, 12)) {
      y -= 13
      if (y < 60) break
      text(l, left, 9)
    }
  }

  y = 40
  text(`Generado el ${new Date().toLocaleString('es-CL')} · Produ Finanzas`, left, 8, font, MUTED)
  return pdf.save()
}
