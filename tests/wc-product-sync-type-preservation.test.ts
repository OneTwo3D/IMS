import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'
import { WC_PRODUCT_CONFLICT_LIST_LOCK_NAMESPACE } from '../lib/db/advisory-locks.ts'
import {
  WC_PRODUCT_CONFLICT_RETRY_LIMIT,
  WC_PRODUCT_CONFLICT_STORE_LIMIT,
} from '../lib/connectors/woocommerce/sync/product-conflict-cursor.ts'

// o3d-y89x: the WooCommerce product sync is the THIRD writer of Product.type (after the
// editor and the CSV import) and was the only unguarded one. It computed
//   productType = wcProduct.type === 'variable' ? 'VARIABLE' : 'SIMPLE'
// and wrote it unconditionally onto an existing IMS row, so a KIT or BOM whose SKU matched a
// WooCommerce `simple` product was silently flattened to SIMPLE — with its ProductComponent
// rows left in place, the exact state o3d-w998 stops the CSV import from creating.
//
// The rule under test: a connector may never downgrade an IMS product out of KIT or BOM.
// WooCommerce has no concept of composition, so `simple` there is an ABSENCE of information,
// not an assertion. Everything else in the payload must still be applied — a refused sync
// would be worse than a preserved type.

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  /** ProductComponent rows. Nothing in the connector may add, change or remove these. */
  components: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  warnings: [] as unknown[][],
  /** Every `data` object handed to product.updateMany, in order — the write log. */
  updateData: [] as Row[],
  /** Set if the connector ever tried to delete component rows. */
  componentDeletes: 0,
  /** Every `Setting` key written by an upsert — the bulk sync's cursor is one of these. */
  settingUpserts: [] as string[],
  /** Every activity row the sync logged, in order. */
  activity: [] as Record<string, unknown>[],
  /** Every advisory-lock statement the sync issued, in order. */
  advisoryLocks: [] as Array<{ sql: string; values: unknown[] }>,
  /**
   * The `include=` id list of every by-id re-attempt fetch, one entry per run.
   *
   * WHICH ids a run re-attempts is the whole of the rotation claim, and it is not
   * visible from the resulting settings row: a list that never rotated and one
   * that rotated twice can look identical at rest.
   */
  includeFetches: [] as number[][],
  /** Persisted Setting rows, so a value written by one run is visible to the next. */
  settings: new Map<string, string>(),

  // --- what makes a product LIVE (o3d-y89x r2) ---------------------------------
  // The editor refuses a type OR parent change on a product carrying any of these, and the
  // connector now asks the same question through the same function. Modelled as rows rather
  // than as a boolean so the double answers PER PRODUCT: a blocker double that ignored
  // `where.productId` would make every "blocked" test and every "not blocked" test pass for
  // the same reason.
  stockLevels: [] as Array<{ productId: string; quantity: number; reservedQty: number }>,
  /** Open sales-order lines. The double is handed rows already restricted to open orders. */
  salesOrderLines: [] as Array<{ productId: string }>,
  purchaseOrderLines: [] as Array<{ productId: string }>,
  productionOrders: [] as Array<{ outputProductId: string }>,
  /**
   * Transfer lines WITH their transfer's status (o3d-y89x r6, Codex finding 2).
   *
   * Modelled with a status because production filters on one — both transfer queries carry
   * `transfer: { status: { in: OPEN_TRANSFER_STATUSES } }` — and a double that ignored it would
   * leave the suite green if production dropped the filter. That is not a cosmetic gap: a
   * RECEIVED transfer from last year would then block a transform forever, and the "blocked"
   * tests would still pass because their lines happen to be open.
   */
  stockTransferLines: [] as Array<{ productId: string; status: string }>,
  /**
   * Every productId the connector asked the blocker question about, in order.
   *
   * The claim "a steady-state re-sync costs no extra queries" is a claim about this list being
   * EMPTY, and it is not observable any other way.
   */
  blockerQueries: [] as string[],
  /**
   * How many blocker STATEMENTS the transaction issued after its last write — i.e. in the
   * pre-commit re-assertion (o3d-y89x r5, Codex finding 1).
   *
   * The claim the re-assertion makes is about a WINDOW, and a window is measured in statements.
   * Row-by-row it was five per transformed row, so the row checked first stayed exposed across
   * every statement the later rows cost; set-wise it is two, whatever the row count. Neither
   * number is observable from behaviour — both implementations refuse a blocker that is already
   * there — so this counter is the only place the property can be asserted at all.
   *
   * Counted per DELEGATE CALL rather than per candidate id on purpose: one query about twenty
   * rows is one statement, and that is exactly the distinction under test.
   */
  commitPhaseBlockerStatements: 0,
  /** Every id set the pre-commit re-assertion asked about, one entry per statement. */
  commitPhaseBlockerIds: [] as string[][],
  /**
   * One label per statement issued against the `product` delegate, in order (o3d-y89x r5, Codex
   * finding 2).
   *
   * "The child question is asked once per batch, index-scoped" is a claim about how many
   * statements a sync issues and what they are scoped to, and a behavioural test cannot see it:
   * the connector reaches the same decision whether the answer rides on the row lookup, follows
   * it once for the whole batch, or follows it once per row. This list is where the difference
   * shows up.
   */
  productReads: [] as string[],
  /**
   * The candidate id set of every child-existence statement, one entry per statement (o3d-y89x
   * r6, Codex finding 1).
   *
   * The r5 regression was NOT a statement count — it was one statement whose plan aggregated the
   * whole catalogue, because `_count` on a relation renders as an UNCORRELATED
   * `LEFT JOIN (SELECT parentId, COUNT(*) FROM products GROUP BY parentId)`. A statement-count
   * assertion is blind to that by construction. What distinguishes the two is SCOPE: the
   * index-scoped form names the ids it is asking about, and the catalogue-wide form names none.
   * So this records the ids, and the tests assert they are exactly the rows the transaction has
   * in hand.
   */
  childQueryIds: [] as string[][],
}

/**
 * True once the transaction has reached `recordStructureConflicts` — its last write, and the
 * statement immediately before the pre-commit re-assertion. Nothing else asks a blocker question
 * after that point, so every blocker read seen while this is set belongs to the re-assertion.
 */
let inCommitPhase = false

function recordCommitPhaseStatement(ids: readonly string[]): void {
  if (!inCommitPhase) return
  state.commitPhaseBlockerStatements++
  state.commitPhaseBlockerIds.push([...ids])
}

function snapshot() {
  return {
    products: state.products.map((row) => ({ ...row })),
    components: state.components.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
    syncLogs: state.syncLogs.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.products.splice(0, state.products.length, ...snap.products)
  state.components.splice(0, state.components.length, ...snap.components)
  state.options.splice(0, state.options.length, ...snap.options)
  state.syncLogs.splice(0, state.syncLogs.length, ...snap.syncLogs)
}

let nextId = 1
let variationPages: Record<string, Row[]> = {}
/** Pages served for GET /products — only the bulk-cursor tests need a non-empty one. */
let productPages: Record<string, Row[]> = {}
/**
 * Products the store still holds but that a `modified_after` page would NOT
 * return — the steady state once the cursor has moved past a conflicted product.
 * GET /products?include= answers from here (o3d-xbt); an id in neither this map
 * nor `productPages` models a product deleted in WooCommerce.
 */
let productsById: Record<string, Row> = {}
/** Set to make GET /products fail — the transport failure the split must keep transient. */
let productFetchError: string | null = null
/** Same, but only for the by-id re-attempt fetch. */
let productFetchErrorOnInclude: string | null = null

function wcVariation(id: number, sku: string, option: string): Row {
  return {
    id,
    sku,
    status: 'publish',
    description: '',
    regular_price: '19.00',
    sale_price: '',
    weight: '',
    dimensions: { length: '', width: '', height: '' },
    images: [],
    attributes: [{ option }],
    global_unique_id: '',
  }
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      const page = params.page ?? '1'
      if (path.includes('/variations')) {
        return { data: variationPages[page] ?? [], totalPages: 1, totalItems: 0, error: null }
      }
      if (path === '/products') {
        if (productFetchError) return { data: [], totalPages: 1, totalItems: 0, error: productFetchError }
        if (params.include) {
          state.includeFetches.push(params.include.split(',').map(Number))
          if (productFetchErrorOnInclude) {
            return { data: [], totalPages: 1, totalItems: 0, error: productFetchErrorOnInclude }
          }
          // WooCommerce answers an explicit id list whatever the modification
          // window, which is exactly why the retry pass uses it.
          const ids = params.include.split(',')
          const paged = Object.values(productPages).flat()
          const rows = ids
            .map((id) => productsById[id] ?? paged.find((row) => String(row.id) === id))
            .filter((row): row is Row => Boolean(row))
          return { data: rows, totalPages: 1, totalItems: rows.length, error: null }
        }
        const rows = productPages[page] ?? []
        return { data: rows, totalPages: Object.keys(productPages).length || 1, totalItems: rows.length, error: null }
      }
      return { data: [], totalPages: 1, totalItems: 0, error: null }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

/**
 * Activity rows are RECORDED, not discarded (o3d-xbt round 2). "The sweep logs
 * what it dropped" is a claim about a row existing, and a no-op double makes
 * every such claim unfalsifiable.
 */
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (row: Record<string, unknown>) => { state.activity.push(row) },
  },
})
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async () => {} },
})

function findProductBySku(sku: unknown) {
  return state.products.find((row) => row.sku === sku) ?? null
}

/**
 * The conditional ownership update, faithfully: `id` plus the OR over externalProductId, then
 * Object.assign of EXACTLY the keys `data` carries.
 *
 * This is the double the whole suite rests on, so be explicit about why it can tell the two
 * outcomes apart. The production fix works by OMITTING `type` from `data` rather than by
 * writing `existing.type` back. A double that seeded a default `type`, or that rebuilt the row
 * from the WC payload, or that returned a canned row regardless of `where`, would report
 * "type preserved" whatever production did — it would prove nothing. Object.assign over the
 * live row means an omitted key is untouched and a present key overwrites, which is the exact
 * distinction under test. `assertDoubleWritesTypeWhenAsked` below pins that down.
 */
/**
 * The RELATION-FILTER arms of `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE`, evaluated arm by arm
 * against the SAME `state.*` arrays the blocker SELECT doubles read (o3d-y89x r3).
 *
 * Reading one shared state from both sides is the whole point. A double that answered the
 * conditional write from a private map, or from the answer the SELECT gave earlier, could not
 * express the interleaving under test — "clean when asked, blocked when written" — because the
 * two answers could never differ. Sharing the state means a test that pushes a blocker row
 * between the two calls makes them disagree exactly as Postgres would.
 *
 * Unknown relation keys THROW. If a sixth arm is ever added to the fragment, this must fail
 * loudly rather than quietly ignore it and keep reporting the write as guarded.
 */
const KNOWN_BLOCKER_WHERE_KEYS = new Set([
  'stockLevels', 'salesOrderLines', 'poLines', 'productionOrdersAsOutput', 'usedAsComponentIn',
])

function transformBlockerWhereRejects(where: Row, productId: string): boolean {
  const relationKeys = Object.keys(where).filter((key) => key !== 'id' && key !== 'OR')
  if (relationKeys.length === 0) return false
  for (const key of relationKeys) {
    if (!KNOWN_BLOCKER_WHERE_KEYS.has(key)) {
      throw new Error(`product.updateMany double got an unmodelled relation filter: ${key}`)
    }
  }

  if (relationKeys.includes('stockLevels')
    && state.stockLevels.some((r) => r.productId === productId && (r.quantity > 0 || r.reservedQty > 0))) return true
  if (relationKeys.includes('salesOrderLines')
    && state.salesOrderLines.some((r) => r.productId === productId)) return true
  if (relationKeys.includes('poLines')
    && state.purchaseOrderLines.some((r) => r.productId === productId)) return true
  if (relationKeys.includes('productionOrdersAsOutput')
    && state.productionOrders.some((r) => r.outputProductId === productId)) return true
  if (relationKeys.includes('usedAsComponentIn')
    && state.components.some((c) => c.componentId === productId
      && state.productionOrders.some((r) => r.outputProductId === c.productId))) return true
  return false
}

/**
 * Fired with the product id of every conditional product write, BEFORE its predicate is
 * evaluated — i.e. strictly after the blocker SELECTs (they are all awaited while `updateData`
 * is still being built) and strictly before the write commits. That is precisely the window
 * o3d-y89x r3 closes, and it is the only place a test can open it.
 */
let beforeProductWrite: ((productId: string) => void) | null = null

/**
 * Fired at the START of every blocker SELECT, before it reads `state.*` (o3d-y89x r4).
 *
 * What it exists for is Codex r4 finding 3: a blocker that is present for the conditional WRITE
 * and GONE by the diagnostic read that follows it. A double whose answer is fixed for the whole
 * run cannot express that at all — the two reads could never differ — so the hook lets a test
 * move the state between them, which is exactly what `stock moving 0 -> 5 -> 0` does in
 * Postgres. It fires for the pre-check reads too, where a test that seeds nothing changes
 * nothing.
 */
let beforeBlockerQuery: ((productId: string) => void) | null = null

/**
 * Fired when the transaction reaches `recordStructureConflicts` — after every product write it
 * is going to make, and before the pre-commit blocker re-assertion (o3d-y89x r4).
 *
 * This is the window Codex r4 finding 2 is about: the connector transforms a row and then keeps
 * working inside the same transaction, so a blocker committing in that stretch is seen by
 * neither the pre-check nor the write's own predicate.
 */
let beforeConflictsRecorded: (() => void) | null = null
/** Set to make `Setting.upsert` throw for one key. */
let settingUpsertError: { key: string; message: string } | null = null

/**
 * Fired ONCE, at the moment the sweep takes the conflict-list advisory lock — the
 * statement immediately before it re-reads the list it is about to merge into
 * (o3d-xbt round 3, finding 1).
 *
 * This is the ONLY seam at which an overlapping sweep can be modelled, and it is
 * a faithful one: `pg_advisory_xact_lock` serializes, it does not exclude, so the
 * other sweep's commit landing just before we are granted the lock is exactly
 * what the production code is required to survive. A test that instead wrote the
 * setting before calling the sweep would be modelling a run that STARTED late,
 * not one that overlapped.
 *
 * One-shot on purpose: one concurrent commit, at one point. If the sweep never
 * takes the lock, the hook never fires and the test that relies on it fails —
 * which is what makes it evidence that the read happens under the lock rather
 * than before it.
 */
let onConflictListLock: (() => void) | null = null

function updateManyMatching(where: Row, data: Row): { count: number } {
  const row = state.products.find((candidate) => candidate.id === where.id)
  if (!row) return { count: 0 }

  const or = where.OR as Array<Row> | undefined
  if (or) {
    const matches = or.some((clause) => {
      if ('externalProductId' in clause && clause.externalProductId === null) {
        return row.externalProductId == null
      }
      const inClause = (clause.externalProductId as { in?: bigint[] } | undefined)?.in
      return Array.isArray(inClause) && row.externalProductId != null
        && inClause.some((id) => id === row.externalProductId)
    })
    if (!matches) return { count: 0 }
  }

  beforeProductWrite?.(String(where.id))
  if (transformBlockerWhereRejects(where, String(where.id))) return { count: 0 }

  state.updateData.push({ ...data })
  Object.assign(row, data)
  return { count: 1 }
}

/**
 * THE r5 SHAPE, STILL ANSWERED (o3d-y89x r6). Production no longer asks for
 * `include: { _count: { select: { variants: true } } }` — it was measured to render as a
 * whole-catalogue aggregate — but the double still answers it, from the SAME `state.products`
 * array everything else reads, so that reverting production to r5 makes the cost tests below
 * fail on the STATEMENT SHAPE they assert rather than on the double refusing to answer. A
 * revert-failure produced by an unmodelled-shape throw would be proving something else.
 *
 * Attached ONLY when the caller asked for it: the connector's structural rules are decided from
 * this answer, and `imsRowHasChildren` throws on a row that carries neither form rather than
 * reading "no children" out of its absence. A double that attached it unconditionally would
 * answer for a production query that never asked, which is precisely the "nobody asked" /
 * "genuinely childless" confusion the rule exists to prevent.
 */
function withChildCount(row: Row, include?: Row): Row {
  if (!include || !('_count' in include)) return { ...row }
  return { ...row, _count: { variants: state.products.filter((child) => child.parentId === row.id).length } }
}

/**
 * `findMany` for the TWO queries production makes: candidate rows by SKU (o3d-h2cz), and the
 * SET-WISE pre-commit blocker re-assertion, which filters the transformed ids through
 * `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE` in one statement (o3d-y89x r5).
 *
 * The old version returned EVERY row whenever `where.sku.in` was absent, which for the
 * blocker query would have reported every transformed row as still clean. Answering an
 * unrecognised `where` with a throw instead is what keeps "no blockers" a fact this double
 * established rather than a coincidence — and the blocker arms are evaluated through the SAME
 * `transformBlockerWhereRejects` the conditional write uses, against the same shared state, so a
 * test that pushes a blocker after the writes makes the two disagree exactly as Postgres would.
 */
function findManyMatching(where?: Row, include?: Row): Row[] {
  const skuIn = (where?.sku as { in?: unknown[] } | undefined)?.in
  if (Array.isArray(skuIn)) {
    state.productReads.push('findMany:sku')
    return state.products.filter((row) => skuIn.includes(row.sku)).map((row) => withChildCount(row, include))
  }
  // THE QUERY r5 REMOVED, STILL ANSWERED. Production asks the child question as a relation count
  // on the lookups above; this branch exists so that reverting to r4's separate
  // `SELECT parentId FROM products WHERE parentId IN (...)` still WORKS here and fails on the
  // statement COUNT instead of on an unmodelled shape. A cost assertion whose revert-failure came
  // from the double refusing to answer would be proving something else.
  const parentIn = (where?.parentId as { in?: unknown[] } | undefined)?.in
  if (Array.isArray(parentIn)) {
    state.productReads.push('findMany:children')
    return state.products
      .filter((row) => row.parentId != null && parentIn.includes(row.parentId))
      .map((row) => ({ ...row }))
  }
  const idIn = (where?.id as { in?: unknown[] } | undefined)?.in
  if (Array.isArray(idIn)) {
    state.productReads.push('findMany:blocker-set')
    const candidates = idIn.map(String)
    for (const productId of candidates) state.blockerQueries.push(productId)
    recordCommitPhaseStatement(candidates)
    for (const productId of candidates) beforeBlockerQuery?.(productId)
    return state.products
      .filter((row) => candidates.includes(String(row.id)) && !transformBlockerWhereRejects(where!, String(row.id)))
      .map((row) => ({ id: row.id }))
  }
  if (where === undefined) return state.products.map((row) => ({ ...row }))
  throw new Error(`product.findMany double got an unmodelled where: ${JSON.stringify(where)}`)
}

const productDelegate = {
  // The bulk sync calls findFirst with no `where` at all, to ask "is the catalogue empty?".
  // Answering that with null while rows exist would be a lie the suite might later lean on.
  findFirst: async ({ where, include }: { where?: { sku?: unknown }; include?: Row } = {}) => {
    if (where === undefined) return state.products[0] ?? null
    state.productReads.push('findFirst:sku')
    const row = findProductBySku(where?.sku)
    return row === null ? null : withChildCount(row, include)
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    state.productReads.push('findUnique:id')
    return state.products.find((row) => row.id === where.id) ?? null
  },
  /**
   * THE CHILD-EXISTENCE STATEMENT (o3d-y89x r6, Codex finding 1):
   * `SELECT parentId FROM products WHERE parentId IN (candidates) GROUP BY parentId`.
   *
   * Grouped here too, rather than returning one row per child, because "at most one row per
   * candidate" is half of what makes it bounded — a double that returned raw child rows would
   * answer both shapes identically and could not fail if production stopped grouping. It refuses
   * any other `by`/`where`: an unscoped child question is the r5 regression, so the double must
   * not be able to answer one.
   */
  groupBy: async ({ by, where }: { by?: unknown; where?: Row } = {}) => {
    const parentIn = (where?.parentId as { in?: unknown[] } | undefined)?.in
    const grouping = Array.isArray(by) ? by.map(String) : []
    if (!Array.isArray(parentIn) || grouping.length !== 1 || grouping[0] !== 'parentId'
      || Object.keys(where ?? {}).length !== 1) {
      throw new Error(`product.groupBy double got an unmodelled query: ${JSON.stringify({ by, where })}`)
    }
    const candidates = parentIn.map(String)
    state.productReads.push('groupBy:children')
    state.childQueryIds.push(candidates)
    return [...new Set(
      state.products
        .filter((row) => row.parentId != null && candidates.includes(String(row.parentId)))
        .map((row) => String(row.parentId)),
    )].map((parentId) => ({ parentId }))
  },
  updateMany: async ({ where, data }: { where: Row; data: Row }) => updateManyMatching(where, data),
  findMany: async ({ where, include }: { where?: Row; include?: Row } = {}) => findManyMatching(where, include),
  create: async ({ data }: { data: Row }) => {
    const row = { id: `ims-${nextId++}`, ...data }
    state.products.push(row)
    return row
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) throw new Error(`no product ${where.id}`)
    Object.assign(row, data)
    return row
  },
  upsert: async () => ({}),
}

/**
 * The five blocker queries `getProductTransformBlockers` makes, each honouring its own
 * `where`, each recording that it was asked.
 *
 * They throw on a `where` they do not recognise for the same reason `findManyMatching` does:
 * if the editor's query ever changes shape, the connector must fail loudly here rather than
 * quietly start answering "clean" for every product.
 */
function requireProductId(where: Row | undefined, delegate: string): string {
  const productId = where?.productId
  if (typeof productId !== 'string') {
    throw new Error(`${delegate} double got an unmodelled where: ${JSON.stringify(where)}`)
  }
  state.blockerQueries.push(productId)
  recordCommitPhaseStatement([productId])
  beforeBlockerQuery?.(productId)
  return productId
}

/**
 * The statuses `lib/products/type-transforms.ts` calls OPEN. Duplicated here on purpose: the
 * doubles below demand this EXACT set, so if production ever widens or narrows it the doubles
 * fail loudly instead of silently agreeing with whatever production now asks (o3d-y89x r6,
 * Codex finding 2).
 */
const OPEN_TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT'] as const

function requireOpenTransferFilter(where: Row | undefined, delegate: string): void {
  const statuses = (where?.transfer as { status?: { in?: unknown[] } } | undefined)?.status?.in
  const asked = Array.isArray(statuses) ? [...statuses].map(String).sort().join(',') : null
  if (asked !== [...OPEN_TRANSFER_STATUSES].sort().join(',')) {
    throw new Error(
      `${delegate} double got an unmodelled transfer filter — it models `
      + `transfer.status.in = [${OPEN_TRANSFER_STATUSES.join(', ')}] and got: ${JSON.stringify(where)}`,
    )
  }
}

function isOpenTransferLine(row: { status: string }): boolean {
  return (OPEN_TRANSFER_STATUSES as readonly string[]).includes(row.status)
}

const blockerDelegates = {
  stockLevel: {
    aggregate: async ({ where }: { where?: Row } = {}) => {
      const productId = requireProductId(where, 'stockLevel.aggregate')
      const rows = state.stockLevels.filter((row) => row.productId === productId)
      return {
        _sum: {
          quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
          reservedQty: rows.reduce((sum, row) => sum + row.reservedQty, 0),
        },
      }
    },
  },
  salesOrderLine: {
    count: async ({ where }: { where?: Row } = {}) => {
      const productId = requireProductId(where, 'salesOrderLine.count')
      return state.salesOrderLines.filter((row) => row.productId === productId).length
    },
  },
  purchaseOrderLine: {
    count: async ({ where }: { where?: Row } = {}) => {
      const productId = requireProductId(where, 'purchaseOrderLine.count')
      return state.purchaseOrderLines.filter((row) => row.productId === productId).length
    },
  },
  productionOrder: {
    // The only one whose `where` names the product inside an OR (output product, or a product
    // consumed as a component of the output). The double answers the first arm, which is the
    // one every test here exercises, and refuses the shape it cannot answer.
    count: async ({ where }: { where?: Row } = {}) => {
      const or = where?.OR as Array<Row> | undefined
      const outputProductId = or?.[0]?.outputProductId
      if (typeof outputProductId !== 'string') {
        throw new Error(`productionOrder.count double got an unmodelled where: ${JSON.stringify(where)}`)
      }
      state.blockerQueries.push(outputProductId)
      recordCommitPhaseStatement([outputProductId])
      beforeBlockerQuery?.(outputProductId)
      return state.productionOrders.filter((row) => row.outputProductId === outputProductId).length
    },
  },
  stockTransferLine: {
    // Honours the status predicate as well as the product one (o3d-y89x r6, Codex finding 2): a
    // line on a RECEIVED or CANCELLED transfer is not a blocker, and a double that returned it
    // would agree with a production query that had lost its filter.
    count: async ({ where }: { where?: Row } = {}) => {
      const productId = requireProductId(where, 'stockTransferLine.count')
      requireOpenTransferFilter(where, 'stockTransferLine.count')
      return state.stockTransferLines
        .filter((row) => row.productId === productId && isOpenTransferLine(row)).length
    },
    /**
     * The transfer arm of the SET-WISE blocker question (o3d-y89x r5). `findProductsWithTransformBlockers`
     * groups it by product because it is the one arm no predicate on the product row can express
     * — `StockTransferLine` carries no FK to Product — so it cannot ride in the product filter
     * with the other four.
     *
     * Grouped here too, rather than returning one entry per line: the double must be able to
     * fail if production ever stops grouping, and a double that returned raw rows would answer
     * both shapes identically.
     *
     * And it honours `where.transfer.status` (o3d-y89x r6, Codex finding 2). Modelling the ids
     * but not the statuses left the transfer arm of the pre-commit re-assertion untested against
     * the predicate it claims: deleting the open-status filter from production would have left
     * this suite green while every historical RECEIVED transfer became a permanent blocker.
     */
    groupBy: async ({ by, where }: { by?: unknown; where?: Row } = {}) => {
      const ids = (where?.productId as { in?: unknown[] } | undefined)?.in
      const grouping = Array.isArray(by) ? by.map(String) : []
      if (!Array.isArray(ids) || grouping.length !== 1 || grouping[0] !== 'productId') {
        throw new Error(`stockTransferLine.groupBy double got an unmodelled query: ${JSON.stringify({ by, where })}`)
      }
      requireOpenTransferFilter(where, 'stockTransferLine.groupBy')
      const candidates = ids.map(String)
      for (const productId of candidates) state.blockerQueries.push(productId)
      recordCommitPhaseStatement(candidates)
      for (const productId of candidates) beforeBlockerQuery?.(productId)
      return [...new Set(
        state.stockTransferLines
          .filter((row) => candidates.includes(row.productId) && isOpenTransferLine(row))
          .map((row) => row.productId),
      )].map((productId) => ({ productId }))
    },
  },
}

const txClient = {
  ...blockerDelegates,
  product: productDelegate,
  productComponent: {
    findMany: async ({ where }: { where?: { productId?: string } } = {}) =>
      state.components.filter((row) => !where?.productId || row.productId === where.productId),
    deleteMany: async ({ where }: { where?: { productId?: string } } = {}) => {
      state.componentDeletes++
      const before = state.components.length
      const kept = state.components.filter((row) => where?.productId && row.productId !== where.productId)
      state.components.splice(0, state.components.length, ...kept)
      return { count: before - state.components.length }
    },
  },
  productOption: {
    upsert: async ({ create }: { create: Row }) => {
      state.options.push({ ...create })
      return create
    },
  },
  shoppingSyncLog: {
    // `connector` is @default("woocommerce") in the schema and production never sets it, so
    // the double has to apply the default too — otherwise the dedup delete below (which
    // filters on connector) would silently match nothing and the "one open row" and
    // "resolved conflicts disappear" assertions would both pass vacuously.
    create: async ({ data }: { data: Row }) => {
      const row = { connector: 'woocommerce', ...data }
      state.syncLogs.push(row)
      return row
    },
    /**
     * The conflict-row dedup/resolution delete. Modelled properly — every scalar key in
     * `where` must match, and the `OR` is a real disjunction — because a double that deleted
     * everything (or nothing) would make both halves of the claim untestable: "exactly one
     * open row per pairing" and "a clean sync clears it" are both statements about WHICH
     * rows this removes.
     */
    deleteMany: async ({ where }: { where: Row }) => {
      // `recordStructureConflicts` is the transaction's last write and the statement immediately
      // before the pre-commit re-assertion, so everything the transaction asks after this point
      // belongs to that re-assertion (o3d-y89x r5).
      inCommitPhase = true
      beforeConflictsRecorded?.()
      const matches = (row: Row) => {
        for (const [key, value] of Object.entries(where)) {
          if (key === 'OR') {
            const clauses = value as Row[]
            if (!clauses.some((clause) => Object.entries(clause).every(([k, v]) => row[k] === v))) return false
            continue
          }
          if (row[key] !== value) return false
        }
        return true
      }
      const kept = state.syncLogs.filter((row) => !matches(row))
      const removed = state.syncLogs.length - kept.length
      state.syncLogs.splice(0, state.syncLogs.length, ...kept)
      return { count: removed }
    },
  },
  setting: {
    // A REAL key/value store (o3d-xbt). It used to record the key and discard the
    // value, and answer every read with null — which cannot model a setting the
    // sync writes on one run and reads on the next, and would let a conflict list
    // that is never actually persisted look like it worked.
    upsert: async ({ where, create, update }: { where: { key: string }; create?: { key: string; value: string }; update?: { value: string } }) => {
      // A settings write that FAILS. The conflict list is the sweep's only record
      // of what it must come back for, so "what happens when it cannot be
      // written" is a real question with a real answer (o3d-xbt round 2).
      if (settingUpsertError && settingUpsertError.key === where.key) {
        throw new Error(settingUpsertError.message)
      }
      state.settingUpserts.push(where.key)
      const value = (state.settings.has(where.key) ? update?.value : create?.value) ?? ''
      state.settings.set(where.key, value)
      return { key: where.key, value }
    },
    // Still no rows for the credential keys => credentials null and version '0',
    // so the credential-rebind fence (o3d-mlc7) stays a consistent no-op here.
    findMany: async () => [],
    findUnique: async ({ where }: { where: { key: string } }) =>
      state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key)! } : null,
  },
  /**
   * The advisory-lock statements, recorded rather than discarded (o3d-xbt round
   * 3). "The conflict list is read and written under a lock" is a claim about a
   * statement being issued, and a no-op double makes it unfalsifiable — the
   * merge would look identical whether the lock was taken or not.
   */
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('pg_advisory_xact_lock')) {
      state.advisoryLocks.push({ sql, values })
      if (values[0] === WC_PRODUCT_CONFLICT_LIST_LOCK_NAMESPACE) {
        const hook = onConflictListLock
        onConflictListLock = null
        hook?.()
      }
    }
    return 1
  },
}

const dbMock = {
  ...txClient,
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const skus = values[0] as string[]
    return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1 + sku.length }))
  },
  $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => {
    const snap = snapshot()
    // Per TRANSACTION, not per run: the bulk sync opens one of these per product, and a flag
    // left set by the previous product would attribute its successor's pre-checks to the
    // commit phase.
    inCommitPhase = false
    try {
      return await fn(txClient)
    } catch (error) {
      restore(snap)
      throw error
    }
  },
}

mock.module('@/lib/db', { namedExports: { db: dbMock } })

async function loadSync() {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function simpleProduct(overrides: Partial<Row> = {}): WcFullProduct {
  return {
    id: 42,
    sku: 'KIT-SKU',
    name: 'Widget Bundle (from WooCommerce)',
    type: 'simple',
    status: 'publish',
    description: 'Fresh WooCommerce copy',
    short_description: '',
    regular_price: '49.00',
    sale_price: '39.00',
    weight: '1.5',
    dimensions: { length: '10', width: '20', height: '30' },
    images: [{ src: 'https://example.test/img.png' }],
    attributes: [],
    categories: [],
    meta_data: [],
    variations: [],
    ...overrides,
  } as unknown as WcFullProduct
}

function variableProduct(overrides: Partial<Row> = {}): WcFullProduct {
  return simpleProduct({
    id: 77,
    sku: 'PARENT-SKU',
    name: 'Parent Widget',
    type: 'variable',
    regular_price: '',
    sale_price: '',
    attributes: [{ name: 'Colour', options: ['Red', 'Blue'], variation: true, position: 0 }],
    variations: [111, 112],
    ...overrides,
  })
}

function imsRow(row: Row): Row {
  return {
    name: 'IMS name',
    description: null,
    imageUrl: null,
    weight: null,
    depthCm: null,
    widthCm: null,
    heightCm: null,
    barcode: null,
    salesPriceBase: null,
    salePriceBase: null,
    active: true,
    lifecycleStatus: 'ACTIVE',
    hsCode: null,
    countryOfOrigin: null,
    customsDescription: null,
    parentId: null,
    externalProductId: null,
    ...row,
  }
}

function resetState() {
  state.products.length = 0
  state.components.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.warnings.length = 0
  state.updateData.length = 0
  state.componentDeletes = 0
  state.settingUpserts.length = 0
  state.activity.length = 0
  state.advisoryLocks.length = 0
  state.includeFetches.length = 0
  state.settings.clear()
  settingUpsertError = null
  onConflictListLock = null
  state.stockLevels.length = 0
  state.salesOrderLines.length = 0
  state.purchaseOrderLines.length = 0
  state.productionOrders.length = 0
  state.stockTransferLines.length = 0
  state.blockerQueries.length = 0
  state.commitPhaseBlockerStatements = 0
  state.commitPhaseBlockerIds.length = 0
  state.productReads.length = 0
  state.childQueryIds.length = 0
  inCommitPhase = false
  beforeProductWrite = null
  beforeBlockerQuery = null
  beforeConflictsRecorded = null
  nextId = 1
  productPages = {}
  productsById = {}
  productFetchError = null
  productFetchErrorOnInclude = null
  variationPages = {
    '1': [wcVariation(111, 'VAR-1', 'Red'), wcVariation(112, 'VAR-2', 'Blue')],
  }
}

/** Capture console.warn for the duration of `fn`, restoring it whatever happens. */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn
  console.warn = (...args: unknown[]) => { state.warnings.push(args) }
  try {
    return await fn()
  } finally {
    console.warn = original
  }
}

function typePreservationWarnings(): Array<Record<string, unknown>> {
  return state.warnings
    .filter((args) => String(args[0]).includes('kept IMS product type'))
    .map((args) => args[1] as Record<string, unknown>)
}

/**
 * The durable exception-inbox rows: FROM_CONNECTOR / Product / QUARANTINED is exactly the
 * predicate `/sync/exceptions` selects on (PRODUCT_STRUCTURE_CONFLICT_WHERE in
 * app/actions/sync-exceptions.ts). Reading them back through the same filter is what makes
 * these assertions about what an operator SEES rather than about a row shape.
 */
function quarantinedConflicts(): Row[] {
  return state.syncLogs.filter((log) =>
    log.connector === 'woocommerce'
    && log.direction === 'FROM_CONNECTOR'
    && log.entityType === 'Product'
    && log.status === 'QUARANTINED')
}

/** A KIT with two components, unmapped to WooCommerce — the ordinary adoption case. */
function seedKit(type: 'KIT' | 'BOM' = 'KIT') {
  state.products.push(imsRow({ id: 'ims-kit', sku: 'KIT-SKU', name: 'Widget Bundle', type }))
  state.components.push(
    { id: 'pc-1', productId: 'ims-kit', componentId: 'ims-part-a', quantity: 2 },
    { id: 'pc-2', productId: 'ims-kit', componentId: 'ims-part-b', quantity: 1 },
  )
}

// --- double integrity ------------------------------------------------------

test('DOUBLE AUDIT: the fake updateMany really does write `type` when production sends it', async () => {
  // If this fails, every "type preserved" assertion below is vacuous: the double would report
  // the old type no matter what production wrote. Exercised through the same helper the
  // delegate uses, against a live row.
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  const result = updateManyMatching({ id: 'ims-x' }, { type: 'SIMPLE', name: 'overwritten' })

  assert.equal(result.count, 1)
  assert.equal(state.products[0].type, 'SIMPLE', 'a `type` key in `data` MUST land on the row')
  assert.equal(state.products[0].name, 'overwritten')
})

test('DOUBLE AUDIT: an omitted key leaves the existing value untouched', async () => {
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  updateManyMatching({ id: 'ims-x' }, { name: 'only the name' })

  assert.equal(state.products[0].type, 'KIT')
  assert.equal(state.products[0].name, 'only the name')
})

test('DOUBLE AUDIT: findFirst honours its where clause instead of returning a canned row', async () => {
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  assert.equal(await productDelegate.findFirst({ where: { sku: 'X' } }) !== null, true)
  assert.equal(await productDelegate.findFirst({ where: { sku: 'NOT-X' } }), null)
})

test('DOUBLE AUDIT: the child count is per row, and absent unless the query asked for it', async () => {
  // The "does this row have children?" answer is the only thing standing between a WooCommerce
  // variation and an IMS parent row, and since r5 it arrives as a relation count on the lookup
  // rather than as a query of its own. Two ways this double could make the tests below vacuous:
  // counting the whole catalogue instead of this row's children, or attaching a count to a row
  // production never asked for one on — which is exactly the "nobody asked" / "genuinely
  // childless" confusion the rule exists to prevent.
  resetState()
  state.products.push(imsRow({ id: 'p-1', sku: 'P1', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'p-2', sku: 'P2', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'c-1', sku: 'C1', type: 'VARIANT', parentId: 'p-1' }))

  const include = { _count: { select: { variants: true } } }
  assert.deepEqual(
    (await productDelegate.findMany({ where: { sku: { in: ['P1', 'P2'] } }, include }))
      .map((row) => [row.id, (row._count as { variants: number }).variants]),
    [['p-1', 1], ['p-2', 0]],
    'each row counts ITS OWN children',
  )
  assert.equal(
    ((await productDelegate.findFirst({ where: { sku: 'P1' }, include }))?._count as { variants: number }).variants,
    1,
  )
  assert.equal(
    (await productDelegate.findFirst({ where: { sku: 'P1' } }))?._count,
    undefined,
    'and a lookup that did not ask gets no count — production must fail loudly, not read zero',
  )
})

test('DOUBLE AUDIT: the set-wise blocker query filters by BOTH the id list and the blocker arms', async () => {
  // The pre-commit re-assertion is one statement over every transformed row, and it decides
  // "still clean" by which ids come back. A double that ignored the id list would report rows
  // this transaction never touched; one that ignored the relation arms would report every
  // transformed row clean and the whole r4/r5 guard would be untestable.
  resetState()
  state.products.push(imsRow({ id: 'p-1', sku: 'P1', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'p-2', sku: 'P2', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'p-3', sku: 'P3', type: 'SIMPLE' }))
  state.salesOrderLines.push({ productId: 'p-2' })

  const blockerWhere = { salesOrderLines: { none: { order: { status: { in: ['PROCESSING'] } } } } }
  assert.deepEqual(
    (await productDelegate.findMany({ where: { id: { in: ['p-1', 'p-2'] }, ...blockerWhere } }))
      .map((row) => row.id),
    ['p-1'],
    'the blocked row is withheld, and p-3 is not in the id list so it is not considered at all',
  )
  assert.deepEqual(
    (await productDelegate.findMany({ where: { id: { in: ['p-1', 'p-2', 'p-3'] } } })).map((row) => row.id),
    ['p-1', 'p-2', 'p-3'],
    'with no blocker arms, every named row is clean',
  )

  // The transfer arm is the one no product predicate can express, so it is its own statement.
  const openTransfers = { transfer: { status: { in: ['DRAFT', 'IN_TRANSIT'] } } }
  state.stockTransferLines.push({ productId: 'p-3', status: 'IN_TRANSIT' })
  state.stockTransferLines.push({ productId: 'p-3', status: 'IN_TRANSIT' })
  state.stockTransferLines.push({ productId: 'p-1', status: 'RECEIVED' })
  assert.deepEqual(
    await blockerDelegates.stockTransferLine.groupBy({
      by: ['productId'],
      where: { productId: { in: ['p-1', 'p-3'] }, ...openTransfers },
    }),
    [{ productId: 'p-3' }],
    'grouped — one entry per blocked product, not one per line — and p-1\'s RECEIVED line is not a blocker',
  )
  await assert.rejects(
    () => blockerDelegates.stockTransferLine.groupBy({ by: ['productId'], where: {} }),
    /unmodelled query/,
  )
  // o3d-y89x r6, Codex finding 2: the double must also refuse a query that has LOST the status
  // predicate, rather than answering it as though every transfer were open.
  await assert.rejects(
    () => blockerDelegates.stockTransferLine.groupBy({ by: ['productId'], where: { productId: { in: ['p-3'] } } }),
    /unmodelled transfer filter/,
  )
  await assert.rejects(
    () => blockerDelegates.stockTransferLine.groupBy({
      by: ['productId'],
      where: { productId: { in: ['p-3'] }, transfer: { status: { in: ['DRAFT', 'IN_TRANSIT', 'RECEIVED'] } } },
    }),
    /unmodelled transfer filter/,
    'and a WIDENED status set too — the set is the predicate, not a hint',
  )
  await assert.rejects(
    () => blockerDelegates.stockTransferLine.groupBy({ by: ['productId', 'transferId'], where: { productId: { in: ['p-3'] }, ...openTransfers } }),
    /unmodelled query/,
    'and the grouping key must be exactly [productId]',
  )
})

test('DOUBLE AUDIT: shoppingSyncLog.deleteMany removes the matching rows and only those', async () => {
  // "One open conflict per pairing" and "a clean sync clears it" are both claims about WHICH
  // rows this delete removes. A double that deleted everything, or nothing, would prove
  // neither — and would make both of those tests pass regardless of production.
  resetState()
  const log = txClient.shoppingSyncLog
  await log.create({ data: { entityType: 'Product', status: 'QUARANTINED', entityId: 'a', externalId: '1' } })
  await log.create({ data: { entityType: 'Product', status: 'QUARANTINED', entityId: 'b', externalId: '2' } })
  await log.create({ data: { entityType: 'Product', status: 'SYNCED', entityId: 'a', externalId: '1' } })
  await log.create({ data: { entityType: 'SalesOrder', status: 'QUARANTINED', entityId: 'a', externalId: '1' } })

  const { count } = await log.deleteMany({
    where: {
      connector: 'woocommerce',
      entityType: 'Product',
      status: 'QUARANTINED',
      OR: [{ entityId: 'a' }, { externalId: '9' }],
    },
  })

  assert.equal(count, 1, 'exactly the one row that matches every clause')
  assert.deepEqual(
    state.syncLogs.map((row) => `${row.entityType}/${row.status}/${row.entityId}`),
    ['Product/QUARANTINED/b', 'Product/SYNCED/a', 'SalesOrder/QUARANTINED/a'],
    'a different entity, a different status and a different entityType all survive',
  )

  // The OR is a real disjunction: matching on the OTHER side of the pairing works too.
  const byExternal = await log.deleteMany({
    where: {
      connector: 'woocommerce',
      entityType: 'Product',
      status: 'QUARANTINED',
      OR: [{ entityId: 'zzz' }, { externalId: '2' }],
    },
  })
  assert.equal(byExternal.count, 1)
})

test('DOUBLE AUDIT: the blocker doubles answer per product, not with a constant', async () => {
  // Every live-row test below rests on these five. A double that ignored `where.productId`
  // would report the same answer for every product, so "this row is blocked" and "that row is
  // clean" would both pass without production ever having asked about the right row.
  resetState()
  state.stockLevels.push({ productId: 'live', quantity: 5, reservedQty: 2 })
  state.salesOrderLines.push({ productId: 'live' })
  state.purchaseOrderLines.push({ productId: 'live' })
  state.productionOrders.push({ outputProductId: 'live' })
  state.stockTransferLines.push({ productId: 'live', status: 'IN_TRANSIT' })

  const live = await blockerDelegates.stockLevel.aggregate({ where: { productId: 'live' } })
  assert.equal(live._sum.quantity, 5)
  assert.equal(live._sum.reservedQty, 2)
  const clean = await blockerDelegates.stockLevel.aggregate({ where: { productId: 'clean' } })
  assert.equal(clean._sum.quantity, 0, 'a different product is not blocked by this one')

  assert.equal(await blockerDelegates.salesOrderLine.count({ where: { productId: 'live' } }), 1)
  assert.equal(await blockerDelegates.salesOrderLine.count({ where: { productId: 'clean' } }), 0)
  assert.equal(await blockerDelegates.purchaseOrderLine.count({ where: { productId: 'live' } }), 1)
  assert.equal(await blockerDelegates.purchaseOrderLine.count({ where: { productId: 'clean' } }), 0)
  const openTransfers = { transfer: { status: { in: ['DRAFT', 'IN_TRANSIT'] } } }
  assert.equal(await blockerDelegates.stockTransferLine.count({ where: { productId: 'live', ...openTransfers } }), 1)
  assert.equal(await blockerDelegates.stockTransferLine.count({ where: { productId: 'clean', ...openTransfers } }), 0)
  // ...and the status predicate is honoured, not just accepted (o3d-y89x r6, Codex finding 2).
  state.stockTransferLines.push({ productId: 'closed', status: 'RECEIVED' })
  assert.equal(
    await blockerDelegates.stockTransferLine.count({ where: { productId: 'closed', ...openTransfers } }),
    0,
    'a RECEIVED transfer line is not an open one',
  )
  assert.equal(
    await blockerDelegates.productionOrder.count({ where: { OR: [{ outputProductId: 'live' }, {}] } }),
    1,
  )
  assert.equal(
    await blockerDelegates.productionOrder.count({ where: { OR: [{ outputProductId: 'clean' }, {}] } }),
    0,
  )

  // And an unrecognised `where` is a loud failure, not a silent "clean".
  await assert.rejects(() => blockerDelegates.salesOrderLine.count({ where: {} }), /unmodelled where/)
  await assert.rejects(() => blockerDelegates.productionOrder.count({ where: {} }), /unmodelled where/)
  await assert.rejects(
    () => blockerDelegates.stockTransferLine.count({ where: { productId: 'live' } }),
    /unmodelled transfer filter/,
    'a transfer query that lost its status predicate is refused, not answered',
  )
})

test('DOUBLE AUDIT: the blocker doubles give DIFFERENT answers to two reads across a change', async () => {
  // Codex r4 finding 3 is about a blocker that is there for the WRITE and gone by the read that
  // diagnoses it. A double that answers from a fixed map, or that caches its first answer, could
  // not express that at all: both reads would agree and the test would pass against a
  // misclassifying production. So pin the capability itself — the same query, twice, with the
  // state moved in between, exactly as `stock 0 -> 5 -> 0` moves it in Postgres.
  const { getProductTransformBlockers } = await import('../lib/products/type-transforms.ts')
  resetState()

  state.stockLevels.push({ productId: 'ims-x', quantity: 5, reservedQty: 0 })
  const withBlocker = await getProductTransformBlockers('ims-x', txClient as never)
  assert.equal(withBlocker.stockQty, 5, 'the first read sees it')

  // The hook the disappearing-blocker test uses, exercised here so its wiring is not first
  // proven by the test that depends on it.
  beforeBlockerQuery = () => { state.stockLevels.length = 0 }
  const afterItCleared = await getProductTransformBlockers('ims-x', txClient as never)
  beforeBlockerQuery = null

  assert.equal(afterItCleared.stockQty, 0, 'and the second read sees it GONE')
  assert.equal(afterItCleared.openSalesOrderLines, 0)
})

test('DOUBLE AUDIT: the post-write hook fires inside the transaction, before the pre-commit re-read', async () => {
  // The finding-2 test claims to open a window "after every product write, before the commit".
  // If the hook never fired, or fired after the transaction closed, that test would pass because
  // nothing ever blocked — the absence of an assertion dressed as one.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))

  const seenAt: string[] = []
  beforeConflictsRecorded = () => {
    seenAt.push(`type=${findProductBySku('PARENT-SKU')?.type}`)
    seenAt.push(`children=${state.products.filter((row) => row.parentId === 'ims-simple').length}`)
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `expected success, got: ${result.error}`)
  assert.deepEqual(
    seenAt,
    ['type=VARIABLE', 'children=2'],
    'the hook runs after the parent transform AND after the variations are written',
  )
})

test('DOUBLE AUDIT: shoppingSyncLog.create applies the schema default for `connector`', async () => {
  // Production never sets `connector` (it is @default("woocommerce")). If the double stored
  // the row without it, every delete above — and the exception-inbox filter these tests read
  // back through — would match nothing, silently.
  resetState()
  await txClient.shoppingSyncLog.create({ data: { entityType: 'Product', status: 'SYNCED' } })
  assert.equal(state.syncLogs[0].connector, 'woocommerce')
})

// --- the policy, directly ---------------------------------------------------
//
// The sync-level tests below prove the policy is WIRED IN. These prove the policy itself,
// per type, so a decision can never be changed by accident without a test naming the type
// that changed. Imported after the `@/lib/db` mock above because the policy module reaches
// type-transforms, which imports the client.

function loadPolicy() {
  return import('@/lib/connectors/woocommerce/sync/product-structure-policy')
}

test('POLICY: SIMPLE is the only existing type a connector may transform out of', async () => {
  const policy = await loadPolicy()
  const protectedTypes = ['VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'] as const
  for (const type of protectedTypes) {
    assert.equal(policy.isConnectorProtectedProductType(type), true, `${type} must be protected`)
  }
  assert.equal(policy.isConnectorProtectedProductType('SIMPLE'), false, 'SIMPLE owns no structure')
})

test('POLICY: a suppressed write means a CHANGED write, so a steady-state re-sync is silent', async () => {
  const policy = await loadPolicy()
  assert.equal(policy.isConnectorTypeWriteSuppressed('KIT', 'SIMPLE'), true)
  assert.equal(policy.isConnectorTypeWriteSuppressed('VARIABLE', 'VARIABLE'), false, 'same type, nothing suppressed')
  assert.equal(policy.isConnectorTypeWriteSuppressed('VARIANT', 'VARIANT'), false)
  assert.equal(policy.isConnectorTypeWriteSuppressed('SIMPLE', 'VARIABLE'), false, 'SIMPLE is writable')
})

test('POLICY: the effective type is what the row ends up with, not what WooCommerce asked for', async () => {
  const policy = await loadPolicy()
  assert.equal(policy.effectiveImsProductType('KIT', 'VARIABLE'), 'KIT')
  assert.equal(policy.effectiveImsProductType('VARIANT', 'SIMPLE'), 'VARIANT')
  assert.equal(policy.effectiveImsProductType('NON_INVENTORY', 'SIMPLE'), 'NON_INVENTORY')
  assert.equal(policy.effectiveImsProductType('SIMPLE', 'VARIABLE'), 'VARIABLE')
  assert.equal(policy.effectiveImsProductType('SIMPLE', 'VARIANT'), 'VARIANT')
  // A protected type asked for the type it already has is not a suppression, so the
  // effective type is the same either way — this is the case the warning must stay quiet for.
  assert.equal(policy.effectiveImsProductType('VARIABLE', 'VARIABLE'), 'VARIABLE')
})

test('POLICY: refuseVariationAdoption, per type and per relationship', async () => {
  const policy = await loadPolicy()
  const adopt = (row: Record<string, unknown>, rowHasChildren = false) =>
    policy.refuseVariationAdoption({
      row: { id: 'r', sku: 'S', type: 'SIMPLE', parentId: null, ...row } as never,
      imsParentId: 'ims-parent',
      rowHasChildren,
    })

  // Adoptable: nothing IMS owns is lost.
  assert.equal(adopt({ type: 'SIMPLE' }), null, 'an unparented SIMPLE row — the initial-import path')
  assert.equal(adopt({ type: 'VARIANT', parentId: 'ims-parent' }), null, 'the ordinary re-sync')
  assert.equal(adopt({ type: 'KIT' }), null, 'a bundle variant is a first-class IMS shape')
  assert.equal(adopt({ type: 'BOM', parentId: 'ims-parent' }), null)

  // Refused, one reason each.
  assert.equal(adopt({ type: 'VARIANT', parentId: 'ims-other' })?.reason, 'different_ims_parent')
  assert.equal(adopt({ type: 'KIT', parentId: 'ims-other' })?.reason, 'different_ims_parent',
    'protection from a type write is not permission to reparent')
  assert.equal(adopt({ type: 'SIMPLE' }, true)?.reason, 'row_is_a_parent',
    'a row with children is a parent whatever its type says')
  assert.equal(adopt({ type: 'VARIABLE' })?.reason, 'type_cannot_be_a_variation')
  assert.equal(adopt({ type: 'NON_INVENTORY' })?.reason, 'type_cannot_be_a_variation')

  // Precedence: the parent check answers first, because it is the more specific fact.
  assert.equal(adopt({ type: 'VARIABLE', parentId: 'ims-other' })?.reason, 'different_ims_parent')
})

test('POLICY: decideConnectorParentWrite gates type, pricing, options and children TOGETHER (o3d-y89x r2)', async () => {
  const policy = await loadPolicy()
  const decide = (row: Record<string, unknown> | null, incoming: string, summary?: string) =>
    policy.decideConnectorParentWrite({
      row: row === null ? null : ({ id: 'r', sku: 'S', parentId: null, ...row } as never),
      incoming: incoming as never,
      rowHasChildren: false,
      transformBlockerSummary: summary ?? null,
    })

  // r1 answered ONE question ("may I write `type`?") and the surrounding code kept answering
  // the others from `wcProduct.type`. Each row below is the full set of answers for one shape.
  const kitAsParent = decide({ type: 'KIT' }, 'VARIABLE')
  assert.equal(kitAsParent.effectiveType, 'KIT')
  assert.equal(kitAsParent.suppressTypeWrite, true)
  assert.equal(kitAsParent.canBeVariableParent, false, 'no children, no variable-only options')
  assert.equal(kitAsParent.wooShapeAgrees, false, 'and its IMS pricing is not erased')
  assert.equal(kitAsParent.parentRoleRefusal?.reason, 'type_cannot_be_a_variable_parent')

  // The counterweight: a KIT paired with a WooCommerce SIMPLE product is the ORDINARY bundle
  // pairing. The type write is still suppressed, but the shapes agree about pricing — both
  // say "not a variable parent" — so WooCommerce's price must still land.
  const kitAsSimple = decide({ type: 'KIT' }, 'SIMPLE')
  assert.equal(kitAsSimple.suppressTypeWrite, true)
  assert.equal(kitAsSimple.wooShapeAgrees, true, 'a bundle must keep receiving price updates')

  // A VARIABLE parent paired with a WooCommerce simple product is the same disagreement in the
  // other direction: stamping a standalone product's price onto a parent that shows min-max
  // from its variants is the same mistake as erasing the kit's.
  const variableAsSimple = decide({ type: 'VARIABLE' }, 'SIMPLE')
  assert.equal(variableAsSimple.effectiveType, 'VARIABLE')
  assert.equal(variableAsSimple.wooShapeAgrees, false)

  // Agreement, both directions.
  const steadyParent = decide({ type: 'VARIABLE' }, 'VARIABLE')
  assert.equal(steadyParent.suppressTypeWrite, false)
  assert.equal(steadyParent.canBeVariableParent, true)
  assert.equal(steadyParent.wooShapeAgrees, true, 'a real parent clears its own prices')
  assert.equal(steadyParent.needsTransformBlockerCheck, false, 'nothing is changing — ask nothing')

  const simpleAsSimple = decide({ type: 'SIMPLE' }, 'SIMPLE')
  assert.equal(simpleAsSimple.wooShapeAgrees, true)
  assert.equal(simpleAsSimple.needsTransformBlockerCheck, false)

  // The create branch is deliberately unguarded.
  const created = decide(null, 'VARIABLE')
  assert.equal(created.suppressTypeWrite, false)
  assert.equal(created.canBeVariableParent, true)
  assert.equal(created.needsTransformBlockerCheck, false, 'a new row has nothing live pointing at it')
})

test('POLICY: a live row is not transformed, and the question is only asked when it matters (o3d-y89x r2)', async () => {
  const policy = await loadPolicy()
  const decide = (row: Record<string, unknown>, incoming: string, summary?: string) =>
    policy.decideConnectorParentWrite({
      row: { id: 'r', sku: 'S', parentId: null, ...row } as never,
      incoming: incoming as never,
      rowHasChildren: false,
      transformBlockerSummary: summary ?? null,
    })

  // SIMPLE -> VARIABLE is the one transform the allow-list permits, so it is the one that owes
  // the editor's live-row question.
  const pending = decide({ type: 'SIMPLE' }, 'VARIABLE')
  assert.equal(pending.needsTransformBlockerCheck, true)
  assert.equal(pending.canBeVariableParent, true, 'clean, so the takeover path still works')

  const blocked = decide({ type: 'SIMPLE' }, 'VARIABLE', 'stock on hand (5.00)')
  assert.equal(blocked.suppressTypeWrite, true, 'the row stays SIMPLE')
  assert.equal(blocked.effectiveType, 'SIMPLE')
  assert.equal(blocked.canBeVariableParent, false)
  assert.equal(blocked.wooShapeAgrees, false)
  assert.equal(blocked.parentRoleRefusal?.reason, 'transform_blocked')
  assert.match(String(blocked.parentRoleRefusal?.detail), /stock on hand \(5\.00\)/)

  // A protected row never gets there: the allow-list has already refused, so no query is owed.
  assert.equal(decide({ type: 'KIT' }, 'VARIABLE').needsTransformBlockerCheck, false)
  assert.equal(decide({ type: 'VARIABLE' }, 'VARIABLE').needsTransformBlockerCheck, false)
})

test("POLICY: a row that is somebody's CHILD may not become a parent, type change or not (o3d-y89x r2)", async () => {
  const policy = await loadPolicy()
  const decide = (row: Record<string, unknown>, incoming: string) =>
    policy.decideConnectorParentWrite({
      row: { id: 'r', sku: 'S', ...row } as never,
      incoming: incoming as never,
      rowHasChildren: false,
    })

  // THIS is the escape hatch r1 left open. `existing !== incoming` was added so a steady-state
  // re-sync would not warn, and it silently turned off the whole guard for a row whose type is
  // unchanged — including a VARIABLE row that already (invalidly) carries a parentId, the exact
  // shape the pre-fix parent branch could mint. Adopting children into it does not merely
  // preserve the broken chain, it deepens it.
  const invalidChain = decide({ type: 'VARIABLE', parentId: 'ims-other' }, 'VARIABLE')
  assert.equal(invalidChain.canBeVariableParent, false, 'the guard must not be skipped by a no-op type')
  assert.equal(invalidChain.parentRoleRefusal?.reason, 'row_is_a_child')
  assert.equal(invalidChain.wooShapeAgrees, false)
  assert.equal(invalidChain.needsTransformBlockerCheck, false, 'and it costs no query to say so')

  // The same fact refuses the changing case too, and outranks the allow-list's reason because
  // it is the more specific statement about this row.
  assert.equal(decide({ type: 'SIMPLE', parentId: 'ims-other' }, 'VARIABLE').suppressTypeWrite, true)
  assert.equal(
    decide({ type: 'SIMPLE', parentId: 'ims-other' }, 'VARIABLE').parentRoleRefusal?.reason,
    'row_is_a_child',
  )
  assert.equal(decide({ type: 'VARIANT', parentId: 'ims-other' }, 'VARIABLE').parentRoleRefusal?.reason, 'row_is_a_child')

  // ...but a genuine steady state stays quiet, which is what `existing !== incoming` was for.
  const steady = decide({ type: 'VARIABLE', parentId: null }, 'VARIABLE')
  assert.equal(steady.canBeVariableParent, true)
  assert.equal(steady.suppressTypeWrite, false)
  assert.equal(steady.parentRoleRefusal, null)
})

test('POLICY: a row that HAS children is a parent whatever its type says (o3d-y89x r4)', async () => {
  const policy = await loadPolicy()
  const decide = (type: string, incoming: string, rowHasChildren: boolean) =>
    policy.decideConnectorParentWrite({
      row: { id: 'r', sku: 'S', type, parentId: null } as never,
      incoming: incoming as never,
      rowHasChildren,
    })

  // THE HOLE (Codex r4 finding 1). The simple arm of the shape rule asked only `effectiveType
  // !== 'VARIABLE'`. Nothing in the schema stops a non-VARIABLE row having children — and the
  // pre-o3d-y89x connector minted exactly that, by flattening a VARIABLE row to SIMPLE and
  // leaving its variants pointing at it. Such a row AGREED with a WooCommerce `simple` product:
  // its price was applied, its children stayed attached and the sync was recorded clean.
  //
  // Enumerated over every IMS type, because "which types can be a parent by type" is precisely
  // the question that was being asked instead of "does this row have children".
  for (const type of ['SIMPLE', 'KIT', 'BOM', 'VARIANT', 'NON_INVENTORY'] as const) {
    const asSimple = decide(type, 'SIMPLE', true)
    assert.equal(asSimple.wooShapeAgrees, false, `${type}-with-children is not a standalone product`)
    assert.equal(asSimple.parentRoleRefusal?.reason, 'row_is_an_invalid_parent', `${type} names the real reason`)

    // The mirror: nor may it be PROMOTED into the parent WooCommerce says it is. That would
    // adopt child rows this payload never mentioned into a WooCommerce-owned parent — and for
    // SIMPLE the allow-list would otherwise have permitted the type write outright.
    const asVariable = decide(type, 'VARIABLE', true)
    assert.equal(asVariable.canBeVariableParent, false, `${type}-with-children may not be promoted`)
    assert.equal(asVariable.effectiveType, type, `${type} keeps its type`)
    assert.equal(asVariable.suppressTypeWrite, true, `${type} has its type write suppressed`)
    assert.equal(asVariable.wooShapeAgrees, false)
    assert.equal(asVariable.needsTransformBlockerCheck, false, 'and it costs no live-row query to say so')
  }

  // A VARIABLE row WITH children is the one shape where children are legitimate: it is a real
  // parent, so it agrees with `variable` and disagrees with `simple` for the ORIGINAL reason.
  const realParent = decide('VARIABLE', 'VARIABLE', true)
  assert.equal(realParent.canBeVariableParent, true, 'a VARIABLE parent with variants is just a parent')
  assert.equal(realParent.wooShapeAgrees, true)
  assert.equal(decide('VARIABLE', 'SIMPLE', true).parentRoleRefusal, null, 'not an invalid-parent refusal')
  assert.equal(decide('VARIABLE', 'SIMPLE', true).wooShapeAgrees, false, 'still a disagreement, by type')

  // And the negative that keeps all of the above from being satisfied by "refuse everything":
  // the SAME types WITHOUT children behave exactly as they did before.
  assert.equal(decide('SIMPLE', 'SIMPLE', false).wooShapeAgrees, true)
  assert.equal(decide('KIT', 'SIMPLE', false).wooShapeAgrees, true, 'the ordinary bundle pairing stays quiet')
  assert.equal(decide('SIMPLE', 'VARIABLE', false).canBeVariableParent, true, 'the takeover path still works')
  assert.equal(decide('SIMPLE', 'VARIABLE', false).needsTransformBlockerCheck, true)
})

test('POLICY: connectorVariationAdoptionChangesStructure is true only for a real transform (o3d-y89x r2)', async () => {
  const policy = await loadPolicy()
  const changes = (row: Record<string, unknown>) =>
    policy.connectorVariationAdoptionChangesStructure({
      row: { type: 'SIMPLE', parentId: null, ...row } as never,
      imsParentId: 'ims-parent',
    })

  // The editor gates on `typeChanged || parentChanged`, so this must too — no more, no less.
  assert.equal(changes({ type: 'SIMPLE', parentId: null }), true, 'type AND parent both change')
  assert.equal(changes({ type: 'KIT', parentId: null }), true, 'type preserved, but the reparent is still a change')
  assert.equal(changes({ type: 'VARIANT', parentId: 'ims-parent' }), false, 'the steady state changes nothing')
  assert.equal(changes({ type: 'KIT', parentId: 'ims-parent' }), false, 'a bundle variant already in place')
})

// --- the rule --------------------------------------------------------------

test('a KIT whose WooCommerce twin is `simple` keeps its type (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'KIT', 'the connector must not downgrade a KIT to SIMPLE')
  assert.ok(
    !('type' in (state.updateData[0] ?? {})),
    '`type` must be omitted from the UPDATE entirely, not written back',
  )
})

test('a BOM whose WooCommerce twin is `simple` keeps its type (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('BOM')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'BOM', 'BOM is protected exactly as KIT is')
})

test('the preserved KIT keeps its ProductComponent rows, and the rest of the sync still applies (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('KIT-SKU')

  // The bug's second half: type=SIMPLE with the components left behind. Preserving the type is
  // what keeps the pair coherent — a KIT that still has components.
  assert.equal(row?.type, 'KIT')
  assert.equal(state.components.length, 2, 'the component rows survive')
  assert.equal(state.componentDeletes, 0, 'and the connector never tries to delete them')

  // "Do not fail the sync" — everything WooCommerce genuinely owns still lands.
  assert.equal(row?.name, 'Widget Bundle (from WooCommerce)', 'name synced')
  assert.equal(row?.description, 'Fresh WooCommerce copy', 'description synced')
  assert.equal(Number(row?.salesPriceBase), 49, 'regular price synced')
  assert.equal(Number(row?.salePriceBase), 39, 'sale price synced')
  assert.equal(Number(row?.weight), 1.5, 'weight synced')
  assert.equal(Number(row?.depthCm), 10, 'dimensions synced')
  assert.equal(row?.imageUrl, 'https://example.test/img.png', 'image synced')
  assert.equal(row?.externalProductId, BigInt(42), 'the WooCommerce mapping is still taken')
  assert.ok(
    state.syncLogs.some((log) => log.status === 'SYNCED'),
    'the import is recorded as SYNCED, not refused',
  )
})

test('the suppressed type change is logged at WARNING with enough detail to find the pair (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1, 'exactly one warning per product per sync — not zero, not per-field')
  const detail = warnings[0]
  assert.equal(detail.sku, 'KIT-SKU', 'names the SKU')
  assert.equal(detail.imsType, 'KIT', 'names the IMS type that was kept')
  assert.equal(detail.wcType, 'simple', 'names the incoming WooCommerce type')
  assert.equal(detail.suppressedType, 'SIMPLE', 'names the write that was refused')
  assert.equal(detail.imsProductId, 'ims-kit', 'names the IMS row')
  assert.equal(detail.wcProductId, '42', 'names the WooCommerce object')
})

test('a genuine SIMPLE -> VARIABLE change still syncs, silently (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // No composition to protect: SIMPLE is not IMS-owned structure, so WooCommerce still decides.
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'the guard must not freeze ordinary types')
  assert.deepEqual(typePreservationWarnings(), [], 'nothing was suppressed, so nothing is warned about')
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT', 'variations are still applied')
})

test('a VARIABLE parent is NOT flattened to SIMPLE by a WooCommerce simple product (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // This test previously asserted the OPPOSITE, and that was the bug: VARIABLE->SIMPLE left
  // the row's children pointing at a parent that is no longer variable, and its ProductOption
  // rows behind. validateProductStructureChange refuses this transformation outright in the
  // editor ("Variable parents cannot be converted through the standard editor"); a connector
  // that has been told strictly less than the editor may not do more.
  state.products.push(imsRow({ id: 'ims-var', sku: 'KIT-SKU', name: 'Was variable', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-child', sku: 'CHILD-1', name: 'Its child', type: 'VARIANT', parentId: 'ims-var' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  // r3 (Codex finding 1) CHANGED THIS ASSERTION, and the reason is the point. This used to
  // expect `success: true` on the grounds that "a simple product carries no variations, so
  // nothing went unapplied". That reasoning looked only at the payload's CHILDREN, and two other
  // pieces of WooCommerce data went unapplied right here: the type (refused, correctly) and the
  // price (withheld, correctly, three assertions below). Meanwhile the IMS variants stayed put.
  // Recording that state as a clean sync advanced the bulk cursor past a product the two systems
  // still disagree about, and no repeat of the payload could ever repair it.
  assert.equal(result.success, false, 'an unapplied shape is not a successful sync')
  assert.equal(result.permanent, true, 'and it is deterministic — retrying the payload reaches it again')
  assert.equal(findProductBySku('KIT-SKU')?.type, 'VARIABLE', 'the connector must not flatten a parent')
  assert.ok(
    !('type' in (state.updateData[0] ?? {})),
    '`type` must be omitted from the UPDATE entirely, not written back',
  )
  // The other half of the same refusal (o3d-y89x r2): the row stays a VARIABLE parent, whose
  // own price columns show min-max from its variants. Stamping a WooCommerce SIMPLE product's
  // 49/39 onto them is the same mistake as erasing a kit's price because WooCommerce called
  // the pairing variable — a shape belief that has already been refused, applied anyway.
  assert.ok(
    !('salesPriceBase' in (state.updateData[0] ?? {})),
    'a refused shape must not decide the price columns either',
  )
  assert.ok(!('salePriceBase' in (state.updateData[0] ?? {})))
  assert.equal(findProductBySku('CHILD-1')?.parentId, 'ims-var', 'its child still points at a VARIABLE parent')
  assert.equal(findProductBySku('KIT-SKU')?.name, 'Widget Bundle (from WooCommerce)', 'leaf fields still sync')

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1, 'the operator is told')
  assert.equal(warnings[0].imsType, 'VARIABLE')
  assert.equal(warnings[0].suppressedType, 'SIMPLE')

  // WooCommerce data DID go unapplied, so the operator gets an inbox row rather than a warning
  // nobody reads — the same QUARANTINED mechanism the refused-variations direction uses.
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1, 'the disagreement is recorded where the operator looks')
  assert.match(String(conflicts[0].errorMessage), /is simple, but IMS product ims-var is VARIABLE/)
  assert.match(String(conflicts[0].errorMessage), /IMS variants remain/)
  assert.match(
    String(conflicts[0].errorMessage),
    /convert the IMS product in the product editor .*, or make the WooCommerce product variable again/,
    'and is given the two things that actually clear it',
  )
  assert.ok(
    !state.syncLogs.some((log) => log.status === 'SYNCED'),
    'and it is NOT also recorded as a successful sync',
  )
})

test('o3d-y89x r3: the SAME rule leaves an IMS KIT paired with a WooCommerce simple product silent', async () => {
  // THE BOUNDARY OF THE FIX ABOVE, and the case that decides whether the rule was re-derived or
  // just widened. A KIT next to a WooCommerce `simple` product is the NORMAL bundle pairing:
  // neither side claims to be a variable parent, so nothing WooCommerce said went unapplied —
  // `simple` is an absence of information about composition, never a denial of it. If this ever
  // starts quarantining, every bundle in the catalogue lands in the exception inbox on every
  // reconcile run and the real conflicts are buried under them.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'KIT-SKU', name: 'A bundle', type: 'KIT' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `a bundle pairing is steady state, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'KIT')
  assert.deepEqual(quarantinedConflicts(), [], 'no inbox row for the ordinary pairing')
  assert.ok(state.syncLogs.some((log) => log.status === 'SYNCED'))
  // And the `if` arm really did run: a bundle must keep receiving WooCommerce price updates.
  assert.ok('salesPriceBase' in (state.updateData[0] ?? {}), 'the price still applies to a bundle')
})

test('a VARIANT is NOT flattened to SIMPLE, so it can never end up SIMPLE-with-a-parentId (o3d-8s89)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The parent branch writes `type` but never writes or clears `parentId`. Writing SIMPLE
  // over a VARIANT therefore minted a SIMPLE row that still carried a parentId — a shape
  // validateProductStructureChange refuses to save, so the connector could produce a row the
  // product editor will not let an operator fix. Preserving the type keeps the two columns
  // consistent without the connector deciding a detach it was never told about.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'OTHER-PARENT', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-variant', sku: 'KIT-SKU', name: 'A variant', type: 'VARIANT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('KIT-SKU')
  assert.equal(row?.type, 'VARIANT', 'the connector must not detach a variant it knows nothing about')
  assert.equal(row?.parentId, 'ims-parent', 'and the parentId it never writes stays coherent with the type')
  assert.equal(row?.name, 'Widget Bundle (from WooCommerce)', 'leaf fields still sync')
  assert.equal(typePreservationWarnings().length, 1)
})

test('a NON_INVENTORY product does not silently acquire inventory semantics (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // NON_INVENTORY means "not stock-tracked" — a service, a fee, a shipping line. WooCommerce's
  // `simple` says nothing at all about whether IMS tracks stock for it, and the editor refuses
  // this conversion outright.
  state.products.push(imsRow({ id: 'ims-service', sku: 'KIT-SKU', name: 'Assembly service', type: 'NON_INVENTORY' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'NON_INVENTORY')
  assert.equal(typePreservationWarnings().length, 1)
})

test('re-syncing a protected row whose type ALREADY matches warns about nothing (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Every steady-state re-sync of every variable parent and every variant hits this path. If
  // "protected" alone triggered the warning, the operator-facing signal would fire on every
  // product on every run and the real conflicts would be invisible inside it.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-v1', sku: 'VAR-1', name: 'Red', type: 'VARIANT', parentId: 'ims-parent' }))
  state.products.push(imsRow({ id: 'ims-v2', sku: 'VAR-2', name: 'Blue', type: 'VARIANT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.deepEqual(typePreservationWarnings(), [], 'nothing changed, so nothing is suppressed')
  assert.equal(findProductBySku('VAR-1')?.name, 'Parent Widget — Red', 'and the variations still sync')
  assert.deepEqual(quarantinedConflicts(), [])
})

test('a NEW product still takes its type from WooCommerce — create is not guarded (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // A brand-new IMS row has no composition to protect, so the create branch is correct as it
  // stands: guarding it would be guarding nothing, and would leave new products typeless.
  const created = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))
  assert.equal(created.success, true, `sync must succeed, got: ${created.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'SIMPLE', 'a new simple product is created SIMPLE')

  resetState()
  const createdVariable = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(createdVariable.success, true, `sync must succeed, got: ${createdVariable.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'a new variable product is created VARIABLE')
  assert.deepEqual(typePreservationWarnings(), [], 'a create never warns')
})

test('a KIT matched by a WooCommerce VARIATION is not flattened to VARIANT either (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // applyVariations was the fourth unconditional writer of Product.type. A KIT or BOM under a
  // VARIABLE parent is a first-class IMS shape ("bundle variant"), so parentId still applies —
  // only the type write is dropped.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-kit-var', sku: 'VAR-1', name: 'Bundle variant', type: 'KIT' }))
  state.components.push({ id: 'pc-9', productId: 'ims-kit-var', componentId: 'ims-part-a', quantity: 3 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('VAR-1')
  assert.equal(row?.type, 'KIT', 'the variation must not overwrite a KIT with VARIANT')
  assert.equal(row?.parentId, 'ims-parent', 'it is still attached to the variable parent')
  assert.equal(row?.name, 'Parent Widget — Red', 'the rest of the variation still applies')
  assert.equal(row?.externalProductId, BigInt(111), 'and it still takes the WooCommerce mapping')
  assert.equal(state.components.length, 1, 'its components survive')
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT', 'ordinary sibling variations are unaffected')

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].sku, 'VAR-1')
  assert.equal(warnings[0].suppressedType, 'VARIANT')
  assert.equal(warnings[0].wcProductId, '111', 'names the variation, not the parent')
})

// --- unresolved conflicts: surfaced, not reported as success -----------------

test('a KIT matched by a WooCommerce VARIABLE parent keeps its type and adopts no children (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit, not a parent', type: 'KIT' }))
  state.components.push({ id: 'pc-1', productId: 'ims-kit', componentId: 'ims-part-a', quantity: 2 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('PARENT-SKU')?.type, 'KIT', 'VARIABLE is a loss of composition too')
  // Writing the children anyway would swap one corruption for another: VARIANT rows parented to
  // a product IMS says is a kit, which validateProductStructureChange refuses (a parent must be
  // VARIABLE).
  assert.equal(findProductBySku('VAR-1'), null, 'no child rows are attached to a non-variable parent')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.equal(typePreservationWarnings().length, 1)

  // ...but leaving them out is not free, and this is what the first version of the fix got
  // wrong: it returned success and let the caller advance its cursor, so two WooCommerce
  // variations existed nowhere in IMS and nothing but a console line ever said so.
  assert.equal(result.success, false, 'an unresolved conflict is not a successful sync')
  assert.equal(result.permanent, true, 're-delivering the same payload reaches the same refusal')
  assert.match(String(result.error), /None of its variations were imported/)

  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1, 'exactly one exception-inbox row')
  assert.equal(conflicts[0].entityId, 'ims-kit', 'pointing at the IMS product')
  assert.equal(conflicts[0].externalId, '77', 'and at the WooCommerce product')
  assert.match(String(conflicts[0].errorMessage), /is KIT, which cannot be a variable parent/)
  assert.equal(
    (conflicts[0].payload as { conflicts: Array<{ kind: string }> }).conflicts[0].kind,
    'variations_not_imported',
  )
  assert.ok(
    !state.syncLogs.some((log) => log.status === 'SYNCED'),
    'a product whose children were never written must not be recorded as SYNCED',
  )
  // The parent row's own fields still committed: a kit paired with a WooCommerce product must
  // keep receiving price and status updates, or the fix costs more than the bug.
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'leaf fields still applied')
  assert.equal(state.components.length, 1, 'and its composition is untouched')
  // ...and nothing that belongs to the parent role it was refused (o3d-y89x r2). This test
  // used to stop at the type, which is why the r1 fix could erase the row's pricing and give
  // it variable-only options while every assertion here still passed.
  assert.deepEqual(state.options.map((option) => option.name), [], 'no variable-only ProductOption rows on a refused row')
  assert.ok(!('salesPriceBase' in (state.updateData[0] ?? {})), 'and its price columns are not named')
})

test('a repeated sync leaves exactly ONE open conflict row, not one per run (o3d-fjqk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))

  // A conflicted product is re-imported every run (by id, o3d-xbt), so without the
  // dedup that is one new actionable row per run.
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(quarantinedConflicts().length, 1, 'three runs, one open exception')
})

test('resolving the conflict clears the exception with no acknowledge step (o3d-fjqk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))

  const conflicted = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(conflicted.success, false)
  assert.equal(quarantinedConflicts().length, 1)

  // The operator does what the row asks: the IMS product becomes the variable parent it is
  // paired with. Nothing else changes — no button is pressed.
  const row = state.products.find((candidate) => candidate.id === 'ims-kit')!
  row.type = 'VARIABLE'

  const resolved = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(resolved.success, true, `the re-sync must now succeed, got: ${resolved.error}`)
  assert.deepEqual(quarantinedConflicts(), [], 'the exception clears itself when the sync works')
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT', 'and the variations finally land')
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT')
})

// --- a refusal leaves the row OTHERWISE untouched (o3d-y89x r2) --------------
//
// The r1 tests asserted the type survived and stopped there, so they passed while the very
// same UPDATE erased the row's pricing and `applyProductOptions` gave it variable-only option
// rows. "The type was preserved" is not the claim; "the protected row was left alone" is.

test('a refused variable parent keeps its own IMS pricing — a refusal erases nothing (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // A KIT priced in IMS, paired with a WooCommerce VARIABLE product. The old code took the
  // `else` arm of the price rule purely because the INCOMING type was variable, so it wrote
  // salesPriceBase = null / salePriceBase = null onto the row whose adoption it had just
  // refused — and re-applied that on every retry.
  state.products.push(imsRow({
    id: 'ims-kit',
    sku: 'PARENT-SKU',
    name: 'A kit, not a parent',
    type: 'KIT',
    salesPriceBase: 12.34,
    salePriceBase: 9.99,
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, false, 'still a conflict — the variations went unimported')
  const row = findProductBySku('PARENT-SKU')
  assert.equal(Number(row?.salesPriceBase), 12.34, 'the IMS regular price survives the refusal')
  assert.equal(Number(row?.salePriceBase), 9.99, 'and so does the IMS sale price')
  // Untouched means the columns are never NAMED in the UPDATE, not that they were rewritten
  // with the same value — the same distinction the `type` fix turns on.
  const written = state.updateData[0] ?? {}
  assert.ok(!('salesPriceBase' in written), '`salesPriceBase` must be omitted from the UPDATE entirely')
  assert.ok(!('salePriceBase' in written), '`salePriceBase` must be omitted from the UPDATE entirely')
  assert.ok(!('type' in written), 'and `type` still is too')
  // ...while the fields WooCommerce genuinely owns still land.
  assert.equal(row?.name, 'Parent Widget', 'leaf fields still sync')
})

test('a refused variable parent is given no variable-only ProductOption rows (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // applyProductOptions ran unconditionally, so a KIT that was refused the parent role still
  // acquired a "Colour: Red,Blue" option row — options for variants that exist nowhere in IMS,
  // on a row the UI only shows options for when it is VARIABLE.
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, false)
  assert.deepEqual(state.options.map((option) => option.name), [], 'no options are written onto a row refused the parent role')

  // The counterweight: when the row really does become the parent, the options DO get written —
  // otherwise this assertion would pass by the feature never working at all.
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const adopted = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(adopted.success, true, `the takeover path must still work, got: ${adopted.error}`)
  assert.deepEqual(
    state.options.map((option) => `${option.name}=${option.values}`),
    ['Colour=Red,Blue'],
    'a real variable parent still gets its options',
  )
})

// --- the editor's live-row checks, reused (o3d-y89x r2) ----------------------
//
// "SIMPLE owns no structure" is a statement about the row's SHAPE. It says nothing about
// whether the row is IN USE, and the editor refuses a type or parent change on a product with
// stock, reservations or open documents. The connector performs the same two changes, so it
// asks the same question through the editor's own getProductTransformBlockers.

test('a SIMPLE row with stock is not turned into a variable parent (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-live', sku: 'PARENT-SKU', name: 'In use', type: 'SIMPLE' }))
  state.stockLevels.push({ productId: 'ims-live', quantity: 5, reservedQty: 0 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'the editor would refuse this, so the connector does')
  assert.ok(!('type' in (state.updateData[0] ?? {})), '`type` is omitted, not written back')
  assert.equal(findProductBySku('VAR-1'), null, 'and no children are attached to it')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.deepEqual(state.options.map((option) => option.name), [], 'nor any variable-only options')

  assert.equal(result.success, false, 'WooCommerce data went unapplied, so this is not a clean sync')
  assert.equal(result.permanent, true)
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /stock on hand \(5\.00\)/, "the editor's own wording")
  assert.match(String(conflicts[0].errorMessage), /None of its variations were imported/)

  // ...and the row still receives everything WooCommerce genuinely owns.
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget')
})

test("each of the editor's five blockers refuses the transform, in the editor's words (o3d-y89x r2)", async () => {
  const syncWcProductToIms = await loadSync()
  // One case per table getProductTransformBlockers reads. Enumerated rather than spot-checked
  // because the whole point of reusing the editor's function is that a table added there is
  // picked up here — a copy that answered only "stock" would pass a single-case test.
  const cases: Array<[string, () => void, RegExp]> = [
    ['stock on hand', () => state.stockLevels.push({ productId: 'ims-live', quantity: 3, reservedQty: 0 }), /stock on hand \(3\.00\)/],
    ['reserved stock', () => state.stockLevels.push({ productId: 'ims-live', quantity: 0, reservedQty: 2 }), /reserved stock \(2\.00\)/],
    ['open sales order line', () => state.salesOrderLines.push({ productId: 'ims-live' }), /1 open sales order line/],
    ['open purchase order line', () => state.purchaseOrderLines.push({ productId: 'ims-live' }), /1 open purchase order line/],
    ['open manufacturing order', () => state.productionOrders.push({ outputProductId: 'ims-live' }), /1 open manufacturing order/],
    ['open stock transfer line', () => state.stockTransferLines.push({ productId: 'ims-live', status: 'IN_TRANSIT' }), /1 open stock transfer line/],
  ]

  for (const [label, seed, expected] of cases) {
    resetState()
    state.products.push(imsRow({ id: 'ims-live', sku: 'PARENT-SKU', name: 'In use', type: 'SIMPLE' }))
    seed()

    const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

    assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', `${label} must block the transform`)
    assert.equal(result.success, false, `${label} must be reported`)
    assert.match(String(quarantinedConflicts()[0]?.errorMessage), expected, `${label} names itself`)
  }

  // The negative: the same row with nothing live IS transformed. Without this the six cases
  // above would pass just as well against a connector that refused every transform outright.
  resetState()
  state.products.push(imsRow({ id: 'ims-live', sku: 'PARENT-SKU', name: 'Not in use', type: 'SIMPLE' }))
  const clean = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(clean.success, true, `a clean row still transforms, got: ${clean.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE')
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT')
})

test('o3d-y89x r6: a CLOSED stock transfer is not a blocker, on either transfer statement', async () => {
  // The control for the transfer arm (Codex r6 finding 2). Both places production asks it —
  // `getProductTransformBlockers` on the write path and `findProductsWithTransformBlockers` in the
  // pre-commit re-assertion — filter on `transfer.status IN (DRAFT, IN_TRANSIT)`. Every other
  // transfer test seeds an OPEN line, so all of them would pass just as well against a query that
  // had lost that filter, and a RECEIVED transfer from last year would then block the product
  // forever. This is the case that can only pass if the predicate is really applied.
  const syncWcProductToIms = await loadSync()

  // 1. The write path: the row transforms with a closed transfer line against it.
  resetState()
  state.products.push(imsRow({ id: 'ims-live', sku: 'PARENT-SKU', name: 'Shipped last year', type: 'SIMPLE' }))
  state.stockTransferLines.push({ productId: 'ims-live', status: 'RECEIVED' })
  state.stockTransferLines.push({ productId: 'ims-live', status: 'CANCELLED' })

  const clean = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(clean.success, true, `a closed transfer must not block, got: ${clean.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE')

  // 2. The pre-commit re-assertion: a closed transfer line arriving after the writes is not a
  // late blocker either. Same seam as the open-line test below, opposite answer.
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(3)
  beforeConflictsRecorded = () => {
    state.stockTransferLines.push({ productId: 'ims-adopt-2', status: 'RECEIVED' })
  }

  const lateClosed = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(lateClosed.success, true, `a closed transfer must not roll the import back, got: ${lateClosed.error}`)
  assert.equal(findProductBySku('ADOPT-2')?.parentId, 'ims-simple', 'the adoption stands')
})

test('a live SIMPLE row is not adopted as a WooCommerce variation either (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The variation path performs the MORE structural of the two changes — type AND parentId —
  // and had exactly the same hole. An IMS-native product with an open sales order was pulled
  // under a WooCommerce parent, which the editor blocks outright.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-native', sku: 'VAR-1', name: 'IMS-native product', type: 'SIMPLE' }))
  state.salesOrderLines.push({ productId: 'ims-native' })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  const row = findProductBySku('VAR-1')
  assert.equal(row?.type, 'SIMPLE', 'not rewritten to VARIANT')
  assert.equal(row?.parentId, null, 'and not pulled under the WooCommerce parent')
  assert.equal(row?.externalProductId, null, 'and not remapped')
  assert.equal(row?.name, 'IMS-native product', 'the whole row is left alone, not just its type')

  assert.equal(result.success, false)
  assert.match(String(quarantinedConflicts()[0]?.errorMessage), /1 open sales order line/)

  // One refused row must not cost its healthy siblings their update — the same rule as the
  // other variation refusals.
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT', 'the sibling variation still synced')
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'and the parent still synced')
})

test('the steady state asks the live-row question about nothing at all (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The check runs inside the write transaction, which already holds this SKU's advisory lock.
  // Five queries per row per sync of a 200-variation product would be a contention regression
  // paid on every reconcile, so it must be owed only when something is actually transforming.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-v1', sku: 'VAR-1', name: 'Red', type: 'VARIANT', parentId: 'ims-parent' }))
  state.products.push(imsRow({ id: 'ims-v2', sku: 'VAR-2', name: 'Blue', type: 'VARIANT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.deepEqual([...state.blockerQueries], [], 'nothing is changing shape, so nothing is asked')

  // And it IS asked when something transforms — otherwise "asks nothing" would be satisfied by
  // a connector that never asks anything.
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.ok(state.blockerQueries.includes('ims-simple'), 'the transforming row IS asked about')
})

// --- an invalid parent chain is caught, not deepened (o3d-y89x r2) -----------

test('a VARIABLE row that is itself a CHILD adopts no children (o3d-y89x r2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The shape r1's `existing !== incoming` condition let straight through. A row typed VARIABLE
  // that still carries a parentId is invalid and predates this sync — the pre-fix parent branch
  // could mint it by writing VARIABLE over a VARIANT without clearing parentId. Because its
  // type is UNCHANGED, the guard was skipped entirely and the sync attached two more children
  // to it: a two-level chain IMS has no concept of, reported as a clean run.
  state.products.push(imsRow({ id: 'ims-other-parent', sku: 'OTHER-PARENT', name: 'The real parent', type: 'VARIABLE' }))
  state.products.push(imsRow({
    id: 'ims-broken',
    sku: 'PARENT-SKU',
    name: "VARIABLE, but somebody's child",
    type: 'VARIABLE',
    parentId: 'ims-other-parent',
    salesPriceBase: 15,
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('VAR-1'), null, 'the chain is not extended')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.deepEqual(state.options.map((option) => option.name), [], 'nor given the options of a parent it may not be')
  const row = findProductBySku('PARENT-SKU')
  assert.equal(row?.parentId, 'ims-other-parent', 'the existing (invalid) chain is left exactly as found')
  assert.equal(Number(row?.salesPriceBase), 15, 'and its pricing is untouched')

  assert.equal(result.success, false, 'caught, not silently preserved')
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /is itself a child of IMS product ims-other-parent/)
  assert.match(String(conflicts[0].errorMessage), /None of its variations were imported/)

  // No blocker query: the answer came from the row already in hand. A guard that is not an
  // escape hatch still must not cost five queries to say "unchanged".
  assert.deepEqual([...state.blockerQueries], [])
})

// --- a parent BY CHILD ROWS, not by type (o3d-y89x r4, Codex finding 1) ------
//
// The mirror of the section above. That one is about a row that is somebody's CHILD; this one is
// about a row that is somebody's PARENT while its type denies it. Nothing in the schema forbids
// it and the pre-o3d-y89x connector minted it — flatten a VARIABLE row to SIMPLE, leave the
// variants pointing at it — so it exists in exactly the catalogues this branch is fixing.

test('a legacy SIMPLE row WITH children is not sold off as a standalone product (o3d-y89x r4)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The r3 shape rule decided the simple arm from `effectiveType !== 'VARIABLE'` alone. This row
  // is typed SIMPLE, so it AGREED with a WooCommerce simple product: WooCommerce's price landed
  // on a row that still has variants, the variants stayed attached to a parent that is not a
  // parent, and the sync was recorded SYNCED with the cursor advanced — the same stale-structure
  // failure the VARIABLE case was fixed for, reached through physical state instead of the type.
  state.products.push(imsRow({
    id: 'ims-legacy',
    sku: 'KIT-SKU',
    name: 'Flattened by the old connector',
    type: 'SIMPLE',
    salesPriceBase: 15,
    salePriceBase: 12,
  }))
  state.products.push(imsRow({
    id: 'ims-orphan',
    sku: 'ORPHAN-1',
    name: 'Still pointing at it',
    type: 'VARIANT',
    parentId: 'ims-legacy',
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  const row = findProductBySku('KIT-SKU')
  assert.equal(Number(row?.salesPriceBase), 15, "WooCommerce's simple price is NOT applied to a row with variants")
  assert.equal(Number(row?.salePriceBase), 12)
  assert.equal(findProductBySku('ORPHAN-1')?.parentId, 'ims-legacy', 'and the children are left exactly as found')

  assert.equal(result.success, false, 'WooCommerce data went unapplied, so this is not a clean sync')
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1, 'and the operator gets one inbox row')
  assert.match(String(conflicts[0].errorMessage), /other IMS products already carry its id as their parent/)
  assert.match(String(conflicts[0].errorMessage), /product editor/, 'naming a remedy that actually clears it')
  assert.doesNotMatch(
    String(conflicts[0].errorMessage),
    /is a variable parent/,
    'and NOT calling a SIMPLE row a variable parent — the operator would go looking for a variants tab',
  )

  // Everything WooCommerce genuinely owns still applies: this is a refusal of the SHAPE, not of
  // the row. Without this the test would pass against a connector that refused the sync outright.
  assert.equal(row?.name, 'Widget Bundle (from WooCommerce)')
})

test('a legacy SIMPLE row WITH children is not promoted into a WooCommerce parent either (o3d-y89x r4)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The other direction, and the more dangerous one: SIMPLE -> VARIABLE is the transform the
  // allow-list PERMITS, so nothing else would have stopped this. The row would have been typed
  // VARIABLE and this payload's two variations adopted into it — alongside an existing child row
  // WooCommerce has never heard of, now silently a variation of a WooCommerce product.
  state.products.push(imsRow({ id: 'ims-legacy', sku: 'PARENT-SKU', name: 'Flattened, then re-adopted', type: 'SIMPLE' }))
  state.products.push(imsRow({
    id: 'ims-orphan',
    sku: 'ORPHAN-1',
    name: 'Never mentioned by WooCommerce',
    type: 'VARIANT',
    parentId: 'ims-legacy',
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'the row is not promoted')
  assert.equal(findProductBySku('VAR-1'), null, 'and no children are adopted into an invalid parent')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.deepEqual(state.options.map((option) => option.name), [], 'nor variable-only options written')
  assert.equal(findProductBySku('ORPHAN-1')?.parentId, 'ims-legacy', 'the pre-existing child is untouched')

  assert.equal(result.success, false)
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /other IMS products already carry its id as their parent/)
  assert.match(String(conflicts[0].errorMessage), /None of its variations were imported/)

  // Decided from the child rows alone: the live-row question is not owed, because the refusal
  // does not depend on the answer.
  assert.deepEqual([...state.blockerQueries], [])
})

test('the child question is asked about THIS row, not about the catalogue (o3d-y89x r4)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The negative that stops the two tests above being satisfied by a connector that treats every
  // row as a parent. An unrelated parent/child pair exists; the row being synced has no children
  // of its own, so the ordinary SIMPLE -> VARIABLE takeover must still work exactly as before.
  state.products.push(imsRow({ id: 'ims-elsewhere', sku: 'ELSEWHERE', name: 'A real parent', type: 'VARIABLE' }))
  state.products.push(imsRow({
    id: 'ims-elsewhere-child',
    sku: 'ELSEWHERE-1',
    name: 'Its variant',
    type: 'VARIANT',
    parentId: 'ims-elsewhere',
  }))
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `expected a clean takeover, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE')
  assert.equal(findProductBySku('VAR-1')?.parentId, 'ims-simple', 'the variations were adopted')
  assert.equal(findProductBySku('ELSEWHERE-1')?.parentId, 'ims-elsewhere', 'and nothing else moved')
})

// --- variation row matching (o3d-h2cz) --------------------------------------

test('a variation SKU may not reparent an IMS row that belongs to a DIFFERENT parent (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // applyVariations resolves rows by BARE SKU, and the ownership guard deliberately waves
  // through a row with no WooCommerce mapping (that is the initial-import takeover path). So
  // an IMS-native variant of another parent was silently moved across, keeping its stock, its
  // reservations and its open order lines — a structural move the editor blocks outright.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-other-parent', sku: 'OTHER-PARENT', name: 'Other parent', type: 'VARIABLE' }))
  state.products.push(imsRow({
    id: 'ims-foreign-variant',
    sku: 'VAR-1',
    name: 'Belongs to the other parent',
    type: 'VARIANT',
    parentId: 'ims-other-parent',
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  const foreign = findProductBySku('VAR-1')
  assert.equal(foreign?.parentId, 'ims-other-parent', 'the row is NOT reparented')
  assert.equal(foreign?.name, 'Belongs to the other parent', 'and not renamed')
  assert.equal(foreign?.externalProductId, null, 'and not remapped onto our WooCommerce variation')

  assert.equal(result.success, false, 'the refusal is reported, not swallowed')
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /already a child of IMS product ims-other-parent/)

  // One refused row must not cost its healthy siblings their update.
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT', 'the sibling variation still synced')
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'and the parent still synced')
})

test('a variation SKU may not turn an IMS row that HAS children into a variation (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The corrupt shape this guards is one whose `type` does not admit it: a row with children
  // that is not typed VARIABLE. Adopting it would leave ITS children pointing at a row that is
  // now itself a child — a two-level chain IMS has no concept of.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-sneaky-parent', sku: 'VAR-1', name: 'Has children', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'ims-grandchild', sku: 'GRANDCHILD', name: 'Child of VAR-1', type: 'VARIANT', parentId: 'ims-sneaky-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('VAR-1')?.type, 'SIMPLE', 'not rewritten to VARIANT')
  assert.equal(findProductBySku('VAR-1')?.parentId, null, 'not given a parent')
  assert.equal(findProductBySku('GRANDCHILD')?.parentId, 'ims-sneaky-parent', 'its own child is undisturbed')
  assert.equal(result.success, false)
  assert.match(String(quarantinedConflicts()[0]?.errorMessage), /is itself the parent of other IMS products/)
})

test('a variation SKU may not turn a NON_INVENTORY row into a variation (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Protected type + not child-capable: preserving the type would leave NON_INVENTORY carrying
  // a parentId, which validateProductStructureChange refuses. There is no write that leaves
  // this row valid, so it is refused rather than adopted.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-service', sku: 'VAR-1', name: 'Delivery surcharge', type: 'NON_INVENTORY' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  const service = findProductBySku('VAR-1')
  assert.equal(service?.type, 'NON_INVENTORY')
  assert.equal(service?.parentId, null, 'a NON_INVENTORY row never acquires a parent')
  assert.equal(service?.name, 'Delivery surcharge')
  assert.equal(result.success, false)
  assert.match(String(quarantinedConflicts()[0]?.errorMessage), /which cannot sit under a variable parent/)
})

test('an unmapped SIMPLE row IS still adopted as a variation — first import must keep working (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The counterweight to the three refusals above. A SIMPLE, unparented, childless row owns no
  // structure, and the connector completes the transformation it is asking for (type AND
  // parentId in the same transaction). Refusing this would break the first sync of every
  // variable product against an IMS-native catalogue.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-native', sku: 'VAR-1', name: 'IMS-native product', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `adoption must succeed, got: ${result.error}`)
  const adopted = findProductBySku('VAR-1')
  assert.equal(adopted?.id, 'ims-native', 'the existing row was reused, not duplicated')
  assert.equal(adopted?.type, 'VARIANT')
  assert.equal(adopted?.parentId, 'ims-parent')
  assert.equal(adopted?.externalProductId, BigInt(111))
  assert.deepEqual(quarantinedConflicts(), [])
})

test('a KIT already under THIS parent is still adopted, type intact (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The parent check is "a DIFFERENT parent", not "any parent" — otherwise every re-sync of
  // every existing variation would refuse itself from the second run onwards.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-bundle-var', sku: 'VAR-1', name: 'Bundle variant', type: 'KIT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('VAR-1')?.type, 'KIT')
  assert.equal(findProductBySku('VAR-1')?.name, 'Parent Widget — Red', 'and it still receives its update')
  assert.deepEqual(quarantinedConflicts(), [])
})

// --- the bulk cursor --------------------------------------------------------

test('a permanent conflict is re-attempted BY ID instead of pinning the cursor (o3d-y89x, o3d-xbt)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  const first = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(first.synced, 0, 'a conflicted product is not counted as synced')
  assert.equal(first.errors.length, 1, 'it is reported as an error')
  assert.deepEqual(first.permanentErrors, first.errors, 'and classified as one no retry can clear')

  // o3d-xbt: the cursor MOVES. It used to be pinned here, so every later cycle
  // re-fetched the whole catalogue from an ever-older modified_after and
  // re-imported all of it just to re-fail on this one row.
  assert.ok(
    state.settingUpserts.includes('last_wc_product_reconcile_at'),
    'the reconcile cursor advances past a purely permanent failure',
  )
  assert.equal(
    state.settings.get('wc_product_reconcile_conflict_ids'),
    '[77]',
    'and the conflicted product is recorded by WooCommerce id so it is not abandoned',
  )

  // The steady state the old code could never reach: the cursor has moved, so a
  // modified_after page returns NOTHING. The product still exists in the store.
  state.settingUpserts.length = 0
  productPages = {}
  productsById = { '77': variableProduct() as unknown as Row }

  const second = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(second.errors.length, 1, 'the conflicted product is still tried, from the recorded id alone')
  assert.deepEqual(second.permanentErrors, second.errors)
  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[77]', 'and stays on the list while it conflicts')

  // The fix is made on the IMS side — which changes nothing in WooCommerce, so a
  // modified_after query would never surface this product again. The by-id
  // re-attempt is the only thing that picks it up.
  state.products.find((row) => row.id === 'ims-kit')!.type = 'VARIABLE'
  state.settingUpserts.length = 0
  const third = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(third.errors.length, 0, 'the resolved product imports on the very next run')
  assert.equal(third.synced, 1, 'the previously conflicted product imports, counted as a sync')
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'and the structure WooCommerce asked for is finally applied')
  assert.equal(findProductBySku('VAR-1')?.parentId, 'ims-kit', 'its variations land under it')
  assert.ok(state.settingUpserts.includes('last_wc_product_reconcile_at'), 'a clean run advances the cursor as before')
  assert.equal(
    state.settings.get('wc_product_reconcile_conflict_ids'),
    '[]',
    'and the conflict list clears itself — it is a live set, not a log',
  )
})

test('a TRANSIENT failure still holds the cursor (o3d-xbt)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The rule the split must not weaken: a run that did not see everything the
  // cursor would claim it saw must not move the cursor, or remote changes older
  // than now are skipped permanently.
  productFetchError = 'WooCommerce API 502'

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(result.errors.length, 1)
  assert.deepEqual(result.permanentErrors, [], 'a transport failure is not a permanent conflict')
  assert.deepEqual(
    state.settingUpserts.filter((key) => key.includes('reconcile')),
    [],
    'so the cursor does not move',
  )
})

test('a permanent conflict alongside a transient failure holds the cursor too (o3d-xbt)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }
  // Page 1 imports (and conflicts); the id re-fetch fails. Mixed run: the
  // permanent failure alone would let the cursor move, the transient one must
  // still stop it.
  state.settings.set('wc_product_reconcile_conflict_ids', '[99]')
  productFetchErrorOnInclude = 'WooCommerce API 500'

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(result.permanentErrors.length, 1, 'the structure conflict is permanent')
  assert.equal(result.errors.length, 2, 'and the failed re-fetch is reported alongside it')
  assert.deepEqual(
    state.settingUpserts.filter((key) => key === 'last_wc_product_reconcile_at'),
    [],
    'one transient failure is enough to hold the cursor',
  )
})

test('a conflicted product WooCommerce no longer returns drops off the retry list (o3d-xbt)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // Deleted in WooCommerce (or no longer visible to these credentials). Nothing
  // re-adds it, so the list shrinks by itself rather than carrying a dead id and
  // an extra request for ever.
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.deepEqual(result.errors, [])
  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[]')
  assert.ok(state.settingUpserts.includes('last_wc_product_reconcile_at'))
})

// --- o3d-xbt round 2: the retry set is only useful if it survives -----------

test('a carried conflict id SURVIVES a failed by-id re-fetch (o3d-xbt r2, finding 1)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The cursor has already moved past 99, so this list is the ONLY record that it
  // exists. A transport failure on the re-fetch says nothing about whether it
  // still conflicts — and dropping it here abandoned it permanently.
  state.settings.set('wc_product_reconcile_conflict_ids', '[99]')
  productFetchErrorOnInclude = 'WooCommerce API 500'

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(result.errors.length, 1, 'the failed re-fetch is reported')
  assert.deepEqual(result.permanentErrors, [], 'a transport failure is transient')
  assert.equal(
    state.settings.get('wc_product_reconcile_conflict_ids'),
    '[99]',
    'the id must still be on the list — nothing else will ever fetch this product again',
  )
  assert.deepEqual(
    state.settingUpserts.filter((key) => key === 'last_wc_product_reconcile_at'),
    [],
    'and the cursor is held, as any transient failure holds it',
  )
})

test('a carried id and a fresh conflict are BOTH carried when the re-fetch fails', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }
  state.settings.set('wc_product_reconcile_conflict_ids', '[99]')
  productFetchErrorOnInclude = 'WooCommerce API 500'

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  const carried = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  assert.deepEqual(
    [...carried].sort((a, b) => a - b),
    [77, 99],
    'the run learned nothing about 99 and everything about 77 — both are still unresolved',
  )
})

test('a carried id is dropped on EVIDENCE: WooCommerce answered without it', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The other direction, and the one that keeps the list from only growing: the
  // re-fetch SUCCEEDED and did not return 4242, so it is gone from the store.
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[]')
})

test('an UNWRITABLE conflict list holds the cursor instead of stepping past it (o3d-xbt r2, finding 1)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }
  settingUpsertError = { key: 'wc_product_reconcile_conflict_ids', message: 'deadlock detected' }

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.deepEqual(
    state.settingUpserts.filter((key) => key === 'last_wc_product_reconcile_at'),
    [],
    'the cursor must NOT advance past products whose ids were never recorded — that is silent abandonment',
  )
  assert.ok(
    result.errors.some((line) => line.includes('Failed to record the conflicted-product list')),
    `the failure must be reported, got: ${JSON.stringify(result.errors)}`,
  )
  assert.ok(
    state.activity.some((row) => row.action === 'wc_product_sync_conflicts_unrecorded' && row.level === 'ERROR'),
    'and logged loudly — an errors array nobody reads is not a report',
  )
})

test('a failed conflict-list write does not take the whole sweep down', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }
  settingUpsertError = { key: 'wc_product_reconcile_conflict_ids', message: 'deadlock detected' }

  // It returns a result rather than throwing: the caller (a cron sweep) reports
  // counts, and an exception here would lose the count of what DID import.
  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))
  assert.equal(typeof result.synced, 'number')
  assert.equal(result.permanentErrors.length, 1, 'the structure conflict is still classified')
})

// --- o3d-xbt round 3: overlapping sweeps, and a bound that abandons nothing ---

/** Seed N products that will each conflict: an IMS KIT against a WC variable parent. */
function seedConflictingProducts(count: number, firstWcId: number): Row[] {
  const page: Row[] = []
  for (let i = 0; i < count; i++) {
    const sku = `OVER-${i}`
    state.products.push(imsRow({ id: `ims-over-${i}`, sku, name: 'A kit', type: 'KIT' }))
    page.push(variableProduct({ id: firstWcId + i, sku, variations: [] }) as unknown as Row)
  }
  return page
}

test('the conflict list is read and written under a MODE-SCOPED advisory lock (o3d-xbt r3, finding 1)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))
  const reconcileLocks = state.advisoryLocks.filter((row) => row.values[0] === WC_PRODUCT_CONFLICT_LIST_LOCK_NAMESPACE)
  assert.equal(reconcileLocks.length, 1, 'exactly one, at the read-modify-write')

  state.advisoryLocks.length = 0
  state.products.push(imsRow({ id: 'ims-kit-2', sku: 'POLL-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct({ id: 78, sku: 'POLL-SKU', variations: [] }) as unknown as Row] }
  await capturingWarnings(() => syncAllWcProducts({ mode: 'poll' }))
  const pollLocks = state.advisoryLocks.filter((row) => row.values[0] === WC_PRODUCT_CONFLICT_LIST_LOCK_NAMESPACE)

  assert.equal(pollLocks.length, 1)
  assert.notDeepEqual(
    pollLocks[0].values[1],
    reconcileLocks[0].values[1],
    'the poll and the reconcile write different rows — queueing one behind the other is contention with no safety gain',
  )
})

test("an overlapping sweep's conflict list is MERGED onto, not replaced (o3d-xbt r3, finding 1)", async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  // The other sweep — a cron reconcile running while an operator pressed the
  // manual button, which share this row and this cursor — commits ITS list while
  // ours is still fetching, and advances the cursor past product 99. Modelled at
  // the lock, because that is exactly the interleaving the lock permits: it
  // serializes, it does not exclude.
  onConflictListLock = () => { state.settings.set('wc_product_reconcile_conflict_ids', '[99]') }

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(onConflictListLock, null, 'the sweep really did take the lock — the hook fired')
  const carried = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  assert.deepEqual(
    [...carried].sort((a, b) => a - b),
    [77, 99],
    'writing our snapshot back would have erased 99 with the cursor already past it — nothing would ever fetch it again',
  )
  assert.equal(result.permanentErrors.length, 1, 'and our own conflict is still classified as permanent')
})

test('a sweep with nothing to say leaves an overlapping sweep\'s list completely alone', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // No stored list at the start, nothing conflicted here: this run has no
  // business writing the row at all, and writing an empty one would delete the
  // ids the other sweep recorded while we ran.
  onConflictListLock = () => { state.settings.set('wc_product_reconcile_conflict_ids', '[99]') }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), undefined, 'no row, so no write, so no clobber')
  assert.notEqual(onConflictListLock, null, 'the hook never fired: the sweep did not take the lock, because it had nothing to write')
})

test('a carried id that fails TRANSIENTLY stays on the list (o3d-xbt r3, finding 1)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The re-fetch SUCCEEDS and the product comes back, but the import of it fails
  // for a reason a retry may well clear. Round 2 rebuilt the list from the
  // conflicts it re-observed, so this id — attempted, not conflicted, not
  // resolved — fell out of the list while the cursor stayed put ahead of it.
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productsById = { '4242': variableProduct({ id: 4242 }) as unknown as Row }
  // A settings-version move is the sync's own transient failure: the credentials
  // were rebound mid-run, so the payload in hand describes the old store.
  state.settings.set('wc_settings_version', '7')

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(result.errors.length, 1, 'the failure is reported')
  assert.deepEqual(result.permanentErrors, [], 'and it is transient — a rebind is not a conflict')
  assert.equal(
    state.settings.get('wc_product_reconcile_conflict_ids'),
    '[4242]',
    'a transient failure is not evidence the conflict is resolved, so the id must not leave the list',
  )
})

test('a backlog longer than the retry window ROTATES, so every id is re-attempted (o3d-xbt r3, finding 2)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  const backlog = WC_PRODUCT_CONFLICT_RETRY_LIMIT + 50
  const page = seedConflictingProducts(backlog, 1000)
  productsById = Object.fromEntries(page.map((row) => [String(row.id), row]))
  variationPages = { '1': [] }
  state.settings.set(
    'wc_product_reconcile_conflict_ids',
    JSON.stringify(Array.from({ length: backlog }, (_, i) => 1000 + i)),
  )

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))
  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.includeFetches.length, 2, 'one extra request per run, whatever the backlog — that is the bound')
  assert.equal(state.includeFetches[0].length, WC_PRODUCT_CONFLICT_RETRY_LIMIT)
  assert.equal(state.includeFetches[0][0], 1000, 'the first run takes the head of the list')
  assert.equal(
    state.includeFetches[1][0],
    1000 + WC_PRODUCT_CONFLICT_RETRY_LIMIT,
    'and the second takes the ids the first could not reach — a fixed order would re-attempt the same head for ever',
  )

  const attempted = new Set([...state.includeFetches[0], ...state.includeFetches[1]])
  for (let i = 0; i < backlog; i++) {
    assert.equal(attempted.has(1000 + i), true, `id ${1000 + i} was never re-attempted`)
  }
  const carried = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  assert.equal(carried.length, backlog, 'and nothing was dropped to achieve it')
})

test('a store overflow HOLDS the cursor rather than abandoning the excess (o3d-xbt r3, finding 2)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // More conflicted products than the row can hold. Round 2 dropped the excess,
  // called it PERMANENT so the cursor advanced past it, and told the operator to
  // "resolve the carried conflicts to make room" — which recovered nothing,
  // because a dropped id was on no list and behind the cursor.
  const overflow = WC_PRODUCT_CONFLICT_STORE_LIMIT + 5
  productPages = { '1': seedConflictingProducts(overflow, 1000) }
  variationPages = { '1': [] }

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  const carried = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  assert.equal(carried.length, WC_PRODUCT_CONFLICT_STORE_LIMIT, 'the row stays bounded — that part was right')

  assert.deepEqual(
    state.settingUpserts.filter((key) => key === 'last_wc_product_reconcile_at'),
    [],
    'THE FIX: the cursor is HELD, so next run re-fetches the products that did not fit and nothing is abandoned',
  )
  assert.equal(
    result.errors.length > result.permanentErrors.length,
    true,
    'the overflow must be reported as transient — classifying it permanent is what let the cursor step past it',
  )
  assert.equal(
    result.permanentErrors.some((line) => line.includes('could not be carried')),
    false,
    'a conflict the list cannot hold is not a permanent one; the retry list is what made permanence safe',
  )

  const truncation = state.activity.find((row) => row.action === 'wc_product_sync_conflicts_truncated')
  assert.ok(truncation, `the overflow must be logged, saw: ${JSON.stringify(state.activity.map((r) => r.action))}`)
  assert.equal(truncation.level, 'ERROR')
  const meta = truncation.metadata as {
    droppedExternalProductIds: number[]
    droppedCount: number
    droppedStrandedExternalProductIds: number[]
    cursorHeld: boolean
  }
  assert.equal(meta.droppedCount, overflow - WC_PRODUCT_CONFLICT_STORE_LIMIT)
  assert.equal(meta.cursorHeld, true)
  assert.deepEqual(
    meta.droppedStrandedExternalProductIds,
    [],
    'every dropped id here was seen through the modified-after window, so the held cursor really does cover them',
  )
  for (const id of meta.droppedExternalProductIds) {
    assert.equal(carried.includes(id), false, 'a dropped id is not also on the carried list')
  }
  assert.match(
    String(truncation.description),
    /HELD/,
    'the row must say what the drop MEANS — round 2 said "will NOT be re-attempted", which is the abandonment itself',
  )
  assert.match(
    String(truncation.description),
    /Resolve the conflicts under Sync . Exceptions to free slots/,
    'and the remedy it advertises must be one that works: with the cursor held, freeing slots DOES pick them up',
  )
  assert.ok(
    result.errors.some((line) => line.includes('could not be carried') && line.includes('held')),
    'and the caller sees it too, not only the activity log',
  )
})

test('the second run after an overflow re-fetches the ids that did not fit', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The claim the message makes, exercised: the cursor was held, so the ordinary
  // modified-after pass presents these products again. Modelled with a small
  // page because what matters is that the SAME page is fetched again, which is
  // what a held cursor means.
  const overflow = WC_PRODUCT_CONFLICT_STORE_LIMIT + 5
  productPages = { '1': seedConflictingProducts(overflow, 1000) }
  variationPages = { '1': [] }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))
  const beforeSecondRun = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  const droppedFirstRun = (state.activity.find((row) => row.action === 'wc_product_sync_conflicts_truncated')!
    .metadata as { droppedExternalProductIds: number[] }).droppedExternalProductIds
  assert.equal(droppedFirstRun.length, 5)
  for (const id of droppedFirstRun) {
    assert.equal(beforeSecondRun.includes(id), false, 'these are the ids the first run could not carry')
  }

  // Resolve some of the carried conflicts to free slots — the remedy the log line
  // advertises, done exactly as it says.
  for (let i = 0; i < 10; i++) {
    state.products.find((row) => row.id === `ims-over-${i}`)!.type = 'VARIABLE'
  }
  state.activity.length = 0
  const second = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(second.synced, 10, 'the resolved products import, because the held cursor fetched them again')
  const after = JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!) as number[]
  for (const id of droppedFirstRun) {
    assert.equal(
      after.includes(id),
      true,
      `id ${id} was dropped by the first run and must be carried by the second — this is the remedy round 2 `
      + 'advertised and could not deliver, because its dropped ids were on no list and behind an advanced cursor',
    )
  }
  assert.equal(
    state.activity.some((row) => row.action === 'wc_product_sync_conflicts_truncated'),
    false,
    'and with slots freed there is nothing left over at all',
  )
})

test('a run inside the cap logs NO truncation row — the warning means something', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(
    state.activity.some((row) => row.action === 'wc_product_sync_conflicts_truncated'),
    false,
  )
})

test('the poll and the reconcile keep separate conflict lists (o3d-xbt)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'poll' }))

  // They keep separate cursors, so a shared list would let one mode's run
  // silently satisfy the other's retry.
  assert.equal(state.settings.get('wc_product_sync_conflict_ids'), '[77]')
  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), undefined)
})

// ---------------------------------------------------------------------------
// o3d-y89x r3 (Codex finding 2) — the live-row answer has to survive to the WRITE.
//
// r2 made the connector ask the editor's question (`getProductTransformBlockers`) before it
// transforms a row, and thread `tx` through so it asked under the right connection. Both were
// necessary; neither made the answer STICK. A SELECT under READ COMMITTED describes the past by
// the time the UPDATE runs, and nothing serializes the gap: the per-SKU advisory locks are
// cooperative and are taken only by the `Product.sku` writers (the editor, the CSV import, this
// sync). The writers that CREATE blockers — stock receipts, allocation, sales/purchase/
// production/transfer documents — take none of them, so one can commit in between and the
// connector transforms a row the editor would have refused.
//
// The fix is to stop asking twice and start ASSERTING: `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE`
// rides in the same `UPDATE ... WHERE` that already guards ownership, so Postgres evaluates the
// blocker predicate at the instant of the write. A blocker that arrived in the gap makes the
// statement match zero rows and the transform is re-decided WITH it.
//
// These tests open that exact window: `beforeProductWrite` fires after every blocker SELECT has
// been awaited and before the write's predicate is evaluated. A double answering from a static
// map could not express it — the check and the write would return the same answer by
// construction, and the test would pass against the unfixed code.
// ---------------------------------------------------------------------------

test('o3d-y89x r3: a blocker created BETWEEN the check and the write refuses the parent transform', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Clean at the moment the connector asks — the pre-check therefore CLEARS the transform, and
  // the sibling test above ('a SIMPLE row ... the guard must not freeze ordinary types') is the
  // control showing this same fixture transforms to VARIABLE when nothing interferes.
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  beforeProductWrite = (productId) => {
    if (productId !== 'ims-simple') return
    // An order is placed against the product between the check and the write.
    state.salesOrderLines.push({ productId: 'ims-simple' })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.ok(
    state.blockerQueries.includes('ims-simple'),
    'the pre-check really did run, and really did see a clean row',
  )
  assert.equal(
    findProductBySku('PARENT-SKU')?.type,
    'SIMPLE',
    'the transform is refused by the write itself, not committed against a stale answer',
  )
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'the non-structural fields still apply')
  assert.equal(result.success, false, 'and it is reported, not swallowed')
  assert.equal(result.permanent, true)

  // The SAME refusal the pre-check produces — identical reason, identical operator message —
  // so the outcome does not depend on WHEN the blocker arrived.
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /cannot be converted from SIMPLE to a variable parent/)
  assert.match(String(conflicts[0].errorMessage), /1 open sales order line/)
  assert.equal(findProductBySku('VAR-1'), null, 'and no children were adopted into the refused parent')
})

test('o3d-y89x r3: a blocker created between check and write refuses the VARIATION adoption too', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [wcVariation(111, 'VAR-1', 'Red')] }
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  // A clean, adoptable SIMPLE row: exactly the initial-import takeover path that must keep
  // working, so nothing in the fixture itself refuses it.
  state.products.push(imsRow({ id: 'ims-orphan', sku: 'VAR-1', name: 'Standalone', type: 'SIMPLE' }))
  beforeProductWrite = (productId) => {
    if (productId !== 'ims-orphan') return
    state.stockLevels.push({ productId: 'ims-orphan', quantity: 4, reservedQty: 0 })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations: [111] })))

  assert.ok(state.blockerQueries.includes('ims-orphan'), 'the pre-check ran on the variation row')
  assert.equal(findProductBySku('VAR-1')?.type, 'SIMPLE', 'the row is not re-typed')
  assert.equal(findProductBySku('VAR-1')?.parentId ?? null, null, 'and it is not reparented either')
  assert.equal(result.success, false)
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /WooCommerce variation 111 matched SKU "VAR-1"/)
  assert.match(String(conflicts[0].errorMessage), /stock on hand \(4\.00\)/)
  assert.match(String(conflicts[0].errorMessage), /The variation was not imported/)
})

test('o3d-y89x r3: a NON-transforming write is not made conditional — a live row still syncs', async () => {
  // THE BOUNDARY, and the reason the predicate is gated on `writeTransformsRow` rather than
  // ANDed unconditionally. `validateProductStructureChange` blocks a TYPE OR PARENT change on a
  // live row; it does not block renaming one. If the connector attached the blocker predicate to
  // every write, every product with stock or an open order would stop receiving name, price and
  // status updates from WooCommerce entirely — a far bigger outage than the race being closed.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'KIT-SKU', name: 'Old name', type: 'SIMPLE' }))
  state.stockLevels.push({ productId: 'ims-simple', quantity: 12, reservedQty: 3 })
  state.salesOrderLines.push({ productId: 'ims-simple' })

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `a re-sync of a live row must still apply, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.name, 'Widget Bundle (from WooCommerce)')
  assert.deepEqual(
    state.blockerQueries,
    [],
    'and the steady state does not even ask — SIMPLE -> SIMPLE is not a transform',
  )
})

// ---------------------------------------------------------------------------
// o3d-y89x r4 (Codex finding 2) — the predicate rides in ONE statement; the transaction is long.
//
// The r3 predicate refuses a write against a blocker committed before that statement's snapshot.
// What it cannot do is cover the REST of the transaction: this sync transforms the parent row and
// then writes potentially hundreds of variations before it commits, and a blocker committing
// anywhere in that stretch is invisible to both the pre-check and the write.
//
// So the blocker question is re-asserted once more as the transaction's last act. It does not
// close the race — a blocker committing after that read and before COMMIT is still write skew,
// and closing THAT needs a lock the blocker writers take (there is none) or SERIALIZABLE across
// all of them — but it bounds the exposure at the width of the re-assertion itself.
//
// r5 (Codex finding 1): that width is only a bound if it does not grow with the number of
// transformed rows. Asked row by row it was 5N statements, and the row checked FIRST — the
// parent, before the variations it adopts — stayed exposed across the remaining 5(N-1). So the
// re-assertion is asked SET-WISE, in two statements whatever N is, and the tests below pin the
// statement count as well as the behaviour.
// ---------------------------------------------------------------------------

test('o3d-y89x r4: a blocker arriving AFTER the transform, before the commit, rolls the import back', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Clean at the pre-check AND clean at the write, so both r3 guards pass and the transform is
  // committed to the transaction. Only then does the order arrive.
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  beforeConflictsRecorded = () => {
    state.salesOrderLines.push({ productId: 'ims-simple' })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, false, 'the import must not commit a transform of a now-live row')
  assert.match(String(result.error), /became live/)
  assert.match(String(result.error), /1 open sales order line/, "in the editor's own words")
  assert.match(String(result.error), /rolled back/)
  assert.notEqual(result.permanent, true, 'a blocker clears itself, so this must stay retryable')

  // The WHOLE transaction is undone — this is the difference between a late refusal (which
  // rewrites the parent row without its type) and this, which cannot re-decide anything because
  // the writes have already happened.
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'the transform is not committed')
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Was simple', 'nor anything else from this run')
  assert.equal(findProductBySku('VAR-1'), null, 'and the adopted children are gone with it')

  // Reported as a plain FAILED sync-log row, unprefixed: o3d-gtk's PERMANENT_CONFLICT prefix is
  // what tells the sync-log view "this will never succeed", and this one will.
  const failed = state.syncLogs.filter((log) => log.status === 'FAILED')
  assert.equal(failed.length, 1)
  assert.doesNotMatch(String(failed[0].errorMessage), /PERMANENT_CONFLICT/)
})

test('o3d-y89x r4: the pre-commit re-assertion costs nothing when nothing was transformed', async () => {
  // THE BOUNDARY. Re-reading the blockers for every synced row would put five queries per
  // variation on every reconcile of every catalogue — and would refuse imports over blockers on
  // rows this transaction never restructured. It is owed only by rows whose `type` or `parentId`
  // this transaction actually moved.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-v1', sku: 'VAR-1', name: 'Red', type: 'VARIANT', parentId: 'ims-parent' }))
  state.products.push(imsRow({ id: 'ims-v2', sku: 'VAR-2', name: 'Blue', type: 'VARIANT', parentId: 'ims-parent' }))
  // Live rows, every arm of the blocker question answered "blocked" — and irrelevant, because
  // nothing here is being restructured.
  state.stockLevels.push({ productId: 'ims-parent', quantity: 9, reservedQty: 1 })
  state.salesOrderLines.push({ productId: 'ims-v1' })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `a steady-state re-sync of live rows must still apply, got: ${result.error}`)
  assert.deepEqual([...state.blockerQueries], [], 'not one blocker query, before or after the writes')
  assert.equal(findProductBySku('VAR-1')?.name, 'Parent Widget — Red', 'and the import really did run')
})

// ---------------------------------------------------------------------------
// o3d-y89x r4 (Codex finding 3) — a cause that has gone may not be attributed to another cause.
//
// The zero-row diagnosis re-reads in order: row deleted, ownership taken, transform blocker. If
// none of them answers, the write's condition has already cleared itself — and the fall-through
// used to be `WcSkuOwnershipConflictError`, which the line above had just DISPROVED and which
// o3d-gtk classifies PERMANENT. So a stock level moving 0 -> 5 -> 0 acknowledged the webhook for
// good and told the operator to fix a duplicate WooCommerce SKU that does not exist.
// ---------------------------------------------------------------------------

test('o3d-y89x r4: a blocker that appears at the write and is GONE by the diagnosis is retryable', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))

  // The interleaving, in three steps against ONE shared state — which is the only reason the
  // doubles can express it: clean for the pre-check, blocked for the write's own predicate, and
  // cleared again before the diagnostic re-read. Stock moving 0 -> 5 -> 0 does exactly this.
  beforeProductWrite = (productId) => {
    if (productId !== 'ims-simple') return
    state.stockLevels.push({ productId: 'ims-simple', quantity: 5, reservedQty: 0 })
  }
  let diagnosisReads = 0
  beforeBlockerQuery = (productId) => {
    if (productId !== 'ims-simple' || state.stockLevels.length === 0) return
    diagnosisReads++
    state.stockLevels.length = 0
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(diagnosisReads, 1, 'the diagnosis really did re-read, and really did find it gone')
  assert.equal(result.success, false, 'the write matched nothing, so nothing may be reported as applied')

  // THE FINDING. Not an ownership conflict — ownership was re-checked and found intact — and
  // therefore not PERMANENT: nothing needs an operator, and an immediate retry can succeed.
  assert.notEqual(result.permanent, true, 'a cause that has already cleared may not be a terminal verdict')
  assert.doesNotMatch(
    String(result.error),
    /already mapped to WooCommerce object/,
    'and the operator is not sent after a duplicate WooCommerce SKU that does not exist',
  )
  assert.match(String(result.error), /the cause had gone/)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'and the transform did not happen')

  // No quarantined inbox row: this is a race to retry, not a structural conflict for a human.
  assert.deepEqual(quarantinedConflicts(), [])
})

test('o3d-y89x r4: a blocker that is STILL there at the diagnosis is still reported as a blocker', async () => {
  // The control. Without it, "not an ownership conflict" would be satisfied by a connector that
  // had stopped diagnosing blockers altogether and called every zero-row write a race.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  beforeProductWrite = (productId) => {
    if (productId !== 'ims-simple') return
    state.stockLevels.push({ productId: 'ims-simple', quantity: 5, reservedQty: 0 })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, false)
  assert.doesNotMatch(String(result.error), /the cause had gone/, 'the cause is observable, so it is named')
  assert.equal(quarantinedConflicts().length, 1, 'and it becomes an operator-facing conflict')
  assert.match(String(quarantinedConflicts()[0].errorMessage), /stock on hand \(5\.00\)/)
})

// ---------------------------------------------------------------------------
// o3d-y89x r5 (Codex finding 1) — the re-assertion's window must not grow with the row count.
//
// r4 asked the blocker question row by row and the comment claimed it shrank the exposure "to one
// statement boundary". That is true for ONE transformed row and false for any more: five
// statements per row means the row checked FIRST — always the parent, recorded before the
// variations it adopts — stays exposed across the 5(N-1) statements the later rows cost. A
// first-time adoption of a 200-variation parent left the parent exposed for ~1,000 statements,
// not one.
//
// Neither number is visible in the OUTCOME: both shapes refuse a blocker that is already present
// when the re-assertion starts, and neither sees one that commits after it. The property is the
// WIDTH, and width is counted in statements — which is why these are counting tests, and why the
// counter lives in the doubles rather than in an assertion about behaviour.
// ---------------------------------------------------------------------------

/**
 * The two halves of a REFUSING re-assertion, told apart by what each statement asked about.
 *
 * The DECISION is the first two statements and both cover every transformed row — that is the
 * constant-width claim, and it is what a per-row loop would fail: its first statement names one
 * id, not twenty-one. Everything after them is the ITEMISATION of the single row the decision
 * flagged, read only to put the blocker in the editor's own words on a path that has already
 * decided to roll back.
 */
function assertSetWiseDecisionThenItemisation(blockedId: string) {
  const expectedIds = ['ims-simple', ...Array.from({ length: 20 }, (_, i) => `ims-adopt-${i + 1}`)].sort()
  const [transferArm, predicateArms, ...itemisation] = state.commitPhaseBlockerIds
  assert.deepEqual([...transferArm].sort(), expectedIds, 'statement 1 covers every transformed row')
  assert.deepEqual([...predicateArms].sort(), expectedIds, 'statement 2 covers every transformed row')
  assert.deepEqual(
    [...new Set(itemisation.flat())],
    [blockedId],
    'and everything after the decision is about the ONE row it flagged',
  )
}

/** N adoptable IMS rows plus the WooCommerce variations that match them, by SKU. */
function seedAdoptableVariations(count: number): number[] {
  const ids: number[] = []
  const pages: Row[] = []
  for (let i = 1; i <= count; i++) {
    const wcId = 1000 + i
    ids.push(wcId)
    pages.push(wcVariation(wcId, `ADOPT-${i}`, `Opt${i}`))
    state.products.push(imsRow({ id: `ims-adopt-${i}`, sku: `ADOPT-${i}`, name: `Standalone ${i}`, type: 'SIMPLE' }))
  }
  variationPages = { '1': pages }
  return ids
}

test('o3d-y89x r5: the pre-commit re-assertion is the SAME two statements for 1 row and for 21', async () => {
  const syncWcProductToIms = await loadSync()

  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  variationPages = { '1': [] }
  const one = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations: [] })))
  assert.equal(one.success, true, `expected a clean transform, got: ${one.error}`)
  assert.deepEqual(state.commitPhaseBlockerIds, [['ims-simple'], ['ims-simple']], 'one transformed row')
  const forOneRow = state.commitPhaseBlockerStatements
  assert.equal(forOneRow, 2, 'two statements: the transfer arm, then the four the predicate expresses')

  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(20)
  const many = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(many.success, true, `expected 20 clean adoptions, got: ${many.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'the parent really did transform')
  assert.equal(findProductBySku('ADOPT-20')?.parentId, 'ims-simple', 'and the 20th row really was adopted')

  // THE FINDING. 21 rows moved, and the re-assertion is still the same two statements it is for
  // one — so the earliest-transformed row is exposed for the same width whether this payload
  // carried one variation or two hundred. Row by row this was 5 x 21 = 105.
  assert.equal(
    state.commitPhaseBlockerStatements,
    forOneRow,
    'the window is CONSTANT in the number of transformed rows, not proportional to it',
  )

  // And it is constant because every row is in BOTH statements — not because rows were dropped.
  // A batch that stopped asking about a row would be a lost guard that this count alone would
  // happily report as an improvement.
  const expectedIds = ['ims-simple', ...Array.from({ length: 20 }, (_, i) => `ims-adopt-${i + 1}`)]
  assert.equal(state.commitPhaseBlockerIds.length, 2)
  for (const asked of state.commitPhaseBlockerIds) {
    assert.deepEqual([...asked].sort(), [...expectedIds].sort(), 'every transformed row is asked about, in each statement')
  }
})

test('o3d-y89x r5: a blocker on the FIRST-transformed row is still caught after 20 more rows moved', async () => {
  // The behavioural half. The batch must not have turned the guard into a counting exercise:
  // with 21 rows transformed and a blocker landing on the one recorded FIRST, the import still
  // has to roll back, and still has to name that row in the editor's own words.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(20)
  beforeConflictsRecorded = () => {
    state.salesOrderLines.push({ productId: 'ims-simple' })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(result.success, false, 'the transform of a now-live row must not commit')
  assert.match(String(result.error), /ims-simple/, 'and the row named is the blocked one, not merely the first')
  assert.match(String(result.error), /1 open sales order line/)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'the whole transaction is undone')
  assert.equal(findProductBySku('ADOPT-20')?.parentId ?? null, null, 'including the 20 adoptions')
})

test('o3d-y89x r5: a blocker on the LAST-transformed row is caught by the same two statements', async () => {
  // The mirror, and the control for the test above: the batch answers about every row it was
  // handed, not just the one it happens to report. Row by row this row was the one CHECKED last
  // and so the least exposed; set-wise there is no such ordering left to rely on.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(20)
  beforeConflictsRecorded = () => {
    state.stockLevels.push({ productId: 'ims-adopt-20', quantity: 7, reservedQty: 0 })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(result.success, false)
  assert.match(String(result.error), /ims-adopt-20/)
  assert.match(String(result.error), /stock on hand \(7\.00\)/)
  assert.equal(findProductBySku('ADOPT-1')?.parentId ?? null, null, 'the whole import is rolled back')

  // THE DECISION took two statements, both over the whole set; everything after it is the
  // ITEMISATION of the one row it flagged, on a path that has already decided to abort. Separated
  // rather than totalled, because "two statements" is a claim about the window and the itemising
  // read is outside it — it widens nothing and answers about nothing else.
  assertSetWiseDecisionThenItemisation('ims-adopt-20')
})

test('o3d-y89x r5: the transfer arm is re-asserted set-wise too, not per row', async () => {
  // The arm no predicate on the product row can express — StockTransferLine carries no FK to
  // Product — so it is its own statement and is the one place the two-statement claim could
  // quietly become 1+N.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(20)
  beforeConflictsRecorded = () => {
    state.stockTransferLines.push({ productId: 'ims-adopt-7', status: 'IN_TRANSIT' })
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(result.success, false, 'an open transfer line blocks the transform like any other arm')
  assert.match(String(result.error), /ims-adopt-7/)
  assert.match(String(result.error), /1 open stock transfer line/)
  assertSetWiseDecisionThenItemisation('ims-adopt-7')
})

// ---------------------------------------------------------------------------
// o3d-y89x r6 (Codex finding 1) — the child question is ONE INDEX-SCOPED statement per batch.
//
// r4 made the child question unconditional, which was right: a row with children is a parent
// whatever its type says, and the CONDITIONAL version is what missed the legacy
// SIMPLE-with-children row in the steady-state re-sync of a WooCommerce `simple` product. What it
// cost was a second round trip PER ROW asked about, dragging back one row per child.
//
// r5 folded it into the row lookup as Prisma's relation `_count` and asserted "zero extra
// statements". The statement count was right and the cost was far worse: `_count` renders as an
// UNCORRELATED `LEFT JOIN (SELECT parentId, COUNT(*) FROM products GROUP BY parentId)`, so every
// lookup aggregated the WHOLE catalogue — measured at 119 shared buffers / 0.905 ms on 2,283 dev
// rows, against 7 buffers / 0.078 ms for the scoped form. Counting statements is exactly what
// could not see that.
//
// So these pin the two properties that actually bound the cost, and both are asserted on the
// statement log because neither is observable from behaviour:
//
//   1. ONE child statement per BATCH of rows — not one per row (r4's regression);
//   2. every child statement SCOPED to the ids the transaction has in hand — not to the
//      catalogue (r5's regression).
//
// The correctness is unchanged; the tests above still hold it.
// ---------------------------------------------------------------------------

test('o3d-y89x r6: a steady-state simple re-sync asks about children once, scoped to that row', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-legacy', sku: 'KIT-SKU', name: 'Old name', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `expected a clean re-sync, got: ${result.error}`)
  assert.deepEqual(
    state.productReads,
    ['findFirst:sku', 'groupBy:children'],
    'the row lookup, then ONE grouped child statement — not a per-row query and not a folded aggregate',
  )
  assert.deepEqual(
    state.childQueryIds,
    [['ims-legacy']],
    'and it names the row it is asking about, so its cost cannot grow with the catalogue',
  )
})

test('o3d-y89x r6: the unconditional child question still catches the legacy parent, still scoped', async () => {
  // The r4 finding, re-run against the r6 shape: the answer must still come from the CHILD ROWS
  // and not from the type column — and the statement that produces it must still be scoped to the
  // one row asked about. Without both halves this is either a correctness regression or the
  // catalogue-wide aggregate back again.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-legacy', sku: 'KIT-SKU', name: 'Flattened by the old connector', type: 'SIMPLE', salesPriceBase: 15 }))
  state.products.push(imsRow({ id: 'ims-orphan', sku: 'ORPHAN-1', name: 'Still pointing at it', type: 'VARIANT', parentId: 'ims-legacy' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, false, 'a row with children is a parent whatever its type says')
  assert.equal(Number(findProductBySku('KIT-SKU')?.salesPriceBase), 15, "WooCommerce's simple price is not applied")
  assert.deepEqual(state.productReads, ['findFirst:sku', 'groupBy:children'])
  assert.deepEqual(
    state.childQueryIds,
    [['ims-legacy']],
    'the child rows are found through an id-scoped statement, not by aggregating the catalogue',
  )
})

test('o3d-y89x r6: a 20-variation import asks about children ONCE for all 20 candidates', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  const variations = seedAdoptableVariations(20)

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations })))

  assert.equal(result.success, true, `expected 20 clean adoptions, got: ${result.error}`)
  // Parent by SKU + its child statement, the 20 candidate rows by SKU + ONE child statement for
  // all of them, then the pre-commit re-assertion's one product statement.
  assert.deepEqual(
    state.productReads,
    ['findFirst:sku', 'groupBy:children', 'findMany:sku', 'groupBy:children', 'findMany:blocker-set'],
  )
  assert.equal(
    state.productReads.filter((label) => label === 'findMany:children').length,
    0,
    'never one child query per row — the double can still answer that shape, so its absence is production\'s choice',
  )
  // TWENTY candidates, ONE statement, and it names all twenty: that pair is what "bounded by the
  // rows in hand" means. A per-row version would show 20 entries; the r5 aggregate, none.
  assert.equal(state.childQueryIds.length, 2, 'one child statement per batch, not per row')
  assert.deepEqual(state.childQueryIds[0], ['ims-simple'])
  assert.equal(state.childQueryIds[1]?.length, 20)
  assert.deepEqual(
    [...(state.childQueryIds[1] ?? [])].sort(),
    state.products.filter((row) => row.type === 'VARIANT').map((row) => String(row.id)).sort(),
    'scoped to exactly the 20 candidate rows this transaction read, and to nothing else',
  )
})

test('o3d-y89x r5: a blocker the DECISION saw and the itemisation missed still rolls the import back', async () => {
  // The set-wise decision returns membership, not reasons, so the message is read afterwards for
  // the one row it flagged. Those are different statements, so they can disagree — stock moving
  // 0 -> 5 -> 0 is enough. The re-read is a DESCRIPTION, never a second decision: a connector that
  // let a clean re-read overturn the flag would commit a transform it had already refused, which
  // is the r4-finding-3 mistake pointing the other way.
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))
  variationPages = { '1': [] }
  beforeConflictsRecorded = () => {
    state.salesOrderLines.push({ productId: 'ims-simple' })
  }
  // Statements 1 and 2 are the decision; anything past them is the itemisation.
  beforeBlockerQuery = () => {
    if (state.commitPhaseBlockerStatements > 2) state.salesOrderLines.length = 0
  }

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct({ variations: [] })))

  assert.equal(result.success, false, 'the decision stands even when its reason can no longer be read')
  assert.match(String(result.error), /had already cleared when it was itemised/, 'and says so, rather than inventing a cause')
  assert.match(String(result.error), /rolled back/)
  assert.notEqual(result.permanent, true, 'a blocker that clears itself must stay retryable')
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'SIMPLE', 'the transform is not committed')
})

// ---------------------------------------------------------------------------
// o3d-xbt round 4, finding 1 — A STALE SUCCESSFUL SWEEP MUST NOT ERASE A NEWER
// CONFLICT.
//
// Round 3's merge fixed the sweep that carries NO evidence about another's id.
// It did not fix the sweep whose evidence is real but OLD, and a SUCCESS is
// evidence: "I imported this cleanly" is exactly what takes an id off the list.
// Sweep A imports product 4242 cleanly and spends another twenty minutes on the
// rest of the catalogue. Sweep B starts later, re-imports 4242, hits a conflict,
// takes the lock and writes it. A finally reaches the lock and removes it — on
// evidence, precisely as round 3 requires — and the live conflict is gone with
// the cursor already past the product.
//
// Modelled at the lock for the same reason round 3's merge tests are: that is
// the interleaving `pg_advisory_xact_lock` permits, because it serializes rather
// than excludes.
// ---------------------------------------------------------------------------

test('a stale clean import does NOT erase a conflict a later sweep recorded (o3d-xbt r4, finding 1)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // Carried from an earlier run, and the cursor is long past it: this list is the
  // only record the product exists. Our by-id re-attempt imports it CLEANLY.
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
  productsById = { '4242': simpleProduct({ id: 4242, sku: 'CLEARED-SKU' }) as unknown as Row }

  // The other sweep, finishing between our import and our lock, records a REAL
  // conflict for the same product — stamped after our clean import.
  onConflictListLock = () => {
    state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
    state.settings.set('wc_product_reconcile_conflict_seen_at', JSON.stringify({ 4242: Date.now() + 60_000 }))
  }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(onConflictListLock, null, 'the sweep really did take the lock — the hook fired')
  assert.deepEqual(
    JSON.parse(state.settings.get('wc_product_reconcile_conflict_ids')!),
    [4242],
    'our import succeeded BEFORE that conflict, so it cannot answer it — dropping 4242 loses it for good, cursor already past',
  )
  const stale = state.activity.find((row) => row.action === 'wc_product_sync_stale_clear_ignored')
  assert.ok(stale, 'and a sweep that declines to act on its own successful import says so')
  assert.deepEqual((stale!.metadata as Row).staleClearedExternalProductIds, [4242])
})

test('a conflict recorded BEFORE this run started is still cleared by a clean import', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The mirror: the rule is a comparison, not "a carried id can never be
  // cleared". Without this the list would only ever grow. (The per-id arm — an
  // OVERLAPPING run whose individual evidence still lands later — is pinned in
  // tests/wc-product-conflict-cursor.test.ts, where the two runs' clocks can be
  // stated exactly rather than raced.)
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
  productsById = { '4242': simpleProduct({ id: 4242, sku: 'CLEARED-SKU' }) as unknown as Row }
  onConflictListLock = () => {
    state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
    state.settings.set('wc_product_reconcile_conflict_seen_at', JSON.stringify({ 4242: Date.now() - 60_000 }))
  }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[]', 'ours is the latest thing anyone knows')
  assert.equal(
    state.activity.some((row) => row.action === 'wc_product_sync_stale_clear_ignored'),
    false,
    'nothing was declined, so nothing is reported',
  )
})

test('the stamps are written in the SAME transaction as the list they describe', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[77]')
  const rawStamps = state.settings.get('wc_product_reconcile_conflict_seen_at')
  assert.ok(
    rawStamps !== undefined,
    'the sidecar row must be written beside the list — an absent one silently degrades every later run to "no timestamps", which is the round-3 behaviour this fixes',
  )
  const stamps = JSON.parse(rawStamps!) as Record<string, number>
  assert.deepEqual(Object.keys(stamps), ['77'], 'every carried id is stamped, and only the carried ones')
  assert.ok(stamps['77'] > 0, 'with the moment the conflict was OBSERVED, not a placeholder')
  // A list whose stamps could be read from an older generation of it would be
  // worse than no stamps at all: it would authorise stale clears rather than
  // merely fail to block them.
  assert.equal(
    settingUpsertError,
    null,
    'sanity: this run wrote both rows through the same upsert path the transaction uses',
  )
})

test('a list written by a build with NO stamp row still clears normally', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  // The migration and the rollback case in one: ids carried by an older build
  // were written before this one was deployed, so they really do predate every
  // run that can be in flight, and behaviour is exactly round 3's until the row
  // is first rewritten.
  state.settings.set('wc_product_reconcile_conflict_ids', '[4242]')
  productsById = { '4242': simpleProduct({ id: 4242, sku: 'CLEARED-SKU' }) as unknown as Row }

  await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(state.settings.get('wc_product_reconcile_conflict_ids'), '[]')
  assert.equal(state.settings.get('wc_product_reconcile_conflict_seen_at'), '{}')
})
