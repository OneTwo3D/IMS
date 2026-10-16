/**
 * THE READ-ONLY WALK of a WooCommerce store's variable products and their variations.
 *
 * THIS IS THE ONLY PLACE IN lib/first-load THAT TALKS TO A STORE, and it does so in exactly one way: `fetchPage` below, which the command wires to the
 * connector's own read function (`wcFetch`, lib/connectors/woocommerce/api.ts) with credentials given explicitly. `wcFetch` can only issue GET, goes
 * through `connectorFetch` (URL and DNS safety, redirect and size limits, and the outbound-write hold, which classifies a GET as a read), and never reads
 * the IMS database when it is handed credentials. There is no other request function in this directory, and a test keeps it that way.
 *
 * What the walk guarantees, each one a test:
 *   - every request waits for the minimum interval since the previous one (rate limiting), and a failed request is retried a bounded number of times;
 *   - COMPLETENESS IS PROVED, not assumed: the rows read for the parents must equal the store's own X-WP-Total, and for every parent the variations
 *     read must equal that call's X-WP-Total AND the list of variation ids the parent itself carries. A page the store did not serve, or a store that
 *     sends no usable total, is an error, never a smaller snapshot;
 *   - a store that changes while it is being walked (its total moves between pages) is an error;
 *   - the walk is RESUMABLE: after every page the state is handed to `onProgress`, and a later run given that state continues after the last whole page.
 */
import { SNAPSHOT_STATUSES, SNAPSHOT_FORMAT_VERSION, payloadSha256, reduceParent, reduceVariation, snapshotProblems, normalizePayload, type SnapshotParent, type SnapshotPayload, type SnapshotVariation } from '../snapshot'

export const WALK_PAGE_SIZE = 100
/** Attempts per request, including the first. */
export const WALK_MAX_ATTEMPTS = 3
/** A walk of 1000 pages is 100,000 rows: far beyond any catalogue this is for, and a store that ignores `page` would otherwise be asked for ever. */
export const WALK_MAX_PAGES = 1000
/**
 * A walk is only believed after a SECOND complete walk reads the same catalogue. Offset pagination over a store that changes while it is read can
 * skip a surviving product with every total and row count still agreeing (delete one on page 1, add one at the end before page 2). Up to this many
 * rounds of (walk, verifying walk) are tried before the store is declared unstable.
 */
export const WALK_MAX_ROUNDS = 3

/**
 * The statuses a snapshot must be able to see, requested EXPLICITLY (one count request each) for the variable products and for the variations of every
 * product. A store answers `status=any` with whatever the key may see, so a key that cannot see drafts or private rows would produce a quietly smaller
 * catalogue whose totals all agree. WooCommerce refuses an explicit status the key may not read (HTTP 403), which is what makes this a proof: a status that
 * cannot be enumerated fails the walk, and the per-status counts must add up to the `any` total.
 */
export const WALK_STATUSES = SNAPSHOT_STATUSES
export type WalkStatus = (typeof WALK_STATUSES)[number]
export type StatusTotals = Record<WalkStatus, number>
const VARIATION_ORDER = { orderby: 'id', order: 'asc' }
const emptyStatusTotals = (): StatusTotals => ({ publish: 0, draft: 0, private: 0, pending: 0 })

/** The store answered, but not with a complete, consistent catalogue. Maps to exit INCONSISTENT. */
export class SnapshotInconsistentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotInconsistentError'
  }
}

/** The store changed while it was being walked (a total moved, a product vanished). The round is abandoned and tried again. */
export class SnapshotChangedError extends SnapshotInconsistentError {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotChangedError'
  }
}

/** A request failed after its retries. Maps to exit FETCH_FAILED; the progress so far is kept for --resume. */
export class SnapshotFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotFetchError'
  }
}

export interface PageResult {
  data: unknown
  totalPages: number
  totalItems: number
  /** True only when the store sent an X-WP-Total header; the connector reads an absent one as 0. */
  totalItemsPresent?: boolean
  error?: string
}

export interface WalkDeps {
  /** One GET. Production passes the connector's read function; tests pass the same function aimed at a local fake store. */
  fetchPage: (path: string, params: Record<string, string>) => Promise<PageResult>
  sleep: (ms: number) => Promise<void>
  now: () => number
  minIntervalMs: number
  /** Called with the state after every whole page, so a crash loses at most one page. */
  onProgress?: (state: WalkState) => void
}

export interface WalkState {
  formatVersion: typeof SNAPSHOT_FORMAT_VERSION
  /** Identifies the store the state belongs to; a state for another store is refused. */
  origin: string
  parents: { total: number; totalPages: number; pagesDone: number; rows: SnapshotParent[] } | null
  /** Per parent id: the variations read for it, complete. */
  variations: Record<string, { total: number; pages: number; rows: SnapshotVariation[]; statusTotals?: StatusTotals }>
  requests: number
  /** Epoch ms of the last checkpoint; a walk older than the allowed age is not resumed (the store has moved on). */
  savedAt?: number
}

export function freshState(origin: string): WalkState {
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, origin, parents: null, variations: {}, requests: 0 }
}

export interface WalkResult {
  payload: SnapshotPayload
  proof: {
    parents: { totalHeader: number; rowsRead: number; pages: number; statusTotals: StatusTotals }
    variations: {
      /** Summed over every product: the per-status counts the operator compares with the shop's own admin counts. */
      statusTotals: StatusTotals
      parentsWithVariations: number; totalHeaderSum: number; rowsRead: number; requests: number }
    variationsWithoutSku: number
  }
  requests: number
  /** How many rounds of (walk, verifying walk) it took for two complete walks to agree. */
  verificationRounds: number
}

/**
 * What may be said about an upstream failure: the HTTP status and, when the body carries one, a WooCommerce-style error code (lower-case snake case).
 * NEVER the body, the message, a URL or a stack: a plugin or proxy can echo the Authorization header into an error body.
 */
export function describeUpstreamError(raw: string): string {
  const status = /WC API error: (\d{3})\b(?:\s+([a-z][a-z0-9_]{0,47})(?=:|\s|$))?/.exec(raw)
  if (status) return `HTTP ${status[1]}${status[2] ? ` (${status[2]})` : ''}`
  if (/redirect/i.test(raw)) return 'the store answered with a redirect, which is refused (the target was not requested)'
  if (/non-JSON/i.test(raw)) return 'the response was not JSON'
  const network = /\b(E[A-Z]{3,}[A-Z0-9_]*)\b/.exec(raw)
  return network ? `network error ${network[1]}` : 'the request failed (details withheld)'
}

function retryable(error: string): boolean {
  if (/redirect/i.test(error)) return false
  // WooCommerce's own client errors (400, 401, 403, 404) will not change on a retry; throttling and server errors may.
  const status = /\b(?:WC API error|WC API POST error): (\d{3})\b/.exec(error)
  if (status) {
    const code = Number(status[1])
    return code === 429 || code >= 500
  }
  return true
}

interface Clock {
  last: number | null
}

async function walkOnce(state: WalkState, deps: WalkDeps, clock: Clock): Promise<Omit<WalkResult, 'verificationRounds'>> {
  const throttle = async () => {
    if (clock.last !== null) {
      const wait = clock.last + deps.minIntervalMs - deps.now()
      if (wait > 0) await deps.sleep(wait)
    }
    clock.last = deps.now()
  }
  const get = async (path: string, params: Record<string, string>): Promise<PageResult> => {
    let lastError = ''
    for (let attempt = 1; attempt <= WALK_MAX_ATTEMPTS; attempt++) {
      await throttle()
      state.requests++
      let result: PageResult | null = null
      try {
        result = await deps.fetchPage(path, params)
        lastError = result.error ?? ''
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (result && !result.error) return result
      if (!retryable(lastError) || attempt === WALK_MAX_ATTEMPTS) break
      await deps.sleep(1000 * 2 ** (attempt - 1))
    }
    throw new SnapshotFetchError(`GET ${path} (page ${params.page}) failed: ${describeUpstreamError(lastError)}`)
  }

  /** Per-status X-WP-Total of one collection, each status asked for by name. A status the key may not read, or a store that ignores the filter, fails the walk. */
  const countByStatus = async (what: string, path: string, base: Record<string, string>, anyTotal: number): Promise<StatusTotals> => {
    const totals = emptyStatusTotals()
    for (const status of WALK_STATUSES) {
      let res: PageResult
      try {
        res = await get(path, { ...base, status, per_page: '1', page: '1' })
      } catch (error) {
        // A product listed a moment ago that no longer exists: the store changed under the walk.
        if (error instanceof SnapshotFetchError && /HTTP 404/.test(error.message)) throw new SnapshotChangedError(`${what}: the product was listed but no longer exists: the store changed during the walk`)
        if (error instanceof SnapshotFetchError && /HTTP (400|401|403)\b/.test(error.message)) {
          throw new SnapshotInconsistentError(`${what}: the status "${status}" cannot be enumerated with this key (${error.message}): the snapshot could be missing every ${status} row, so it is refused. Use a key that can read ${status} products and variations.`)
        }
        throw error
      }
      if (!Array.isArray(res.data) || res.totalItemsPresent !== true || !Number.isSafeInteger(res.totalItems) || res.totalItems < 0 || (res.totalItems === 0 && res.data.length > 0)) {
        throw new SnapshotInconsistentError(`${what}: the count of "${status}" rows came without a readable X-WP-Total (an empty list with no total is what a key sees for rows it may not read): completeness cannot be proved`)
      }
      totals[status] = res.totalItems
    }
    const sum = WALK_STATUSES.reduce((n, status) => n + totals[status], 0)
    if (sum !== anyTotal) {
      throw new SnapshotInconsistentError(`${what}: the per-status counts (${WALK_STATUSES.map((s) => `${s} ${totals[s]}`).join(', ')}; ${sum}) do not add up to the store's total of ${anyTotal}: some rows have a status the snapshot cannot enumerate, so it is refused`)
    }
    return totals
  }
  const assertKnownStatus = (what: string, status: string) => {
    if (!(WALK_STATUSES as readonly string[]).includes(status)) throw new SnapshotInconsistentError(`${what} has the status "${status}", which the snapshot cannot enumerate (it covers ${WALK_STATUSES.join(', ')}): refusing`)
  }

  // ----- parents -----
  const parentParams = (page: number): Record<string, string> => ({ type: 'variable', status: 'any', per_page: String(WALK_PAGE_SIZE), page: String(page), orderby: 'id', order: 'asc' })
  state.parents ??= { total: -1, totalPages: -1, pagesDone: 0, rows: [] }
  const parents = state.parents
  while (parents.totalPages < 0 || parents.pagesDone < parents.totalPages) {
    if (parents.pagesDone >= WALK_MAX_PAGES) throw new SnapshotInconsistentError(`the product walk passed ${WALK_MAX_PAGES} pages without ending: refusing to continue`)
    const page = parents.pagesDone + 1
    const res = await get('/products', parentParams(page))
    if (!Array.isArray(res.data)) throw new SnapshotInconsistentError(`GET /products page ${page} did not return a list`)
    // The connector reports an ABSENT total as 0 items / 1 page, so rows with a total of 0 mean the store sent none.
    if (!Number.isSafeInteger(res.totalItems) || res.totalItems < 0 || (res.totalItems === 0 && res.data.length > 0) || !Number.isSafeInteger(res.totalPages) || res.totalPages < 1) {
      throw new SnapshotInconsistentError(`GET /products page ${page} came without a readable X-WP-Total / X-WP-TotalPages (${res.totalItems} / ${res.totalPages}): completeness cannot be proved`)
    }
    if (parents.totalPages >= 0 && (res.totalItems !== parents.total || res.totalPages !== parents.totalPages)) {
      throw new SnapshotChangedError(`the store's product total moved during the walk (was ${parents.total} in ${parents.totalPages} page(s), now ${res.totalItems} in ${res.totalPages}): run again without --resume`)
    }
    parents.total = res.totalItems
    parents.totalPages = res.totalPages
    for (const raw of res.data) {
      const reduced = reduceParent(raw)
      if (!reduced.ok) throw new SnapshotInconsistentError(reduced.problem)
      assertKnownStatus(`product ${reduced.parent.id}`, reduced.parent.status)
      parents.rows.push(reduced.parent)
    }
    parents.pagesDone = page
    deps.onProgress?.(state)
  }
  if (parents.rows.length !== parents.total) {
    throw new SnapshotInconsistentError(`${parents.rows.length} variable product(s) were read but the store's X-WP-Total says ${parents.total}: the snapshot would be incomplete`)
  }
  if (parents.total === 0) throw new SnapshotInconsistentError('the store returned no variable products: refusing to write an empty snapshot')
  const parentStatusTotals = await countByStatus('variable products', '/products', { type: 'variable', orderby: 'id', order: 'asc' }, parents.total)

  // ----- variations of each parent -----
  const ordered = [...parents.rows].sort((a, b) => a.id - b.id)
  let variationRequests = 0
  for (const parent of ordered) {
    const key = String(parent.id)
    if (state.variations[key]?.statusTotals) continue
    if (parent.variationIds.length === 0) {
      state.variations[key] = { total: 0, pages: 0, rows: [], statusTotals: await countByStatus(`the variations of product ${parent.id}`, `/products/${parent.id}/variations`, VARIATION_ORDER, 0) }
      deps.onProgress?.(state)
      continue
    }
    const rows: SnapshotVariation[] = []
    let total = -1
    let totalPages = -1
    let page = 0
    while (totalPages < 0 || page < totalPages) {
      if (page >= WALK_MAX_PAGES) throw new SnapshotInconsistentError(`the variation walk of product ${parent.id} passed ${WALK_MAX_PAGES} pages without ending`)
      page++
      variationRequests++
      let res: PageResult
      try {
        res = await get(`/products/${parent.id}/variations`, { status: 'any', per_page: String(WALK_PAGE_SIZE), page: String(page), orderby: 'id', order: 'asc' })
      } catch (error) {
        // A product listed a moment ago that no longer exists: the store changed under the walk.
        if (error instanceof SnapshotFetchError && /HTTP 404/.test(error.message)) throw new SnapshotChangedError(`product ${parent.id} was listed but no longer exists: the store changed during the walk`)
        throw error
      }
      if (!Array.isArray(res.data)) throw new SnapshotInconsistentError(`GET /products/${parent.id}/variations page ${page} did not return a list`)
      if (!Number.isSafeInteger(res.totalItems) || res.totalItems < 1 || !Number.isSafeInteger(res.totalPages) || res.totalPages < 1) {
        throw new SnapshotInconsistentError(`the variations of product ${parent.id} came without a readable X-WP-Total / X-WP-TotalPages (${res.totalItems} / ${res.totalPages}) although the product lists ${parent.variationIds.length}: completeness cannot be proved`)
      }
      if (totalPages >= 0 && (res.totalItems !== total || res.totalPages !== totalPages)) {
        throw new SnapshotChangedError(`the variation total of product ${parent.id} moved during the walk: run again without --resume`)
      }
      total = res.totalItems
      totalPages = res.totalPages
      for (const raw of res.data) {
        const reduced = reduceVariation(raw, parent.id)
        if (!reduced.ok) throw new SnapshotInconsistentError(reduced.problem)
        assertKnownStatus(`variation ${reduced.variation.id}`, reduced.variation.status)
        rows.push(reduced.variation)
      }
    }
    if (rows.length !== total) {
      throw new SnapshotInconsistentError(`${rows.length} variation(s) of product ${parent.id} were read but the store's X-WP-Total says ${total}: the snapshot would be incomplete`)
    }
    state.variations[key] = { total, pages: totalPages, rows, statusTotals: await countByStatus(`the variations of product ${parent.id}`, `/products/${parent.id}/variations`, VARIATION_ORDER, total) }
    deps.onProgress?.(state)
  }

  const variations = ordered.flatMap((p) => state.variations[String(p.id)].rows)
  const payload = normalizePayload({ source: 'woocommerce', parents: ordered, variations })
  const problems = snapshotProblems(payload)
  if (problems.length > 0) throw new SnapshotInconsistentError(`the snapshot is not consistent:\n  - ${problems.join('\n  - ')}`)
  const perParent = ordered.map((p) => state.variations[String(p.id)])
  return {
    payload,
    proof: {
      parents: { totalHeader: parents.total, rowsRead: parents.rows.length, pages: parents.pagesDone, statusTotals: parentStatusTotals },
      variations: {
        statusTotals: perParent.reduce((acc, v) => {
          for (const status of WALK_STATUSES) acc[status] += v.statusTotals?.[status] ?? 0
          return acc
        }, emptyStatusTotals()),
        parentsWithVariations: perParent.filter((v) => v.total > 0).length,
        totalHeaderSum: perParent.reduce((n, v) => n + v.total, 0),
        rowsRead: variations.length,
        requests: variationRequests,
      },
      variationsWithoutSku: variations.filter((v) => v.sku === '').length,
    },
    requests: state.requests,
  }
}

/** Two complete walks must read the same catalogue (same canonical payload, byte for byte) before it is believed. */
export async function walkStore(state: WalkState, deps: WalkDeps): Promise<WalkResult> {
  const clock: Clock = { last: null }
  let first = state
  let requests = 0
  let last = ''
  for (let round = 1; round <= WALK_MAX_ROUNDS; round++) {
    try {
      const a = await walkOnce(first, deps, clock)
      const second = freshState(state.origin)
      const b = await walkOnce(second, { ...deps, onProgress: undefined }, clock)
      requests += a.requests + b.requests
      if (payloadSha256(a.payload) === payloadSha256(b.payload)) return { ...a, requests, verificationRounds: round }
      last = 'two complete walks read different catalogues'
    } catch (error) {
      if (!(error instanceof SnapshotChangedError)) throw error
      last = error.message
    }
    first = freshState(state.origin)
  }
  throw new SnapshotInconsistentError(`the store's catalogue changed while it was walked, in each of ${WALK_MAX_ROUNDS} rounds (last: ${last}): it is not stable enough to snapshot. Try again when nobody is editing products.`)
}
