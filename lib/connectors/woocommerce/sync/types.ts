/**
 * Full WooCommerce REST API v3 response types for sync operations.
 */

export type WcAddress = {
  first_name: string
  last_name: string
  company: string
  address_1: string
  address_2: string
  city: string
  state: string
  postcode: string
  country: string
  email?: string
  phone?: string
}

export type WcLineItem = {
  id: number
  name: string
  product_id: number
  variation_id: number
  quantity: number
  tax_class: string
  subtotal: string      // before discount (line total pre-coupon)
  subtotal_tax: string
  total: string         // after discount
  total_tax: string
  taxes: { id: number; total: string; subtotal: string }[]
  meta_data: WcMeta[]
  sku: string
  price: number
}

export type WcShippingLine = {
  id: number
  method_title: string
  method_id: string
  total: string
  total_tax: string
  taxes: { id: number; total: string }[]
}

export type WcCouponLine = {
  id: number
  code: string
  discount: string      // discount amount
  discount_tax: string
}

export type WcFeeLine = {
  id: number
  name: string
  total: string
  total_tax: string
}

export type WcTaxLine = {
  id: number
  rate_code: string
  rate_id: number
  label: string
  compound: boolean
  tax_total: string
  shipping_tax_total: string
}

export type WcMeta = {
  id: number
  key: string
  value: unknown
}

export type WcRefundRef = {
  id: number
  reason: string
  total: string
}

export type WcFullOrder = {
  id: number
  parent_id: number
  number: string
  order_key: string
  created_via: string
  version: string
  status: string
  currency: string
  date_created: string
  date_created_gmt: string
  date_modified: string
  date_modified_gmt: string
  discount_total: string
  discount_tax: string
  shipping_total: string
  shipping_tax: string
  cart_tax: string
  total: string
  total_tax: string
  prices_include_tax: boolean
  customer_id: number
  customer_ip_address: string
  customer_note: string
  billing: WcAddress
  shipping: WcAddress
  payment_method: string
  payment_method_title: string
  transaction_id: string
  date_paid: string | null
  date_paid_gmt: string | null
  date_completed: string | null
  date_completed_gmt: string | null
  cart_hash: string
  meta_data: WcMeta[]
  line_items: WcLineItem[]
  tax_lines: WcTaxLine[]
  shipping_lines: WcShippingLine[]
  fee_lines: WcFeeLine[]
  coupon_lines: WcCouponLine[]
  refunds: WcRefundRef[]
}

export type WcRefundLineItem = {
  id: number
  name: string
  product_id: number
  variation_id: number
  quantity: number // negative for refund
  tax_class: string
  subtotal: string
  subtotal_tax: string
  total: string
  total_tax: string
  sku: string
  meta_data: WcMeta[]
  refund_total: number
}

export type WcRefund = {
  id: number
  parent_id?: number
  date_created: string
  date_created_gmt: string
  amount: string
  reason: string
  refunded_by: number
  refunded_payment: boolean
  meta_data: WcMeta[]
  line_items: WcRefundLineItem[]
}

export type WcFullProduct = {
  id: number
  name: string
  slug: string
  permalink: string
  date_created: string
  date_modified: string
  type: string // simple, grouped, external, variable
  status: string // draft, pending, private, publish
  featured: boolean
  catalog_visibility: string
  description: string
  short_description: string
  sku: string
  price: string
  regular_price: string
  sale_price: string
  on_sale: boolean
  purchasable: boolean
  total_sales: number
  virtual: boolean
  downloadable: boolean
  tax_status: string
  tax_class: string
  manage_stock: boolean
  stock_quantity: number | null
  stock_status: string // instock, outofstock, onbackorder
  backorders: string
  weight: string
  dimensions: { length: string; width: string; height: string }
  categories: { id: number; name: string; slug: string }[]
  tags: { id: number; name: string; slug: string }[]
  images: { id: number; src: string; name: string; alt: string }[]
  attributes: { id: number; name: string; position: number; visible: boolean; variation: boolean; options: string[] }[]
  variations: number[]
  meta_data: WcMeta[]
  parent_id: number
  global_unique_id?: string  // WC 9.2+ native GTIN/EAN/UPC/ISBN field
}

export type WcVariation = {
  id: number
  sku: string
  status: string
  description: string
  price: string
  regular_price: string
  sale_price: string
  on_sale: boolean
  manage_stock: boolean
  stock_quantity: number | null
  stock_status: string
  weight: string
  dimensions: { length: string; width: string; height: string }
  images: { id: number; src: string; name: string; alt: string }[]  // WC variation: single-element array
  attributes: { id: number; name: string; option: string }[]
  meta_data: WcMeta[]
  parent_id: number
  global_unique_id?: string
}

export type WcTrackingItem = {
  tracking_provider: string
  tracking_number: string
  date_shipped: string
  custom_tracking_provider?: string
  custom_tracking_link?: string
}

export type SyncResult = {
  synced: number
  skipped: number
  errors: string[]
}

export type StockSyncResult = SyncResult & {
  /** Products with stocked warehouses that are candidates for sync. */
  candidates: number
  /** Candidates whose externalProductId is known (either pre-stored or resolved this run). */
  matched: number
  /** Candidates whose SKU was not found in WooCommerce. */
  unmatched: number
  /** Whether any batch POST to WC actually succeeded. */
  pushed: boolean
  /** Short message explaining the outcome (for UI display). */
  message: string
  /** Up to 10 SKUs that could not be matched in WC — shown to operators. */
  unmatchedSkuSample: string[]
}
