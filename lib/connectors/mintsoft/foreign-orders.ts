/**
 * THE FOREIGN MINTSOFT ORDER READER (switchover evidence MINTSOFT_FOREIGN_ORDER, o3d-zvec.3).
 *
 * After step M the bridge must not create Mintsoft orders any more, and IMS creates them under the one shared API user. So an order on OUR Mintsoft client
 * (the configured `mintsoft_client_id`) created at or after the step's live-from instant S that IMS holds NO LINK for was made by somebody else: the bridge
 * (still running) or an operator. This reads the client's recently changed orders (a READ: `GET /api/Order/List`, the connector's allow-listed read) and
 * counts those.
 *
 * FAIL-CLOSED RULES. Every row must carry a readable ID, an order number and a ClientId equal to ours (the tenant is shared: a row of another client, or one
 * with no ClientId, throws and the whole read fails, which the evidence reader reports as unreadable). The list is read to its end, or it throws (a
 * truncated list is never a clean one). A row whose creation time cannot be read is COUNTED, not skipped: it cannot be shown to predate S. The creation time is only ever read from a
 * real created field (never OrderDate, the channel's order date, which for a late-created order predates S): with none readable the row is counted as
 * foreign and undated unless IMS holds a link with that exact ID.
 *
 * A row is LINKED when IMS holds a Mintsoft push link whose external order id equals the row's ID, or (only where the link has NO id yet) whose external
 * order number equals the row's order number. A row whose number matches a link that carries a DIFFERENT id is a DUPLICATE of an order IMS made: it is
 * counted as foreign (and in `duplicates`), never as linked. The reader never writes anything, never mints a key (reads use the stored key) and returns counts only: no order
 * number, id, name or address leaves it.
 */
import { db } from '@/lib/db'
import { extractMintsoftArrayPayloadStrict } from './api/normalizers'
import { mintsoftRequest, type MintsoftRequestResult } from './api/client'
import { getMintsoftSettings, parseMintsoftPositiveId } from './settings/schema'

const PAGE_LIMIT = 100
const MAX_PAGES = 200
/** Mintsoft compares SinceLastUpdated in its tenant's own zone, so the cursor is sent in Europe/London wall-clock time. */
const TENANT_ZONE = 'Europe/London'
/** The window sent to Mintsoft starts this much before S, which absorbs a clock or zone slip; the count itself is judged against S exactly. */
const LOOKBACK_MS = 3 * 3_600_000
/** The fields that can carry the creation time, in order of preference. */
const CREATED_FIELDS = ['CreatedDate', 'DateCreated', 'Created'] as const

export type ForeignOrderRead = {
  /** Rows of our client read. */
  scanned: number
  /** Created at or after S, with no IMS link (or with a creation time that cannot be read and no IMS link). */
  foreign: number
  /** Of `foreign`, those whose creation time could not be read. */
  undated: number
  /** Of `foreign`, those whose order number is one IMS holds a link for under a DIFFERENT Mintsoft id (a second order for the same storefront order). */
  duplicates: number
  pages: number
}

/** `ids`: ids of links. `numbers`: order numbers of links that have NO id yet. `numbersWithOtherId`: order numbers of links that carry an id. */
export type LinkedSets = { ids: ReadonlySet<string>; numbers: ReadonlySet<string>; numbersWithOtherId?: ReadonlySet<string> }

export type ForeignOrderDeps = {
  /** Test seam: the Mintsoft request. Absent = the connector's own (stored key, read allow-list, egress hold). */
  request?: (path: string) => Promise<MintsoftRequestResult<unknown>>
  /** Test seam: which of these ids / numbers IMS holds a Mintsoft push link for. Absent = the database. */
  linked?: (ids: string[], numbers: string[]) => Promise<LinkedSets>
  clientId?: number
}

/** `YYYY-MM-DDTHH:MM:SS` wall-clock time of an instant in the tenant's zone. */
export function formatTenantCursor(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TENANT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`
}

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * The creation instant of a Mintsoft row, or null. A value with no zone is the tenant's wall-clock time (Europe/London): it is read as UTC-offset by the
 * zone's offset at that moment, found by comparing the formatted tenant time of the UTC reading.
 */
export function mintsoftRowCreatedAt(row: Record<string, unknown>): Date | null {
  for (const field of CREATED_FIELDS) {
    const raw = row[field]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const text = raw.trim()
    if (/Z$|[+-]\d\d:?\d\d$/.test(text)) {
      const at = new Date(text)
      if (!Number.isNaN(at.getTime())) return at
      continue
    }
    const asUtc = new Date(`${text.replace(' ', 'T')}Z`)
    if (Number.isNaN(asUtc.getTime())) continue
    // asUtc is the wall-clock reading placed on the UTC axis; the true instant is earlier by the tenant's offset at that time.
    const wall = Date.parse(`${formatTenantCursor(asUtc)}Z`)
    return new Date(asUtc.getTime() - (wall - asUtc.getTime()))
  }
  return null
}

async function linkedInDb(ids: string[], numbers: string[]): Promise<LinkedSets> {
  const rows = await db.wmsOrderPushLink.findMany({
    where: { connector: 'mintsoft', OR: [{ externalOrderId: { in: ids } }, { externalOrderNumber: { in: numbers } }] },
    select: { externalOrderId: true, externalOrderNumber: true },
  })
  return {
    ids: new Set(rows.map((row) => row.externalOrderId).filter((v): v is string => v !== null)),
    numbers: new Set(rows.filter((row) => row.externalOrderId === null).map((row) => row.externalOrderNumber).filter((v): v is string => v !== null)),
    numbersWithOtherId: new Set(rows.filter((row) => row.externalOrderId !== null).map((row) => row.externalOrderNumber).filter((v): v is string => v !== null)),
  }
}

export async function readMintsoftForeignOrders(since: Date, deps: ForeignOrderDeps = {}): Promise<ForeignOrderRead> {
  const clientId = deps.clientId ?? parseMintsoftPositiveId((await getMintsoftSettings()).mintsoft_client_id)
  if (clientId == null) throw new Error('Mintsoft foreign-order read requires mintsoft_client_id: refusing an unscoped cross-client read')
  const request = deps.request ?? ((path: string) => mintsoftRequest<unknown>(path))
  const linked = deps.linked ?? linkedInDb
  const cursor = formatTenantCursor(new Date(since.getTime() - LOOKBACK_MS))
  const out: ForeignOrderRead = { scanned: 0, foreign: 0, undated: 0, duplicates: 0, pages: 0 }

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const query = new URLSearchParams({ SinceLastUpdated: cursor, Limit: String(PAGE_LIMIT), PageNo: String(pageNo), SortOldestFirst: 'true', ClientId: String(clientId) })
    const result = await request(`/api/Order/List?${query.toString()}`)
    if (result.error) throw new Error(`Mintsoft Order/List: ${result.error}`)
    const page = extractMintsoftArrayPayloadStrict(result.data, `Order/List page ${pageNo}`)
    if (page.length > PAGE_LIMIT) throw new Error(`Mintsoft Order/List page ${pageNo} returned more rows than the page size: refusing an unbounded read`)
    out.pages += 1
    const rows: Array<{ id: string; number: string; createdAt: Date | null }> = []
    for (const raw of page) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Mintsoft Order/List page ${pageNo}: a row is not an object`)
      const row = raw as Record<string, unknown>
      const id = asText(row.ID ?? row.Id ?? row.id)
      const number = asText(row.OrderNumber)
      const rowClient = asText(row.ClientId ?? row.clientId)
      if (id === null || number === null) throw new Error(`Mintsoft Order/List page ${pageNo}: a row has no ID or order number`)
      if (rowClient === null || Number(rowClient) !== clientId) throw new Error(`Mintsoft Order/List page ${pageNo}: a row is not of client ${clientId}: refusing a cross-client read`)
      rows.push({ id, number, createdAt: mintsoftRowCreatedAt(row) })
    }
    out.scanned += rows.length
    // Only a row that could be foreign needs the link lookup: created at or after S, or with no readable creation time.
    const candidates = rows.filter((row) => row.createdAt === null || row.createdAt.getTime() >= since.getTime())
    if (candidates.length > 0) {
      const known = await linked(candidates.map((row) => row.id), candidates.map((row) => row.number))
      for (const row of candidates) {
        if (known.ids.has(row.id)) continue
        // A number-only match is weaker evidence than an id match: it is never enough for a row whose creation time is unreadable.
        if (row.createdAt !== null && known.numbers.has(row.number)) continue
        out.foreign += 1
        if (known.numbersWithOtherId?.has(row.number)) out.duplicates += 1
        if (row.createdAt === null) out.undated += 1
      }
    }
    if (page.length < PAGE_LIMIT) return out
  }
  throw new Error(`Mintsoft Order/List exceeded ${MAX_PAGES} pages: refusing to treat a truncated read as complete`)
}
