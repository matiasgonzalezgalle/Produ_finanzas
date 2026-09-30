// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { decodeXml, parseXmlDocuments } from './dteXml'

const envio = `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioDTE xmlns="http://www.sii.cl/SiiDte" version="1.0"><SetDTE ID="SetDoc">
  <Caratula><RutEmisor>77217248-6</RutEmisor></Caratula>
  <DTE version="1.0"><Documento ID="F555T33"><Encabezado>
    <IdDoc><TipoDTE>33</TipoDTE><Folio>555</Folio><FchEmis>2026-09-20</FchEmis><FchVenc>2026-10-20</FchVenc></IdDoc>
    <Emisor><RUTEmisor>77217248-6</RUTEmisor><RznSoc>Transportes Andinos Ltda.</RznSoc></Emisor>
    <Receptor><RUTRecep>76086428-5</RUTRecep><RznSocRecep>Nube Films SpA</RznSocRecep></Receptor>
    <Totales><MntNeto>100000</MntNeto><TasaIVA>19</TasaIVA><IVA>19000</IVA><MntTotal>119000</MntTotal></Totales>
  </Encabezado><Detalle><NroLinDet>1</NroLinDet><NmbItem>Flete</NmbItem></Detalle></Documento></DTE>
  <DTE version="1.0"><Documento ID="F12T61"><Encabezado>
    <IdDoc><TipoDTE>61</TipoDTE><Folio>12</Folio><FchEmis>2026-09-22</FchEmis></IdDoc>
    <Emisor><RUTEmisor>77217248-6</RUTEmisor><RznSoc>Transportes Andinos Ltda.</RznSoc></Emisor>
    <Receptor><RUTRecep>76086428-5</RUTRecep></Receptor>
    <Totales><MntNeto>10000</MntNeto><IVA>1900</IVA><MntTotal>11900</MntTotal></Totales>
  </Encabezado><Referencia><NroLinRef>1</NroLinRef><TpoDocRef>33</TpoDocRef><FolioRef>555</FolioRef><RazonRef>Descuento por atraso</RazonRef></Referencia></Documento></DTE>
</SetDTE></EnvioDTE>`

const export110 = `<DTE xmlns="http://www.sii.cl/SiiDte"><Exportaciones ID="E1"><Encabezado>
  <IdDoc><TipoDTE>110</TipoDTE><Folio>7</Folio><FchEmis>2026-09-25</FchEmis></IdDoc>
  <Emisor><RUTEmisor>76086428-5</RUTEmisor><RznSoc>Nube Films SpA</RznSoc></Emisor>
  <Receptor><RUTRecep>55555555-5</RUTRecep><RznSocRecep>Streaming Inc.</RznSocRecep></Receptor>
  <Totales><TpoMoneda>DOLAR USA</TpoMoneda><MntExe>1299.50</MntExe><MntTotal>1299.50</MntTotal></Totales>
</Encabezado></Exportaciones></DTE>`

const ubl = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>F001-000123</cbc:ID><cbc:IssueDate>2026-09-20</cbc:IssueDate><cbc:DueDate>2026-10-20</cbc:DueDate>
  <cbc:InvoiceTypeCode listID="1001">01</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">20601234567</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Estudio Lima SAC</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">20100070970</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Supermercados Peruanos S.A.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentTerms><cbc:ID>Detraccion</cbc:ID><cbc:PaymentMeansID>037</cbc:PaymentMeansID><cbc:PaymentPercent>12</cbc:PaymentPercent><cbc:Amount currencyID="PEN">141.60</cbc:Amount></cac:PaymentTerms>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">180.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">1000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">180.00</cbc:TaxAmount>
      <cac:TaxCategory><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">1180.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">180.00</cbc:TaxAmount></cac:TaxTotal></cac:InvoiceLine>
</Invoice>`

describe('XML de documentos tributarios', () => {
  it('Chile: EnvioDTE con factura y nota de crédito referenciada', () => {
    const r = parseXmlDocuments([{ name: 'envio.xml', text: envio }])
    expect(r.errors).toEqual([])
    expect(r.documents.map((d) => [d.type_code, d.doc_type, d.folio, d.total_amount])).toEqual([['33', 'factura', '555', 119000], ['61', 'nota_credito', '12', 11900]])
    expect(r.documents[0]).toMatchObject({ issuer_tax_id: '77217248-6', receiver_tax_id: '76086428-5', net_amount: 100000, tax_amount: 19000, due_date: '2026-10-20', currency: 'CLP' })
    expect(r.documents[1]).toMatchObject({ reference_folio: '555' })
    expect(r.documents[1].description).toContain('Descuento por atraso')
    expect(r.documents[0].xml).toContain('F555T33')
    expect(r.documents[0].xml).not.toContain('F12T61')
  })

  it('Chile: factura de exportación en dólares', () => {
    const [d] = parseXmlDocuments([{ name: 'exp.xml', text: export110 }]).documents
    expect(d).toMatchObject({ doc_type: 'invoice', currency: 'USD', exempt_amount: 129950, total_amount: 129950, receiver_name: 'Streaming Inc.' })
  })

  it('Perú: factura UBL con IGV y detracción', () => {
    const [d] = parseXmlDocuments([{ name: 'F001-123.xml', text: ubl }]).documents
    expect(d).toMatchObject({
      country: 'PE', doc_type: 'factura', folio: 'F001-000123', currency: 'PEN', net_amount: 100000, tax_amount: 18000, total_amount: 118000,
      issuer_tax_id: '20601234567', receiver_tax_id: '20100070970', due_date: '2026-10-20', detraction_rate: 12, detraction_amount: 14160,
    })
  })

  it('errores: XML inválido o sin documentos; decodifica ISO-8859-1', () => {
    const r = parseXmlDocuments([{ name: 'roto.xml', text: '<a><b></a>' }, { name: 'acuse.xml', text: '<RespuestaDTE><Resultado/></RespuestaDTE>' }])
    expect(r.errors.map((e) => e.fileName)).toEqual(['roto.xml', 'acuse.xml'])
    const latin1 = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><a>Pacífico</a>'].map((c) => c.charCodeAt(0)))
    expect(decodeXml(latin1)).toContain('Pacífico')
  })
})
