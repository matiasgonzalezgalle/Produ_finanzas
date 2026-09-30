import { describe, expect, it } from 'vitest'
import { legacyBlocks, normalizeBlocks, renderRichText, richTextToPlain, sanitizeRichText } from '../functions/_shared/richText'

const style = { ink: '#111', muted: '#555', link: '#26e', font: 'Arial' }

describe('texto enriquecido de las plantillas', () => {
  it('deja solo etiquetas permitidas, sin atributos peligrosos', () => {
    expect(sanitizeRichText('<p onclick="x()">Hola <b>cliente</b><script>alert(1)</script></p>')).toBe('<p>Hola <b>cliente</b>alert(1)</p>')
    expect(sanitizeRichText('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>')).toBe('x')
    expect(sanitizeRichText('<a href="https://pago.cl/?a=1&amp;b=2" style="x">pagar</a>')).toBe('<a href="https://pago.cl/?a=1&amp;b=2">pagar</a>')
    expect(sanitizeRichText('<ul><li>uno<li>dos</ul>')).toBe('<ul><li>uno<li>dos</li></li></ul>')
    expect(sanitizeRichText('<div>a</div><p>b')).toBe('<p>a</p><p>b</p>')
    expect(sanitizeRichText('1 < 2 & 3')).toBe('1 &lt; 2 &amp; 3')
  })

  it('reemplaza variables escapadas; un href con variable se valida después', () => {
    const html = renderRichText('<p>Hola {{cliente}}, <a href="{{link_pago}}">paga aquí</a> <a href="{{cliente}}">x</a></p>', { cliente: 'A&B <S.A.>', link_pago: 'https://mpago.la/1' }, style)
    expect(html).toContain('Hola A&amp;B &lt;S.A.&gt;')
    expect(html).toContain('<a href="https://mpago.la/1" target="_blank"')
    expect(html).toContain('<a>x</a>')
    expect(html).toContain('<p style=')
    expect(renderRichText('<p>Link: {{link_pago}}</p>', { link_pago: 'https://mpago.la/9' }, style)).toContain('<a href="https://mpago.la/9" target="_blank"')
  })

  it('plantillas antiguas: texto, documentos y botón; texto plano para la lista', () => {
    const blocks = legacyBlocks('Hola {{cliente}},\n\nte escribimos.\nSaludos', true, false)
    expect(blocks.map((b) => b.type)).toEqual(['text', 'documents'])
    expect(richTextToPlain((blocks[0] as { html: string }).html)).toBe('Hola {{cliente}},\nte escribimos.\nSaludos')
    expect(normalizeBlocks([{ type: 'button' }, { type: 'otro' }, { type: 'text', html: '<script>x</script>' }])).toEqual([{ type: 'button' }, { type: 'text', html: 'x' }])
  })
})
