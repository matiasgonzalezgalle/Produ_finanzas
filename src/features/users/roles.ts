import type { MemberRole } from '../../data'

export const ROLE_LABEL: Record<MemberRole, string> = { owner: 'Dueño', admin: 'Administrador', finance: 'Finanzas', viewer: 'Solo lectura' }
export const ROLE_HINT: Record<Exclude<MemberRole, 'owner'>, string> = {
  admin: 'Todo, incluida la configuración, usuarios, integraciones y portal.',
  finance: 'Registra y edita documentos, pagos, cobros y contrapartes.',
  viewer: 'Solo consulta. No puede crear ni modificar nada.',
}
