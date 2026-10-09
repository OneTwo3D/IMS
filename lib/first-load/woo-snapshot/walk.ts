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
import { SNAPSHOT_FORMAT_VERSION, reduceParent, reduceVariation, snapshotProblems, normalizePayload, type SnapshotParent, type SnapshotPayload, type SnapshotVariation } from '../snapshot'

export const WALK_PAGE_SIZE = 100
/** Attempts per request, including the first. */
export const WALK_MAX_ATTEMPTS = 3
/** A walk of 1000 pages is 100,000 rows: far beyond any catalogue this is for, and a store that ignores `page` would otherwise be asked for ever. */
export const WALK_MAX_PAGES = 1000

/** The store answered, but not with a complete, consistent catalogue. Maps to exit INCONSISTENT. */
export class SnapshotInconsistentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotInconsistentError'
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
  variations: Record<string, { total: number; pages: number; rows: SnapshotVariation[] }>
  requests: number
}

export function freshState(origin: string): WalkState {
  return { formatVersion: SNAPSHOT_FORMAT_VERSION, origin, parents: null, variations: {}, requests: 0 }
}

export interface WalkResult {
  payload: SnapshotPayload
  proof: {
    parents: { totalHeader: number; rowsRead: number; pages: number }
    variations: { parentsWithVariations: number; totalHeaderSum: number; rowsRead: number; requests: number }
    variationsWithoutSku: number
  }
  requests: number
}

function retryable(error: string): boolean {
  // WooCommerce's own client errors (400, 401, 403, 404) will not change on a retry; throttling and server errors may.
  const status = /\b(?:WC API error|WC API POST error): (\d{3})\b/.exec(error)
  if (status) {
    const code = Number(status[1])
    return code === 429 || code >= 500
  }
  return true
}

export async function walkStore(state: WalkState, deps: WalkDeps): Promise<WalkResult> {
  let lastRequestAt: number | null = null
  const throttle = async () => {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + deps.minIntervalMs - deps.now()
      if (wait > 0) await deps.sleep(wait)
    }
    lastRequestAt = deps.now()
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
    throw new SnapshotFetchError(`GET ${path} (page ${params.page}) failed: ${lastError}`)
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
      throw new SnapshotInconsistentError(`the store's product total moved during the walk (was ${parents.total} in ${parents.totalPages} page(s), now ${res.totalItems} in ${res.totalPages}): run again without --resume`)
    }
    parents.total = res.totalItems
    parents.totalPages = res.totalPages
    for (const raw of res.data) {
      const reduced = reduceParent(raw)
      if (!reduced.ok) throw new SnapshotInconsistentError(reduced.problem)
      parents.rows.push(reduced.parent)
    }
    parents.pagesDone = page
    deps.onProgress?.(state)
  }
  if (parents.rows.length !== parents.total) {
    throw new SnapshotInconsistentError(`${parents.rows.length} variable product(s) were read but the store's X-WP-Total says ${parents.total}: the snapshot would be incomplete`)
  }
  if (parents.total === 0) throw new SnapshotInconsistentError('the store returned no variable products: refusing to write an empty snapshot')

  // ----- variations of each parent -----
  const ordered = [...parents.rows].sort((a, b) => a.id - b.id)
  let variationRequests = 0
  for (const parent of ordered) {
    const key = String(parent.id)
    if (state.variations[key]) continue
    if (parent.variationIds.length === 0) {
      state.variations[key] = { total: 0, pages: 0, rows: [] }
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
      const res = await get(`/products/${parent.id}/variations`, { per_page: String(WALK_PAGE_SIZE), page: String(page), orderby: 'id', order: 'asc' })
      if (!Array.isArray(res.data)) throw new SnapshotInconsistentError(`GET /products/${parent.id}/variations page ${page} did not return a list`)
      if (!Number.isSafeInteger(res.totalItems) || res.totalItems < 1 || !Number.isSafeInteger(res.totalPages) || res.totalPages < 1) {
        throw new SnapshotInconsistentError(`the variations of product ${parent.id} came without a readable X-WP-Total / X-WP-TotalPages (${res.totalItems} / ${res.totalPages}) although the product lists ${parent.variationIds.length}: completeness cannot be proved`)
      }
      if (totalPages >= 0 && (res.totalItems !== total || res.totalPages !== totalPages)) {
        throw new SnapshotInconsistentError(`the variation total of product ${parent.id} moved during the walk: run again without --resume`)
      }
      total = res.totalItems
      totalPages = res.totalPages
      for (const raw of res.data) {
        const reduced = reduceVariation(raw, parent.id)
        if (!reduced.ok) throw new SnapshotInconsistentError(reduced.problem)
        rows.push(reduced.variation)
      }
    }
    if (rows.length !== total) {
      throw new SnapshotInconsistentError(`${rows.length} variation(s) of product ${parent.id} were read but the store's X-WP-Total says ${total}: the snapshot would be incomplete`)
    }
    state.variations[key] = { total, pages: totalPages, rows }
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
      parents: { totalHeader: parents.total, rowsRead: parents.rows.length, pages: parents.pagesDone },
      variations: {
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
