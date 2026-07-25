import type { WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { getMintsoftSettings, MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE } from '../settings/schema'
import type { MintsoftSettings } from '../settings/schema'
import { extractMintsoftArrayPayload, extractMintsoftArrayPayloadStrict, extractMintsoftObjectPayload } from './normalizers'
import { mintsoftRequest } from './client'

/**
 * Live Mintsoft order-status lookup, modelled on the proven woo-mintsoft plugin
 * (wc_mintsoft_orders.py). An order is found by `GET /api/Order/Search?OrderNumber=`;
 * its numeric `OrderStatusId` is resolved to a name via `GET /api/Order/Statuses`
 * (cached); split (`NumberOfParts`>1) and merged (`OrderNumber` carries "a+b")
 * orders are detected from the order fields. Read-only.
 */

type RawOrder = Record<string, unknown>

const STATUSES_TTL_MS = 10 * 60 * 1000
let statusCache: { at: number; map: Map<number, string> } | null = null

function toStr(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** A positive integer with NO coercion — rejects "4junk", 4.5, "", true, null. */
function strictPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/**
 * A DespatchDate we are willing to treat as EVIDENCE the goods left. Mintsoft
 * sends `YYYY-MM-DDTHH:MM:SS` (sometimes date-only, sometimes with fractional
 * seconds and/or a zone). Anything that isn't a real calendar timestamp is NOT
 * proof of despatch — and `Date.parse` alone is far too permissive to decide
 * that: it happily accepts `"2026-07-15junk"` (trailing text ignored),
 * `"2026-02-30"` and `"2026-04-31"` (rolled over into the next month),
 * `"24:00:00"`, and reads bare `"0"` as the year 2000. So the grammar is fully
 * ANCHORED and each component is range- and calendar-checked. .NET defaults
 * (`0001-01-01T00:00:00`) fall below the floor.
 *
 * Without this, a malformed field would both mark an IMS order SHIPPED and
 * satisfy the unknown-status escape hatch below.
 */
const DESPATCH_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?\s*(?:[Zz]|([+-])(\d{2}):?(\d{2}))?)?$/
const DESPATCH_DATE_MIN_YEAR = 1990

export function parseMintsoftDespatchDate(value: unknown): string | null {
  const raw = toStr(value)
  if (!raw) return null
  const match = DESPATCH_DATE_PATTERN.exec(raw)
  if (!match) return null
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] = match
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  // Checked BEFORE Date.UTC, whose two-digit-year remapping would turn year 1
  // into 1901 and whose overflow silently rolls 02-30 into March.
  if (year < DESPATCH_DATE_MIN_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null
  if (hourRaw !== undefined) {
    if (Number(hourRaw) > 23 || Number(minuteRaw) > 59) return null
    if (secondRaw !== undefined && Number(secondRaw) > 59) return null
  }
  // The grammar admits any two digits for a zone offset, so "+99:99" would slip
  // through and — with an unknown status — falsely prove despatch. Range-check it
  // against the XSD dateTime offset range: ±14:00 inclusive, and at hour 14 the
  // minutes must be exactly 00 (so "+14:01" and "+14:59" are NOT valid offsets).
  if (offsetHourRaw !== undefined) {
    const offsetHour = Number(offsetHourRaw)
    const offsetMinute = Number(offsetMinuteRaw)
    if (offsetHour > 14 || offsetMinute > 59) return null
    if (offsetHour === 14 && offsetMinute !== 0) return null
  }
  // Belt and braces: after all of the above the value must still be a real instant.
  if (!Number.isFinite(Date.parse(raw))) return null
  return raw
}

/**
 * OrderStatusId → uppercased status name. Cached for STATUSES_TTL_MS.
 *
 * STRICT (o3d-bjc.2.2): a malformed or empty 2xx `/api/Order/Statuses` body must
 * never be cached as an empty map. Every subsequent row would then resolve to an
 * unresolved status `''` → `dispatched:false` → counted as a clean `pending`, and
 * the Order/List delta watermark would advance past orders whose real dispatch
 * state was never determined — aging a genuinely DESPATCHED order out of the
 * window. Throwing instead keeps the cache empty and fails the delta safe.
 */
async function fetchMintsoftOrderStatusMap(): Promise<Map<number, string>> {
  if (statusCache && Date.now() - statusCache.at < STATUSES_TTL_MS) {
    return statusCache.map
  }
  const result = await mintsoftRequest<unknown>('/api/Order/Statuses')
  if (result.error) throw new Error(result.error)

  const map = new Map<number, string>()
  for (const item of extractMintsoftArrayPayloadStrict(result.data, 'Order/Statuses')) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Mintsoft Order/Statuses: entry is not an object — refusing to cache an unusable status map')
    }
    const row = item as RawOrder
    // Deliberately NOT toInt/toStr: those coerce ("4junk" → 4, numeric Name 123 →
    // "123"), which would mint a truthy-but-meaningless status name that then
    // passes the strictStatus gate below and lets an unknown dispatch state ride
    // through as a clean `pending`. A status map must be exactly right or absent.
    const id = strictPositiveInt(row.ID ?? row.Id ?? row.id)
    const rawName = row.Name ?? row.name
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (id === null || !name) {
      throw new Error(
        'Mintsoft Order/Statuses: entry is missing a positive-integer ID or a non-empty string Name — ' +
          'refusing to cache an unusable status map',
      )
    }
    const upper = name.toUpperCase()
    const existing = map.get(id)
    if (existing !== undefined && existing !== upper) {
      throw new Error(
        `Mintsoft Order/Statuses: id ${id} maps to both "${existing}" and "${upper}" — ` +
          'refusing to cache an ambiguous status map',
      )
    }
    map.set(id, upper)
  }
  if (map.size === 0) {
    throw new Error('Mintsoft Order/Statuses returned no statuses — refusing to cache an empty status map')
  }
  statusCache = { at: Date.now(), map }
  return map
}

/** Drop the memoised status map (tests only — the TTL handles it in production). */
export function resetMintsoftOrderStatusCacheForTests(): void {
  statusCache = null
}

export function requireMintsoftClientId(clientId: number | null | undefined, operation: string): number {
  if (!Number.isInteger(clientId) || (clientId ?? 0) <= 0) {
    throw new Error(
      `${operation} requires a ClientId (configure mintsoft_client_id) — ` +
        'refusing to run an unscoped cross-client order lookup',
    )
  }
  return clientId as number
}

export function assertMintsoftOrderClient(row: unknown, clientId: number, context: string): RawOrder {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(
      `${context}: row is not an object — refusing an unverifiable cross-client order lookup`,
    )
  }
  const order = row as RawOrder
  const rowId = toStr(order.ID ?? order.Id ?? order.id) ?? 'unknown'
  const rowClientId = toInt(order.ClientId ?? order.clientId)
  if (rowClientId === null) {
    throw new Error(
      `${context}: row ${rowId} has no ClientId — refusing an unverifiable cross-client order lookup`,
    )
  }
  if (rowClientId !== clientId) {
    throw new Error(
      `${context}: row ${rowId} ClientId ${rowClientId} does not match configured ${clientId} — ` +
        'refusing a cross-client order lookup',
    )
  }
  return order
}

async function searchMintsoftOrdersByNumber(orderNumber: string, clientId: number | null): Promise<RawOrder[]> {
  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft Order/Search')
  const query = new URLSearchParams({
    OrderNumber: orderNumber.trim(),
    ClientId: String(scopedClientId),
  })
  const result = await mintsoftRequest<unknown>(`/api/Order/Search?${query.toString()}`)
  if (result.status === 404) return []
  if (result.error) throw new Error(result.error)
  const rows = extractMintsoftArrayPayloadStrict(result.data, 'Mintsoft Order/Search')
  return rows.map((row) => assertMintsoftOrderClient(row, scopedClientId, 'Mintsoft Order/Search'))
}

/**
 * Authoritative single-order fetch. `/api/Order/Search` rows can carry null
 * status/courier fields, so we re-read the picked order by id (matching the
 * proven plugin, which follows every search hit with GET /api/Order/{id}).
 */
export async function fetchMintsoftOrderById(externalOrderId: string, clientId: number | null): Promise<RawOrder | null> {
  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft Order detail')
  // Scope the request itself (defence in depth) in addition to validating the
  // returned row's ClientId below — so the shared-tenant boundary is enforced
  // server-side wherever the API honours it, not only on the response.
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}?ClientId=${scopedClientId}`)
  if (result.status === 404) return null
  if (result.error) throw new Error(result.error)
  const row = extractMintsoftObjectPayload(result.data)
  return row === null ? null : assertMintsoftOrderClient(row, scopedClientId, 'Mintsoft Order detail')
}

export function mergedParts(orderNumber: string | null): string[] {
  if (!orderNumber || !orderNumber.includes('+')) return []
  return orderNumber.split('+').map((part) => part.trim()).filter(Boolean)
}

/**
 * Choose the order to report for `orderNumber`. Prefer an exact OrderNumber
 * match; a split order returns one row per part (sharing the number), so sort by
 * `Part` and take the primary (Part 1) deterministically. Otherwise fall back to
 * a merged survivor that folded this number in — but only when EXACTLY ONE
 * merged candidate matches (fail closed on ambiguity, like the reference plugin).
 */
export function pickOrderRow(orders: RawOrder[], orderNumber: string, clientId: number): RawOrder | null {
  const wanted = orderNumber.trim()
  // Defence in depth: even if Order/Search ignores its ClientId filter, a
  // foreign or unverifiable row can never win the exact/merged selection.
  const scoped = orders.filter((order) => toInt(order.ClientId ?? order.clientId) === clientId)
  const exact = scoped
    .filter((order) => toStr(order.OrderNumber) === wanted)
    .sort((a, b) => (toInt(a.Part) ?? 1) - (toInt(b.Part) ?? 1))
  if (exact.length > 0) return exact[0]

  const merged = scoped.filter((order) => mergedParts(toStr(order.OrderNumber)).includes(wanted))
  return merged.length === 1 ? merged[0] : null
}

/**
 * Tri-state presence probe (q66in.4.4): unlike fetchMintsoftOrderStatus, this
 * distinguishes a search with NO trace of the order (MISSING) from one whose
 * candidates exist but cannot be disambiguated (AMBIGUOUS — pickOrderRow fails
 * closed on multiple merged matches). Reconciliation only treats MISSING as
 * safe grounds for re-creating the order.
 */
export async function probeMintsoftOrderPresence(
  orderNumber: string,
  clientId: number | null,
): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> {
  const reference = orderNumber.trim()
  if (!reference) return 'MISSING'
  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft order presence probe')
  const matches = await searchMintsoftOrdersByNumber(reference, scopedClientId)
  if (matches.length === 0) return 'MISSING'
  return pickOrderRow(matches, reference, scopedClientId) ? 'FOUND' : 'AMBIGUOUS'
}

export function readTracking(order: RawOrder): WmsOrderTracking[] {
  const trackingNumber = toStr(order.TrackingNumber)
  const carrier = toStr(order.CourierServiceName)
  // Validated, not merely non-empty: despatchedAt is consumed as dispatch proof
  // (isMintsoftDispatched, the strictStatus escape) AND as the shipment date, so
  // a sentinel/garbage value must never reach any of them.
  const despatchedAt = parseMintsoftDespatchDate(order.DespatchDate)
  if (!trackingNumber && !carrier && !despatchedAt) return []
  return [{ trackingNumber, carrier, despatchedAt }]
}

export function buildDeepLink(template: string, externalOrderId: string): string | null {
  const base = (template || MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE).trim()
  if (!base.includes('{id}')) return null
  return base.replace('{id}', encodeURIComponent(externalOrderId))
}

/**
 * Build a WmsOrderStatus from a single raw Mintsoft Order row. Shared by the
 * per-order lookup (fetchMintsoftOrderStatus) and the bulk Order/List delta
 * (fetchMintsoftOrderList) so both derive status/tracking/split/merge/deep-link
 * identically. Returns null when the row has no resolvable id. The row is
 * trusted as-is (the delta path does not re-read by id) — callers that need the
 * authoritative re-read do it before calling this.
 */
export async function normalizeMintsoftOrderRow(
  order: RawOrder,
  // Bulk callers (Order/List delta) pass a pre-fetched status map + settings so a
  // multi-row page resolves them ONCE, not once per row — otherwise a cold status
  // cache with no in-flight dedup fans out one /api/Order/Statuses request and one
  // settings read per row (o3d-bjc Codex: a request storm that trips throttling).
  //
  // `strictStatus` (o3d-bjc.2.2) is set by the DELTA path only: there an
  // unresolvable dispatch state must fail the whole delta, because a lenient
  // `status: ''` normalises to "not dispatched" → a clean `pending` → the
  // watermark advances past a row whose true state was never determined. The
  // per-order path stays lenient: it re-polls the same order every reconcile
  // tick, so nothing can age out.
  ctx?: { statusMap: Map<number, string>; settings: MintsoftSettings; strictStatus?: boolean },
): Promise<WmsOrderStatus | null> {
  const externalOrderId = toStr(order.ID ?? order.Id ?? order.id)
  if (!externalOrderId) return null

  // strictPositiveInt, not toInt: toInt would read "4junk" as 4 and truncate 4.7 to
  // 4, letting a malformed id resolve onto a REAL status — DESPATCHED off drifted
  // input falsely ships the order, and a pending one advances the watermark.
  // A malformed id is simply unresolved, which strictStatus below then rejects.
  const statusId = strictPositiveInt(order.OrderStatusId)
  const statusMap = ctx?.statusMap ?? (await fetchMintsoftOrderStatusMap())
  const status = (statusId !== null ? statusMap.get(statusId) : null) ?? ''

  const externalOrderNumber = toStr(order.OrderNumber) ?? ''
  const partCount = toInt(order.NumberOfParts)
  const merged = mergedParts(externalOrderNumber)
  const settings = ctx?.settings ?? (await getMintsoftSettings())
  const tracking = readTracking(order)

  // Fail closed on an unresolved dispatch state (delta path only). A DespatchDate
  // is authoritative on its own — the goods demonstrably left — so a row that
  // carries one is allowed through even without a resolvable status name.
  if (ctx?.strictStatus && !status && !tracking.some((entry) => Boolean(entry.despatchedAt))) {
    throw new Error(
      `Mintsoft Order/List: order ${externalOrderId} has an unresolved OrderStatusId ` +
        `(${statusId ?? 'missing'}) and no despatch date — refusing to treat an unknown dispatch state as pending`,
    )
  }

  return {
    externalOrderId,
    externalOrderNumber,
    status,
    statusLabel: status || 'Unknown',
    isSplit: (partCount ?? 1) > 1,
    partCount: partCount ?? null,
    isMerged: merged.length > 0,
    mergedOrderNumbers: merged,
    deepLinkUrl: buildDeepLink(settings.mintsoft_admin_order_url_template, externalOrderId),
    tracking,
    dispatched: isMintsoftDispatched({ status, tracking }),
    raw: order,
  }
}

export async function fetchMintsoftOrderStatus(
  orderNumber: string,
  clientId: number | null,
): Promise<WmsOrderStatus | null> {
  const reference = orderNumber.trim()
  if (!reference) return null

  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft order status lookup')
  const matches = await searchMintsoftOrdersByNumber(reference, scopedClientId)
  const picked = pickOrderRow(matches, reference, scopedClientId)
  if (!picked) return null

  const pickedId = toStr(picked.ID ?? picked.Id ?? picked.id)
  if (!pickedId) return null

  // Re-read by id for authoritative status/tracking; fall back to the search row
  // if the detail 404s (e.g. the order was merged away after the search).
  const order = (await fetchMintsoftOrderById(pickedId, scopedClientId)) ?? picked
  const normalized = await normalizeMintsoftOrderRow(order)
  if (!normalized) return null

  // Preserve the historical fallbacks: a row with no id echoes the picked id;
  // a row with no number echoes the caller's reference.
  return {
    ...normalized,
    externalOrderId: normalized.externalOrderId || pickedId,
    externalOrderNumber: normalized.externalOrderNumber || reference,
  }
}

/**
 * Bulk Order/List delta: every order changed since `sinceLastUpdated`, in one
 * (paginated) call, normalised to WmsOrderStatus. This is the replacement for
 * the per-active-order status poll — the dispatch sweep processes the orders in
 * this delta directly and only per-order polls on a throttled reconcile.
 *
 * `sinceLastUpdated` must already be a `YYYY-MM-DDTHH:MM:SS` timestamp in the
 * Mintsoft tenant's own timezone (Mintsoft compares SinceLastUpdated against
 * LastUpdated in the database's zone, NOT UTC — the caller does the conversion).
 * `IncludeOrderItems=true` + `SortOldestFirst=true` are always sent; ClientId /
 * WarehouseId / ChannelId scope the query to our traffic on a shared tenant.
 *
 * FAILS CLOSED on `clientId`: Mintsoft is a shared 3PL tenant, so an UNSCOPED
 * Order/List returns EVERY client's orders — and matching a foreign row to a
 * local link by order number alone could mark OUR order shipped off a FOREIGN
 * despatch. A null/absent `clientId` therefore THROWS rather than running an
 * unscoped delta. As defence in depth, EVERY returned row must carry a parseable
 * ClientId exactly equal to `clientId`; a missing or mismatched ClientId (an
 * ignored filter or contract drift) REJECTS THE WHOLE RESPONSE (throw), so a
 * drifted contract can never quietly advance the watermark past unverified rows —
 * the sweep fails safe to the per-order reconcile and holds the watermark.
 *
 * Also THROWS (rather than returning a partial list) when the result overflows
 * `maxPages * limit` — a truncated delta must never look complete, or the sweep
 * would advance its watermark past orders it never saw. Like every other
 * client.ts fetch it also throws on any HTTP error, so the caller can tell
 * "nothing changed" (empty list) from "couldn't complete the delta" (throw) and
 * fail safe to the per-order reconcile.
 */
export async function fetchMintsoftOrderList(opts: {
  sinceLastUpdated: string
  clientId: number | null
  warehouseId?: number | null
  channelId?: number | null
  limit?: number
  maxPages?: number
}): Promise<WmsOrderStatus[]> {
  const since = opts.sinceLastUpdated.trim()
  if (!since) return []
  // Fail closed: never run an unscoped cross-client delta (see the doc-comment).
  const clientId = opts.clientId ?? null
  if (clientId == null) {
    throw new Error(
      'Mintsoft Order/List delta requires a ClientId (configure mintsoft_client_id) — ' +
        'refusing to run an unscoped cross-client delta',
    )
  }
  const limit = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : 200
  const maxPages = opts.maxPages && opts.maxPages > 0 ? Math.trunc(opts.maxPages) : 50

  const collected: RawOrder[] = []
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const query = new URLSearchParams({
      SinceLastUpdated: since,
      Limit: String(limit),
      PageNo: String(pageNo),
      SortOldestFirst: 'true',
      IncludeOrderItems: 'true',
      ClientId: String(clientId),
    })
    if (opts.warehouseId != null) query.set('WarehouseId', String(opts.warehouseId))
    if (opts.channelId != null) query.set('ChannelId', String(opts.channelId))

    const result = await mintsoftRequest<unknown>(`/api/Order/List?${query.toString()}`)
    if (result.error) throw new Error(result.error)

    // Strict parse: a 2xx body that is neither an array nor a recognised wrapper
    // (schema drift, a proxy error object, null) THROWS rather than looking like a
    // complete empty page — else the caller would advance its watermark past rows
    // it never saw. A genuine empty/short page still ends pagination normally.
    const page = extractMintsoftArrayPayloadStrict(result.data, `Order/List page ${pageNo}`)
    // Per-row fail-closed validation (parity with the Python delta reader): every
    // row must be an object carrying a resolvable ID and a non-empty order number.
    // A malformed row is schema/API drift, not "no change" — silently dropping it
    // (normalize→null filter, or an empty delta-map key) would let the caller
    // advance its watermark past an order it never applied.
    for (const row of page) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row is not an object — refusing to treat a malformed delta as complete`)
      }
      const record = row as RawOrder
      const rowId = toStr(record.ID ?? record.Id ?? record.id)
      if (rowId === null) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row missing a valid ID — refusing to treat a malformed delta as complete`)
      }
      if (toStr(record.OrderNumber) === null) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row ${rowId} missing an order number — refusing to treat a malformed delta as complete`)
      }
      // Tenant boundary — fail closed (o3d-bjc): EVERY row must carry a parseable
      // ClientId exactly equal to ours. A missing ClientId (contract drift) or a
      // mismatched one (the query filter was ignored) means we can NOT verify the
      // response belongs to us — reject the WHOLE delta (throw → the sweep fails
      // safe to per-order reconcile and holds the watermark) rather than trust an
      // order-number match that could belong to another client on the shared tenant.
      const rowClientId = toInt(record.ClientId ?? record.clientId)
      if (rowClientId === null) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row ${rowId} has no ClientId — refusing an unverifiable cross-client delta`)
      }
      if (rowClientId !== clientId) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row ${rowId} ClientId ${rowClientId} does not match configured ${clientId} — refusing a cross-client delta`)
      }
      collected.push(record)
    }
    if (page.length < limit) {
      if (collected.length === 0) return []
      // Resolve the status map + settings ONCE for the whole list (they're the
      // same for every row) so normalisation makes no per-row API/DB calls.
      const statusMap = await fetchMintsoftOrderStatusMap()
      const settings = await getMintsoftSettings()
      const normalized = await Promise.all(
        collected.map((row) => normalizeMintsoftOrderRow(row, { statusMap, settings, strictStatus: true })),
      )
      return normalized.filter((row): row is WmsOrderStatus => row !== null)
    }
  }

  // No short page within the budget ⇒ more changed rows than maxPages*limit.
  // Fail closed so the caller keeps its watermark and reconciles.
  throw new Error(
    `Mintsoft Order/List delta exceeded ${maxPages} pages at limit=${limit} (since=${since}); ` +
      'refusing to treat a truncated delta as complete',
  )
}

/**
 * Raw Mintsoft order statuses that mean the goods have left the warehouse. Mintsoft
 * invoices only after despatch, so INVOICED is strictly post-despatch (the SO chip
 * treats it as terminal/green); the despatchedAt fallback covers feeds where the status
 * row lags. If a proforma-style pre-despatch INVOICED ever appears, tighten to DESPATCHED.
 */
export const MINTSOFT_DISPATCHED_STATUSES = new Set(['DESPATCHED', 'INVOICED'])

/** Mintsoft's connector-specific "dispatched" decision (normalised onto WmsOrderStatus). */
export function isMintsoftDispatched(status: { status: string; tracking: WmsOrderTracking[] }): boolean {
  if (MINTSOFT_DISPATCHED_STATUSES.has(status.status.trim().toUpperCase())) return true
  return status.tracking.some((entry) => Boolean(entry.despatchedAt))
}

export type MintsoftOrderPart = {
  /** The Mintsoft order id of this part (used to fetch its line items). */
  externalId: string
  /** 1-based part number within the split. */
  partNumber: number
  /** Raw Mintsoft status name (uppercased), e.g. "DESPATCHED". */
  status: string
  /** Normalised dispatched flag for this part. */
  dispatched: boolean
  tracking: WmsOrderTracking[]
}

/**
 * Every part of a (possibly split) Mintsoft order, by order number. A split order
 * returns one row per part from `/Order/Search` sharing the OrderNumber; unlike
 * fetchMintsoftOrderStatus (which collapses to Part 1), we keep every part and
 * re-read each by id for an authoritative status + tracking (search rows can carry
 * null status/courier). Used by dispatch-sync to reconcile per-part despatch.
 */
export async function fetchMintsoftOrderParts(
  orderNumber: string,
  clientId: number | null,
): Promise<MintsoftOrderPart[]> {
  const reference = orderNumber.trim()
  if (!reference) return []
  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft order-parts lookup')
  const rows = await searchMintsoftOrdersByNumber(reference, scopedClientId)
  const exact = rows.filter((row) => toStr(row.OrderNumber) === reference)
  if (exact.length === 0) return []

  const statusMap = await fetchMintsoftOrderStatusMap()
  const parts: MintsoftOrderPart[] = []
  for (const row of exact) {
    const searchId = toStr(row.ID ?? row.Id ?? row.id)
    if (!searchId) continue
    const detail = (await fetchMintsoftOrderById(searchId, scopedClientId)) ?? row
    const externalId = toStr(detail.ID ?? detail.Id ?? detail.id) ?? searchId
    // Same no-coercion rule as the order-level status (see normalizeMintsoftOrderRow):
    // a coerced part status could falsely complete a split order.
    const statusId = strictPositiveInt(detail.OrderStatusId)
    const partStatus = (statusId !== null ? statusMap.get(statusId) : null) ?? ''
    const partTracking = readTracking(detail)
    parts.push({
      externalId,
      // Fall back to a running index (not a constant 1) when Mintsoft omits Part, so
      // two part-less rows can't collapse to the same number and have the storefront's
      // per-part idempotency dedupe distinct despatches into one.
      partNumber: toInt(detail.Part) ?? toInt(row.Part) ?? (parts.length + 1),
      status: partStatus,
      dispatched: isMintsoftDispatched({ status: partStatus, tracking: partTracking }),
      tracking: partTracking,
    })
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

/** Line items (SKU + whole-unit qty) of a single Mintsoft order/part. */
export async function fetchMintsoftPartItems(
  externalOrderId: string,
  clientId: number | null,
): Promise<Array<{ sku: string; qty: number }>> {
  const scopedClientId = requireMintsoftClientId(clientId, 'Mintsoft part-items lookup')
  // The Items DTO does not carry ClientId. Validate the parent part immediately
  // before consuming its items so an arbitrary/foreign part id can never cross
  // the tenant boundary.
  const parent = await fetchMintsoftOrderById(externalOrderId, scopedClientId)
  if (!parent) return []
  // Parent already validated as ours; scope the items request too (defence in
  // depth) since the Items DTO carries no ClientId of its own.
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Items?ClientId=${scopedClientId}`)
  if (result.error) throw new Error(result.error)
  const out: Array<{ sku: string; qty: number }> = []
  for (const raw of extractMintsoftArrayPayload(result.data)) {
    const r = raw as RawOrder
    const sku = toStr(r.SKU)
    const qty = toInt(r.Quantity) ?? 0
    if (sku && qty > 0) out.push({ sku, qty })
  }
  return out
}
