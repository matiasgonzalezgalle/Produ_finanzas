// Carga el widget de Fintoc (https://js.fintoc.com/v1/) solo cuando se necesita.
interface FintocWidget {
  open(): void
  destroy(): void
}
interface FintocGlobal {
  create(options: Record<string, unknown>): FintocWidget
}
declare global {
  interface Window {
    Fintoc?: FintocGlobal
  }
}

let loading: Promise<FintocGlobal> | null = null

function loadFintoc(): Promise<FintocGlobal> {
  if (window.Fintoc) return Promise.resolve(window.Fintoc)
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://js.fintoc.com/v1/'
    script.async = true
    script.onload = () => (window.Fintoc ? resolve(window.Fintoc) : reject(new Error('No se pudo cargar Fintoc')))
    script.onerror = () => {
      loading = null
      reject(new Error('No se pudo cargar el widget de Fintoc. Revisa tu conexión.'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Abre el widget para conectar el SII (producto invoices). Resuelve true si el usuario terminó, false si lo cerró. */
export async function openFiscalWidget(params: { publicKey: string; webhookUrl: string }): Promise<boolean> {
  const Fintoc = await loadFintoc()
  return new Promise((resolve) => {
    let widget: FintocWidget | null = null
    const finish = (ok: boolean) => {
      widget?.destroy()
      resolve(ok)
    }
    widget = Fintoc.create({
      publicKey: params.publicKey,
      holderType: 'business',
      product: 'invoices',
      country: 'cl',
      webhookUrl: params.webhookUrl,
      onSuccess: () => finish(true),
      onExit: () => finish(false),
    })
    widget.open()
  })
}
