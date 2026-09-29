/** Orden de navegación (Anterior/Siguiente) guardado por la lista al abrir un documento. */
export function rememberDocumentOrder(direction: string, ids: string[]) {
  try {
    sessionStorage.setItem(`produ-finanzas:doc-order:${direction}`, JSON.stringify(ids))
  } catch {
    // ignorar
  }
}

export function readDocumentOrder(direction: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(`produ-finanzas:doc-order:${direction}`)
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    return null
  }
}
