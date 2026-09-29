import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPurchaseOrderPdf } from './purchaseOrderPdf'

describe('PDF de orden de compra', () => {
  it('genera un PDF con varias páginas cuando hay muchas líneas', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Ítem ${i + 1} con descripción larga para probar el corte de línea en la tabla`, quantity: 2, unit_price: 15000, discount: 0, amount: 30000 }))
    const bytes = await buildPurchaseOrderPdf({
      order: {
        direction: 'payable', number: 'OC-00010', counterparty_name: 'Proveedor Ñandú SpA', counterparty_tax_id: '76086428-5', issue_date: '2026-09-29',
        delivery_date: null, currency: 'CLP', payment_terms_days: 30, payment_method: 'Transferencia', requester: 'Producción', description: 'Compra de prueba',
        net_amount: 1_800_000, exempt_amount: 0, tax_amount: 342_000, total_amount: 2_142_000, notes: 'Entregar en bodega → puerta 2',
      },
      lines,
      tenant: { name: 'Empresa Demo', taxId: '76086428-5', country: 'CL' },
      statusLabel: 'Aprobada',
    })
    const text = new TextDecoder('latin1').decode(bytes.slice(0, 8))
    expect(text.startsWith('%PDF')).toBe(true)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1)
  })
})
