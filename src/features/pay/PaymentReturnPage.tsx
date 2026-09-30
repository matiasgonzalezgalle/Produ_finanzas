// Páginas públicas a las que MercadoPago devuelve al cliente después de pagar (o intentar pagar).
// MercadoPago agrega a la URL external_reference (el id de nuestro link) y el estado del pago.
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock3, XCircle } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { api, type DocumentRow } from '../../data'
import { documentTypeLabel } from '../../domain/documents'
import { formatMoney, isCurrency } from '../../domain/money'

export type PaymentReturnStatus = 'exito' | 'pendiente' | 'error'

const COPY: Record<PaymentReturnStatus, { title: string; text: string; icon: typeof CheckCircle2; color: string }> = {
  exito: { title: 'Pago recibido', text: 'Gracias. MercadoPago aprobó tu pago y quedará registrado automáticamente en unos minutos.', icon: CheckCircle2, color: 'text-ok' },
  pendiente: { title: 'Pago en proceso', text: 'MercadoPago está procesando tu pago. Cuando se apruebe, quedará registrado automáticamente; no necesitas pagar de nuevo.', icon: Clock3, color: 'text-warn' },
  error: { title: 'El pago no se realizó', text: 'MercadoPago no pudo completar el pago y no se hizo ningún cargo. Puedes intentarlo nuevamente con el mismo link.', icon: XCircle, color: 'text-bad' },
}

export function PaymentReturnPage({ status }: { status: PaymentReturnStatus }) {
  const [params] = useSearchParams()
  const linkId = params.get('external_reference') ?? ''
  // MercadoPago puede volver con "approved" aunque la URL sea otra (y viceversa): manda su estado.
  const mpStatus = params.get('collection_status') ?? params.get('status')
  const effective: PaymentReturnStatus = mpStatus === 'approved' ? 'exito' : mpStatus === 'pending' || mpStatus === 'in_process' ? 'pendiente' : mpStatus === 'rejected' ? 'error' : status
  const info = useQuery({ queryKey: ['payment-link-public', linkId], queryFn: () => api.paymentLinkInfo(linkId), enabled: !!linkId })
  const copy = COPY[effective]
  const Icon = copy.icon
  const d = info.data
  const operation = params.get('payment_id') ?? params.get('collection_id')

  return (
    <div className="flex min-h-full items-center justify-center bg-subtle px-4 py-12">
      <div className="w-full max-w-md">
        {d?.tenant_name && <p className="mb-3 px-1 text-[15px] font-semibold text-ink">{d.tenant_name}</p>}
        <div className="rounded-xl border border-line bg-white p-7 shadow-sm">
          <Icon size={40} className={copy.color} />
          <h1 className="mt-4 text-xl font-semibold text-ink">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{copy.text}</p>
          {d && (
            <dl className="mt-5 divide-y divide-line rounded-lg border border-line text-sm">
              <div className="flex justify-between px-4 py-2.5"><dt className="text-muted">Documento</dt><dd className="font-medium text-ink">{documentTypeLabel(d.doc_type as DocumentRow['doc_type'])} N° {d.folio}</dd></div>
              <div className="flex justify-between px-4 py-2.5"><dt className="text-muted">Monto</dt><dd className="font-medium text-ink">{isCurrency(d.currency) ? formatMoney(d.amount, d.currency) : d.amount}</dd></div>
              {operation && <div className="flex justify-between px-4 py-2.5"><dt className="text-muted">Operación MercadoPago</dt><dd className="font-medium text-ink">{operation}</dd></div>}
            </dl>
          )}
          <p className="mt-5 text-xs text-faint">Ya puedes cerrar esta ventana.{effective === 'exito' && ' Guarda el comprobante que te envió MercadoPago.'}</p>
        </div>
        <p className="mt-4 text-center text-xs text-faint">Produ<span className="text-brand-500">.</span> Finanzas</p>
      </div>
    </div>
  )
}
