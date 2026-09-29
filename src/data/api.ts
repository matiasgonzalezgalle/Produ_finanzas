// Contrato de acceso a datos. La UI depende solo de esta interfaz, así se puede
// cambiar el backend (Supabase, demo en memoria, API propia) sin tocar pantallas.
import type { Country } from '../domain/taxId'
import type { DocumentDirection } from '../domain/documents'
import type {
  AccountingCategory,
  AllocationLine,
  ApprovalStatus,
  CostCenter,
  DocumentComment,
  PortalComment,
  Attachment,
  BankAccount,
  BankAccountInput,
  Member,
  MemberRole,
  TenantInput,
  PortalAccess,
  PortalAccount,
  PortalSnapshot,
  PortalPublicInfo,
  Contact,
  ContactInput,
  Counterparty,
  CounterpartyInput,
  DocumentInput,
  DocumentRow,
  IntegrationConnection,
  Payment,
  PaymentInput,
  Tenant,
  DocumentTypeSetting,
  ModuleSettings,
  ModuleSettingsInput,
  PaymentMethod,
  PaymentMethodInput,
  PurchaseOrderAttachment,
  PurchaseOrderInput,
  PurchaseOrderLine,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  IntegrationProvider,
  SiiDocument,
  SiiImportResult,
  EmailLogRow,
  EmailSettings,
} from './types'

export interface Session {
  userId: string
  email: string
  fullName: string
}

export interface DataApi {
  readonly mode: 'supabase' | 'demo'

  // Auth
  getSession(): Promise<Session | null>
  onSessionChange(cb: (session: Session | null) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string, fullName: string): Promise<{ needsConfirmation: boolean }>
  signOut(): Promise<void>
  /** Envía el correo para crear una contraseña nueva (vuelve a redirectTo con sesión de recuperación). */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>
  /** Define la contraseña del usuario con sesión (recuperación o invitación); opcionalmente su nombre. */
  updatePassword(password: string, fullName?: string): Promise<void>

  // Empresas (tenants)
  listTenants(): Promise<Tenant[]>
  createTenant(input: { name: string; country: Country; legal_name?: string; tax_id?: string }): Promise<Tenant>
  updateTenant(tenantId: string, input: TenantInput): Promise<void>

  // Usuarios de la empresa
  listMembers(tenantId: string): Promise<Member[]>
  inviteMember(tenantId: string, input: { email: string; role: Exclude<MemberRole, 'owner'> }): Promise<{ invited: boolean }>
  updateMemberRole(tenantId: string, userId: string, role: Exclude<MemberRole, 'owner'>): Promise<void>
  removeMember(tenantId: string, userId: string): Promise<void>

  // Contrapartes
  listCounterparties(tenantId: string): Promise<Counterparty[]>
  saveCounterparty(tenantId: string, input: CounterpartyInput, id?: string): Promise<Counterparty>
  listContacts(tenantId: string): Promise<Contact[]>
  saveContact(tenantId: string, input: ContactInput, id?: string): Promise<Contact>
  listBankAccounts(tenantId: string, counterpartyId: string): Promise<BankAccount[]>
  saveBankAccount(tenantId: string, input: BankAccountInput, id?: string): Promise<void>
  deleteBankAccount(tenantId: string, id: string): Promise<void>

  // Documentos
  listDocuments(tenantId: string, direction: DocumentDirection): Promise<DocumentRow[]>
  /** Devuelve el id del documento. */
  saveDocument(tenantId: string, input: DocumentInput, id?: string): Promise<string>
  voidDocument(tenantId: string, id: string): Promise<void>
  setApproval(tenantId: string, id: string, status: ApprovalStatus, reason?: string): Promise<void>
  /** Gestión de pago CxP: solicitar, programar (con fecha) o volver a sin gestionar. */
  setPaymentStage(tenantId: string, id: string, stage: 'requested' | 'scheduled' | null, scheduledDate?: string | null): Promise<void>
  listDocumentAllocations(tenantId: string, documentId: string): Promise<AllocationLine[]>
  setDocumentAllocations(tenantId: string, documentId: string, lines: AllocationLine[]): Promise<void>
  listComments(tenantId: string, documentId: string): Promise<DocumentComment[]>
  addComment(tenantId: string, documentId: string, body: string, visibility: 'internal' | 'shared'): Promise<void>
  deleteComment(tenantId: string, id: string): Promise<void>

  // Catálogos contables
  listCategories(tenantId: string): Promise<AccountingCategory[]>
  saveCategory(tenantId: string, input: Omit<AccountingCategory, 'id'>, id?: string): Promise<void>
  listCostCenters(tenantId: string): Promise<CostCenter[]>
  saveCostCenter(tenantId: string, input: Omit<CostCenter, 'id'>, id?: string): Promise<void>
  // Órdenes de compra
  listPurchaseOrders(tenantId: string, direction: DocumentDirection): Promise<PurchaseOrderRow[]>
  listPurchaseOrderLines(tenantId: string, id: string): Promise<PurchaseOrderLine[]>
  /** Crea o edita la OC con su detalle. Devuelve el id. */
  savePurchaseOrder(tenantId: string, input: PurchaseOrderInput, lines: Omit<PurchaseOrderLine, 'amount'>[], id?: string): Promise<string>
  setPurchaseOrderStatus(tenantId: string, id: string, status: PurchaseOrderStatus, reason?: string): Promise<void>
  /** Registra (o quita) el envío de la OC al proveedor. */
  markPurchaseOrderSent(tenantId: string, id: string, sentTo: string | null): Promise<void>
  deletePurchaseOrder(tenantId: string, id: string): Promise<void>
  listPurchaseOrderAttachments(tenantId: string, id: string): Promise<PurchaseOrderAttachment[]>
  uploadPurchaseOrderAttachment(tenantId: string, id: string, file: File): Promise<void>
  deletePurchaseOrderAttachment(tenantId: string, attachment: PurchaseOrderAttachment): Promise<void>
  purchaseOrderAttachmentUrl(tenantId: string, attachment: PurchaseOrderAttachment): Promise<string>

  // Administradores de CxP / CxC
  getModuleSettings(tenantId: string, direction: DocumentDirection): Promise<ModuleSettings>
  saveModuleSettings(tenantId: string, direction: DocumentDirection, input: ModuleSettingsInput): Promise<void>
  /** Solo los tipos con configuración propia; los demás están habilitados. */
  listDocumentTypeSettings(tenantId: string, direction: DocumentDirection): Promise<DocumentTypeSetting[]>
  saveDocumentTypeSetting(tenantId: string, direction: DocumentDirection, input: DocumentTypeSetting): Promise<void>
  listPaymentMethods(tenantId: string, direction: 'in' | 'out'): Promise<PaymentMethod[]>
  savePaymentMethod(tenantId: string, input: PaymentMethodInput, id?: string): Promise<void>
  /** Solo documentos sin pagos ni notas de crédito; si no, se anulan. */
  deleteDocument(tenantId: string, id: string): Promise<void>
  listAttachments(tenantId: string, documentId: string): Promise<Attachment[]>
  uploadAttachment(tenantId: string, documentId: string, file: File): Promise<void>
  deleteAttachment(tenantId: string, attachment: Attachment): Promise<void>
  /** URL temporal para descargar un adjunto. */
  attachmentUrl(tenantId: string, attachment: Attachment): Promise<string>

  // Pagos y cobros
  listPayments(tenantId: string, direction: 'in' | 'out'): Promise<Payment[]>
  createPayment(tenantId: string, input: PaymentInput): Promise<void>
  /** Anula el movimiento: deja de contar en los saldos (queda en auditoría). */
  voidPayment(tenantId: string, id: string): Promise<void>

  // Portal financiero: configuración interna
  listPortalAccess(tenantId: string): Promise<PortalAccess[]>
  addPortalAccess(tenantId: string, counterpartyId: string, email: string): Promise<void>
  setPortalAccessEnabled(tenantId: string, id: string, enabled: boolean): Promise<void>
  removePortalAccess(tenantId: string, id: string): Promise<void>
  /** Nuevo link para la contraparte; el anterior deja de funcionar. */
  regeneratePortalSlug(tenantId: string, counterpartyId: string): Promise<string>
  /** Acceso con código para usuarios sin correo. Devuelve el código en claro (solo esta vez). */
  createPortalCode(tenantId: string, counterpartyId: string, label: string, expiresAt: string | null): Promise<{ code: string; slug: string }>
  regeneratePortalCode(tenantId: string, accessId: string): Promise<{ code: string; slug: string }>

  // Portal financiero: usuario externo
  /** Correo con sesión en el portal, o null. */
  /** Datos públicos de la pantalla de ingreso de un link, o null si no existe/está desactivado. */
  portalPublicInfo(slug: string): Promise<PortalPublicInfo | null>
  portalSession(): Promise<string | null>
  portalSignOut(): Promise<void>
  portalSendCode(email: string, redirectTo: string): Promise<void>
  /** Ingreso sin correo: canjea el código entregado por la empresa en el link de la contraparte. */
  portalRedeemCode(slug: string, code: string): Promise<void>
  portalVerifyCode(email: string, code: string): Promise<void>
  portalAccounts(): Promise<PortalAccount[]>
  portalSnapshot(tenantId: string, counterpartyId: string): Promise<PortalSnapshot>
  portalFileUrl(storagePath: string): Promise<string>
  portalComments(documentId: string): Promise<PortalComment[]>
  portalAddComment(documentId: string, body: string): Promise<void>

  // Integraciones
  getIntegration(tenantId: string, provider: IntegrationProvider): Promise<IntegrationConnection | null>

  // Correos del negocio
  getEmailSettings(tenantId: string): Promise<EmailSettings>
  saveEmailSettings(tenantId: string, input: EmailSettings): Promise<void>
  listEmailLog(tenantId: string): Promise<EmailLogRow[]>
  /** Envía los avisos pendientes (los anota la base de datos al ocurrir cada evento). */
  dispatchEmails(tenantId: string): Promise<void>
  sendCollectionReminder(tenantId: string, documentId: string): Promise<void>
  sendPurchaseOrderEmail(tenantId: string, input: { purchaseOrderId: string; to: string[]; message: string; pdfBase64: string }): Promise<void>

  // SII vía Fintoc (solo Chile)
  /** Prepara el widget de Fintoc para conectar el SII de la empresa. */
  siiStart(tenantId: string): Promise<{ publicKey: string; webhookUrl: string; holderId: string | null }>
  siiSync(tenantId: string): Promise<{ fetched: number; syncedAt: string }>
  siiDisconnect(tenantId: string): Promise<void>
  listSiiDocuments(tenantId: string, direction: DocumentDirection): Promise<SiiDocument[]>
  importSiiDocuments(tenantId: string, ids: string[]): Promise<SiiImportResult>
  setSiiIgnored(tenantId: string, id: string, ignored: boolean): Promise<void>
  connectMercadoPago(tenantId: string, input: { accessToken: string; webhookSecret: string }): Promise<{ webhookUrl: string }>
  createPaymentLink(tenantId: string, documentId: string): Promise<{ url: string }>
}
