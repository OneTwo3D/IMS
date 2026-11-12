import { isOutboundMaybeSentRefusalText, isOutboundWriteHeldText, outboundTextAfterEarlierSend } from '@/lib/security/outbound-write-hold-constants'
import type {
  WmsAmbiguousCreateResolution,
  WmsMergedItemRemoval,
  WmsMergedSurvivorLookup,
  WmsOrderItemRef,
  WmsOrderCancelResult,
  WmsOrderPushInput,
  WmsOrderPushLine,
  WmsOrderPushResult,
  WmsOrderUpdateResult,
} from '@/lib/connectors/wms/types'
import { WmsOrderUpdatePartialError, legacyCourierFormInput } from '@/lib/connectors/wms/courier-form'
import { roundTransmittedMoney } from '@/lib/connectors/wms/transmitted-money'
import { extractMintsoftArrayPayload, extractMintsoftArrayPayloadStrict, extractMintsoftObjectPayload } from './normalizers'
import { mintsoftRequest } from './client'
import { assertMintsoftOrderClient, mergedParts as mintsoftMergedParts, requireMintsoftClientId } from './orders'
import { getMintsoftSettings, parseMintsoftPositiveId } from '../settings/schema'

/**
 * Outbound Mintsoft order push (Phase 8), modelled on the proven woo-mintsoft
 * plugin (wc_mintsoft_orders.py): create via `PUT /api/Order` (NewOrderWithItems),
 * dedupe on "already exists" by re-finding the order via ExternalOrderReference,
 * and cancel via `GET /api/Order/{id}/Cancel` — only while the order is still NEW.
 *
 * TENANT BOUNDARY (o3d-bjc.6): Mintsoft is a shared 3PL tenant, so an UNSCOPED
 * lookup can surface ANOTHER client's order. Every path here that resolves or
 * mutates an order by a reference we did not just create is therefore scoped by
 * `mintsoft_client_id` AND re-validates the returned row's ClientId, exactly like
 * the read path (assertMintsoftOrderClient). Order CREATION is unaffected — it
 * binds nothing pre-existing.
 */

type RawOrder = Record<string, unknown>

/**
 * Mintsoft OrderStatusIds this module acts on (confirmed against the live API: a new order with stock is 1, a backordered one 9, and a
 * cancelled one 3, which keeps its OrderNumber for ever).
 */
const MINTSOFT_STATUS_NEW = 1
const MINTSOFT_STATUS_CANCELLED = 3
const MINTSOFT_STATUS_ON_BACKORDER = 9
/** Order/Search returns at most this many rows; a response this size may have been cut short. */
const MINTSOFT_SEARCH_PAGE = 10

/**
 * THE ONE STATUS PREDICATE for "may IMS treat this Mintsoft order as the live one?", shared by the read-back before binding, the by-id
 * verification and the by-reference verification so they cannot drift apart: a PRESENT status that is not CANCELLED is live; CANCELLED is
 * dead; an absent status proves nothing.
 */
function orderLiveness(row: RawOrder): 'live' | 'cancelled' | 'unknown' {
  const status = orderStatusId(row)
  if (status === null) return 'unknown'
  return status === MINTSOFT_STATUS_CANCELLED ? 'cancelled' : 'live'
}

/**
 * THE ONE IDENTITY PREDICATE, shared by the read-back before binding and both verification routes: an order is OURS only if it carries
 * BOTH this order's OrderNumber AND its own ExternalOrderReference, exactly. `incomplete` (a field is absent, nothing contradicts) proves
 * nothing either way and stays unverified; `mismatch` (a present field differs) is somebody else's order.
 */
function orderIdentity(row: RawOrder, identity: { orderNumber: string | null; externalReference: string | null }): 'match' | 'mismatch' | 'incomplete' {
  if (!identity.orderNumber || !identity.externalReference) return 'incomplete'
  const number = toStr(row.OrderNumber)
  const ref = toStr(row.ExternalOrderReference)
  if ((number !== null && number !== identity.orderNumber) || (ref !== null && ref !== identity.externalReference)) return 'mismatch'
  return number === null || ref === null ? 'incomplete' : 'match'
}

function orderStatusId(row: RawOrder): number | null {
  const value = row.OrderStatusId
  const n = typeof value === 'number' ? value : Number.parseInt(toStr(value) ?? '', 10)
  return Number.isFinite(n) ? n : null
}

function toStr(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

// One shared implementation with the payload total guard (see transmitted-money.ts).
const round2 = roundTransmittedMoney

type CourierOption =
  | { kind: 'name' }
  | { kind: 'mappedId'; courierServiceId: number }
  | { kind: 'defaultId'; courierServiceId: number }
  | { kind: 'none' }

/** Resolve a shipping-service name to a Mintsoft CourierServiceId via the configured map. */
export function resolveMappedCourierId(courierService: string | null, mapJson: string): number | null {
  if (!courierService || !mapJson.trim()) return null
  try {
    const map = JSON.parse(mapJson) as Record<string, unknown>
    const raw = map[courierService]
    const id = typeof raw === 'number' ? raw : Number(String(raw).trim())
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * Resolve the order's courier through the configured map: the name sent (the courier key when there is one), then
 * the alternates in order (combined "{method_id}:{method_title}", bare title, method id).
 */
export function resolveMappedCourierIdForInput(
  input: Pick<WmsOrderPushInput, 'courierService' | 'courierServiceAlternates'>,
  mapJson: string,
): number | null {
  for (const name of [input.courierService, ...(input.courierServiceAlternates ?? [])]) {
    const id = resolveMappedCourierId(name, mapJson)
    if (id != null) return id
  }
  return null
}

/**
 * Strict parse for the configured default CourierServiceId: a plain positive
 * integer, else null. Plain-digit only so the saved value and this consumer
 * agree (avoids `parseInt`/`Number` divergence on `"1e3"`, `"0x10"`, decimals).
 */
export function parseDefaultCourierId(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return null
  const id = Number(trimmed)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function buildPushPayload(input: WmsOrderPushInput, courier: CourierOption, includeItems = true): Record<string, unknown> {
  const a = input.shippingAddress
  const payload: Record<string, unknown> = {
    OrderNumber: input.orderNumber,
    ExternalOrderReference: input.externalReference,
    FirstName: a.firstName,
    LastName: a.lastName,
    CompanyName: a.company,
    Address1: a.address1,
    Address2: a.address2,
    Town: a.town,
    County: a.county,
    PostCode: a.postCode,
    Country: a.country,
    Email: input.email ?? '',
    Phone: input.phone ?? '',
    Currency: input.currency,
    TotalVat: round2(input.totalVat),
    ShippingTotalExVat: round2(input.shippingExVat),
    ShippingTotalVat: round2(input.shippingVat),
    DiscountTotalExVat: round2(input.discountExVat),
    DiscountTotalVat: round2(input.discountVat),
    Comments: (input.comments ?? '').slice(0, 1000),
  }
  // VAT goes on the create payload only (with the items); amends reuse this builder
  // with includeItems=false, and a Mintsoft order's VAT number may be immutable once
  // created — don't risk an amend rejection by re-sending it.
  if (includeItems && input.vatNumber) payload.VATNumber = input.vatNumber
  if (includeItems) {
    // The order-update endpoint (NewOrder) ignores items, so creates send them here and
    // amendments are reconciled separately via the /Items sub-resource endpoints
    // (see reconcileMintsoftOrderItems).
    payload.OrderItems = input.lines.map((line) => ({
      SKU: line.sku,
      Quantity: line.quantity,
      UnitPrice: line.unitPriceExVat,
      UnitPriceVat: line.unitPriceVat,
      Details: (line.description ?? '').slice(0, 255),
    }))
  }
  const warehouseId = Number.parseInt(input.externalWarehouseId, 10)
  if (Number.isFinite(warehouseId)) payload.WarehouseId = warehouseId
  if (courier.kind === 'name' && input.courierService) {
    payload.CourierService = input.courierService
  } else if (courier.kind === 'mappedId') {
    // Configured mapping: send both the name and the resolved service id.
    if (input.courierService) payload.CourierService = input.courierService
    payload.CourierServiceId = courier.courierServiceId
  } else if (courier.kind === 'defaultId') {
    // Mintsoft requires a courier identifier; fall back to a configured default
    // service id so the warehouse can re-pick if the name didn't resolve.
    payload.CourierServiceId = courier.courierServiceId
  }
  return payload
}

/**
 * Resolve the configured shared-tenant ClientId, failing closed (o3d-bjc.6).
 * `operation` names the caller so an unconfigured tenant produces an actionable
 * error rather than a silent cross-client lookup.
 */
async function getPushClientId(operation: string): Promise<number> {
  const settings = await getMintsoftSettings()
  return requireMintsoftClientId(parseMintsoftPositiveId(settings.mintsoft_client_id), operation)
}

/**
 * The ONE Order/Search request (OrderNumber + ClientId). Mintsoft documents no ClientId parameter and the search is a TERM search over
 * order number, tracking number and external reference returning at most MINTSOFT_SEARCH_PAGE rows, so callers filter by ClientId and
 * exact fields themselves and treat a full page as possibly truncated.
 */
async function fetchSearchRows(orderNumber: string, clientId: number): Promise<RawOrder[]> {
  const query = new URLSearchParams({ OrderNumber: orderNumber, ClientId: String(clientId) })
  const result = await mintsoftRequest<unknown>(`/api/Order/Search?${query.toString()}`)
  if (result.error) throw new Error(result.error)
  return extractMintsoftArrayPayloadStrict(result.data, 'Order/Search (push dedupe)') as RawOrder[]
}

/**
 * The existing order a duplicate-number refusal points at. Resolves ONLY when the search page is complete (a full page may have cut the
 * real order off) and exactly one same-client, non-merged row carries BOTH this order's OrderNumber AND its own ExternalOrderReference,
 * exactly. A reused reference under another number, or a reused number under another reference, is somebody else's order.
 */
async function findExistingByReference(input: WmsOrderPushInput, clientId: number): Promise<RawOrder | null> {
  const raw = await fetchSearchRows(input.orderNumber, clientId)
  if (raw.length >= MINTSOFT_SEARCH_PAGE) return null
  const matches = raw
    .map((row) => assertMintsoftOrderClient(row, clientId, 'Mintsoft Order/Search (push dedupe)'))
    .filter((row) => {
      const number = toStr(row.OrderNumber)
      if (number && number.includes('+')) return false // skip merged survivors
      return number === input.orderNumber && input.externalReference !== '' && toStr(row.ExternalOrderReference) === input.externalReference
    })
  return matches.length === 1 ? matches[0] : null
}

type LiveOrderRead = { ok: true } | { ok: false; kind: 'cancelled' | 'unconfirmed'; reason: string }

/**
 * THE ONE READ-BACK BEFORE IMS BINDS TO AN ORDER IT FOUND BY SEARCH (shared by the ambiguous-create reconcile and the duplicate-create
 * path). The search row's own status is not trusted (it can be absent): the order is read by id and bound only if that scoped read
 * succeeds, is ours, and carries a PRESENT status that is not CANCELLED.
 */
async function readBackLiveOrder(id: string, clientId: number, identity: { orderNumber: string; externalReference: string }): Promise<LiveOrderRead> {
  const detail = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(id)}?ClientId=${clientId}`)
  const row = !detail.error && detail.data && typeof detail.data === 'object' && !Array.isArray(detail.data) ? (detail.data as RawOrder) : null
  if (!row) return { ok: false, kind: 'unconfirmed', reason: 'Mintsoft holds this order but it could not be read back to check its status, so it was not linked' }
  if (toStr(row.ClientId ?? row.clientId) !== String(clientId) || toStr(row.ID ?? row.Id ?? row.id) !== id) {
    return { ok: false, kind: 'unconfirmed', reason: 'Mintsoft holds this order but the read-back did not confirm it is ours, so it was not linked' }
  }
  // IDENTITY: the order read back must carry BOTH this order's number and its own reference, exactly. A missing field is a mismatch.
  if (orderIdentity(row, identity) !== 'match') {
    return { ok: false, kind: 'unconfirmed', reason: 'Mintsoft holds an order under this number but the read-back does not carry this order\'s own number and reference, so it was not linked' }
  }
  const liveness = orderLiveness(row)
  if (liveness === 'unknown') return { ok: false, kind: 'unconfirmed', reason: 'Mintsoft holds this order but its status could not be read, so it was not linked' }
  if (liveness === 'cancelled') {
    return { ok: false, kind: 'cancelled', reason: 'Mintsoft holds this order but it is CANCELLED there (a cancelled order keeps its number), so it was not linked' }
  }
  return { ok: true }
}

/**
 * Resolve a create whose outcome IS NOT RECORDED (a timed-out PUT, a 5xx, a lost link write) by READING Mintsoft: the same scoped
 * Order/Search the push dedupe uses. Nothing is written. An order is adopted only when exactly one row matches and that row carries
 * THIS order's own stable external reference; a number-only match can be another order of ours that shares a number, so it (and
 * several matches, and a row that has no usable id) is UNRESOLVED and left for a person. Zero matches is NONE.
 */
export async function reconcileMintsoftAmbiguousCreate(
  reference: { orderNumber: string; externalReference: string },
): Promise<WmsAmbiguousCreateResolution> {
  const clientId = await getPushClientId('Mintsoft ambiguous-create reconcile')
  const raw = await fetchSearchRows(reference.orderNumber, clientId)
  // A term search can return other clients' orders (it matches tracking numbers and references too) and stops at one page: a full page
  // may have cut the order we want off, so nothing is adopted from it.
  if (raw.length >= MINTSOFT_SEARCH_PAGE) {
    return { kind: 'UNRESOLVED', reason: `Mintsoft returned a full page of ${raw.length} search results, which may be incomplete, so none can be proved to be this order` }
  }
  const ours: RawOrder[] = []
  for (const row of raw) {
    const rowClient = toStr(row.ClientId ?? row.clientId)
    // No ClientId on a row means ownership cannot be shown: nothing is adopted.
    if (rowClient === null) return { kind: 'UNRESOLVED', reason: 'a Mintsoft search result carries no ClientId, so ownership cannot be shown' }
    if (rowClient === String(clientId)) ours.push(row)
  }
  // A same-client MERGED order that lists OUR exact number as one of its parts means Mintsoft merged this order with another: the create
  // landed and was absorbed. It is never adopted and never "absent": the survivor is named, and the guidance does not suggest cancelling
  // it, because that would take the other order's goods with it.
  const mergedInto = ours.find((row) => {
    const number = toStr(row.OrderNumber)
    return number !== null && number.includes('+') && mintsoftMergedParts(number).includes(reference.orderNumber)
  })
  if (mergedInto) {
    const survivorNumber = toStr(mergedInto.OrderNumber)
    const survivorId = toStr(mergedInto.ID ?? mergedInto.Id ?? mergedInto.id)
    return {
      kind: 'UNRESOLVED',
      reason: `Mintsoft merged this order with another into order ${survivorNumber}${survivorId ? ` (id ${survivorId})` : ''}, which also holds the other order's goods, so IMS did not link it. Do not cancel that order on this order's behalf`,
    }
  }
  const matches = ours.filter((row) => {
    const number = toStr(row.OrderNumber)
    if (number && number.includes('+')) return false // a merged survivor holds other orders too
    return number === reference.orderNumber || toStr(row.ExternalOrderReference) === reference.externalReference
  })
  if (matches.length === 0) return { kind: 'NONE' }
  const ownReference = reference.externalReference.trim()
  const exact = ownReference ? matches.filter((row) => toStr(row.ExternalOrderReference) === ownReference && toStr(row.OrderNumber) === reference.orderNumber) : []
  if (matches.length === 1 && exact.length === 1) {
    const id = toStr(exact[0].ID ?? exact[0].Id ?? exact[0].id)
    if (id) {
      // THE SEARCH ROW'S STATUS IS NOT TRUSTED: the order is read back by id and adopted only if that shows a live order.
      const live = await readBackLiveOrder(id, clientId, reference)
      if (!live.ok) return { kind: 'UNRESOLVED', reason: live.reason }
      return { kind: 'ADOPT', externalOrderId: id, externalOrderNumber: toStr(exact[0].OrderNumber) ?? reference.orderNumber }
    }
  }
  const seen = matches.map((row) => toStr(row.OrderNumber) ?? '?').join(', ')
  return {
    kind: 'UNRESOLVED',
    reason: matches.length > 1
      ? `Mintsoft holds ${matches.length} orders that match (${seen}), so none can be proved to be this order`
      : `Mintsoft holds order ${seen} under this number, but it does not carry this order's own reference, so it cannot be proved to be this order`,
  }
}

/**
 * READ-ONLY (live-confirmed): when order B is merged into C the survivor keeps C's id, its OrderNumber becomes "<absorbing>+<absorbed>"
 * (so this order's number can be ANY part), its ExternalOrderReference stays the absorbing order's, and it gains the order name/value
 * MergedOrder=True; B itself then 404s like a deletion. Order/Search by either original number returns the survivor. Adopted as the
 * survivor only when: our ClientId, a full-page-free search, the number is one exact "+" part, the MergedOrder flag is set, and exactly
 * one order qualifies.
 */
// WHY A SAME-CLIENT SURVIVOR WITH OUR EXACT NUMBER AS A PART CAN ONLY HAVE ABSORBED OUR ORDER: observed live, Mintsoft refuses a second
// order with an existing OrderNumber within a client ("Order Number already exists!"), and keeps refusing it after the first is
// cancelled (a cancelled order keeps its number). So within our client the number belongs to exactly one order for good, and a merged
// survivor listing it as one "+" part has absorbed that order. The checks that remain are therefore the ones that tie the survivor to
// OUR client (ClientId), to a real merge (MergedOrder=True) and to our order (an EXACT part, never a prefix or substring).
export async function findMintsoftMergedSurvivor(orderNumber: string): Promise<WmsMergedSurvivorLookup> {
  const clientId = await getPushClientId('Mintsoft merged-survivor lookup')
  const wanted = orderNumber.trim()
  if (!wanted) return { kind: 'ABSENT' }
  const raw = await fetchSearchRows(wanted, clientId)
  if (raw.length >= MINTSOFT_SEARCH_PAGE) return { kind: 'INCONCLUSIVE', reason: 'the search returned a full page of results, which may be incomplete' }
  const survivors: RawOrder[] = []
  for (const row of raw) {
    const parts = mintsoftMergedParts(toStr(row.OrderNumber))
    if (!parts.includes(wanted)) continue // not a merge containing this number: ruled out
    // A row whose number IS a merge containing ours but which cannot be tied to our client, or says nothing about being a merge, rules
    // nothing out: it may be the survivor, so the answer is INCONCLUSIVE and never ABSENT.
    const rowClient = toStr(row.ClientId ?? row.clientId)
    if (rowClient === null) return { kind: 'INCONCLUSIVE', reason: 'a search result that contains this number in a merged number carries no ClientId' }
    if (rowClient !== String(clientId)) continue // another client's: ruled out
    if (!Array.isArray(row.OrderNameValues)) return { kind: 'INCONCLUSIVE', reason: 'a merged-number search result carries no order name/values, so it cannot be told whether it is flagged as a merge' }
    const flagged = (row.OrderNameValues as unknown[]).some((entry) => {
      const nv = entry as Record<string, unknown> | null
      return nv !== null && typeof nv === 'object' && toStr(nv.Name) === 'MergedOrder' && toStr(nv.Value)?.toLowerCase() === 'true'
    })
    if (flagged) survivors.push(row)
  }
  if (survivors.length === 0) return { kind: 'ABSENT' }
  if (survivors.length > 1) return { kind: 'INCONCLUSIVE', reason: `${survivors.length} merged orders contain this number` }
  const id = toStr(survivors[0].ID ?? survivors[0].Id ?? survivors[0].id)
  const number = toStr(survivors[0].OrderNumber)
  return id && number ? { kind: 'FOUND', externalOrderId: id, externalOrderNumber: number } : { kind: 'INCONCLUSIVE', reason: 'the merged order carries no readable id or number' }
}

async function createOrder(payload: Record<string, unknown>): Promise<{ ok: boolean; data: RawOrder | null; message: string | null }> {
  const result = await mintsoftRequest<unknown>('/api/Order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (result.error) throw new Error(result.error)
  // PUT /api/Order returns NewOrderResult[] (older tenants: a single object).
  const raw = result.data
  const data: RawOrder | null = Array.isArray(raw)
    ? ((raw[0] as RawOrder) ?? null)
    : (extractMintsoftObjectPayload(raw) as RawOrder | null)
  // Only an UNAMBIGUOUS success binds a link (o3d-bjc.6). Accepting any response
  // that merely carries an OrderId meant `{Success:false, OrderId:999, Message:
  // 'Order already exists'}` bound order 999 before the scoped dedupe branch could
  // ever run — no ownership check at all. A response that reports failure now falls
  // through to the dedupe path, which verifies the ClientId.
  const ok = data?.Success === true
  return { ok, data, message: toStr(data?.Message) }
}

/**
 * The ONE place that decides the single legacy retry after Mintsoft refuses a courier KEY, shared by the create and the
 * amendment. Returns the input and courier to retry with, or null unless ALL hold: the name sent is the courier key (a
 * legacy "{method_id}:{method_title}" form exists and differs), and the answer is a decoded `Success: false` carrying
 * "Unable to Find CourierService" (the order was not created or changed). Anything vaguer returns null and the caller keeps its
 * existing behaviour. The legacy lookup never sees the key: combined form, bare title, method id.
 */
export function legacyCourierRetry(
  input: WmsOrderPushInput,
  mapJson: string,
  data: Record<string, unknown> | null,
  message: string | null,
): { input: WmsOrderPushInput; courier: CourierOption } | null {
  if (data?.Success !== false || !message || !/unable to find courierservice/i.test(message)) return null
  const legacyInput = legacyCourierFormInput(input)
  if (!legacyInput) return null
  const mappedId = resolveMappedCourierIdForInput(legacyInput, mapJson)
  return { input: legacyInput, courier: mappedId != null ? { kind: 'mappedId', courierServiceId: mappedId } : { kind: 'name' } }
}

export async function pushMintsoftOrder(input: WmsOrderPushInput): Promise<WmsOrderPushResult> {
  // Fail closed BEFORE creating anything (o3d-bjc.6). Every later lifecycle step —
  // amend, hold/cancel, warehouse comment — requires the tenant scope, so creating
  // an order without one would mark it SYNCED and then be unable to propagate a
  // cancellation: the warehouse ships an order the customer cancelled. Better to
  // never start a lifecycle we cannot finish.
  const clientId = await getPushClientId('Mintsoft order push')
  const settings = await getMintsoftSettings()
  // Courier selection: a configured shipping-service → CourierServiceId mapping
  // wins; else pass the name through for the WMS to resolve; else (no service on
  // the order at all) fall straight to the configured default id if one is set.
  const mappedId = resolveMappedCourierIdForInput(input, settings.mintsoft_courier_service_map)
  const defaultId = parseDefaultCourierId(settings.mintsoft_default_courier_service_id)
  const initialCourier: CourierOption =
    mappedId != null ? { kind: 'mappedId', courierServiceId: mappedId }
    : input.courierService ? { kind: 'name' }
    : defaultId != null ? { kind: 'defaultId', courierServiceId: defaultId }
    : { kind: 'name' }
  // A create refused on a REDIRECT HOP (the outbound-write hold) has ALREADY been sent: the first
  // request may have created the order. It must not be answered by a blind second PUT. It goes down the
  // maybe-sent path instead: look the order up (a scoped READ) and bind it ONLY if it is provably this
  // order (below). If it cannot be proven the error is re-thrown unchanged (an attempt is spent, as for a
  // timeout, and the link parks AMBIGUOUS_CREATE for an operator).
  // Whether ANY create request in this push has been handed to the WMS. A hold that arrives on a LATER
  // request (the courier-fallback PUT) after an earlier one was sent is not "nothing sent": the earlier
  // PUT may have created the order. Its text is converted so nothing downstream reads it as a hold.
  let anyCreateSent = false
  // Set when the order bound is one that ALREADY existed (a reconciled maybe-sent create, or an "already exists" answer): which
  // courier form it carries is then unknown, not the form this run attempted.
  let boundExisting = false
  const createOrReconcile = async (payload: Record<string, unknown>) => {
    try {
      const result = await createOrder(payload)
      anyCreateSent = true
      return result
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (isOutboundWriteHeldText(text)) {
        // A hop-0 hold: THIS request sent nothing. Only if an earlier one did is it maybe-sent overall.
        if (anyCreateSent) throw new Error(outboundTextAfterEarlierSend(text, 'Mintsoft'))
        throw error
      }
      anyCreateSent = true // any other failure of a create may have reached the WMS
      if (!isOutboundMaybeSentRefusalText(text)) throw error
      // A failed RECONCILIATION never replaces the maybe-sent outcome: if this lookup itself throws (a held
      // login, a transport fault, a malformed body) the ORIGINAL maybe-sent error is what the caller sees.
      // Otherwise a held lookup would surface as a pre-send hold and clear the create dispatch stamp over a
      // PUT that may have created the order.
      const existing = await findExistingByReference(input, clientId).catch(() => 'lookup-failed' as const)
      if (existing === 'lookup-failed') throw error
      // PROVABLY OURS OR NOT AT ALL. The scoped search matches the order number OR the external reference,
      // so a single hit can be ANOTHER order of ours that shares a number. Only a row carrying THIS order's
      // stable external reference (and the ClientId the search already asserts) may be bound; anything else
      // leaves the create unresolved (the maybe-sent error is re-thrown, an attempt is spent, the link
      // parks AMBIGUOUS_CREATE for an operator).
      const existingId = existing
        && input.externalReference != null && input.externalReference !== ''
        && toStr(existing.ExternalOrderReference) === input.externalReference
        ? toStr(existing.ID ?? existing.Id ?? existing.id)
        : null
      if (!existing || !existingId) throw error
      // Bound as a MINTED-BUT-UNVERIFIED id (PENDING_VERIFY): the scoped verification read still runs.
      boundExisting = true
      return { ok: true, data: { Success: true, OrderId: existingId, OrderNumber: toStr(existing.OrderNumber) } as RawOrder, message: null }
    }
  }
  let created = await createOrReconcile(buildPushPayload(input, initialCourier))

  // Courier the WMS couldn't resolve → retry with the configured default id
  // (unless we already used it). Mintsoft requires a resolvable courier. A default id
  // used from the outset (order had no shipping service) is equally "pending" — the
  // warehouse should still confirm the courier before despatch (G6).
  let courierFallback = initialCourier.kind === 'defaultId'
  let courierForm: 'NAME' | 'LEGACY' | 'PLACEHOLDER' = initialCourier.kind === 'defaultId' ? 'PLACEHOLDER' : 'NAME'
  const courierFormName = input.courierService

  // The language-independent courier key was sent and Mintsoft definitively refused it (a decoded
  // `Success: false` answer naming the courier service: nothing was created) → retry ONCE with the legacy
  // label form this order would have been pushed with before the key existed, ahead of any placeholder
  // courier. Anything else (a transport fault, a timeout, a hold, a maybe-sent refusal, an answer that does
  // not say `Success: false`) throws out of createOrReconcile or fails the test below, so it is never retried
  // this way: only a rejection that provably created nothing earns a second PUT. It goes through the same
  // createOrReconcile (outbound hold, maybe-sent reconciliation) as the first.
  const keySent = input.courierServiceLegacy != null && input.courierService != null && input.courierServiceLegacy !== input.courierService
  const legacyRetry = created.ok ? null : legacyCourierRetry(input, settings.mintsoft_courier_service_map, created.data, created.message)
  if (legacyRetry) {
    courierForm = 'LEGACY'
    created = await createOrReconcile(buildPushPayload(legacyRetry.input, legacyRetry.courier))
    if (created.ok) console.info('Mintsoft order create: courier key refused, the legacy {method_id}:{method_title} form succeeded')
  } else if (created.ok && keySent) {
    console.info('Mintsoft order create: the courier key form succeeded')
  }

  // Only an explicit decoded `Success: false` courier rejection earns the placeholder retry: anything vaguer
  // (no Success field, a message that merely mentions the courier) may be an ambiguous create, and a second PUT
  // after it could duplicate the order. It then falls through to the "already exists" / failure handling below.
  if (
    !created.ok && created.data?.Success === false && created.message && /courierservice/i.test(created.message)
    && defaultId != null && initialCourier.kind !== 'defaultId'
  ) {
    courierFallback = true
    courierForm = 'PLACEHOLDER'
    created = await createOrReconcile(buildPushPayload(input, { kind: 'defaultId', courierServiceId: defaultId }))
  }

  // A create that unambiguously succeeded binds the id Mintsoft minted for it —
  // and says so (o3d-bjc.8). Still deliberately NOT read back HERE for the binding (the only read is the best-effort one of the
  // order's LINES, which decides nothing and never throws): the create has
  // already happened, so a verification failure at this point leaves only bad
  // options — bind unverified anyway, or throw and let the sweep re-PUT,
  // duplicating a real warehouse order (or dead-letter the link while a live order
  // stays unlinked and can never be cancelled).
  //
  // `needsVerification` is the third option. The link is persisted PENDING_VERIFY,
  // which is not SYNCED (we have not proved it) and not PENDING_CREATE (it must
  // never be re-pushed); a later sweep runs verifyPushedOrder — a scoped READ, no
  // mutation — until it resolves one way or the other.
  if (created.ok && created.data) {
    const externalOrderId = toStr(created.data.OrderId)
    if (externalOrderId) {
      const items = await snapshotMintsoftOrderItems(externalOrderId, clientId, input.lines, 'exact')
      return {
        externalOrderId,
        externalOrderNumber: toStr(created.data.OrderNumber) ?? input.orderNumber,
        status: 'NEW',
        courierFallback: courierFallback || boundExisting,
        ...(boundExisting ? {} : { courierForm, courierFormName }),
        ...(items ? { items } : {}),
        needsVerification: true,
      }
    }
  }

  // Duplicate → reconcile to the order that already exists (lost writeback). THIS is
  // the branch that binds our link to a pre-existing order chosen by a collidable
  // number, so the ClientId scope + per-row assertion inside are essential.
  if (created.message && /already exists/i.test(created.message)) {
    // This lookup follows a create that WAS sent (the PUT answered "already exists"). A hold on the lookup
    // is therefore not "nothing sent": re-word it so no queue reads it as a hold that clears the stamp.
    const existing = await findExistingByReference(input, clientId).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      throw isOutboundWriteHeldText(text) ? new Error(outboundTextAfterEarlierSend(text, 'Mintsoft')) : error
    })
    const externalOrderId = existing ? toStr(existing.ID ?? existing.Id ?? existing.id) : null
    if (existing && externalOrderId) {
      // A cancelled Mintsoft order keeps its OrderNumber, so "already exists" can be answered by one. Binding to it would make IMS treat
      // a dead order as the live one (it would never despatch). Refused: the push fails for an operator instead.
      const live = await readBackLiveOrder(externalOrderId, clientId, input)
      if (!live.ok) {
        throw new Error(live.kind === 'cancelled'
          ? 'Mintsoft refused the create because the order number already exists, and the order holding it is CANCELLED in Mintsoft (a cancelled order keeps its number). IMS did not link to it.'
          : 'Mintsoft refused the create because the order number already exists, but the order holding it could not be confirmed live (the read-back failed, was not ours, or showed no status). IMS did not link to it.')
      }
      const items = await snapshotMintsoftOrderItems(externalOrderId, clientId, input.lines, 'exact')
      return {
        externalOrderId,
        externalOrderNumber: toStr(existing.OrderNumber) ?? input.orderNumber,
        status: 'NEW',
        ...(items ? { items } : {}),
        // Which form the pre-existing order carries is unknown: record none, flag the courier for review, and let the first
        // amendment pick it like a fresh create.
        courierFallback: true,
        // Already proven: findExistingByReference asserts our ClientId on every row it considers and the read-back above confirmed a live
        // order, so this id came from reads, not from trust.
        needsVerification: false,
      }
    }
  }

  throw new Error(created.message ?? 'Mintsoft order push failed')
}

/**
 * o3d-bjc.8: prove a minted id is ours, mutating NOTHING.
 *
 * Two independent routes, because either alone can be inconclusive: the id
 * (authoritative when it answers) and then the order NUMBER (which catches the
 * case where the create landed under an id we did not record correctly).
 *
 * Silence is 'unknown', never 'foreign'. A transient read failure that returned
 * 'foreign' would quarantine a perfectly good order; one that returned 'ours'
 * would bind an unproven id. Only a row we can positively read as belonging to
 * someone else is 'foreign'.
 */
export async function verifyMintsoftPushedOrder(
  externalOrderId: string,
  reference: { orderNumber: string | null; externalReference: string | null },
): Promise<'ours' | 'foreign' | 'unknown'> {
  const clientId = await getPushClientId('Mintsoft push verification')
  const wantNumber = reference.orderNumber?.trim() || null
  const wantReference = reference.externalReference?.trim() || null
  // Identity is checked against OUR record, never against anything the create
  // response said. A create that answered with some other order's id would
  // otherwise verify perfectly — same tenant, same id — and the link would go
  // SYNCED pointing at another customer's order while ours stayed orphaned.
  const want = { orderNumber: wantNumber, externalReference: wantReference }
  if (!wantNumber || !wantReference) {
    // BOTH are needed to say an order is ours (a reused reference under another number is another order): refuse to claim either way.
    return 'unknown'
  }

  // 1. By id. A scoped detail read either returns OUR row or does not.
  try {
    const byId = await mintsoftRequest<unknown>(
      `/api/Order/${encodeURIComponent(externalOrderId)}?ClientId=${clientId}`,
    )
    if (!byId.error && byId.data && typeof byId.data === 'object') {
      const row = byId.data as RawOrder
      const rowClient = toStr(row.ClientId ?? (row as Record<string, unknown>).clientId)
      const rowId = toStr(row.ID ?? row.Id ?? row.id)
      if (rowId && rowId === externalOrderId) {
        // BOTH have to agree: the tenant AND the order. Tenant alone says only
        // "we may touch this row", not "this row is the order we created".
        // Only a PRESENT, non-CANCELLED status proves a live order ours: a link must not become SYNCED against a dead one, nor on a row that
        // says nothing about its status. Otherwise it stays unproven (retried, then quarantined for an operator).
        if (rowClient === String(clientId)) {
          const identity = orderIdentity(row, want)
          if (identity === 'match') return orderLiveness(row) === 'live' ? 'ours' : 'unknown'
          // A field the order does not echo proves nothing: unverified (retried, then quarantined for an operator), never accepted.
          if (identity === 'incomplete') return 'unknown'
        }
        if (rowClient && rowClient !== String(clientId)) return 'foreign'
        if (rowClient === String(clientId)) {
          // Ours to touch, but it is somebody else's ORDER. Not 'foreign' in the
          // tenant sense, and definitely not 'ours' — the id is wrong, and the
          // order we created is still out there. Hand it to an operator.
          return 'foreign'
        }
      }
    }
  } catch {
    // Fall through to the reference route: a failed read is not evidence.
  }

  // 2. By reference. If the create landed but the id we recorded is wrong, our
  //    own order number still finds it under our own tenant.
  {
    try {
      const query = new URLSearchParams({ OrderNumber: wantNumber, ClientId: String(clientId) })
      const search = await mintsoftRequest<unknown>(`/api/Order/Search?${query.toString()}`)
      if (!search.error) {
        const rows = extractMintsoftArrayPayloadStrict(search.data, 'Order/Search (push verify)')
          .map((row) => assertMintsoftOrderClient(row, clientId, 'Mintsoft Order/Search (push verify)'))
          .filter((row) => orderIdentity(row, want) === 'match')
          // Only a row whose status is KNOWN and not CANCELLED proves a live order (an absent status proves nothing).
          .filter((row) => orderLiveness(row) === 'live')
        if (rows.some((row) => toStr(row.ID ?? row.Id ?? row.id) === externalOrderId)) return 'ours'
      }
    } catch {
      // Same rule: no evidence is not counter-evidence.
    }
  }

  return 'unknown'
}

/** What {@link verifyWarehouseOrderIdentity} concludes about a warehouse order detail. */
export type WarehouseOrderIdentity = 'OK' | 'MERGED' | 'MISMATCH' | 'UNVERIFIABLE'

/**
 * THE ONE IDENTITY GATE for every write to an EXISTING Mintsoft order. Pure: it judges the fresh order detail the write path has just read.
 *
 *   MERGED        the order is flagged MergedOrder=True (live-confirmed). It holds other orders' goods; the writer takes the merged paths.
 *   UNVERIFIABLE  the number is missing, the id or client is missing, or the caller could not say which number to expect: it cannot be
 *                 proved to be this order, so NOTHING may be written to it.
 *   MISMATCH      the number (or the id, or the client) is present and is not this order's.
 *   OK            the number is present and equals the number IMS pushed, with the same id and client, and the order is not flagged merged.
 *
 * Only OK (or MERGED, by the writers that handle it) proceeds. The flag is checked first because a flagged survivor is a merge whatever
 * else its detail says.
 */
export function verifyWarehouseOrderIdentity(
  detail: RawOrder,
  expected: { orderNumber: string | null; clientId: number; id: string },
): WarehouseOrderIdentity {
  const flagged = Array.isArray(detail.OrderNameValues) && (detail.OrderNameValues as unknown[]).some((entry) => {
    const nv = entry as Record<string, unknown> | null
    return nv !== null && typeof nv === 'object' && toStr(nv.Name) === 'MergedOrder' && toStr(nv.Value)?.toLowerCase() === 'true'
  })
  if (flagged) return 'MERGED'
  const number = toStr(detail.OrderNumber)
  const id = toStr(detail.ID ?? detail.Id ?? detail.id)
  const client = toStr(detail.ClientId ?? detail.clientId)
  if (number === null || id === null || client === null || !expected.orderNumber) return 'UNVERIFIABLE'
  if (id !== expected.id || client !== String(expected.clientId)) return 'MISMATCH'
  return number === expected.orderNumber ? 'OK' : 'MISMATCH'
}

/**
 * Mintsoft OrderStatusId 1 === NEW; only NEW orders are mutable/cancellable.
 *
 * This is the gate every mutation (update / item amend / cancel) passes through,
 * so it is also where the tenant boundary is enforced (o3d-bjc.6): the request is
 * scoped by ClientId and the returned row must echo ours. A link that was
 * mis-bound to a foreign order BEFORE the dedupe fix — the ids are persisted —
 * therefore fails here instead of amending or cancelling someone else's order.
 */
async function fetchMintsoftOrderStatusId(
  externalOrderId: string,
  clientId: number,
  /** The number IMS pushed for this order, or null when the caller cannot say (the identity is then UNVERIFIABLE). A write path must act on `identity`. */
  expectedOrderNumber: string | null,
): Promise<{ found: boolean; isNew: boolean; statusId: number | null; merged: boolean; orderNumber: string | null; identity: WarehouseOrderIdentity }> {
  const current = await mintsoftRequest<unknown>(
    `/api/Order/${encodeURIComponent(externalOrderId)}?ClientId=${clientId}`,
  )
  // ONLY an explicit 404 is authoritative "this order does not exist". Anything
  // else that yields no readable order is an UNKNOWN state and must throw: the
  // client renders a 204 as `data: null`, and reporting that as NOT_FOUND would
  // tell the push sweep the remote cancellation succeeded — moving the local link
  // to CANCELLED/HELD while the warehouse carries on fulfilling the order.
  if (current.status === 404) return { found: false, isNew: false, statusId: null, merged: false, orderNumber: null, identity: 'UNVERIFIABLE' }
  if (current.error) throw new Error(current.error)
  const raw = extractMintsoftObjectPayload(current.data)
  if (raw === null) {
    throw new Error(
      `Mintsoft Order detail (push gate): order ${externalOrderId} returned HTTP ${current.status} with no readable `
        + 'order object — refusing to treat an unverifiable response as "not found"',
    )
  }
  const order = assertMintsoftOrderClient(raw, clientId, 'Mintsoft Order detail (push gate)')
  const statusId = orderStatusId(order)
  const orderNumber = toStr(order.OrderNumber)
  const identity = verifyWarehouseOrderIdentity(order, { orderNumber: expectedOrderNumber, clientId, id: externalOrderId })
  return { found: true, isNew: statusId === MINTSOFT_STATUS_NEW, statusId, merged: identity === 'MERGED', orderNumber, identity }
}

type MintsoftOrderItem = { ID: number; SKU: string | null; Quantity: number }

/** One concrete amendment to bring a Mintsoft order's items in line with the desired set. */
export type MintsoftItemAmendment =
  | { kind: 'update'; itemId: number; line: WmsOrderPushLine; quantity: number }
  | { kind: 'add'; line: WmsOrderPushLine; quantity: number }
  | { kind: 'delete'; itemId: number }

/**
 * Pure planner: diff a Mintsoft order's current items against the desired (refund-netted)
 * line set and return the amendments needed. Quantities are absolute. Matched by trimmed
 * SKU; an order carrying the same SKU on more than one line is aggregated, and any duplicate
 * WMS rows for that SKU are consolidated into the first (the rest deleted). Lines that net to
 * zero (or are gone) are deleted; lines not yet on the order are added. The plan is ordered
 * deletes → updates → adds so a consolidation never transiently overstates demand for a SKU.
 */
export function planMintsoftItemAmendments(
  current: MintsoftOrderItem[],
  desiredLines: WmsOrderPushLine[],
): MintsoftItemAmendment[] {
  const desired = new Map<string, { quantity: number; line: WmsOrderPushLine }>()
  for (const line of desiredLines) {
    const sku = line.sku?.trim()
    if (!sku) continue
    const existing = desired.get(sku)
    if (existing) existing.quantity += line.quantity
    else desired.set(sku, { quantity: line.quantity, line })
  }

  const currentBySku = new Map<string, MintsoftOrderItem[]>()
  for (const item of current) {
    const sku = item.SKU?.trim()
    if (!sku) continue
    const list = currentBySku.get(sku) ?? []
    list.push(item)
    currentBySku.set(sku, list)
  }

  const deletes: MintsoftItemAmendment[] = []
  const updates: MintsoftItemAmendment[] = []
  const adds: MintsoftItemAmendment[] = []
  for (const sku of new Set<string>([...desired.keys(), ...currentBySku.keys()])) {
    const want = desired.get(sku)
    const have = currentBySku.get(sku) ?? []
    if (!want || want.quantity <= 0) {
      for (const item of have) deletes.push({ kind: 'delete', itemId: item.ID })
      continue
    }
    if (have.length === 0) {
      adds.push({ kind: 'add', line: want.line, quantity: want.quantity })
      continue
    }
    const [primary, ...duplicates] = have
    for (const dup of duplicates) deletes.push({ kind: 'delete', itemId: dup.ID })
    if (primary.Quantity !== want.quantity) {
      updates.push({ kind: 'update', itemId: primary.ID, line: want.line, quantity: want.quantity })
    }
  }
  return [...deletes, ...updates, ...adds]
}

function buildMintsoftOrderItemPayload(line: WmsOrderPushLine, quantity: number, externalWarehouseId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    SKU: line.sku,
    Quantity: quantity,
    UnitPrice: round2(line.unitPriceExVat),
    UnitPriceVat: round2(line.unitPriceVat),
    Details: (line.description ?? '').slice(0, 255),
  }
  const warehouseId = Number.parseInt(externalWarehouseId, 10)
  if (Number.isFinite(warehouseId)) payload.WarehouseId = warehouseId
  return payload
}

// The Items DTO carries no ClientId of its own, so ownership is established by
// the caller's gate (fetchMintsoftOrderStatusId) and the request is scoped too
// (defence in depth, mirroring the read path's fetchMintsoftPartItems).
async function fetchMintsoftOrderItems(externalOrderId: string, clientId: number): Promise<MintsoftOrderItem[]> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Items?ClientId=${clientId}`)
  if (result.error) throw new Error(result.error)
  return extractMintsoftArrayPayload(result.data)
    .map((raw) => {
      const r = raw as RawOrder
      const id = typeof r.ID === 'number' ? r.ID : Number.parseInt(toStr(r.ID) ?? '', 10)
      const qty = typeof r.Quantity === 'number' ? r.Quantity : Number.parseInt(toStr(r.Quantity) ?? '', 10)
      return { ID: id, SKU: toStr(r.SKU), Quantity: Number.isFinite(qty) ? qty : 0 }
    })
    .filter((item): item is MintsoftOrderItem => Number.isFinite(item.ID))
}

/**
 * STRICT read of an order's lines for the merged-order removal: a response that is not an array, or a line without a readable id, SKU
 * and whole quantity, THROWS rather than reading as "fewer lines". The lenient reader above drops such rows, which is fine for an
 * amendment's diff but would make a removal's proof ("these lines are gone, the others are untouched") vacuous.
 */
async function fetchMintsoftOrderItemsStrict(externalOrderId: string, clientId: number): Promise<WmsOrderItemRef[]> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Items?ClientId=${clientId}`)
  if (result.error) throw new Error(result.error)
  return extractMintsoftArrayPayloadStrict(result.data, 'Order items (merged-order removal)').map((raw) => {
    const r = raw as RawOrder
    const id = toStr(r?.ID ?? r?.Id)
    const sku = toStr(r?.SKU)
    const qty = typeof r?.Quantity === 'number' ? r.Quantity : Number.parseInt(toStr(r?.Quantity) ?? '', 10)
    if (!id || !sku || !Number.isInteger(qty)) throw new Error('Mintsoft order items (merged-order removal): a line carries no readable id, SKU or whole quantity')
    return { externalItemId: id, sku, quantity: qty }
  })
}

/**
 * The lines of an order IMS has just created or amended, as the warehouse numbers them. BEST EFFORT and never throws: the order exists
 * already, so a failed read must not fail the push (a retry would duplicate it). The create response carries no lines (live), so this is
 * a read-back of the order just created.
 *
 * A SNAPSHOT IS STORED ONLY WHEN IT PROVABLY IS THIS ORDER'S LINES: the order is not merged (MergedOrder is not True; a merge between the
 * write and this read would put both orders' lines on one id) AND the lines returned are exactly what IMS sent (same SKU and quantity,
 * no extra line). `exact` compares line by line (a create sends each line as it is); `bySku` compares the quantity per SKU (an
 * amendment consolidates duplicate lines). Otherwise nothing is stored, the reason is logged, and a later merged-order removal falls
 * back to the operator notice (no ids recorded).
 */
async function snapshotMintsoftOrderItems(
  externalOrderId: string,
  clientId: number,
  sent: WmsOrderPushLine[],
  mode: 'exact' | 'bySku',
): Promise<WmsOrderItemRef[] | undefined> {
  const skip = (reason: string): undefined => {
    console.warn(`[mintsoft] line ids of order ${externalOrderId} not recorded: ${reason}`)
    return undefined
  }
  try {
    const gate = await fetchMintsoftOrderStatusId(externalOrderId, clientId, null)
    if (!gate.found) return skip('the order could not be found for the read-back')
    if (gate.merged) return skip('the order is already a merged order, so its lines cannot be told apart')
    const items = await fetchMintsoftOrderItemsStrict(externalOrderId, clientId)
    const want = new Map<string, number>()
    const have = new Map<string, number>()
    const key = (sku: string, quantity: number) => (mode === 'exact' ? `${sku.trim()}\u0000${quantity}` : sku.trim())
    for (const line of sent) {
      if (!(line.quantity > 0)) continue
      const k = key(line.sku, line.quantity)
      want.set(k, (want.get(k) ?? 0) + (mode === 'exact' ? 1 : line.quantity))
    }
    for (const item of items) {
      const k = key(item.sku, item.quantity)
      have.set(k, (have.get(k) ?? 0) + (mode === 'exact' ? 1 : item.quantity))
    }
    const same = want.size === have.size && [...want].every(([k, n]) => have.get(k) === n)
    if (!same) return skip('the lines read back are not exactly the lines IMS sent')
    return items.length > 0 ? items : undefined
  } catch (error) {
    return skip(`the read-back failed (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** Bring a NEW Mintsoft order's line items in line with the (refund-netted) desired set. */
async function reconcileMintsoftOrderItems(externalOrderId: string, input: WmsOrderPushInput, clientId: number): Promise<void> {
  // Mintsoft item quantities are whole units. If any desired line is non-integer or
  // negative, skip item reconciliation rather than send rejects in a retry loop — the
  // refund still surfaces a manual line-item query. Whole-unit orders (the norm) reconcile.
  if (input.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 0)) return

  const plan = planMintsoftItemAmendments(await fetchMintsoftOrderItems(externalOrderId, clientId), input.lines)
  const base = `/api/Order/${encodeURIComponent(externalOrderId)}/Items`
  for (const amendment of plan) {
    let result
    if (amendment.kind === 'delete') {
      result = await mintsoftRequest<unknown>(`${base}/${encodeURIComponent(String(amendment.itemId))}`, { method: 'DELETE' })
    } else if (amendment.kind === 'add') {
      result = await mintsoftRequest<unknown>(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMintsoftOrderItemPayload(amendment.line, amendment.quantity, input.externalWarehouseId)),
      })
    } else {
      result = await mintsoftRequest<unknown>(`${base}/${encodeURIComponent(String(amendment.itemId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMintsoftOrderItemPayload(amendment.line, amendment.quantity, input.externalWarehouseId)),
      })
    }
    if (result.error) throw new Error(result.error)
  }
}

export async function updateMintsoftOrder(externalOrderId: string, input: WmsOrderPushInput): Promise<WmsOrderUpdateResult> {
  const clientId = await getPushClientId('Mintsoft order update')
  const { found, isNew, orderNumber, identity } = await fetchMintsoftOrderStatusId(externalOrderId, clientId, input.orderNumber)
  if (!found) return { updated: false, status: 'NOT_FOUND' }
  // THE IDENTITY GATE, before any order post or item write. MERGED (flagged MergedOrder=True): the order holds other orders' goods and the
  // absorbing order keeps the survivor's id, so its link can still name it; amending it would diff ALL its lines against this one
  // order's, so the link is handed to the merged paths. MISMATCH / UNVERIFIABLE (not flagged, but the number is not the one IMS pushed, or
  // is missing: a merge whose flag is missing, a rename, an incomplete detail): the same safety, but it proves nothing about a merge, so
  // the link is NOT moved to MERGED; the caller raises a durable notice and leaves the amendment due. Only OK amends.
  if (identity === 'MERGED') {
    return { updated: false, status: 'MERGED_SURVIVOR', ...(orderNumber ? { mergedSurvivorNumber: orderNumber } : {}) }
  }
  if (identity === 'MISMATCH') return { updated: false, status: 'ORDER_NUMBER_MISMATCH', ...(orderNumber ? { observedOrderNumber: orderNumber } : {}) }
  if (identity === 'UNVERIFIABLE') return { updated: false, status: 'ORDER_UNVERIFIABLE' }
  if (!isNew) return { updated: false, status: 'NOT_NEW' }

  const settings = await getMintsoftSettings()
  const courierMap = settings.mintsoft_courier_service_map
  const defaultId = parseDefaultCourierId(settings.mintsoft_default_courier_service_id)
  // The courier for the FIRST post, chosen before any write. An order created on the placeholder courier is amended on the
  // configured default CourierServiceId; every other order on the override id for its form or, failing that, its name; an
  // order with no courier name falls to the default id, as a create does. If that leaves neither a name nor an id the
  // amendment is refused BEFORE any write (items included): it must never go out without a courier, and a recorded failure on
  // the link is what an operator sees.
  const mappedId = resolveMappedCourierIdForInput(input, courierMap)
  const firstCourier: CourierOption | null = input.courierPlaceholder
    ? (defaultId != null ? { kind: 'defaultId', courierServiceId: defaultId } : null)
    : mappedId != null ? { kind: 'mappedId', courierServiceId: mappedId }
    : input.courierService ? { kind: 'name' }
    : defaultId != null ? { kind: 'defaultId', courierServiceId: defaultId }
    : null
  if (!firstCourier) {
    throw new Error(input.courierPlaceholder
      ? 'Mintsoft order amendment not sent: the order was created on the placeholder courier but no default CourierServiceId is configured now; set one or choose the courier in Mintsoft'
      : 'Mintsoft order amendment not sent: the order has no courier service name and no default CourierServiceId is configured; refusing to amend without a courier')
  }

  const post = async (body: Record<string, unknown>) => {
    const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (result.error) throw new Error(result.error)
    const raw = result.data
    return Array.isArray(raw) ? ((raw[0] as RawOrder) ?? null) : (extractMintsoftObjectPayload(raw) as RawOrder | null)
  }
  const courierFormName = input.courierService
  let form: 'NAME' | 'LEGACY' | 'PLACEHOLDER' = input.courierPlaceholder || firstCourier.kind === 'defaultId' ? 'PLACEHOLDER' : 'NAME'
  let data = await post(buildPushPayload(input, firstCourier, false))
  // The same rule as the create (one shared helper). An order the create already moved to the legacy form arrives with no
  // key left, so there is nothing further to retry.
  const retry = data?.Success === false ? legacyCourierRetry(input, courierMap, data, toStr(data.Message)) : null
  if (retry) {
    form = 'LEGACY'
    data = await post(buildPushPayload(retry.input, retry.courier, false))
  }
  // A link that does not know its order's courier form selects like a fresh create, so after the key (and its one legacy
  // retry) a definitive courier rejection falls to the configured default id, exactly as the create does.
  if (
    input.courierFormUnknown && defaultId != null && firstCourier.kind !== 'defaultId'
    && data?.Success === false && /courierservice/i.test(toStr(data.Message) ?? '')
  ) {
    form = 'PLACEHOLDER'
    data = await post(buildPushPayload(input, { kind: 'defaultId', courierServiceId: defaultId }, false))
  }
  // A decoded Success: true on EVERY post of the chain, as the create requires: an answer that carries an OrderId but says
  // Success: false (or does not say Success: true) is a failure, not an amendment.
  if (data?.Success === true) {
    // The amendment as the caller needs to hear of it: the form the accepted post ended on, and whether that is the default
    // courier where the order was not already known to be on it (the same warehouse review flag a create fallback raises).
    const movedToDefault = form === 'PLACEHOLDER' && (input.courierFormUnknown === true || !input.courierPlaceholder)
    const applied = {
      ...(movedToDefault ? { courierFallback: true } : {}),
      ...(input.courierFormUnknown || retry || (form === 'PLACEHOLDER' && !input.courierPlaceholder) ? { courierForm: form, courierFormName } : {}),
    }
    // Line items are amended via the /Items sub-resource (the order-update endpoint ignores them); this propagates
    // refund-netted quantities to the still-NEW WMS order. They go AFTER the order post on purpose: the courier selection
    // is the part of an amendment that can be refused (and retried), and deciding it first means a courier failure never
    // leaves the items half-amended. If the items then fail, the courier is already changed on the WMS order, so the error
    // carries what the accepted post did (see WmsOrderUpdatePartialError) and the order stays due for the items to be redone.
    try {
      await reconcileMintsoftOrderItems(externalOrderId, input, clientId)
    } catch (error) {
      throw new WmsOrderUpdatePartialError(error instanceof Error ? error.message : String(error), applied)
    }
    // The amendment may have deleted, added or consolidated lines (new ids), so the stored line ids are re-read.
    const items = await snapshotMintsoftOrderItems(externalOrderId, clientId, input.lines, 'bySku')
    return { updated: true, status: 'NEW', ...applied, ...(items ? { items } : {}) }
  }
  throw new Error(toStr(data?.Message) ?? 'Mintsoft order update failed')
}

/**
 * Post an internal (admin) note onto a Mintsoft order via POST /api/Order/{id}/Comments.
 *
 * The note quotes IMS order context, so o3d-bjc.6 applies here too: prove the
 * order is ours before writing to it, or a link mis-bound by the old unscoped
 * dedupe would disclose our order detail on a FOREIGN order. Callers treat
 * comments as best-effort, so the extra ownership read is cheap insurance.
 */
export async function addMintsoftOrderComment(externalOrderId: string, comment: string): Promise<void> {
  const clientId = await getPushClientId('Mintsoft order comment')
  // The one write to an existing order that is NOT identity-gated, on purpose: it is an additive, fixed-wording note, and the merged-order
  // notices are posted to a survivor whose number is by definition not IMS's. The ownership read (client) still applies.
  const { found } = await fetchMintsoftOrderStatusId(externalOrderId, clientId, null)
  if (!found) {
    // Observable, not silent: callers audit this call's outcome, and a warehouse
    // warning that was never posted must not be recorded as SUCCEEDED.
    throw new Error(`Mintsoft order ${externalOrderId} not found — the warehouse note was not posted`)
  }

  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Comment: comment.slice(0, 1000), Admin: true }),
  })
  if (result.error) throw new Error(result.error)
}

export async function cancelMintsoftOrder(
  externalOrderId: string,
  /** `expectedOrderNumber` is REQUIRED: the number IMS pushed for the order (null when unknown, which is refused as unverifiable). */
  options: { expectedOrderNumber: string | null; onlyLines?: WmsOrderItemRef[] },
): Promise<WmsOrderCancelResult> {
  // Only a NEW or a BACKORDERED order is cancellable (both confirmed live); anything further along is a no-op.
  // The gate also proves the order is OURS before we cancel it (o3d-bjc.6).
  const clientId = await getPushClientId('Mintsoft order cancel')
  const { found, statusId, merged, orderNumber, identity } = await fetchMintsoftOrderStatusId(externalOrderId, clientId, options.expectedOrderNumber)
  if (!found) return { cancelled: false, status: 'NOT_FOUND' }
  // THE IDENTITY GATE (cancel AND hold): an order that cannot be proved to be this order (the number is missing, or is not the one IMS
  // pushed, whether or not it contains a "+") is never cancelled. Nothing is written; the caller raises a notice and the link stays live.
  if (identity === 'MISMATCH') return { cancelled: false, status: 'IDENTITY_MISMATCH', ...(orderNumber ? { mergedSurvivorNumber: orderNumber } : {}) }
  if (identity === 'UNVERIFIABLE') return { cancelled: false, status: 'IDENTITY_UNVERIFIABLE' }
  // Already cancelled (by the warehouse, or by an earlier attempt whose answer was lost): Mintsoft answers /Cancel with Success: true
  // either way, so Success alone cannot tell this apart from a cancellation IMS just made. It is reported as its own status and /Cancel
  // is not called.
  if (statusId === MINTSOFT_STATUS_CANCELLED) return { cancelled: false, status: 'ALREADY_CANCELLED' }
  // A MERGED order holds other orders' goods: it is never cancelled here, whichever of its orders the call was made for (the absorbing
  // order keeps the survivor's id, so its link can still name it as a plain order). The caller removes only that order's own lines.
  if (merged && !options.onlyLines) return { cancelled: false, status: 'MERGED_SURVIVOR', ...(orderNumber ? { mergedSurvivorNumber: orderNumber } : {}) }
  if (statusId !== MINTSOFT_STATUS_NEW && statusId !== MINTSOFT_STATUS_ON_BACKORDER) return { cancelled: false, status: 'NOT_CANCELLABLE' }
  // Whenever the caller names the lines it is cancelling (whatever the merge flag says on this read), the order may be cancelled only
  // while it still holds EXACTLY those lines: a strict re-read immediately
  // before /Cancel. (Mintsoft has no conditional cancel, so a line added between this read and the call is an accepted inter-system
  // race limit.)
  if (options.onlyLines) {
    const now = await fetchMintsoftOrderItemsStrict(externalOrderId, clientId)
    const mine = options.onlyLines
    const same = now.length === mine.length && mine.every((m) => now.some((n) => sameRef(n, m)))
    if (!same) return { cancelled: false, status: 'MERGED_LINES_CHANGED' }
  }

  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Cancel`)
  if (result.error) throw new Error(result.error)
  const data = extractMintsoftObjectPayload(result.data) as RawOrder | null
  if (data?.Success === true) {
    // A race: it was cancelled between the status read and this call. Not a cancellation IMS made.
    if (/already cancelled/i.test(toStr(data.Message) ?? '')) return { cancelled: false, status: 'ALREADY_CANCELLED' }
    return { cancelled: true, status: 'CANCELLED' }
  }
  throw new Error(toStr(data?.Message) ?? 'Mintsoft order cancel failed')
}

const sameRef = (a: WmsOrderItemRef, b: WmsOrderItemRef) => a.externalItemId === b.externalItemId && a.sku === b.sku && a.quantity === b.quantity
const describeRef = (ref: WmsOrderItemRef) => `${ref.quantity} x ${ref.sku} (line ${ref.externalItemId})`

/**
 * Take ONE order's lines out of a merged survivor (live-confirmed 2026-11-12: the merge keeps every original line, with its original
 * line id, even for a shared SKU, and `DELETE /api/Order/{id}/Items/{itemId}` answers Success:true naming the SKU, not the line, so
 * only a re-read proves which line went).
 *
 * Order of events, and what each step proves:
 *   1. the survivor is read through the ordinary ownership gate and must be NEW or ON BACKORDER (the statuses `/Cancel` works on);
 *   2. its lines are read STRICTLY, and every wanted line must be there with the same SKU and quantity: BEFORE anything is deleted;
 *   3. when the wanted lines are ALL there is, nothing is written (ONLY_LINES_LEFT): the caller cancels the order normally;
 *   4. one DELETE per line, each followed by a re-read that must show that line gone and every other line exactly as it was.
 * A failure after the first delete answers REFUSED carrying exactly what was removed and what remains. Nothing is retried.
 */
export async function removeMintsoftOrderItems(survivorId: string, expectedOrderNumber: string | null, wanted: WmsOrderItemRef[]): Promise<WmsMergedItemRemoval> {
  const clientId = await getPushClientId('Mintsoft merged-order line removal')
  const targets = [...new Map(wanted.map((ref) => [ref.externalItemId, ref])).values()]
  const refuse = (reason: string, removed: WmsOrderItemRef[], remaining: WmsOrderItemRef[]): WmsMergedItemRemoval => ({ kind: 'REFUSED', reason, removed, remaining })
  if (targets.length === 0) return refuse('IMS holds no line ids for this order', [], [])

  const gate = await fetchMintsoftOrderStatusId(survivorId, clientId, expectedOrderNumber)
  if (!gate.found) return refuse(`the merged order ${survivorId} is no longer returned by the warehouse`, [], targets)
  // THE IDENTITY GATE: the survivor must be flagged merged (the expected state) or carry exactly the number IMS recorded for it.
  if (gate.identity !== 'MERGED' && gate.identity !== 'OK') {
    return refuse(`the warehouse order could not be verified as the merged order IMS recorded (${gate.identity === 'MISMATCH' ? `it now carries the number ${gate.orderNumber ?? 'unknown'}` : 'its number or id is missing from the detail'})`, [], targets)
  }
  if (gate.statusId !== MINTSOFT_STATUS_NEW && gate.statusId !== MINTSOFT_STATUS_ON_BACKORDER) {
    return refuse(`the merged order is past the point where its lines can be changed (status ${gate.statusId ?? 'unknown'})`, [], targets)
  }

  let current: WmsOrderItemRef[]
  try {
    current = await fetchMintsoftOrderItemsStrict(survivorId, clientId)
  } catch (error) {
    return refuse(`the merged order's lines could not be read (${error instanceof Error ? error.message : String(error)})`, [], targets)
  }
  const problems: string[] = []
  for (const target of targets) {
    const found = current.find((item) => item.externalItemId === target.externalItemId)
    if (!found) problems.push(`line ${target.externalItemId} (${target.quantity} x ${target.sku}) is not on the merged order`)
    else if (found.sku !== target.sku || found.quantity !== target.quantity) {
      problems.push(`line ${target.externalItemId} is now ${found.quantity} x ${found.sku}, IMS pushed ${target.quantity} x ${target.sku}`)
    }
  }
  if (problems.length > 0) return refuse(problems.join('; '), [], targets)
  if (current.length === targets.length) return { kind: 'ONLY_LINES_LEFT' }

  const removed: WmsOrderItemRef[] = []
  let before = current
  const base = `/api/Order/${encodeURIComponent(survivorId)}/Items`
  for (const target of targets) {
    const remaining = () => targets.filter((t) => !removed.some((r) => r.externalItemId === t.externalItemId))
    const done = () => (removed.length > 0 ? `removed ${removed.map(describeRef).join(', ')}; ` : 'nothing was removed; ')
    try {
      const result = await mintsoftRequest<unknown>(`${base}/${encodeURIComponent(target.externalItemId)}`, { method: 'DELETE' })
      if (result.error) throw new Error(result.error)
      const data = extractMintsoftObjectPayload(result.data) as RawOrder | null
      if (data?.Success !== true) throw new Error(toStr(data?.Message) ?? 'the delete was not confirmed')
    } catch (error) {
      return refuse(`deleting ${describeRef(target)} failed (${error instanceof Error ? error.message : String(error)}); ${done()}it may or may not have gone, so it is listed as still there`, removed, remaining())
    }
    let after: WmsOrderItemRef[]
    try {
      after = await fetchMintsoftOrderItemsStrict(survivorId, clientId)
    } catch (error) {
      return refuse(`${describeRef(target)} was deleted but the re-read to prove it failed (${error instanceof Error ? error.message : String(error)}); ${done()}it is listed as still there until a person checks`, removed, remaining())
    }
    // Two separate proofs. The line itself: gone, or not. The others: exactly as they were. A delete that DID land is recorded as
    // removed even when something else then looks wrong, so the notice never lists a line as still there that is already gone.
    const gone = !after.some((item) => item.externalItemId === target.externalItemId)
    if (!gone) {
      return refuse(`after deleting ${describeRef(target)} the line is still on the merged order; ${done()}check the order`, removed, remaining())
    }
    removed.push(target)
    const expected = before.filter((item) => item.externalItemId !== target.externalItemId)
    const unchanged = after.length === expected.length && expected.every((item) => after.some((other) => sameRef(item, other)))
    if (!unchanged) {
      return refuse(`after deleting ${describeRef(target)} another line of the merged order is not what it was (it changed, or a line appeared or went); ${done()}check the order`, removed, remaining())
    }
    before = after
  }
  return { kind: 'REMOVED', removed }
}
