import type {
  WmsOrderCancelResult,
  WmsOrderPushInput,
  WmsOrderPushLine,
  WmsOrderPushResult,
  WmsOrderUpdateResult,
} from '@/lib/connectors/wms/types'
import { extractShipheroConnectionNodes, shipheroGraphql } from './client'

/**
 * Outbound ShipHero order push (epic h02x.11) — the GraphQL equivalent of the
 * Mintsoft REST `order-push.ts`. The connector-agnostic WMS order-push sweep
 * (`lib/domain/wms/order-push-sweep.ts`) guards every pass on capability
 * presence, so wiring these four operations onto `ShipheroConnector` lights up
 * the create / update / cancel / refund-comment passes automatically.
 *
 * NOT VERIFIED anywhere: there is no live or sandbox ShipHero tenant, and the
 * reference `woocommerce-shiphero-sync` plugin is itself untested against one — so
 * its mutation shapes are a design reference, not a validated contract. Every
 * GraphQL document below is sourced from developer.shiphero.com + that plugin and
 * MUST be verified against a real tenant before the h02x epic closes. Reads are
 * deliberately defensive.
 *
 * KEY ShipHero DIFFERENCES vs Mintsoft (see bd memory + developer.shiphero.com):
 *  - `order_create` does NOT enforce `partner_order_id` uniqueness, so a re-push
 *    after a lost writeback would DUPLICATE the order. Every push therefore does
 *    a `find by partner_order_id` preflight and reconciles to the existing order.
 *  - `order_update` CANNOT amend line items — it only accepts scalar fields
 *    (shipping address, notes, …). Line edits go through the dedicated
 *    `order_add_line_items` / `order_update_line_items` / `order_remove_line_items`
 *    mutations, keyed by the ShipHero line-item `id` (so we query the live line
 *    items and diff before amending). This is how refund-netted quantities
 *    propagate to a still-pre-fulfilment order.
 *  - Cancellation is the documented `order_cancel` mutation; we verify the
 *    returned `fulfillment_status === "canceled"` before ACKing (a status-only
 *    response must not clear the IMS push link while warehouse work is live).
 *  - An operator note maps to `order_add_tags` (additive — it won't clobber the
 *    warehouse's `packing_note`), used by the sweep to flag a refund/hold that
 *    can't be auto-applied.
 *
 * (See the no-verification note above: GraphQL shapes are unproven and need
 * live-tenant validation before the h02x epic closes.)
 */

const SHIPHERO_SHOP_NAME = 'IMS'

/** ShipHero fulfillment_status values where the order is still pre-fulfilment and
 *  therefore safe to amend (line edits) or auto-cancel. Past these, the warehouse
 *  is already working the order and the sweep must dead-letter for a manual query. */
const SHIPHERO_PRE_FULFILMENT_STATUSES = new Set([
  'pending',
  'allocated',
  'partially_allocated',
  'backorder',
  'on_hold',
])

const SHIPHERO_CANCELED_STATUS = 'canceled'

type RawRecord = Record<string, unknown>

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRecord) : null
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** ShipHero money fields are strings; emit a 2dp fixed string. */
function money(value: number): string {
  return round2(value).toFixed(2)
}

function normalizeStatus(value: unknown): string {
  return (str(value) ?? '').toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
}

// --- Address + line-item payload builders -----------------------------------

/** Map the generic WMS push address onto ShipHero's address input shape
 *  (first_name/last_name/company/address1/address2/city/state/zip/country/phone),
 *  mirroring the reference plugin's `_map_address`. */
function buildShipheroAddress(input: WmsOrderPushInput): RawRecord {
  const a = input.shippingAddress
  return {
    first_name: a.firstName.slice(0, 64),
    last_name: a.lastName.slice(0, 64),
    company: a.company.slice(0, 128),
    address1: a.address1.slice(0, 255),
    address2: a.address2.slice(0, 255),
    city: a.town.slice(0, 128),
    state: a.county.slice(0, 64),
    zip: a.postCode.slice(0, 32),
    country: a.country.slice(0, 2),
    phone: (input.phone ?? '').slice(0, 64),
  }
}

/**
 * Update-shape address for `order_update`. ShipHero's UpdateOrderInput.shipping_address
 * additionally expects `state_code` / `country_code` (CreateOrderInput accepts plain
 * `state` / `country`), and carries `email` / `phone` INSIDE the address block rather
 * than at the top level. Only populated fields are sent so an amendment never blanks a
 * field the order legitimately has set; both `state` and `state_code` (and country) are
 * sent since ShipHero ignores unknown fields — a schema drift no-ops rather than rejects.
 * Mirrors the reference plugin's `_build_update_input` (NOT verified against a tenant).
 */
export function buildShipheroUpdateAddress(input: WmsOrderPushInput): RawRecord {
  // Only emit a shipping_address block for a "usable" address — a street line plus
  // a country — mirroring the reference plugin's `_usable` guard. A name/email-only
  // block risks rejection if ShipHero requires country_code whenever the block is
  // present; better to send nothing than a partial address.
  const a = input.shippingAddress
  const street = (a.address1 || a.address2).trim()
  if (!street || !a.country.trim()) return {}
  const base = buildShipheroAddress(input)
  const address: RawRecord = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string' && value.trim()) address[key] = value
  }
  if (typeof base.state === 'string' && base.state.trim()) address.state_code = base.state
  if (typeof base.country === 'string' && base.country.trim()) address.country_code = base.country
  const email = (input.email ?? '').trim()
  if (email) address.email = email
  return address
}

/**
 * Build a stable, within-order-unique `partner_line_item_id`. ShipHero rejects
 * duplicate partner_line_item_id within a payload; the generic push line carries
 * no line id, so we key on the external order reference + SKU and disambiguate
 * repeated SKUs with a hyphen counter (hyphen is safe in every ShipHero id form).
 */
function buildPartnerLineItemId(externalReference: string, sku: string, seen: Set<string>): string {
  const base = `${externalReference}:${sku}`
  let candidate = base
  let n = 1
  while (seen.has(candidate)) {
    candidate = `${base}-${n}`
    n += 1
  }
  seen.add(candidate)
  return candidate
}

/** Minimal ShipHero line-item input for `order_create` (CreateOrderInput.line_items),
 *  matching the reference plugin's `_build_create_input`: sku, a within-order-unique
 *  partner_line_item_id, whole-unit quantity, unit price, and name. The fulfilment /
 *  warehouse fields are NOT sent on create (the create reference omits them — they only
 *  appear in the documented `order_add_line_items` example). */
function buildLineItemInput(line: WmsOrderPushLine, quantity: number, partnerLineItemId: string): RawRecord {
  return {
    sku: line.sku,
    partner_line_item_id: partnerLineItemId,
    quantity,
    price: money(line.unitPriceExVat),
    product_name: (line.description ?? line.sku).slice(0, 255),
  }
}

/** Line-item input for `order_add_line_items` — the documented add example carries the
 *  fulfilment + warehouse fields (added to an already-created order, so the warehouse
 *  and pending-fulfilment quantity are explicit). */
function buildAddLineItemInput(
  line: WmsOrderPushLine,
  quantity: number,
  partnerLineItemId: string,
  externalWarehouseId: string | null,
): RawRecord {
  const item = buildLineItemInput(line, quantity, partnerLineItemId)
  item.fulfillment_status = 'pending'
  item.quantity_pending_fulfillment = quantity
  if (externalWarehouseId) item.warehouse_id = externalWarehouseId
  return item
}

/** Assemble the CreateOrderInput payload from the generic push input. */
export function buildShipheroCreateInput(input: WmsOrderPushInput): RawRecord {
  const seen = new Set<string>()
  const lineItems = input.lines.map((line) =>
    buildLineItemInput(line, line.quantity, buildPartnerLineItemId(input.externalReference, line.sku, seen)),
  )

  const goodsExVat = input.lines.reduce((sum, line) => sum + line.unitPriceExVat * line.quantity, 0)
  const goodsVat = input.lines.reduce((sum, line) => sum + line.unitPriceVat * line.quantity, 0)
  const shippingGross = input.shippingExVat + input.shippingVat

  const address = buildShipheroAddress(input)
  const payload: RawRecord = {
    partner_order_id: input.externalReference,
    order_number: input.orderNumber,
    shop_name: SHIPHERO_SHOP_NAME,
    fulfillment_status: 'pending',
    order_date: '',
    required_ship_date: '',
    email: input.email ?? '',
    profile: '',
    // Store credit is a payment, not a discount — push the full goods value so
    // the warehouse / customs see the real invoice (see store-credit memory).
    subtotal: money(goodsExVat),
    total_tax: money(input.totalVat),
    total_discounts: money(input.discountExVat + input.discountVat),
    total_price: money(goodsExVat + goodsVat + shippingGross),
    shipping_address: address,
    billing_address: address,
    line_items: lineItems,
  }
  if (input.courierService || shippingGross > 0) {
    payload.shipping_lines = {
      title: input.courierService ?? 'Default',
      price: money(shippingGross),
    }
  }
  const comments = (input.comments ?? '').trim()
  if (comments) payload.packing_note = comments.slice(0, 1000)
  return payload
}

// --- GraphQL documents -------------------------------------------------------

const FIND_BY_PARTNER_ID_QUERY = `query ($partnerOrderId: String!) {
  orders(partner_order_id: $partnerOrderId) {
    data(first: 2) {
      edges {
        node { id legacy_id order_number partner_order_id fulfillment_status }
      }
    }
  }
}`

const ORDER_CREATE_MUTATION = `mutation ($data: CreateOrderInput!) {
  order_create(data: $data) {
    request_id
    complexity
    order { id legacy_id order_number partner_order_id fulfillment_status }
  }
}`

const ORDER_DETAIL_QUERY = `query ($id: String!) {
  order(id: $id) {
    data {
      id
      legacy_id
      order_number
      fulfillment_status
      line_items {
        edges {
          node { id sku quantity partner_line_item_id }
        }
      }
    }
  }
}`

const ORDER_UPDATE_MUTATION = `mutation ($data: UpdateOrderInput!) {
  order_update(data: $data) { request_id complexity }
}`

const ORDER_ADD_LINE_ITEMS_MUTATION = `mutation ($data: AddLineItemsInput!) {
  order_add_line_items(data: $data) { request_id complexity }
}`

const ORDER_UPDATE_LINE_ITEMS_MUTATION = `mutation ($data: UpdateLineItemsInput!) {
  order_update_line_items(data: $data) { request_id complexity }
}`

const ORDER_REMOVE_LINE_ITEMS_MUTATION = `mutation ($data: RemoveLineItemsInput!) {
  order_remove_line_items(data: $data) { request_id complexity }
}`

const ORDER_CANCEL_MUTATION = `mutation ($data: CancelOrderInput!) {
  order_cancel(data: $data) {
    request_id
    complexity
    order { id fulfillment_status }
  }
}`

const ORDER_ADD_TAGS_MUTATION = `mutation ($data: UpdateTagsInput!) {
  order_add_tags(data: $data) { request_id complexity }
}`

// --- Order push (create) -----------------------------------------------------

type ShipheroOrderNode = {
  id: string
  legacyId: string | null
  orderNumber: string | null
  fulfillmentStatus: string
}

function readOrderNode(record: RawRecord | null): ShipheroOrderNode | null {
  if (!record) return null
  const id = str(record.id) ?? str(record.legacy_id)
  if (!id) return null
  return {
    id,
    legacyId: str(record.legacy_id),
    orderNumber: str(record.order_number),
    fulfillmentStatus: normalizeStatus(record.fulfillment_status),
  }
}

/**
 * Preflight dedupe: resolve the ShipHero order already created for this IMS
 * order reference, or null if none. Refuses (returns null) on an ambiguous
 * match — two distinct ShipHero ids for one partner_order_id is tenant data
 * drift we surface rather than write back against a coin flip.
 */
async function findShipheroOrderByPartnerId(externalReference: string): Promise<ShipheroOrderNode | null> {
  const reference = externalReference.trim()
  if (!reference) return null
  const result = await shipheroGraphql<{ orders?: unknown }>(FIND_BY_PARTNER_ID_QUERY, { partnerOrderId: reference })
  if (result.error) throw new Error(result.error)
  const nodes = extractShipheroConnectionNodes((result.data?.orders as { data?: unknown })?.data ?? result.data?.orders)
    .map((node) => readOrderNode(asRecord(node)))
    .filter((node): node is ShipheroOrderNode => node !== null)
  if (nodes.length === 0) return null
  const distinctIds = new Set(nodes.map((node) => node.id))
  if (distinctIds.size > 1) {
    throw new Error(
      `ShipHero find-by-partner_order_id(${reference}) matched ${distinctIds.size} distinct orders ` +
        `[${[...distinctIds].join(', ')}] — refusing to reconcile against an ambiguous match (tenant data drift).`,
    )
  }
  return nodes[0]
}

export async function pushShipheroOrder(input: WmsOrderPushInput): Promise<WmsOrderPushResult> {
  // Idempotency preflight: ShipHero's order_create does NOT enforce
  // partner_order_id uniqueness, so a retry after a lost writeback would create
  // a duplicate. Reconcile to the existing order if one is already there.
  const existing = await findShipheroOrderByPartnerId(input.externalReference)
  if (existing) {
    return {
      externalOrderId: existing.id,
      externalOrderNumber: existing.orderNumber ?? input.orderNumber,
      status: existing.fulfillmentStatus || 'pending',
    }
  }

  const result = await shipheroGraphql<{ order_create?: { order?: unknown } }>(ORDER_CREATE_MUTATION, {
    data: buildShipheroCreateInput(input),
  })
  if (result.error) throw new Error(result.error)
  const order = readOrderNode(asRecord(result.data?.order_create?.order))
  if (!order) throw new Error('ShipHero order_create returned no order id')
  return {
    externalOrderId: order.id,
    externalOrderNumber: order.orderNumber ?? input.orderNumber,
    status: order.fulfillmentStatus || 'pending',
  }
}

// --- Live order + line-item amendment ---------------------------------------

type ShipheroLineItem = {
  id: string
  sku: string | null
  quantity: number
  /** ShipHero's stored partner_line_item_id, when the detail query returns one — used
   *  to seed add-dedupe so a re-add doesn't reuse an id already on the order. */
  partnerLineItemId?: string | null
}

type ShipheroOrderDetail = {
  id: string
  orderNumber: string | null
  fulfillmentStatus: string
  lineItems: ShipheroLineItem[]
}

async function fetchShipheroOrderDetail(externalOrderId: string): Promise<ShipheroOrderDetail | null> {
  const result = await shipheroGraphql<{ order?: { data?: unknown } }>(ORDER_DETAIL_QUERY, {
    id: externalOrderId.trim(),
  })
  if (result.error) throw new Error(result.error)
  const data = asRecord(result.data?.order?.data)
  if (!data) return null
  const id = str(data.id) ?? str(data.legacy_id)
  if (!id) return null
  const lineItems = extractShipheroConnectionNodes(data.line_items)
    .map((node) => asRecord(node))
    .filter((node): node is RawRecord => node !== null)
    .map((node) => ({
      id: str(node.id) ?? '',
      sku: str(node.sku),
      quantity: toInt(node.quantity),
      partnerLineItemId: str(node.partner_line_item_id),
    }))
    .filter((line) => line.id !== '')
  return {
    id,
    orderNumber: str(data.order_number),
    fulfillmentStatus: normalizeStatus(data.fulfillment_status),
    lineItems,
  }
}

/** One concrete amendment to reconcile a ShipHero order's lines to the desired set. */
export type ShipheroLineAmendment =
  | { kind: 'remove'; lineItemId: string }
  | { kind: 'update'; lineItemId: string; quantity: number }
  | { kind: 'add'; line: WmsOrderPushLine; quantity: number }

/**
 * Pure planner: diff a ShipHero order's current line items against the desired
 * (refund-netted) line set. Quantities are absolute, matched by trimmed SKU.
 * Duplicate current rows for one SKU are consolidated into the first (the rest
 * removed); lines that net to zero/absent are removed; SKUs not yet on the order
 * are added. Ordered removes → updates → adds so a consolidation never transiently
 * overstates demand for a SKU. Mirrors `planMintsoftItemAmendments`.
 */
export function planShipheroLineAmendments(
  current: ShipheroLineItem[],
  desiredLines: WmsOrderPushLine[],
): ShipheroLineAmendment[] {
  const desired = new Map<string, { quantity: number; line: WmsOrderPushLine }>()
  for (const line of desiredLines) {
    const sku = line.sku?.trim()
    if (!sku) continue
    const existing = desired.get(sku)
    if (existing) existing.quantity += line.quantity
    else desired.set(sku, { quantity: line.quantity, line })
  }

  const currentBySku = new Map<string, ShipheroLineItem[]>()
  for (const item of current) {
    const sku = item.sku?.trim()
    if (!sku) continue
    const list = currentBySku.get(sku) ?? []
    list.push(item)
    currentBySku.set(sku, list)
  }

  const removes: ShipheroLineAmendment[] = []
  const updates: ShipheroLineAmendment[] = []
  const adds: ShipheroLineAmendment[] = []
  for (const sku of new Set<string>([...desired.keys(), ...currentBySku.keys()])) {
    const want = desired.get(sku)
    const have = currentBySku.get(sku) ?? []
    if (!want || want.quantity <= 0) {
      for (const item of have) removes.push({ kind: 'remove', lineItemId: item.id })
      continue
    }
    if (have.length === 0) {
      adds.push({ kind: 'add', line: want.line, quantity: want.quantity })
      continue
    }
    const [primary, ...duplicates] = have
    for (const dup of duplicates) removes.push({ kind: 'remove', lineItemId: dup.id })
    if (primary.quantity !== want.quantity) {
      updates.push({ kind: 'update', lineItemId: primary.id, quantity: want.quantity })
    }
  }
  return [...removes, ...updates, ...adds]
}

async function applyShipheroLineAmendment(
  externalOrderId: string,
  amendment: ShipheroLineAmendment,
  input: WmsOrderPushInput,
  addedIds: Set<string>,
): Promise<void> {
  if (amendment.kind === 'remove') {
    const result = await shipheroGraphql(ORDER_REMOVE_LINE_ITEMS_MUTATION, {
      data: { order_id: externalOrderId, line_items: [{ id: amendment.lineItemId }] },
    })
    if (result.error) throw new Error(result.error)
    return
  }
  if (amendment.kind === 'update') {
    const result = await shipheroGraphql(ORDER_UPDATE_LINE_ITEMS_MUTATION, {
      data: { order_id: externalOrderId, line_items: [{ id: amendment.lineItemId, quantity: amendment.quantity }] },
    })
    if (result.error) throw new Error(result.error)
    return
  }
  const externalWarehouseId = input.externalWarehouseId.trim() || null
  const partnerLineItemId = buildPartnerLineItemId(input.externalReference, amendment.line.sku, addedIds)
  const result = await shipheroGraphql(ORDER_ADD_LINE_ITEMS_MUTATION, {
    data: {
      order_id: externalOrderId,
      line_items: [buildAddLineItemInput(amendment.line, amendment.quantity, partnerLineItemId, externalWarehouseId)],
    },
  })
  if (result.error) throw new Error(result.error)
}

/** Reconcile a pre-fulfilment ShipHero order's line items to the (refund-netted)
 *  desired set via the dedicated add/update/remove line-item mutations. Skips
 *  reconciliation if any desired line is non-integer/negative — ShipHero quantities
 *  are whole units; the refund itself still reaches the warehouse via the order tag
 *  that createRefund posts through addOrderComment (so the skip is not silent at the
 *  system level — it mirrors the Mintsoft /Items reconciliation skip). */
async function reconcileShipheroLineItems(detail: ShipheroOrderDetail, input: WmsOrderPushInput): Promise<void> {
  if (input.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 0)) return
  const plan = planShipheroLineAmendments(detail.lineItems, input.lines)
  // Seed the add-dedupe set with the partner_line_item_ids already on the order so a
  // generated add id can't collide with an existing one. NOTE (unverified): if ShipHero
  // keeps a removed line's partner_line_item_id reserved, a remove-then-re-add of the
  // same SKU across separate sweeps could still clash (the removed line no longer
  // appears in the detail query); confirm reservation behaviour against a live tenant.
  const addedIds = new Set<string>(
    detail.lineItems
      .map((line) => line.partnerLineItemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  for (const amendment of plan) {
    await applyShipheroLineAmendment(detail.id, amendment, input, addedIds)
  }
}

export async function updateShipheroOrder(
  externalOrderId: string,
  input: WmsOrderPushInput,
): Promise<WmsOrderUpdateResult> {
  const detail = await fetchShipheroOrderDetail(externalOrderId)
  if (!detail) return { updated: false, status: 'NOT_FOUND' }
  if (!SHIPHERO_PRE_FULFILMENT_STATUSES.has(detail.fulfillmentStatus)) {
    // Past pre-fulfilment: the warehouse is working the order; do not amend.
    return { updated: false, status: detail.fulfillmentStatus.toUpperCase() || 'NOT_AMENDABLE' }
  }

  // Scalar amend (shipping address incl. email/phone in the update shape, + packing
  // note) via order_update; line items go via the dedicated line-item mutations
  // (order_update cannot edit lines). Skip the call when there's nothing to send.
  const updateData: RawRecord = { order_id: externalOrderId }
  const updateAddress = buildShipheroUpdateAddress(input)
  if (Object.keys(updateAddress).length > 0) updateData.shipping_address = updateAddress
  const comments = (input.comments ?? '').trim()
  if (comments) updateData.packing_note = comments.slice(0, 1000)
  if (Object.keys(updateData).length > 1) {
    const scalar = await shipheroGraphql(ORDER_UPDATE_MUTATION, { data: updateData })
    if (scalar.error) throw new Error(scalar.error)
  }

  await reconcileShipheroLineItems(detail, input)
  return { updated: true, status: 'AMENDED' }
}

// --- Cancel ------------------------------------------------------------------

export async function cancelShipheroOrder(externalOrderId: string): Promise<WmsOrderCancelResult> {
  const detail = await fetchShipheroOrderDetail(externalOrderId)
  if (!detail) return { cancelled: false, status: 'NOT_FOUND' }
  if (detail.fulfillmentStatus === SHIPHERO_CANCELED_STATUS) {
    return { cancelled: true, status: 'CANCELLED' }
  }
  if (!SHIPHERO_PRE_FULFILMENT_STATUSES.has(detail.fulfillmentStatus)) {
    // Already being fulfilled/shipped — not auto-cancellable; the sweep dead-letters
    // and an operator raises a manual cancellation query in ShipHero.
    return { cancelled: false, status: detail.fulfillmentStatus.toUpperCase() || 'NOT_CANCELLABLE' }
  }

  const result = await shipheroGraphql<{ order_cancel?: { order?: unknown } }>(ORDER_CANCEL_MUTATION, {
    // void_on_platform=false: IMS initiated the cancel, so ShipHero needn't echo it
    // back. force omitted (false): an order with a live label/shipment fails loud
    // rather than being force-cancelled out from under the warehouse.
    data: { order_id: externalOrderId, reason: 'Cancelled in IMS' },
  })
  if (result.error) throw new Error(result.error)
  const observed = normalizeStatus(asRecord(result.data?.order_cancel?.order)?.fulfillment_status)
  if (observed !== SHIPHERO_CANCELED_STATUS) {
    // A non-confirming response must NOT clear the IMS push link — warehouse work
    // could still be live. Throw so the sweep retries / surfaces the failure.
    throw new Error(
      `ShipHero order_cancel returned fulfillment_status=${observed || '(none)'}, expected '${SHIPHERO_CANCELED_STATUS}'`,
    )
  }
  return { cancelled: true, status: 'CANCELLED' }
}

// --- Operator note (tag) -----------------------------------------------------

/** Flag a warehouse-visible note onto a ShipHero order. Uses `order_add_tags`
 *  (additive — it does not overwrite the order's packing_note) so the sweep can
 *  surface a refund/hold that couldn't be auto-applied. */
export async function addShipheroOrderComment(externalOrderId: string, comment: string): Promise<void> {
  const tag = comment.trim().slice(0, 255)
  if (!tag) return
  const result = await shipheroGraphql(ORDER_ADD_TAGS_MUTATION, {
    data: { order_id: externalOrderId, tags: [tag] },
  })
  if (result.error) throw new Error(result.error)
}
