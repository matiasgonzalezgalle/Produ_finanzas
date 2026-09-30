// Texto enriquecido de las plantillas de correo: lista blanca de etiquetas (sin atributos salvo el
// href de los enlaces), variables {{…}} con valores escapados y estilos en línea para clientes de correo.

export type EmailBlock =
  | { type: 'text'; html: string }
  | { type: 'documents' }
  | { type: 'button' }
  | { type: 'divider' }

const ALLOWED = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'div'])
const VOID = new Set(['br'])
const escText = (v: string) => v.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** href permitido: http(s), mailto o una variable {{…}} (se valida de nuevo tras reemplazarla). */
const safeHref = (href: string) => /^(https?:\/\/|mailto:)/i.test(href) || /^\{\{\s*[a-z_]+\s*\}\}$/.test(href)

/** Deja solo etiquetas permitidas, sin atributos (salvo href en <a>), bien cerradas. */
export function sanitizeRichText(input: string): string {
  const out: string[] = []
  const stack: string[] = []
  for (const part of String(input ?? '').slice(0, 20000).split(/(<[^<>]*>)/)) {
    const tag = part.match(/^<\s*(\/)?\s*([a-zA-Z0-9]+)([^>]*)>$/)
    if (!tag) {
      out.push(escText(part))
      continue
    }
    const closing = !!tag[1]
    let name = tag[2].toLowerCase()
    if (name === 'div') name = 'p'
    if (!ALLOWED.has(name)) continue
    if (closing) {
      const i = stack.lastIndexOf(name)
      if (i === -1) continue
      while (stack.length > i) out.push(`</${stack.pop()}>`)
      continue
    }
    if (VOID.has(name)) {
      out.push('<br>')
      continue
    }
    if (name === 'a') {
      const href = (tag[3].match(/href\s*=\s*"([^"]*)"/i) ?? tag[3].match(/href\s*=\s*'([^']*)'/i))?.[1]?.trim() ?? ''
      const decoded = href.replace(/&amp;/g, '&')
      if (!safeHref(decoded)) continue
      out.push(`<a href="${escAttr(decoded)}">`)
    } else {
      out.push(`<${name}>`)
    }
    stack.push(name)
  }
  while (stack.length) out.push(`</${stack.pop()}>`)
  return out.join('')
}

/** Texto plano (para la lista de plantillas y como respaldo). */
export function richTextToPlain(html: string): string {
  return sanitizeRichText(html)
    .replace(/<br>/g, '\n')
    .replace(/<\/(p|li|h2|h3)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plantilla antigua (texto plano) → bloques: texto, documentos y botón en el orden de siempre. */
export function legacyBlocks(body: string, includeDocuments: boolean, includeButton: boolean): EmailBlock[] {
  const html = String(body ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p>${escText(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
  return [{ type: 'text', html }, ...(includeDocuments ? [{ type: 'documents' } as const] : []), ...(includeButton ? [{ type: 'button' } as const] : [])]
}

export function normalizeBlocks(raw: unknown): EmailBlock[] | null {
  if (!Array.isArray(raw)) return null
  const blocks: EmailBlock[] = []
  for (const b of raw.slice(0, 40)) {
    const type = (b as { type?: string })?.type
    if (type === 'text') blocks.push({ type, html: sanitizeRichText(String((b as { html?: string }).html ?? '')) })
    else if (type === 'documents' || type === 'button' || type === 'divider') blocks.push({ type })
  }
  return blocks
}

/** URLs sueltas en el texto (fuera de un enlace) se vuelven enlaces. */
function autoLink(html: string): string {
  let insideLink = 0
  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<a[\s>]/.test(part)) insideLink++
      else if (part === '</a>') insideLink = Math.max(0, insideLink - 1)
      return part
    }
    return insideLink ? part : part.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
  }).join('')
}

/**
 * HTML del bloque de texto listo para el correo: variables reemplazadas (escapadas), enlaces
 * validados y estilos en línea.
 */
export function renderRichText(html: string, vars: Record<string, string>, style: { ink: string; muted: string; link: string; font: string }): string {
  const filled = sanitizeRichText(html).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => (key in vars ? escAttr(vars[key]) : m))
  return autoLink(filled)
    // Un href que tras reemplazar la variable no es una URL válida se quita (queda el texto).
    .replace(/<a href="([^"]*)">/g, (_m, href: string) => (/^(https?:\/\/|mailto:)/i.test(href.replace(/&amp;/g, '&')) ? `<a href="${href}" target="_blank" style="color:${style.link};text-decoration:underline">` : '<a>'))
    .replace(/<p>/g, `<p style="margin:0 0 12px;font-family:${style.font};font-size:14px;line-height:22px;color:${style.muted}">`)
    .replace(/<h2>/g, `<h2 style="margin:4px 0 10px;font-family:${style.font};font-size:18px;line-height:24px;color:${style.ink}">`)
    .replace(/<h3>/g, `<h3 style="margin:4px 0 8px;font-family:${style.font};font-size:15px;line-height:22px;color:${style.ink}">`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 12px;padding-left:20px;font-family:${style.font};font-size:14px;line-height:22px;color:${style.muted}">`)
    .replace(/<(strong|b)>/g, `<$1 style="color:${style.ink}">`)
}
