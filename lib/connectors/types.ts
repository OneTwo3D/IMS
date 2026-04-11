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
  /**
   * Product name, used when the item needs to be created in the accounting
   * system (e.g. first time the SKU is sold through Xero). Falls back to
   * `description` if omitted.
   */
  itemName?: string
  description: string
  quantity: number
  unitAmount: number
  accountCode: string
  taxType?: string
  /**
   * Per-line discount amount (in the invoice currency, same tax convention
   * as `unitAmount`). Generic across connectors — each connector decides how
   * to represent it in its target system:
   *   - Xero sales invoices (ACCREC) → converted to `DiscountRate` %
   *   - Xero bills (ACCPAY) → applied by reducing `UnitAmount`
   *   - QuickBooks → maps to `DiscountRate` / `DiscountAmt`
   */
  discountAmount?: number
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
  /**
   * Tax type for the shipping line. Defaults to the connector's "no tax" code
   * when omitted, but orders with a VAT rate should pass the matching
   * accounting tax type so shipping is taxed at the same rate as the products.
   */
  shippingTaxType?: string
  discountAmount?: number
  discountAccountCode?: string
  /**
   * Tax type for the order-level discount line. Should match the order's tax
   * rate so the discount reduces the taxable base correctly. Defaults to the
   * connector's "no tax" code when omitted.
   */
  discountTaxType?: string
  /**
   * When true, unit amounts on all lines (products, shipping, discount) are
   * treated as tax-inclusive by the accounting system. Defaults to exclusive.
   * Each connector maps this to its own native flag.
   */
  lineAmountsIncludeTax?: boolean
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
