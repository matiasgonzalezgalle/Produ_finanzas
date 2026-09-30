// Bloques de las plantillas de correo en el navegador: limpieza del HTML del editor (lista blanca,
// igual que el servidor), conversión de plantillas antiguas y texto plano para listados.
import type { EmailBlock } from '../data'

const ALLOWED = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI', 'H2', 'H3'])
const RENAME: Record<string, string> = { DIV: 'P' }
const safeHref = (href: string) => /^(https?:\/\/|mailto:)/i.test(href) || /^\{\{\s*[a-z_]+\s*\}\}$/.test(href)

/** Limpia el HTML (del editor o guardado) dejando solo etiquetas permitidas y href seguros. */
export function sanitizeEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const walk = (node: Node, target: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        target.appendChild(out.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      const tag = RENAME[el.tagName] ?? el.tagName
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(tag)) continue
      if (!ALLOWED.has(tag)) {
        walk(el, target) // se conserva el texto, no la etiqueta
        continue
      }
      const copy = out.createElement(tag.toLowerCase())
      if (tag === 'A') {
        const href = el.getAttribute('href')?.trim() ?? ''
        if (!safeHref(href)) {
          walk(el, target)
          continue
        }
        copy.setAttribute('href', href)
      }
      target.appendChild(copy)
      if (tag !== 'BR') walk(el, copy)
    }
  }
  walk(doc.body, out.body)
  return out.body.innerHTML.slice(0, 20000)
}

export function emailHtmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeEmailHtml(html).replace(/<br>/g, '\n').replace(/<\/(p|li|h2|h3)>/g, '$&\n')}</body>`, 'text/html')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plantilla antigua (texto plano) → bloques en el orden de siempre. */
export function legacyBlocks(body: string, includeDocuments: boolean, includeButton = true): EmailBlock[] {
  const html = body.split(/\n{2,}/).map((p) => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('')
  return [{ type: 'text', html }, ...(includeDocuments ? [{ type: 'documents' as const }] : []), ...(includeButton ? [{ type: 'button' as const }] : [])]
}

export function blocksOf(rule: { blocks?: EmailBlock[] | null; body: string; include_documents: boolean }): EmailBlock[] {
  return rule.blocks?.length ? rule.blocks.map((b) => (b.type === 'text' ? { ...b, html: sanitizeEmailHtml(b.html) } : b)) : legacyBlocks(rule.body, rule.include_documents)
}

/** Texto plano de todos los bloques de texto (se guarda en body para listados y respaldo). */
export function blocksToPlain(blocks: EmailBlock[]): string {
  return blocks.filter((b): b is Extract<EmailBlock, { type: 'text' }> => b.type === 'text').map((b) => emailHtmlToPlain(b.html)).filter(Boolean).join('\n\n')
}
