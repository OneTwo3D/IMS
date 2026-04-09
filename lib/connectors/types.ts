/**
 * Shared interfaces for platform connectors.
 *
 * Shopping connectors: WooCommerce, Shopify (future)
 * Accounting connectors: Xero (current), QuickBooks (future)
 */

// ---------------------------------------------------------------------------
// Shopping Connector
// ---------------------------------------------------------------------------

export type ConnectorCredentials = {
  url: string
  key: string
  secret: string
  [k: string]: string
}

export type SyncDirection = 'TO_PLATFORM' | 'FROM_PLATFORM'
export type SyncStatus = 'PENDING' | 'SYNCED' | 'FAILED'

export type ExternalOrder = {
  externalId: number | string
  orderNumber: string
  status: string
  currency: string
  total: number
  dateCreated: string
  customerName: string
  customerEmail?: string
  billingAddress?: unknown
  shippingAddress?: unknown
  lineItems: ExternalOrderLine[]
  shippingTotal?: number
  shippingService?: string
  notes?: string
}

export type ExternalOrderLine = {
  externalLineId: number | string
  sku: string
  name: string
  quantity: number
  unitPrice: number
  total: number
}

export type ExternalProduct = {
  externalId: number | string
  sku: string
  name: string
  description?: string
  price?: number
  salePrice?: number
  imageUrl?: string
  permalink?: string
  status: string
}

export type StockUpdate = {
  sku: string
  productId: string
  quantity: number
}

export type DeliveryStatus = {
  externalOrderId: number | string
  status: string // 'delivered' | 'in_transit' | 'out_for_delivery' | etc.
  trackingNumber?: string
  carrier?: string
  lastEvent?: string
  lastEventTime?: string
}

export interface ShoppingConnector {
  /** Unique connector identifier */
  readonly id: string
  /** Display name */
  readonly name: string

  // --- Configuration ---
  getCredentials(): Promise<ConnectorCredentials | null>
  isConfigured(): Promise<boolean>

  // --- Orders ---
  fetchOrders(params: { status?: string; after?: string; page?: number; perPage?: number }): Promise<{ orders: ExternalOrder[]; totalPages: number }>
  fetchOrder(externalId: number | string): Promise<ExternalOrder | null>

  // --- Products ---
  fetchProduct(sku: string): Promise<ExternalProduct | null>
  fetchProductUrl(sku: string): Promise<string | null>
  syncStockLevels(updates: StockUpdate[]): Promise<{ synced: number; errors: string[] }>

  // --- Delivery ---
  getDeliveryStatus(externalOrderId: number | string): Promise<DeliveryStatus | null>
}

// ---------------------------------------------------------------------------
// Accounting Connector (Xero, QuickBooks future)
// ---------------------------------------------------------------------------

export type JournalEntry = {
  date: string
  reference: string
  narration: string
  lines: JournalLine[]
}

export type JournalLine = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
  taxType?: string
}

export type SyncResult = {
  success: boolean
  externalId?: string
  error?: string
}

export type InvoiceLine = {
  itemCode?: string
  description: string
  quantity: number
  unitAmount: number
  accountCode: string
  taxType?: string
  discountRate?: number
}

export type InvoiceData = {
  invoiceNumber: string
  contactName: string
  contactEmail?: string
  date: string
  dueDate?: string
  currency: string
  lines: InvoiceLine[]
  shippingAmount?: number
  shippingDescription?: string
  shippingAccountCode?: string
  discountAmount?: number
  discountAccountCode?: string
  reference?: string
}

export type BillData = {
  invoiceNumber?: string
  contactName: string
  date: string
  dueDate?: string
  currency: string
  lines: InvoiceLine[]
  reference?: string
}

export type CreditNoteData = {
  creditNoteNumber: string
  contactName: string
  contactEmail?: string
  date: string
  currency: string
  lines: InvoiceLine[]
  reference?: string
}

export interface AccountingConnector {
  readonly id: string
  readonly name: string

  isConfigured(): Promise<boolean>
  isConnected(): Promise<boolean>
  postJournalEntry(entry: JournalEntry): Promise<SyncResult>
  postInvoice(data: InvoiceData): Promise<SyncResult>
  postBill(data: BillData): Promise<SyncResult>
  postCreditNote(data: CreditNoteData): Promise<SyncResult>
  findOrCreateContact(name: string, email?: string, isSupplier?: boolean): Promise<SyncResult>
  findOrCreateItem(code: string, name: string): Promise<SyncResult>
  syncAccounts(): Promise<{ synced: number; errors: string[] }>
}
