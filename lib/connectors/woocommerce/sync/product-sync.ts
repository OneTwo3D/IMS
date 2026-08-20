/**
 * Bidirectional product sync between WooCommerce and IMS.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { decryptSettingValue } from '@/lib/security/encrypted-settings'
import { getSettingValue } from '@/lib/settings-store'
import { wcFetch, wcPut } from '../api'
import { ensureWcCategoryTreeMirrored, resolveImsCategoryId } from './category-mirror'
import { isPermanentProductSyncConflict } from './product-sync-errors'
import {
  WC_PRODUCT_CONFLICT_RETRY_LIMIT,
  capWcProductConflictIds,
  parseWcProductConflictIds,
  shouldAdvanceWcProductCursor,
  wcProductConflictSettingKey,
} from './product-conflict-cursor'
import {
  WC_PRODUCT_WRITE_LOCK_NAMESPACE,
  WC_SETTINGS_VERSION_KEY,
  WC_SYNC_ADVISORY_LOCK_KEY,
  resolveWcProductWriteLockIds,
  wcProductWriteLockKeys,
} from '../sync-lock'
import {
  assertWcRowNotClaimedByAnotherWcObject,
  WcProductTransformBlockedError,
  WcProductWriteRaceError,
  WcSettingsVersionChangedError,
} from './product-sync-errors'
import { validateWooCommerceBaseUrl } from '../url-safety'
import type { ConnectorCredentials } from '../../types'
import { toIsoCountryCode, DEFAULT_COUNTRY_OF_ORIGIN } from '@/lib/countries'
import { invalidateStaleHsProposal } from '@/lib/trade/hs-classification-trigger'
import { clampCustomsDescription } from '@/lib/trade/customs-description'
import {
  deriveLegacyActiveFromLifecycleStatus,
  deriveLifecycleStatusFromWooStatus,
  deriveWooStatusFromLifecycleStatus,
} from '@/lib/products/lifecycle'
import {
  connectorVariationAdoptionChangesStructure,
  decideConnectorParentWrite,
  describeParentShapeNotApplied,
  isConnectorTypeWriteSuppressed,
  refuseVariationAdoption,
  summarizeWcProductStructureConflicts,
  type ConnectorParentWriteDecision,
  type VariationAdoptionRefusal,
  type WcProductStructureConflict,
} from './product-structure-policy'
import {
  findProductsWithTransformBlockers,
  getProductTransformBlockers,
  hasProductTransformBlockers,
  summarizeTransformBlockers,
  PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE,
} from '@/lib/products/type-transforms'
import { bumpFulfillmentGraphVersions } from '@/lib/products/component-graph-edit-guard'
import type { Prisma, ProductType } from '@/app/generated/prisma/client'
import type { WcFullProduct, WcVariation, SyncResult } from './types'

const WEBHOOK_PRIMARY_FRESH_MS = 24 * 60 * 60 * 1000
const MANUAL_PRODUCT_SYNC_JOB_KEY = 'manual_wc_product_sync_job'
const MANUAL_PRODUCT_SYNC_STALE_MS = 30 * 60 * 1000

/**
 * Budget for the single product-write transaction (o3d-uh2). Every remote fetch
 * happens BEFORE the transaction opens, so this covers local writes only: one
 * parent row, N variant rows and the option/sync-log rows. Prisma's 5s default is
 * too tight for a product with several hundred variations, but the ceiling stays
 * low enough that a wedged transaction cannot hold its row locks indefinitely.
 */
const PRODUCT_WRITE_TX_TIMEOUT_MS = 60_000
const PRODUCT_WRITE_TX_MAX_WAIT_MS = 15_000

/**
 * A connector may never silently destroy IMS-owned structure (o3d-y89x, o3d-8s89, o3d-h2cz).
 *
 * The per-type reasoning lives in ./product-structure-policy.ts, next to the allow-list it
 * justifies. What this file adds is the two places the policy is applied — the parent update
 * and applyVariations — and the answer to the question the policy cannot answer on its own:
 * what happens to the WooCommerce data the policy refuses to apply.
 *
 * Two outcomes, and the line between them is whether anything went UNAPPLIED:
 *
 *   - A suppressed `type` write with nothing left over is a WARNING and the sync SUCCEEDS.
 *     An IMS KIT whose WooCommerce twin is `simple` is the ordinary, correct pairing for a
 *     bundle; refusing it would stop that product receiving price and status updates
 *     forever, which is strictly worse than the type being out of step.
 *   - A WooCommerce object that now exists in WooCommerce and NOWHERE in IMS is a
 *     CONFLICT: the sync records it durably, does not mark the product SYNCED, and reports
 *     failure — a PERMANENT one, so the bulk sweep carries its WooCommerce id in the
 *     conflict retry set and re-fetches it by id every run (o3d-xbt; the cursor itself
 *     moves on). See recordStructureConflicts and product-conflict-cursor.ts.
 *
 * Deliberately NOT symmetrical with the create branch: a brand-new IMS row has no structure
 * to protect, so a create takes the WooCommerce type as given.
 */

/**
 * Emitted once per suppressed write, at WARNING. Carries everything needed to find the pair
 * by hand: both ids, the SKU, the IMS type kept and the WC type that was refused. Silence
 * would make the connector look like it agreed with WooCommerce.
 */
function warnImsProductTypePreserved(args: {
  imsProductId: string
  sku: string
  imsType: ProductType
  wcProductId: number | string
  wcType: string | undefined
  suppressedType: string
}): void {
  console.warn('[woocommerce-product-sync] kept IMS product type; connector may not overwrite IMS structure', {
    sku: args.sku,
    imsProductId: args.imsProductId,
    imsType: args.imsType,
    wcProductId: String(args.wcProductId),
    wcType: args.wcType ?? null,
    suppressedType: args.suppressedType,
  })
}

/**
 * The editor's live-row question, asked with the editor's own query (o3d-y89x r2).
 *
 * `getProductTransformBlockers` is what `validateProductStructureChange` runs before it lets
 * an operator change a product's type or parent; the connector performs the SAME two changes
 * (SIMPLE→VARIABLE on the parent branch, SIMPLE→VARIANT + parentId in applyVariations) and
 * used to perform them without asking. Reusing the function rather than restating its five
 * queries is the point: a second copy would drift the moment a new document type is added.
 *
 * Returns the operator-facing summary when the row is live, null when it is clean.
 *
 * `tx` — not the ambient `db` — because this runs inside the write transaction that already
 * holds this SKU's advisory lock, and the answer has to describe the state those locks hold.
 * Callers ask only when a transform is genuinely on the table, so a steady-state re-sync of a
 * 200-variation product still makes zero of these queries.
 */
async function connectorTransformBlockerSummary(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<string | null> {
  const blockers = await getProductTransformBlockers(productId, tx)
  return hasProductTransformBlockers(blockers) ? summarizeTransformBlockers(blockers) : null
}

/**
 * THE BLOCKER QUESTION, ASKED ONCE MORE OVER THE WHOLE SET AS THE TRANSACTION'S LAST ACT
 * (o3d-y89x r4/r5, Codex findings 2 and 1).
 *
 * `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE` rides in each structural UPDATE, so each of those
 * writes is refused by a blocker committed before ITS OWN snapshot. What that leaves is
 * duration: this transaction can transform a parent row and then spend hundreds of variation
 * writes inside the same transaction before it commits, and a blocker committing anywhere in
 * that stretch is seen by neither the write's predicate nor the pre-check.
 *
 * WHAT THIS ACTUALLY GUARANTEES, STATED TO MATCH THE CODE. The r4 wording claimed the
 * re-assertion shrank the exposure "to one statement boundary". For a single transformed row
 * that was true; for a multi-row transform it was FALSE, and this is the third time on this
 * branch that a stated guarantee outran the code. Asked row by row, the re-assertion is 5N
 * statements and the row it checks first stays exposed across the remaining 5(N-1) — so the
 * window was proportional to the number of transformed rows, which for a first-time adoption of
 * a 200-variation parent is ~1,000 statements, not one. What is true now:
 *
 *   - every transformed row is re-read in the SAME TWO statements, whichever row it is and
 *     however many there are (`findProductsWithTransformBlockers`): one grouped read of the open
 *     transfer lines, then one read of the four arms `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE`
 *     expresses, filtered over the whole id set. The window is therefore CONSTANT — two
 *     statements — not proportional to N;
 *   - two statements are two snapshots, not one. A blocker committing between them is seen by
 *     the second and not the first, so the transfer arm is answered as of one statement earlier
 *     than the other four;
 *   - it covers ALL FIVE arms, including the open stock-transfer lines the write predicate
 *     cannot express at all, so the transfer arm is no longer the one weak leg;
 *   - it fails CLOSED. There is no graceful second decision available at this point (the writes
 *     are already in the transaction and re-deciding them would mean redoing the import), so it
 *     throws and the whole transaction rolls back. The next attempt's pre-check finds the
 *     blocker in the ordinary way and refuses it properly, with the operator-facing conflict.
 *
 * WHAT IT STILL DOES NOT DO: close the race. A blocker whose transaction commits after these
 * two reads and before this transaction's COMMIT is invisible here, exactly as it is to the
 * predicate. That is write skew and it needs a lock the blocker writers take, or SERIALIZABLE
 * across all of them — neither exists (see PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE). This bounds
 * the window; it does not remove it, and nothing in this file may claim otherwise.
 *
 * The blocked row's operator-facing WHY is read afterwards, one row at a time, because the set
 * query returns membership only. That read is on a path that has already decided to abort, so
 * it widens nothing. If it finds the row clean again — the blocker cleared between the two
 * statements — this still throws: the set query is the decision and a re-read that disagrees is
 * not a licence to commit. The error stays transient, so the retry re-decides against whatever
 * is true then.
 *
 * Costs nothing in the steady state: `transformed` is empty unless this transaction actually
 * moved a row's `type` or `parentId`, which a re-sync of an established catalogue never does.
 */
async function assertTransformedRowsStillTransformable(
  tx: Prisma.TransactionClient,
  transformed: ReadonlyMap<string, string>,
): Promise<void> {
  if (transformed.size === 0) return

  const blocked = await findProductsWithTransformBlockers([...transformed.keys()], tx)
  if (blocked.size === 0) return

  // Report the first row in INSERTION order — the parent before the variations it adopted — so
  // repeated attempts name the same row rather than whichever one a Set happened to yield first.
  const imsProductId = [...transformed.keys()].find((id) => blocked.has(id))!
  const sku = transformed.get(imsProductId)!
  throw new WcProductTransformBlockedError({
    imsProductId,
    sku,
    summary: await connectorTransformBlockerSummary(tx, imsProductId)
      ?? 'a transform blocker was present at the pre-commit re-read and had already cleared when it was itemised',
    phase: 'commit',
  })
}

/**
 * IS THIS ROW PHYSICALLY A PARENT — i.e. do other rows carry its id in `parentId`? — ASKED
 * UNCONDITIONALLY, AS ONE INDEX-SCOPED STATEMENT PER BATCH OF ROWS (o3d-y89x r4/r5/r6, Codex
 * finding 1 in r4, r5 and r6).
 *
 * It cannot be answered from the row's own columns — a row's children are different rows, with
 * different SKUs — and it must not be inferred from `type`, because the shapes it exists to
 * catch are exactly the ones whose type does not admit that they have children. Nothing in the
 * schema enforces that only a VARIABLE row may have children, and the pre-o3d-y89x connector
 * could mint a SIMPLE-with-children row by flattening a VARIABLE without deleting its variants.
 * So the question is unconditional: r4's *conditional* child query is what missed the legacy
 * row in the steady-state re-sync of a WooCommerce `simple` product.
 *
 * WHAT THE QUERY ACTUALLY IS, AND WHAT IT COSTS. r5 folded the question into the row lookup as
 * Prisma's relation `_count`, on the belief that Prisma renders it as a correlated aggregate
 * inside the same statement. IT DOES NOT. Probed against this repo's own checked-in client
 * (Prisma 7.x, `@prisma/adapter-pg`), `include: { _count: { select: { variants: true } } }`
 * renders as
 *
 *     SELECT products.*, COALESCE(aggr._aggr_count_variants, 0)
 *       FROM products
 *       LEFT JOIN (SELECT "parentId", COUNT(*) AS _aggr_count_variants
 *                    FROM products WHERE 1=1 GROUP BY "parentId") aggr
 *              ON products.id = aggr."parentId"
 *      WHERE products.sku = $1
 *
 * The aggregate subquery is UNCORRELATED — the SKU predicate stays on the outer query, and
 * Postgres cannot push a join qual into a grouped subquery — so every lookup aggregates the
 * ENTIRE products table. `EXPLAIN (ANALYZE, BUFFERS)` on the dev catalogue (2,283 rows) gives
 * `Seq Scan on products` + `HashAggregate` over all 2,283 rows, 119 shared buffers, 0.905 ms.
 * One statement, catalogue-sized — and the reconcile runs one transaction per catalogue
 * product, so that is O(N) whole-table scans over an O(N) table. It was strictly worse than
 * the round trip it removed.
 *
 * So the question is its own statement again, but ONE statement per batch of rows, scoped to
 * exactly the ids that batch has in hand:
 *
 *     SELECT "parentId" FROM products WHERE "parentId" IN ($1, ...) GROUP BY "parentId"
 *
 * On the same data: `Bitmap Index Scan on products_parentId_idx` -> `Group`, 7 shared buffers,
 * 0.078 ms. `Product.parentId` is indexed (`@@index([parentId])`) and that index is what it
 * uses, so its cost is bounded by the CHILDREN OF THE ROWS ASKED ABOUT and by nothing else —
 * it does not grow with the catalogue. GROUPED, not selected raw: r4 returned one row per
 * child (a 200-variant parent transferring 200 rows to compute a boolean), this returns at
 * most one row per candidate. And ONE statement per batch, not per row: `applyVariations` asks
 * about all its candidate rows together, so a 200-variation import pays one, not 200.
 *
 * What it does not do is ride along free. The parent branch pays one extra round trip per
 * existing product on a full reconcile. That is the honest price of the correctness, and on
 * the measurement above it is about 1/17th of the buffers and 1/12th of the time of the
 * version that appeared free — before counting that the free version's cost grows with the
 * catalogue and this one's does not.
 *
 * Shared rather than duplicated because the two rules disagreeing is the failure mode: r3 asked
 * the physical question in `refuseVariationAdoption` (a variation may not swallow a parent) and
 * the TYPE question in the parent branch's shape rule, so the identical legacy row was refused
 * by one door and flattened by the other. Both doors now read this one accessor, off a row
 * carried through `withConnectorChildFlags` — a row that never went through it THROWS rather
 * than quietly answering "no children", because "nobody asked" and "genuinely childless" are
 * the exact pair Codex r4 finding 1 was about.
 *
 * IT IS STILL A SELECT, AND IT IS STILL NOT ATOMIC WITH THE WRITES THAT FOLLOW. Codex r4
 * suggested pinning it into the UPDATE as `variants: { none: {} }`; that is not done, and the
 * reason is the same one written out at length on the blocker predicate: a predicate would move
 * the boundary by one statement, not close the race, and the three writers of `Product.parentId`
 * (this sync, the editor, the CSV import) all take per-SKU advisory locks on the CHILD's SKU —
 * never on this row's — so no lock serializes it either. What that residual costs is bounded and
 * self-correcting: a child row appearing between this read and the commit means WooCommerce's
 * simple price lands on a row that has just become a parent, and the NEXT sync of the pairing
 * sees the child and quarantines it. Nothing structural is written on that path, because the
 * paths that DO write structure are the ones this answer refuses.
 */
type ConnectorRowChildFlag = { hasChildren: boolean }

async function withConnectorChildFlags<T extends { id: string }>(
  tx: Prisma.TransactionClient,
  rows: readonly T[],
): Promise<Array<T & ConnectorRowChildFlag>> {
  if (rows.length === 0) return []
  const parentRows = await tx.product.groupBy({
    by: ['parentId'],
    where: { parentId: { in: rows.map((row) => row.id) } },
  })
  const parents = new Set(
    parentRows.map((row) => row.parentId).filter((id): id is string => typeof id === 'string'),
  )
  return rows.map((row) => ({ ...row, hasChildren: parents.has(row.id) }))
}

function imsRowHasChildren(row: { id: string; hasChildren?: boolean }): boolean {
  if (typeof row.hasChildren !== 'boolean') {
    throw new Error(
      `IMS product ${row.id} was read without its child flag, so the connector's structural `
      + 'rules cannot be decided for it. Carry it through `withConnectorChildFlags`.',
    )
  }
  return row.hasChildren
}

/**
 * The durable, operator-facing record of a structural conflict, and its resolution.
 *
 * A `console.warn` is invisible inside the app: every sync of the pair logs it again and
 * nobody ever sees one (o3d-fjqk). This writes the conflict where the exception inbox
 * already looks — `/sync/exceptions` reads QUARANTINED FROM_CONNECTOR Product rows — reusing
 * the same ShoppingSyncLog + QUARANTINED shape the parked WooCommerce refunds use rather
 * than inventing a second mechanism.
 *
 * Three properties matter, and each is a line of code here:
 *
 *   1. DEDUPLICATED. The delete runs on EVERY sync, conflict or not, so a product cannot
 *      accumulate one open row per reconcile run. It is keyed on either side of the pairing
 *      (the IMS row OR the WooCommerce object) so a re-pairing cannot strand the old row.
 *      Both arms are indexed — `[connector, entityType, entityId]` and
 *      `[connector, externalId, createdAt]` — so this stays a BitmapOr of two index scans on
 *      a table that grows by a row per sync, rather than a scan of the whole sync log.
 *   2. SELF-RESOLVING. Because the delete is unconditional, the sync that finally succeeds —
 *      after an operator converts the IMS product or fixes the SKU in WooCommerce — clears
 *      the exception as a side effect of working. There is no "acknowledge" button to click
 *      and therefore no way to acknowledge a conflict that is still live.
 *   3. NOT SYNCED. The SYNCED log row is written only on the clean path. A conflicted
 *      product is not a synced product, and the caller's cursor decision reads that.
 */
const WC_PRODUCT_STRUCTURE_CONFLICT_STATUS = 'QUARANTINED' as const

async function recordStructureConflicts(
  tx: Prisma.TransactionClient,
  args: {
    productId: string
    wcProductId: number
    conflicts: readonly WcProductStructureConflict[],
  },
): Promise<void> {
  await tx.shoppingSyncLog.deleteMany({
    where: {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR',
      entityType: 'Product',
      status: WC_PRODUCT_STRUCTURE_CONFLICT_STATUS,
      OR: [{ entityId: args.productId }, { externalId: String(args.wcProductId) }],
    },
  })

  if (args.conflicts.length === 0) {
    await tx.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: args.productId,
        externalId: String(args.wcProductId),
        syncedAt: new Date(),
      },
    })
    return
  }

  await tx.shoppingSyncLog.create({
    data: {
      direction: 'FROM_CONNECTOR',
      status: WC_PRODUCT_STRUCTURE_CONFLICT_STATUS,
      entityType: 'Product',
      entityId: args.productId,
      externalId: String(args.wcProductId),
      errorMessage: summarizeWcProductStructureConflicts(args.conflicts),
      // Same JSON round-trip the TO_CONNECTOR log uses: the structured detail survives for
      // anyone reading the row directly, without the readonly tuple types fighting Prisma's
      // InputJsonValue.
      payload: JSON.parse(JSON.stringify({ reason: 'product_structure_conflict', conflicts: args.conflicts })),
    },
  })
}

export type ManualProductSyncProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  productsProcessed: number
  productsImported: number
  productsSkipped: number
  totalProducts: number
  currentPage: number
  totalPages: number
  errors: string[]
  startedAt?: string
  updatedAt?: string
}

type ProductSyncProgressSnapshot = {
  message: string
  processed: number
  synced: number
  skipped: number
  totalProducts: number
  currentPage: number
  totalPages: number
  errors: string[]
}

const INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS: ManualProductSyncProgress = {
  status: 'idle',
  message: '',
  productsProcessed: 0,
  productsImported: 0,
  productsSkipped: 0,
  totalProducts: 0,
  currentPage: 0,
  totalPages: 0,
  errors: [],
}

async function saveManualProductSyncProgress(progress: ManualProductSyncProgress) {
  await db.setting.upsert({
    where: { key: MANUAL_PRODUCT_SYNC_JOB_KEY },
    create: { key: MANUAL_PRODUCT_SYNC_JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getManualWcProductSyncProgress(): Promise<ManualProductSyncProgress> {
  const row = await db.setting.findUnique({ where: { key: MANUAL_PRODUCT_SYNC_JOB_KEY } })
  if (!row?.value) return INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS
  try {
    return JSON.parse(row.value) as ManualProductSyncProgress
  } catch {
    return INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS
  }
}

export async function startManualWcProductSync(): Promise<void> {
  const current = await getManualWcProductSyncProgress()
  if (current.status === 'running') {
    const updatedAt = current.updatedAt ? Date.parse(current.updatedAt) : NaN
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < MANUAL_PRODUCT_SYNC_STALE_MS) return
  }

  const progress: ManualProductSyncProgress = {
    ...INITIAL_MANUAL_PRODUCT_SYNC_PROGRESS,
    status: 'running',
    message: 'Preparing WooCommerce product import...',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveManualProductSyncProgress(progress)

  after(() => runManualWcProductSync(progress).catch(async (error) => {
    progress.status = 'error'
    progress.message = error instanceof Error ? error.message : String(error)
    progress.errors = [...progress.errors, progress.message]
    await saveManualProductSyncProgress(progress)
  }))
}

async function runManualWcProductSync(progress: ManualProductSyncProgress) {
  const result = await syncAllWcProducts({
    mode: 'manual_reconcile',
    onProgress: async (snapshot) => {
      progress.status = 'running'
      progress.message = snapshot.message
      progress.productsProcessed = snapshot.processed
      progress.productsImported = snapshot.synced
      progress.productsSkipped = snapshot.skipped
      progress.totalProducts = snapshot.totalProducts
      progress.currentPage = snapshot.currentPage
      progress.totalPages = snapshot.totalPages
      progress.errors = snapshot.errors
      progress.updatedAt = new Date().toISOString()
      await saveManualProductSyncProgress(progress)
    },
  })

  progress.status = 'done'
  progress.productsProcessed = Math.max(progress.productsProcessed, result.synced + result.skipped)
  progress.productsImported = result.synced
  progress.productsSkipped = result.skipped
  progress.errors = result.errors
  progress.updatedAt = new Date().toISOString()

  const totalProducts = progress.totalProducts || (result.synced + result.skipped)
  if (totalProducts > 0) {
    const parts = [`Imported ${result.synced} of ${totalProducts} product(s)`]
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
    if (result.errors.length > 0) parts.push(`${result.errors.length} errors`)
    progress.message = parts.join(' · ')
  } else if (result.errors.length > 0) {
    progress.message = `WooCommerce product import failed: ${result.errors[0]}`
  } else {
    progress.message = 'No WooCommerce products found'
  }

  await saveManualProductSyncProgress(progress)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

// Trade fields (HS code / country-of-origin / customs description) are owned upstream by
// hs-code-woo, which writes authoritative WC pa_* attributes. Policy: WC wins when present.
// When WC supplies a differing value we overwrite IMS (so re-classifications/corrections
// propagate); when WC omits the attribute we preserve the existing IMS value (never null it).
// Inputs are expected already-trimmed (see asTrimmedString / toIsoCountryCode at the call
// site); an empty string is treated as absent via truthiness.
export const WC_TRADE_FIELDS = ['hsCode', 'countryOfOrigin', 'customsDescription'] as const
export type WcTradeField = (typeof WC_TRADE_FIELDS)[number]
export type WcTradeSnapshot = Record<WcTradeField, string | null>
export type WcTradeFieldChange = { field: WcTradeField; from: string | null; to: string }

export function resolveWcTradeFieldUpdates(
  existing: WcTradeSnapshot,
  incoming: WcTradeSnapshot,
): WcTradeFieldChange[] {
  const changes: WcTradeFieldChange[] = []
  for (const field of WC_TRADE_FIELDS) {
    const next = incoming[field]
    // WC value absent/empty -> preserve IMS; present and different -> overwrite.
    if (next && next !== existing[field]) {
      changes.push({ field, from: existing[field], to: next })
    }
  }
  return changes
}

/** Parse a WC numeric-ish value, returning null if empty/NaN. */
function parseNum(val: unknown): number | null {
  const normalized = asTrimmedString(val)
  if (!normalized) return null
  const n = parseFloat(normalized)
  return Number.isNaN(n) ? null : n
}

function getFirstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  for (const image of images) {
    if (image && typeof image === 'object' && 'src' in image) {
      const src = asTrimmedString((image as { src?: unknown }).src)
      if (src) return src
    }
  }
  return null
}

function normalizeAttributeOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options
    .map((option) => asTrimmedString(option))
    .filter((option): option is string => Boolean(option))
}

/** Search WC product attributes array by name (case-insensitive, ignores underscores/spaces), return first option value. */
function getWcAttribute(
  attrs: WcFullProduct['attributes'] | undefined,
  ...names: string[]
): string | null {
  if (!Array.isArray(attrs)) return null
  const normalise = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '')
  const targets = names.map(normalise)
  const attr = attrs.find((a) => {
    const name = asTrimmedString(a?.name)
    return name ? targets.includes(normalise(name)) : false
  })
  return attr ? normalizeAttributeOptions(attr.options)[0] ?? null : null
}

async function snapshotProductSyncContext(): Promise<{
  creds: ConnectorCredentials | null
  syncVersion: string
}> {
  return db.$transaction(async (tx) => {
    // SHARED, not exclusive: this path only READS the settings. The rebind/reset writers
    // take the lock exclusively (app/actions/wc-sync.ts), so shared still blocks them —
    // which is the whole guarantee — while letting concurrent imports proceed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const rows = await tx.setting.findMany({
      where: {
        key: { in: ['wc_url', 'wc_consumer_key', 'wc_consumer_secret', WC_SETTINGS_VERSION_KEY] },
      },
    })
    const map = new Map(rows.map((row) => [row.key, row.value]))
    const url = map.get('wc_url')
    const key = map.get('wc_consumer_key')
    const secret = map.get('wc_consumer_secret')
    const syncVersion = map.get(WC_SETTINGS_VERSION_KEY) ?? '0'
    const validatedUrl = url ? validateWooCommerceBaseUrl(url) : null
    const creds: ConnectorCredentials | null = validatedUrl?.ok && key && secret
      ? { url: validatedUrl.normalizedUrl, key, secret: decryptSettingValue('wc_consumer_secret', secret) }
      : null
    return { creds, syncVersion }
  })
}

async function ensureWcSettingsVersionMatches(expectedVersion: string): Promise<{
  ok: true
} | {
  ok: false
  currentVersion: string
}> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
    const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
    const currentVersion = row?.value ?? '0'
    if (currentVersion !== expectedVersion) {
      return { ok: false as const, currentVersion }
    }
    return { ok: true as const }
  })
}

type MappingFailure =
  | { ok: false; reason: 'version_changed' }
  | { ok: false; reason: 'mapping_changed' }
  | { ok: false; reason: 'error'; error: string }

function describeMappingFailure(failure: MappingFailure, sku: string): string {
  switch (failure.reason) {
    case 'version_changed':
      return `WooCommerce settings changed while resolving ${sku}`
    case 'mapping_changed':
      // Another writer claimed this product while we were resolving it against WooCommerce. The
      // push is abandoned rather than overwriting them; the next run reads the winning mapping.
      return `WooCommerce mapping for ${sku} was claimed by another sync while resolving it`
    default:
      return failure.error
  }
}

/**
 * Claim `externalProductId` for a product that had none.
 *
 * Both callers reach here only inside `if (!resolvedId)` — i.e. having read a NULL mapping and
 * then gone to WooCommerce to resolve one. That premise is re-asserted in the write itself
 * (o3d-fsi): the update matches only while the mapping is still null.
 *
 * Without that predicate this is a one-sided race against the import path. If this resolver read
 * null, then blocked behind `updateProductGuardingOwnership`, Postgres would resume this UPDATE
 * after the importer committed and overwrite the id the importer just claimed — leaving a row
 * carrying one WooCommerce object's `parentId`/`type` and another's `externalProductId`. The
 * importer's guard cannot prevent that on its own; the other writer has to stop overwriting.
 */
async function persistMappingIfVersionMatches(
  productId: string,
  externalId: number,
  expectedVersion: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'version_changed' }
  | { ok: false; reason: 'mapping_changed' }
  | { ok: false; reason: 'error'; error: string }
> {
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const row = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
      const currentVersion = row?.value ?? '0'
      if (currentVersion !== expectedVersion) {
        return { ok: false as const, reason: 'version_changed' as const }
      }
      const { count } = await tx.product.updateMany({
        // Re-affirming the same id is a no-op we still want to succeed; anything else means
        // another writer claimed this product while we were resolving it.
        where: {
          id: productId,
          OR: [{ externalProductId: null }, { externalProductId: BigInt(externalId) }],
        },
        data: { externalProductId: BigInt(externalId) },
      })
      if (count === 0) return { ok: false as const, reason: 'mapping_changed' as const }
      return { ok: true as const }
    })
  } catch (error) {
    return { ok: false as const, reason: 'error' as const, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// WC → IMS product sync
// ---------------------------------------------------------------------------

/**
 * Import one WooCommerce product (and, for VARIABLE products, all of its
 * variations) into IMS.
 *
 * Ordering contract (o3d-uh2) — the whole point of this function's shape:
 *
 *   1. Everything remote happens FIRST: the category mirror and *every*
 *      variations page are fetched and validated before a single row is
 *      written. A page that fails throws here, while the database is still
 *      untouched.
 *   2. Everything local happens inside ONE transaction: parent, variants,
 *      product options and the SYNCED log commit together or not at all.
 *      Previously the parent was written first and each variations page as it
 *      arrived, so a mid-sync failure left a parent with no variants, or a
 *      parent with a mix of freshly-written and stale variants.
 *   3. That transaction opens with a per-SKU advisory lock, so two workers
 *      importing the same product serialize instead of both taking the create
 *      branch and one dying on a P2002 (see WC_PRODUCT_WRITE_LOCK_NAMESPACE).
 *   4. Only fire-and-forget/audit side effects run after the commit.
 *
 * No HTTP call may move inside the transaction: it holds row locks, and a slow
 * WooCommerce would hold them for the length of the request.
 *
 * `permanent: true` on a failure means re-running this identical payload re-hits the identical
 * conflict, so the caller should acknowledge and report it rather than retry (o3d-gtk; see
 * product-sync-errors.ts for why only barcode/externalProductId qualify).
 *
 * CREDENTIAL-REBIND FENCE (o3d-mlc7). This function now participates in the two-part fence
 * described in sync-lock.ts, which it previously sat outside: it took the per-SKU locks but
 * never WC_SYNC_ADVISORY_LOCK_KEY and never read `wc_settings_version`, so an import carrying
 * store-A data could resume after a rebind/reset and repopulate store-A external ids against
 * store-B credentials. The o3d-fsi ownership guard does not help — it treats a wiped (null)
 * mapping as adoptable, which is exactly what the wipe produces.
 *
 * Four things make that race impossible, and they have to happen in this order:
 *
 *   1. Snapshot the credentials AND the settings version together, under the advisory lock,
 *      BEFORE any remote read.
 *   2. Use those PINNED credentials for every remote read — the variations pages and the
 *      category tree — so one import cannot mix store-A parent data with store-B variations.
 *   3. Take WC_SYNC_ADVISORY_LOCK_KEY as the write transaction's FIRST statement, before the
 *      per-SKU lock ids. A fixed order between the two lock families is what stops them
 *      deadlocking against each other.
 *   4. Re-read the version inside that transaction and abandon the import if it moved — the
 *      same contract stock sync already honours.
 */
export async function syncWcProductToIms(
  wcProduct: WcFullProduct,
  /**
   * The `wc_settings_version` that was current when THIS PAYLOAD was obtained.
   *
   * The payload arrives already fetched, so snapshotting inside this function only fences
   * the variations and the write — a parent page pulled from store A before a rebind would
   * still be written under store-B settings that look perfectly stable from in here (Codex
   * review). Callers that fetched the payload themselves pass the version they fetched it
   * under; a mismatch means the payload is stale and none of it may be written.
   */
  observedVersion?: string,
): Promise<{ success: boolean; error?: string; permanent?: boolean }> {
  try {
    const sku = asTrimmedString(wcProduct.sku)
    if (!sku) return { success: true } // skip products without SKU

    // Fence step 1 (o3d-mlc7): credentials and settings version snapshotted TOGETHER under
    // the advisory lock, before a single remote read. Taking them separately would let a
    // rebind slip between the two and pin credentials to the wrong version.
    const { creds: pinnedCreds, syncVersion } = await snapshotProductSyncContext()

    // The payload predates this snapshot. If the version moved in between, it describes the
    // previous store and nothing in it may be written — the same refusal as the write-time
    // check, applied to the one input this function did not fetch itself.
    if (observedVersion !== undefined && observedVersion !== syncVersion) {
      throw new WcSettingsVersionChangedError(observedVersion, syncVersion)
    }

    // --- Shared field extraction ---
    const description = stripHtml(wcProduct.short_description || wcProduct.description || '')
    const salesPriceBase = parseNum(wcProduct.regular_price)
    const salePriceBase = parseNum(wcProduct.sale_price)
    const weight = parseNum(wcProduct.weight)
    const depthCm = parseNum(wcProduct.dimensions?.length)   // WC "length" = depth
    const widthCm = parseNum(wcProduct.dimensions?.width)
    const heightCm = parseNum(wcProduct.dimensions?.height)
    const imageUrl = getFirstImageUrl(wcProduct.images)
    const gtin = asTrimmedString(wcProduct.global_unique_id)

    // Customs fields from WC attributes
    const hsCodeAttr = asTrimmedString(getWcAttribute(wcProduct.attributes, 'hs_code', 'hs code', 'hscode'))
    const originAttr = getWcAttribute(wcProduct.attributes, 'country_of_origin', 'Country of Origin', 'coo')
    const originIso = toIsoCountryCode(originAttr)
    const customsDescriptionRaw = asTrimmedString(getWcAttribute(wcProduct.attributes, 'customs_description', 'customs description', 'customsdescription'))
    // Cap at the downstream WMS 50-char customs-description limit on the way in,
    // so the stored value matches what we can push downstream (and never blocks
    // a WMS product create). Preserve null/blank so "WC omitted it" semantics
    // are unchanged.
    const customsDescriptionAttr = customsDescriptionRaw ? clampCustomsDescription(customsDescriptionRaw) : customsDescriptionRaw

    // Product type mapping
    const productType = wcProduct.type === 'variable' ? 'VARIABLE' : 'SIMPLE'

    // Mirror WC's category tree once per sync run (cached) and resolve this product's
    // IMS ProductCategory id — preferring the WC primary category (Yoast / Rank Math)
    // and falling back to the deepest mapped category. Fails open: if the WC categories
    // endpoint is unreachable, leave categoryId untouched.
    const wcCategories = Array.isArray(wcProduct.categories) ? wcProduct.categories : []
    let imsCategoryId: string | null | undefined
    if (wcCategories.length > 0) {
      const mirror = await ensureWcCategoryTreeMirrored(pinnedCreds, syncVersion)
      if (mirror) imsCategoryId = resolveImsCategoryId(wcCategories, wcProduct.meta_data, mirror)
    }

    // --- Remote reads: ALL of them, before anything is written (o3d-uh2) ---
    // A variations page that fails throws from here, leaving the catalog untouched.
    const isVariable = wcProduct.type === 'variable' && wcProduct.variations?.length > 0
    const variations = isVariable ? await fetchAllWcVariations(wcProduct.id, pinnedCreds) : []

    const variationAttrs = Array.isArray(wcProduct.attributes)
      ? wcProduct.attributes.filter((a) => a.variation)
      : []

    // Every SKU this transaction will write (o3d-fsi). Computed out here because the
    // variations are already in hand — the lock set has to be complete BEFORE the first
    // lookup, not discovered as applyVariations walks. Resolved to sorted advisory-lock
    // ids outside the transaction: hashtext is pure, so this needs no snapshot, and the
    // ids (not the SKU strings) are what has to be acquired in a single global order.
    const lockIds = await resolveWcProductWriteLockIds(
      db,
      wcProductWriteLockKeys(
        sku,
        variations.map((v) => asTrimmedString(v.sku)).filter((s): s is string => Boolean(s)),
      ),
    )

    // --- Local writes: all of them, in ONE transaction ---
    const { syncedProductId, syncedSku, tradeChanges, wasUpdate, structureConflicts } = await db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Fence step 3 (o3d-mlc7): the settings lock comes FIRST, before any per-SKU lock.
        // Both families are taken inside this transaction, so a fixed order between them is
        // what keeps them from deadlocking against each other.
        //
        // SHARED mode matters here. This transaction can run for up to
        // PRODUCT_WRITE_TX_TIMEOUT_MS (60s) on a product with hundreds of variations, and
        // taking the GLOBAL settings key exclusively for that long would serialize every
        // unrelated product import behind it — a contention regression, not a safety gain
        // (Codex review). Imports do not need to exclude each other; the per-SKU locks below
        // already do that. They only need to stop a rebind committing underneath them, and a
        // shared lock does exactly that, because the rebind writers take it exclusively.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${WC_SYNC_ADVISORY_LOCK_KEY})`

        // Fence step 4: with that lock held, the version cannot move under us. If it moved
        // while we were reading WooCommerce, everything in hand describes the OLD store and
        // must not be written — abandon rather than repopulate a wiped mapping.
        const versionRow = await tx.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY } })
        const currentVersion = versionRow?.value ?? '0'
        if (currentVersion !== syncVersion) {
          throw new WcSettingsVersionChangedError(syncVersion, currentVersion)
        }

        // Serialize concurrent syncs touching ANY of these SKUs so the find-then-create
        // below cannot race another WC sync into a P2002, and so two parents sharing a
        // variation SKU cannot both take the create branch (o3d-uh2, o3d-fsi).
        //
        // Acquired one statement at a time, ascending by lock id: that order is the
        // deadlock-freedom argument, and a single set-returning statement would leave the
        // acquisition sequence up to the planner. The extra round trips are proportionate
        // — applyVariations already makes one per variant.
        for (const lockId of lockIds) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_PRODUCT_WRITE_LOCK_NAMESPACE}::int4, ${lockId}::int4)`
        }

        // The child question follows this lookup as its own index-scoped statement: see
        // `withConnectorChildFlags` for why it is unconditional, and for the measurement that
        // says folding it into this lookup as `_count` cost a whole-catalogue aggregate.
        const existingRow = await tx.product.findFirst({ where: { sku } })
        const existing = existingRow
          ? (await withConnectorChildFlags(tx, [existingRow]))[0]
          : null
        // Never reassign a row another WooCommerce object already maps (o3d-fsi): the
        // update branch below overwrites type/parentId/externalProductId. Checked here so a
        // conflict fails BEFORE any write, and re-checked atomically inside the update itself.
        const parentClaimants = new Set([BigInt(wcProduct.id)])
        if (existing) assertWcRowNotClaimedByAnotherWcObject(existing, parentClaimants)
        const lifecycleStatus = deriveLifecycleStatusFromWooStatus(
          wcProduct.status,
          existing?.lifecycleStatus ?? null,
        )
        const active = deriveLegacyActiveFromLifecycleStatus(lifecycleStatus)

        let productId: string
        let productSku: string
        let changes: WcTradeFieldChange[] = []
        /**
         * ONE decision covering every write whose correctness depends on the row really being
         * the shape WooCommerce described (o3d-y89x r2): the `type` column, the row's own
         * price columns, its variable-only ProductOption rows and its children.
         *
         * r1 guarded only `type`, so a refused adoption still erased the protected row's
         * pricing and gave it variable-only options — the type survived and everything around
         * it was rewritten anyway. Gating them together is what makes a refusal mean the row
         * is left alone.
         *
         * Seeded with the create-branch answer (WooCommerce decides, because a new row has no
         * structure to protect) and replaced below when there is an existing row.
         */
        let parentWrite: ConnectorParentWriteDecision =
          decideConnectorParentWrite({ row: null, incoming: productType, rowHasChildren: false })
        const structureConflicts: WcProductStructureConflict[] = []
        /**
         * Every EXISTING row this transaction structurally transformed — moved `type`, or
         * `parentId`, or both — by IMS product id, carrying its SKU for the message
         * (o3d-y89x r4, Codex finding 2).
         *
         * Collected so the blocker question can be re-asserted once more as this transaction's
         * last act; see `assertTransformedRowsStillTransformable`. Created rows are deliberately
         * absent: a row this transaction inserted cannot have acquired stock or open documents
         * from anyone else.
         */
        const structurallyTransformed = new Map<string, string>()

        if (existing) {
          // o3d-y89x: the row's structural identity is IMS-owned; a connector may not decide
          // it. `type` is therefore omitted from the update entirely on a protected row —
          // omitted, not set to `existing.type`, so the column is never named in the UPDATE at
          // all — while every other field below still applies.
          //
          // Decided in two passes so the live-row query is only paid for when a transform is
          // actually on the table: the first pass answers from the row alone plus the child
          // query, and says whether the editor's question is even relevant.
          //
          // The child question is NOT conditional (o3d-y89x r4, Codex finding 1). Whether this
          // row is physically a parent decides the shape rule in BOTH directions — including the
          // steady-state re-sync of a WooCommerce `simple` product, which is precisely where a
          // legacy SIMPLE-with-children row was being priced and marked SYNCED. It costs no
          // query at all: the count came back with the row above (r5).
          const existingHasChildren = imsRowHasChildren(existing)
          parentWrite = decideConnectorParentWrite({
            row: existing,
            incoming: productType,
            rowHasChildren: existingHasChildren,
          })
          if (parentWrite.needsTransformBlockerCheck) {
            const transformBlockerSummary = await connectorTransformBlockerSummary(tx, existing.id)
            if (transformBlockerSummary) {
              parentWrite = decideConnectorParentWrite({
                row: existing,
                incoming: productType,
                rowHasChildren: existingHasChildren,
                transformBlockerSummary,
              })
            }
          }

          // Trade fields — hs-code-woo (WC pa_*) is authoritative: overwrite IMS when WC supplies
          // a differing value so re-classifications propagate; preserve IMS when WC omits it.
          // Independent of the structural decision, so it is resolved once even if the write
          // below has to be decided a second time.
          changes = resolveWcTradeFieldUpdates(
            {
              hsCode: existing.hsCode,
              countryOfOrigin: existing.countryOfOrigin,
              customsDescription: existing.customsDescription,
            },
            { hsCode: hsCodeAttr, countryOfOrigin: originIso, customsDescription: customsDescriptionAttr },
          )

          /**
           * The parent row's UPDATE, as a function of the structural decision (o3d-y89x r3).
           *
           * Built here rather than inline because the decision can be reached TWICE: once from
           * the pre-write blocker check, and again if the conditional write below discovers a
           * blocker that appeared in between. Deriving the write from the decision both times is
           * what makes the late refusal produce the identical row the early one would have —
           * rather than a second, hand-maintained "what do we write when it is blocked?" path.
           */
          const buildParentUpdateData = (decision: ConnectorParentWriteDecision): Record<string, unknown> => {
            const updateData: Record<string, unknown> = {
              name: wcProduct.name,
              description: description || existing.description,
              imageUrl: imageUrl ?? existing.imageUrl,
              weight: weight ?? existing.weight,
              depthCm: depthCm ?? existing.depthCm,
              widthCm: widthCm ?? existing.widthCm,
              heightCm: heightCm ?? existing.heightCm,
              active,
              lifecycleStatus,
              ...(decision.suppressTypeWrite ? {} : { type: productType }),
              externalProductId: BigInt(wcProduct.id),
            }

            // Prices — only when IMS and WooCommerce AGREE on the row's shape. A variable parent
            // shows min-max from its variants and carries none of its own; a standalone product
            // carries exactly these. On a disagreement neither arm is right, so the columns are
            // left untouched rather than cleared by WooCommerce's refused belief.
            if (decision.wooShapeAgrees) {
              if (productType !== 'VARIABLE') {
                if (salesPriceBase !== null) updateData.salesPriceBase = salesPriceBase
                if (salePriceBase !== null) updateData.salePriceBase = salePriceBase
              } else {
                updateData.salesPriceBase = null
                updateData.salePriceBase = null
              }
            }

            // GTIN — only set if IMS field is currently null/empty
            if (gtin && !existing.barcode) updateData.barcode = gtin

            for (const change of changes) {
              updateData[change.field] = change.to
            }

            // Category — link to mirrored IMS category for the deepest WC category
            // referenced by this product. If WC dropped all categories, clear the link.
            if (imsCategoryId !== undefined) updateData.categoryId = imsCategoryId

            return updateData
          }

          /**
           * Write the parent row under BOTH conditions the decision depends on: the ownership
           * predicate, and — when this write really moves `type` — the editor's live-row
           * predicate, evaluated by Postgres in the same statement (o3d-y89x r3/r4).
           *
           * WHAT THE PREDICATE ACTUALLY BUYS. The pre-check is a SELECT, so its answer is a
           * statement about the past by the time the UPDATE runs. ANDing the predicate into the
           * UPDATE moves the boundary to POSTGRES' snapshot for that statement: a blocker
           * committed before it makes the UPDATE match zero rows, and the transform is
           * re-decided WITH the blocker instead of committed without it — the same refusal,
           * message and quarantine the pre-check produces, just discovered later. It is a
           * fail-closed re-assertion, and that is the whole of it.
           *
           * WHAT IT DOES NOT BUY, precisely — the r3 text claimed this made the connector
           * "exactly as safe as `updateProduct`, and no safer", and that was wrong in both
           * directions (Codex r4 finding 2):
           *
           *   - IT DOES NOT CLOSE THE RACE, FOR ANY ARM. Under READ COMMITTED a blocker
           *     transaction still uncommitted when this UPDATE takes its snapshot, but committed
           *     before THIS transaction commits, is invisible here and this transform is
           *     invisible to it. That is write skew. A predicate cannot see it.
           *   - SERIALIZABLE ON THIS TRANSACTION ALONE WOULD NOT CLOSE IT EITHER. Postgres'
           *     SSI guarantees hold only among transactions that are ALL serializable, and every
           *     blocker writer runs READ COMMITTED, so that remedy is a change to all of them.
           *   - A SHARED LOCK WOULD CLOSE IT, AND THERE IS NONE. The per-SKU advisory locks are
           *     taken only by the `Product.sku` writers (this sync, the editor, the CSV import);
           *     no stock receipt, allocation or document writer takes any lock this transaction
           *     contends on. Inventing a product-scoped lock here would be worse than useless —
           *     it is only sound once every blocker writer takes it too.
           *   - OPEN STOCK TRANSFER LINES ARE NOT IN THE PREDICATE AT ALL. `StockTransferLine`
           *     carries no FK to Product by design, so Prisma has no relation to filter through.
           *     That arm is answered by the pre-check SELECT, one statement earlier than the
           *     other four.
           *
           * SO THE RESIDUAL IS NARROWED, NOT REMOVED, and it is narrowed twice: here, to this
           * statement's snapshot, and again by `assertTransformedRowsStillTransformable` as the
           * transaction's last act — without which the exposure would run from this statement
           * through potentially hundreds of variation writes to COMMIT. What survives both is
           * genuine write skew: a blocker committing after that final re-read and before this
           * transaction commits. The editor carries the same residual, from the same cause; the
           * connector's is narrower by one statement on four arms and equal on the fifth.
           * Neither is race-free and neither may claim to be.
           */
          const writeParentRow = async (decision: ConnectorParentWriteDecision) => {
            const updateData = buildParentUpdateData(decision)
            // o3d-4kfh r7 (Codex finding 2): CAPTURED BEFORE THE WRITE. `existing` is the
            // pre-update snapshot, and the mutation is defined by the pair (what it was, what it
            // is becoming) — reading `existing.type` after the update makes the answer depend on
            // whether the write path happened to mutate the object in place, which is not a
            // property to rely on.
            const kitnessMutation = {
              kind: 'kitness' as const,
              currentType: existing.type,
              // Read from `updateData.type`, NOT from the locally computed `productType`, so this
              // composes with o3d-y89x, which stops the connector DOWNGRADING an IMS KIT/BOM.
              // When that guard leaves the existing type in place, `nextType === existing.type`,
              // `componentGraphMutationAffectsFulfillment` is false and the bump is a no-op that
              // reads nothing. With the allow-list as it stands that is EVERY connector write —
              // see the note on the bump below.
              nextType: (updateData.type as ProductType | undefined) ?? existing.type,
            }
            await updateProductGuardingOwnership(tx, existing, parentClaimants, updateData, {
              requireTransformable: decision.writeTransformsRow,
            })
            // Recorded once the write has landed, and only when it MOVED `type` (r4).
            if (decision.writeTransformsRow) structurallyTransformed.set(existing.id, existing.sku)
            // A CONNECTOR TYPE WRITE IS A COMPONENT-GRAPH MUTATION LIKE ANY OTHER, AND MUST MOVE
            // THE VERSION.
            //
            // `OrderAllocation.fulfillmentGraphVersion` is what tells commitment and dispatch that
            // a row was expanded from a recipe that no longer exists. Every other writer of a
            // product's KIT-ness — the editor (app/actions/products.ts) and the CSV import
            // (app/actions/import.ts) — bumps it, for this product and every KIT above it, in the
            // same transaction as the write.
            //
            // WITH THE o3d-y89x ALLOW-LIST IN PLACE THIS IS CURRENTLY ALWAYS A NO-OP, AND IS KEPT
            // DELIBERATELY. `productType` is only ever SIMPLE or VARIABLE and the only existing
            // type the connector may overwrite is SIMPLE, so every pair it can still write is
            // leaf-to-leaf and `componentGraphMutationAffectsFulfillment` is false. Widening
            // `CONNECTOR_TRANSFORMABLE_TYPES` by one entry brings the flip back, and a graph write
            // with no bump is exactly the silent corruption o3d-4kfh closed — so the wiring stays,
            // and tests/products/component-graph-edit-guard.test.ts pins it as a mutation site.
            //
            // No in-flight blocker check here on purpose: the connector is not an interactive
            // editor and has no operator to refuse to. Refusing would strand the import (and its
            // retries) behind sales work it cannot influence; the CAS handles the consequence
            // correctly by refusing the affected orders' commitments with an actionable
            // "re-allocate" instead.
            await bumpFulfillmentGraphVersions(tx, existing.id, kitnessMutation)
          }

          try {
            await writeParentRow(parentWrite)
          } catch (e) {
            if (!(e instanceof WcProductTransformBlockedError)) throw e
            // The blocker appeared between the check and the write. Decide again WITH it — the
            // identical second pass the pre-check takes — so the outcome does not depend on WHEN
            // the blocker arrived. `writeTransformsRow` is false on the new decision (the type
            // write is now suppressed), so the retry no longer asks for the transform and cannot
            // loop; the non-structural fields still apply, exactly as they do when the blocker was
            // there all along.
            parentWrite = decideConnectorParentWrite({
              row: existing,
              incoming: productType,
              rowHasChildren: existingHasChildren,
              transformBlockerSummary: e.summary,
            })
            await writeParentRow(parentWrite)
          }

          if (parentWrite.suppressTypeWrite) {
            warnImsProductTypePreserved({
              imsProductId: existing.id,
              sku: existing.sku,
              imsType: existing.type,
              wcProductId: wcProduct.id,
              wcType: wcProduct.type,
              suppressedType: productType,
            })
          }

          // `sku` is never in updateData — the row is resolved BY sku — so the pre-update values
          // are still current, and re-reading only to learn what we already know costs a round trip.
          productId = existing.id
          productSku = existing.sku
        } else {
          const created = await tx.product.create({
            data: {
              sku,
              name: wcProduct.name,
              description: description || null,
              imageUrl,
              barcode: gtin,
              weight,
              depthCm,
              widthCm,
              heightCm,
              salesPriceBase: productType === 'VARIABLE' ? null : salesPriceBase,
              salePriceBase: productType === 'VARIABLE' ? null : salePriceBase,
              active,
              lifecycleStatus,
              type: productType,
              hsCode: hsCodeAttr,
              countryOfOrigin: originIso ?? DEFAULT_COUNTRY_OF_ORIGIN,
              customsDescription: customsDescriptionAttr,
              externalProductId: BigInt(wcProduct.id),
              categoryId: imsCategoryId ?? null,
            },
          })
          productId = created.id
          productSku = created.sku
        }

        // --- Variations (VARIABLE products) — already fetched, just applied here ---
        //
        // Skipped when the parent row did NOT end up VARIABLE (o3d-y89x). applyVariations
        // writes `parentId` on every child, and IMS only accepts a VARIABLE product as a
        // parent (validateProductStructureChange). Attaching children to a row we have just
        // decided stays a KIT, a VARIANT or a NON_INVENTORY would swap one corruption for
        // another — children pointing at a non-variable parent.
        //
        // Leaving them out is the lesser of the two, but it is NOT free: those WooCommerce
        // variations now exist nowhere in IMS, and order import resolves lines by SKU, so
        // each one becomes an order line with no product and no inventory allocation. That
        // is a conflict, not a silent skip — hence the durable record below and the failure
        // this function returns.
        //
        // ONE PREDICATE, BOTH DIRECTIONS (o3d-y89x r3, Codex finding 1). This used to read
        // `isVariable && parentWrite.parentRoleRefusal`, which asks "did the INCOMING payload
        // want a parent it could not have?" — and so could only ever see one of the two ways
        // the systems disagree. The other way round, an IMS VARIABLE row paired with a
        // WooCommerce `simple` product, took the `else` arm, wrote neither the type (the
        // allow-list protects VARIABLE) nor the price (`wooShapeAgrees` is false, correctly),
        // left the IMS variants standing, and was recorded as a clean SYNCED sync that advanced
        // the cursor. Reading BOTH off `wooShapeAgrees` is what makes the two cases one rule:
        // disagreement about "is this row a variable parent" is exactly the set of states in
        // which parent-level WooCommerce data went unapplied.
        //
        // Note what still takes the quiet path, and must: an IMS KIT or BOM paired with a
        // WooCommerce `simple` product AGREES — neither side claims a parent, WooCommerce never
        // contradicted the composition, and nothing went unapplied. That is the ordinary bundle
        // pairing, and turning it into an inbox row would bury the real conflicts under it.
        if (!parentWrite.wooShapeAgrees) {
          const refusal = parentWrite.parentRoleRefusal
          structureConflicts.push(
            isVariable && refusal
              ? {
                kind: 'variations_not_imported',
                sku: productSku,
                imsProductId: productId,
                imsType: parentWrite.effectiveType,
                wcObjectId: String(wcProduct.id),
                detail: `WooCommerce product ${wcProduct.id} ("${productSku}") is variable with `
                  + `${variations.length} variation(s), but ${refusal.detail} `
                  + `None of its variations were imported. ${refusal.remedy}`,
              }
              : {
                kind: 'parent_shape_not_applied',
                sku: productSku,
                imsProductId: productId,
                imsType: parentWrite.effectiveType,
                wcObjectId: String(wcProduct.id),
                detail: describeParentShapeNotApplied({
                  wcProductId: String(wcProduct.id),
                  sku: productSku,
                  imsProductId: productId,
                  imsType: parentWrite.effectiveType,
                  parentRoleRefusal: refusal,
                }),
              },
          )
        } else if (isVariable) {
          structureConflicts.push(
            ...await applyVariations(
              tx, variations, productId, wcProduct.name, imsCategoryId, structurallyTransformed,
            ),
          )
        }

        // --- Product options (variation attributes) ---
        //
        // Gated on the SAME decision as the children (o3d-y89x r2). These rows are the parent
        // half of a variable product — the UI only shows them for a VARIABLE row — so writing
        // them onto a row we just refused to make a parent left a KIT carrying options for
        // variants that were never imported, re-applied on every retry.
        if (parentWrite.canBeVariableParent) {
          await applyProductOptions(tx, productId, variationAttrs)
        }

        // SYNCED on the clean path, a deduplicated exception-inbox row otherwise — and in
        // BOTH cases any previously recorded conflict for this pairing is cleared, so a
        // resolved conflict leaves the inbox by itself.
        await recordStructureConflicts(tx, {
          productId,
          wcProductId: wcProduct.id,
          conflicts: structureConflicts,
        })

        // LAST, so it sees as much of the concurrent world as this transaction ever can.
        await assertTransformedRowsStillTransformable(tx, structurallyTransformed)

        return {
          syncedProductId: productId,
          syncedSku: productSku,
          tradeChanges: changes,
          wasUpdate: Boolean(existing),
          structureConflicts,
        }
      },
      { timeout: PRODUCT_WRITE_TX_TIMEOUT_MS, maxWait: PRODUCT_WRITE_TX_MAX_WAIT_MS },
    )

    // --- Post-commit side effects (never roll back, never fail the import) ---

    // If WC changed the classification-relevant fields, drop the stale HS-code proposal so the
    // sweep re-classifies (6igm.5/.7). Fire-and-forget (not after() — this runs in non-request
    // sync/cron contexts too); never affects the import result.
    if (wasUpdate) {
      void invalidateStaleHsProposal(syncedProductId).catch((err) => console.error(err))
    }

    // Audit trail when hs-code-woo overwrote IMS trade fields (bhdm.2). logActivity
    // swallows its own errors, so running it after the commit cannot strand a
    // committed import behind a FAILED log.
    if (tradeChanges.length > 0) {
      await logActivity({
        entityType: 'PRODUCT',
        entityId: syncedProductId,
        action: 'wc_trade_fields_updated',
        tag: 'sync',
        description: `WC trade fields updated on ${syncedSku}: ${tradeChanges
          .map((c) => `${c.field} ${c.from ?? '∅'}→${c.to}`)
          .join(', ')}`,
      })
    }

    // An unresolved structural conflict is NOT a successful sync (o3d-y89x / o3d-fjqk).
    //
    // The parent row's own fields committed above — a kit paired with a WooCommerce product
    // must keep receiving price and status updates — but WooCommerce objects went unapplied,
    // so this is reported as a failure. Three things follow from that, and all three are the
    // point:
    //
    //   - syncAllWcProducts pushes it into `result.errors`, and the cursor is only advanced
    //     after a fully clean run. So the reconcile does not step past a product whose
    //     children were never imported; it re-attempts it every run until it is resolved.
    //   - the webhook path acknowledges it (permanent) and logs at ERROR, instead of retrying
    //     ~24 times into the dead-letter queue. It IS deterministic: re-delivering the same
    //     payload against the same catalogue reaches the same refusal, so retrying tells
    //     nobody anything the first attempt did not.
    //   - the exception inbox row written inside the transaction is the operator's copy.
    //
    // No FAILED sync-log row is written here — the QUARANTINED row above IS the record, and
    // a second row per run would make the inbox count the same conflict repeatedly.
    if (structureConflicts.length > 0) {
      const summary = summarizeWcProductStructureConflicts(structureConflicts)
      await logActivity({
        entityType: 'PRODUCT',
        entityId: syncedProductId,
        action: 'wc_product_structure_conflict',
        tag: 'sync',
        level: 'WARNING',
        description: `WooCommerce product sync could not apply structure to ${syncedSku}: ${summary}`,
        resolveUser: false,
      })
      return { success: false, error: summary, permanent: true }
    }

    return { success: true }
  } catch (e) {
    const permanent = isPermanentProductSyncConflict(e)
    await db.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'FAILED',
        entityType: 'Product',
        externalId: String(wcProduct.id),
        // Prefix the permanent ones so the sync-log view distinguishes "will never succeed,
        // needs an operator" from "retrying" without re-parsing the Prisma error (o3d-gtk).
        errorMessage: permanent ? `PERMANENT_CONFLICT: ${String(e)}` : String(e),
        syncedAt: new Date(),
      },
    })
    return { success: false, error: String(e), permanent }
  }
}

// ---------------------------------------------------------------------------
// Variation sync helpers
//
// Deliberately split in two (o3d-uh2): fetchAllWcVariations does the remote work
// and must complete before the write transaction opens; applyVariations does the
// local work and must run inside it. Merging them again would either put HTTP
// inside a lock-holding transaction or reintroduce page-by-page partial writes.
// ---------------------------------------------------------------------------

/**
 * Fetch EVERY variations page for a WC parent, or throw.
 *
 * Nothing is written here, so a failure on any page (first or last) leaves the
 * catalog exactly as it was. Propagating instead of swallowing is o3d-q1w: the
 * parent sync then records FAILED, writes no SYNCED log, and neither the webhook
 * nor the bulk cursor advances, so the reconcile re-attempts.
 */
async function fetchAllWcVariations(
  wcParentId: number,
  creds: ConnectorCredentials | null,
): Promise<WcVariation[]> {
  const all: WcVariation[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages) {
    // PINNED credentials, not ambient (o3d-mlc7): resolving them per page let a rebind
    // mid-import pair store-A parent data with store-B variations in one transaction.
    const { data, totalPages: tp, error } = await wcFetch(
      `/products/${wcParentId}/variations`,
      { per_page: '100', page: String(page) },
      creds,
    )
    if (error) {
      throw new Error(
        `Failed to fetch variations for WC product ${wcParentId} (page ${page}/${totalPages}): ${error}`,
      )
    }

    totalPages = tp
    all.push(...(data as WcVariation[]))
    page++
  }

  return all
}

/**
 * Apply `data` to `row` ONLY while its WooCommerce mapping is still one this payload may write
 * (o3d-fsi). Zero rows updated means someone reassigned it in between: an ownership conflict.
 *
 * The plain read-then-check-then-update is a TOCTOU. `assertWcRowNotClaimedByAnotherWcObject`
 * decides on a snapshot, and the SKU advisory lock only excludes other WooCommerce IMPORTS —
 * `persistMappingIfVersionMatches` and the stock-sync mapping path write `externalProductId`
 * under a DIFFERENT lock. Either could reassign the row between the read and the write, after
 * which the stale check still passes and this transaction overwrites `parentId` and
 * `externalProductId` anyway. The exposure grows down the variation loop, because every prior
 * iteration awaits its own writes.
 *
 * Folding the predicate into the UPDATE closes that window without asking every other writer to
 * join the SKU-lock protocol: the row-level lock the update takes is what makes the check and
 * the write one step.
 */
async function updateProductGuardingOwnership(
  tx: Prisma.TransactionClient,
  row: { id: string; sku: string; externalProductId?: bigint | number | string | null },
  claimants: ReadonlySet<bigint>,
  data: Record<string, unknown>,
  /**
   * Set when this write actually TRANSFORMS the row — moves `type`, or `parentId`, the pair
   * `validateProductStructureChange` refuses on a live row (o3d-y89x r3, Codex finding 2).
   *
   * The blocker predicate then rides in the same statement as the ownership predicate, so the
   * answer is Postgres', taken at the instant of the write, rather than ours from a SELECT that
   * has since gone stale. Deliberately OFF for a non-transforming write: an ordinary re-sync of
   * a product that has stock and open orders is not a transform and must keep applying.
   */
  options: { requireTransformable?: boolean } = {},
): Promise<void> {
  const { count } = await tx.product.updateMany({
    where: {
      id: row.id,
      OR: [{ externalProductId: null }, { externalProductId: { in: [...claimants] } }],
      ...(options.requireTransformable ? PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE : {}),
    },
    data,
  })
  if (count > 0) return

  // Re-read so the error names the claimant that actually won the race rather than the stale one.
  const current = await tx.product.findUnique({
    where: { id: row.id },
    select: { id: true, sku: true, externalProductId: true },
  })

  // The row is GONE — deleted concurrently, not claimed by anyone. Reporting that as an ownership
  // conflict would be doubly wrong: the message would tell an operator to resolve a duplicate SKU
  // that does not exist, and o3d-gtk classifies ownership conflicts as PERMANENT.
  //
  // Throwing a plain error instead puts this in the TRANSIENT bucket, which is where a deletion
  // race belongs. Be precise about what that buys today: the product webhook currently returns
  // HTTP 200 for transient failures too, so nothing retries yet either way — o3d-i0y (PR #551) is
  // what turns the transient branch into a retryable 5xx. This classification is what makes the
  // case retry once that lands, and stops it being permanently acked in the meantime.
  if (!current) {
    throw new Error(
      `IMS product ${row.id} (SKU "${row.sku}") disappeared while importing it; retrying`,
    )
  }

  assertWcRowNotClaimedByAnotherWcObject(current, claimants)

  // Ownership is intact, so if the write ALSO asked to be transformable, the blocker predicate
  // is the remaining candidate — a blocker committed between the check and this statement.
  // Diagnosed after ownership on purpose: ownership is the older and more serious condition,
  // and reporting "the product went live" for a row another WooCommerce object has stolen would
  // send the operator after the wrong thing.
  if (options.requireTransformable) {
    const summary = await connectorTransformBlockerSummary(tx, row.id)
    if (summary) {
      throw new WcProductTransformBlockedError({ imsProductId: row.id, sku: row.sku, summary })
    }
  }

  // NOTHING EXPLAINS THE ZERO ROWS ANY MORE (o3d-y89x r4, Codex finding 3).
  //
  // The row is here, this payload still owns it, and no blocker remains. Every predicate in the
  // statement has been re-evaluated and they all pass now — so whatever refused the write has
  // already cleared. A blocker that appeared for the UPDATE's snapshot and was gone by these
  // SELECTs is enough (stock moving 0 -> 5 -> 0), as is a mapping reassigned and reassigned back.
  //
  // This used to fall through to `WcSkuOwnershipConflictError`, which was wrong twice: it named
  // an ownership conflict that `assertWcRowNotClaimedByAnotherWcObject` had just DISPROVED — so
  // the message told the operator to resolve a duplicate WooCommerce SKU that does not exist,
  // quoting `externalProductId` as the rival claimant when it is null or one of our own ids —
  // and o3d-gtk classifies those PERMANENT, so the webhook was acknowledged and the product
  // stranded on a condition that had already fixed itself.
  //
  // A cause that can no longer be observed may not be attributed to the wrong cause, and a
  // transient condition may not produce a terminal verdict. So this is its own transient error:
  // the transaction still rolls back (no retry loop here — the predicates are Postgres', not
  // ours to spin on), but the delivery is retried from the top and can legitimately succeed.
  throw new WcProductWriteRaceError({ imsProductId: row.id, sku: row.sku })
}

/**
 * Write already-fetched variations inside the caller's transaction.
 *
 * Returns the variations it REFUSED to apply (o3d-h2cz). Refusing is deliberately not the
 * same as throwing: an ownership conflict aborts the whole import because it can also hit
 * the parent row, where there is nothing to skip, whereas a structurally incompatible
 * variation is one row out of potentially hundreds. Skipping it keeps every healthy sibling
 * updated, and the returned conflict is what stops the sync being reported as clean.
 */
async function applyVariations(
  tx: Prisma.TransactionClient,
  variations: WcVariation[],
  imsParentId: string,
  parentName: string,
  // Variants inherit the parent product's resolved category. Only a real (non-null)
  // category is applied — a variant's category is never cleared by inheritance, even
  // if the parent currently resolves to no category (matches the backfill's policy).
  parentCategoryId: string | null | undefined,
  /**
   * The caller's set of rows this transaction has structurally transformed, id -> SKU
   * (o3d-y89x r4). Adoption moves `parentId` and, for a SIMPLE row, `type`, so every adopted
   * EXISTING row belongs in it — that is what makes the caller's pre-commit re-assertion cover
   * the variation door as well as the parent one. Written into rather than returned because the
   * return value is already the conflict list, and a row must be recorded the moment its write
   * lands, not once the loop finishes.
   */
  structurallyTransformed: Map<string, string>,
): Promise<WcProductStructureConflict[]> {
  const conflicts: WcProductStructureConflict[] = []
  const entries = variations
    .map((v) => ({ v, sku: asTrimmedString(v.sku) }))
    .filter((entry): entry is { v: WcVariation; sku: string } => Boolean(entry.sku)) // skip variations without SKU
  if (entries.length === 0) return conflicts

  // One lookup for all variant SKUs rather than one per variant. This runs inside a
  // transaction holding row locks, so every saved round trip shortens the lock hold.
  //
  // Which of those candidate rows are themselves parents (o3d-h2cz) is asked through the same
  // accessor the parent branch's shape rule uses (o3d-y89x r4/r5/r6), and asked ONCE for the whole
  // candidate set: `WHERE parentId IN (candidates) GROUP BY parentId` returns at most one row per
  // candidate, off the `parentId` index. r4 asked it per row and returned one row per child —
  // hundreds of rows for a high-variation catalogue, read only to compute a boolean per candidate.
  const existingRows = await withConnectorChildFlags(
    tx,
    await tx.product.findMany({ where: { sku: { in: entries.map((entry) => entry.sku) } } }),
  )
  const existingBySku = new Map(existingRows.map((row) => [row.sku, row]))

  // Every WC variation id this payload maps to each SKU (o3d-fsi). WC permits one SKU on
  // several variations of a parent, and the sync has always resolved that last-one-wins —
  // so after an import the surviving row carries the LAST duplicate's id. Checking a row
  // against only the variation currently being applied would then reject it on the very
  // next re-sync: the first duplicate would find a row mapped to its sibling. Accepting
  // the whole group keeps the quirk tolerated across repeated syncs, while still refusing
  // any id that is not in this payload at all.
  const claimantsBySku = new Map<string, Set<bigint>>()
  for (const { v, sku } of entries) {
    const claimants = claimantsBySku.get(sku) ?? new Set<bigint>()
    claimants.add(BigInt(v.id))
    claimantsBySku.set(sku, claimants)
  }

  for (const { v, sku } of entries) {
    // Build variant name: parent name + attribute values
    const attrSuffix = Array.isArray(v.attributes)
      ? v.attributes
        .map((a) => asTrimmedString(a.option))
        .filter((option): option is string => Boolean(option))
        .join(' / ')
      : ''
    const variantName = attrSuffix ? `${parentName} — ${attrSuffix}` : parentName

    const description = stripHtml(v.description || '')
    const salesPriceBase = parseNum(v.regular_price)
    const salePriceBase = parseNum(v.sale_price)
    const weight = parseNum(v.weight)
    const depthCm = parseNum(v.dimensions?.length)
    const widthCm = parseNum(v.dimensions?.width)
    const heightCm = parseNum(v.dimensions?.height)
    const imageUrl = getFirstImageUrl(v.images)
    const gtin = asTrimmedString(v.global_unique_id)

    const existing = existingBySku.get(sku)

    if (existing) {
      // The update below rewrites type/parentId/externalProductId, so refuse a row a
      // different WC object already owns instead of reparenting it (o3d-fsi). Checked here so
      // the conflict is raised before any write, then re-checked atomically inside the update.
      const claimants = claimantsBySku.get(sku) ?? new Set([BigInt(v.id)])
      assertWcRowNotClaimedByAnotherWcObject(existing, claimants)

      // A SKU match is evidence of identity, not proof of it (o3d-h2cz). The ownership check
      // above only asks whether ANOTHER WooCommerce object owns the row and passes an unmapped
      // one straight through — that is the initial-import takeover path. So an IMS-native row
      // that merely shares a SKU was silently reparented and remapped, which the o3d-y89x type
      // guard did not stop: it suppressed the `type` write and let `parentId` through.
      const adoptionTransformsRow = connectorVariationAdoptionChangesStructure({ row: existing, imsParentId })
      let refusal = refuseVariationAdoption({
        row: existing,
        imsParentId,
        rowHasChildren: imsRowHasChildren(existing),
      })
      // The editor's live-row gate, on the connector's other transforming path (o3d-y89x r2).
      // Adoption writes `parentId` and — for a SIMPLE row — `type`, which is exactly the pair
      // validateProductStructureChange refuses to change on a product with stock, reservations
      // or open documents. Asked LAST and only when the adoption really would transform the
      // row, so the steady-state re-sync of an existing variation pays nothing and a row
      // already refused above is never queried at all.
      if (refusal === null && adoptionTransformsRow) {
        const transformBlockerSummary = await connectorTransformBlockerSummary(tx, existing.id)
        if (transformBlockerSummary) {
          refusal = refuseVariationAdoption({
            row: existing,
            imsParentId,
            rowHasChildren: imsRowHasChildren(existing),
            transformBlockerSummary,
          })
        }
      }
      /** One shape for both the early refusal and the one the write itself discovers. */
      const refusalConflict = (reason: VariationAdoptionRefusal): WcProductStructureConflict => ({
        kind: 'variation_row_refused',
        sku,
        imsProductId: existing.id,
        imsType: existing.type,
        wcObjectId: String(v.id),
        detail: `WooCommerce variation ${v.id} matched SKU "${sku}", but ${reason.detail} `
          + 'The variation was not imported.',
      })

      if (refusal) {
        conflicts.push(refusalConflict(refusal))
        continue
      }

      // Same rule as the parent branch (o3d-y89x): a WC variation may not flatten a protected
      // IMS type into a VARIANT. For KIT/BOM this is not even a conflict — a KIT or BOM sitting
      // under a VARIABLE parent is a first-class IMS shape (a "bundle variant";
      // canTypeHaveVariableParent admits VARIANT, KIT and BOM), so `parentId` and everything
      // else still apply and only the type write is dropped. The types for which it WOULD be a
      // conflict never get here — refuseVariationAdoption has already turned them away.
      const preserveType = isConnectorTypeWriteSuppressed(existing.type, 'VARIANT')
      if (preserveType) {
        warnImsProductTypePreserved({
          imsProductId: existing.id,
          sku: existing.sku,
          imsType: existing.type,
          wcProductId: v.id,
          wcType: 'variation',
          suppressedType: 'VARIANT',
        })
      }

      const updateData: Record<string, unknown> = {
        name: variantName,
        description: description || existing.description,
        imageUrl: imageUrl ?? existing.imageUrl,
        weight: weight ?? existing.weight,
        depthCm: depthCm ?? existing.depthCm,
        widthCm: widthCm ?? existing.widthCm,
        heightCm: heightCm ?? existing.heightCm,
        active: deriveLegacyActiveFromLifecycleStatus(
          deriveLifecycleStatusFromWooStatus(v.status, existing.lifecycleStatus),
        ),
        lifecycleStatus: deriveLifecycleStatusFromWooStatus(v.status, existing.lifecycleStatus),
        ...(preserveType ? {} : { type: 'VARIANT' }),
        parentId: imsParentId,
        externalProductId: BigInt(v.id),
      }
      if (parentCategoryId != null) updateData.categoryId = parentCategoryId
      if (salesPriceBase !== null) updateData.salesPriceBase = salesPriceBase
      if (salePriceBase !== null) updateData.salePriceBase = salePriceBase
      if (gtin && !existing.barcode) updateData.barcode = gtin

      // o3d-4kfh r7 (Codex finding 2): the VARIATION path writes a type too — `VARIANT`, over
      // whatever the IMS row was. An IMS KIT whose SKU is adopted as a WC variation is the same
      // corruption by the other door, so it takes the same bump. Same composition rule as the
      // parent branch: the type is read out of `updateData`, so a preservation guard landing there
      // turns this into a no-op rather than fighting it. Captured BEFORE the write for the same
      // reason as the parent branch.
      const kitnessMutation = {
        kind: 'kitness' as const,
        currentType: existing.type,
        nextType: (updateData.type as ProductType | undefined) ?? existing.type,
      }
      try {
        // The adoption's live-row condition, re-asserted by the write itself (o3d-y89x r3,
        // Codex finding 2). Adoption sets `parentId` and — for a SIMPLE row — `type`, the exact
        // pair the editor refuses on a live row, so the same predicate that guards the parent
        // branch guards this one. Requested only when the adoption really transforms the row, so
        // the steady-state re-sync of a 200-variation product still pays nothing.
        await updateProductGuardingOwnership(tx, existing, claimants, updateData, {
          requireTransformable: adoptionTransformsRow,
        })
      } catch (e) {
        if (!(e instanceof WcProductTransformBlockedError)) throw e
        // A blocker appeared between the check and the write. This path has a natural, already
        // correct answer that the parent branch does not: a refused variation is SKIPPED and
        // reported, one row out of potentially hundreds. So re-decide with the summary and take
        // exactly the refusal the pre-check would have taken.
        const late = refuseVariationAdoption({
          row: existing,
          imsParentId,
          rowHasChildren: imsRowHasChildren(existing),
          transformBlockerSummary: e.summary,
        })
        // `late` is non-null by construction — the three structural checks passed above, so the
        // summary is the only remaining arm — but the fallback keeps a future reordering of
        // those checks from turning a refusal into a silent skip.
        conflicts.push(refusalConflict(late ?? {
          reason: 'transform_blocked',
          detail: `IMS product ${existing.id} (SKU "${existing.sku}") became live while it was being `
            + `adopted as a variation of ${imsParentId} (${e.summary}).`,
        }))
        continue
      }
      // The adoption landed; same rule as the parent branch (r4).
      if (adoptionTransformsRow) structurallyTransformed.set(existing.id, existing.sku)
      await bumpFulfillmentGraphVersions(tx, existing.id, kitnessMutation)
      // Reflect the FULL applied update, not just the new mapping. A later sibling sharing this
      // SKU builds its `?? existing.x` fallbacks from this row; caching the pre-update values
      // would write the first sibling's fresh description/image straight back out again.
      existingBySku.set(sku, { ...existing, ...updateData } as typeof existing)
    } else {
      const created = await tx.product.create({
        data: {
          sku,
          name: variantName,
          description: description || null,
          imageUrl,
          barcode: gtin,
          weight,
          depthCm,
          widthCm,
          heightCm,
          salesPriceBase,
          salePriceBase,
          active: deriveLegacyActiveFromLifecycleStatus(deriveLifecycleStatusFromWooStatus(v.status)),
          lifecycleStatus: deriveLifecycleStatusFromWooStatus(v.status),
          type: 'VARIANT',
          parentId: imsParentId,
          ...(parentCategoryId != null ? { categoryId: parentCategoryId } : {}),
          externalProductId: BigInt(v.id),
        },
      })
      // WC can repeat a SKU across variations of one parent; keep the map authoritative
      // so the duplicate updates the row we just created instead of colliding on it.
      //
      // The child flag is stated, not queried: a row this transaction inserted a statement ago
      // has no children, and nothing may re-derive it from the type. Stating it is also what
      // keeps `imsRowHasChildren` free to throw on a row that was never asked (r5).
      existingBySku.set(sku, { ...created, hasChildren: false })
    }
  }

  return conflicts
}

/** Write the parent's variation attributes as ProductOptions, inside the caller's transaction. */
async function applyProductOptions(
  tx: Prisma.TransactionClient,
  productId: string,
  variationAttrs: NonNullable<WcFullProduct['attributes']>,
) {
  for (const attr of variationAttrs) {
    const attrName = asTrimmedString(attr.name)
    const optionValues = normalizeAttributeOptions(attr.options)
    if (!attrName || optionValues.length === 0) continue
    await tx.productOption.upsert({
      where: {
        productId_name: { productId, name: attrName },
      },
      create: {
        productId,
        name: attrName,
        values: optionValues.join(','),
        sortOrder: attr.position,
      },
      update: {
        values: optionValues.join(','),
        sortOrder: attr.position,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// IMS → WC product push
// ---------------------------------------------------------------------------

export async function pushImsProductToWc(productId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { creds, syncVersion } = await snapshotProductSyncContext()
    if (!creds) {
      return { success: false, error: 'WooCommerce not configured. Set wc_url, wc_consumer_key, wc_consumer_secret in Settings.' }
    }
    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
        salesPriceBase: true,
        salePriceBase: true,
        barcode: true,
        type: true,
        externalProductId: true,
        lifecycleStatus: true,
        parent: { select: { sku: true, externalProductId: true } },
      },
    })
    if (!product?.sku) return { success: false, error: 'Product has no SKU' }

    // Push updates
    const updateData: Record<string, unknown> = { name: product.name }
    updateData.status = deriveWooStatusFromLifecycleStatus(product.lifecycleStatus)
    if (product.description) updateData.description = product.description
    if (product.salesPriceBase) updateData.regular_price = String(Number(product.salesPriceBase))
    updateData.sale_price = product.salePriceBase ? String(Number(product.salePriceBase)) : ''

    // Only send global_unique_id if barcode is purely numeric (WC only accepts numbers)
    if (product.barcode && /^\d+$/.test(product.barcode)) {
      updateData.global_unique_id = product.barcode
    }

    let externalProductId: number
    let putPath: string

    if (product.parent?.sku) {
      const parentWcId = product.parent?.externalProductId != null ? Number(product.parent.externalProductId) : null
      if (!parentWcId || !product.parent?.sku) {
        return { success: false, error: `Variant ${product.sku} is missing a WooCommerce parent mapping` }
      }

      let variationId = product.externalProductId != null ? Number(product.externalProductId) : null
      if (!variationId) {
        const { data, error } = await wcFetch(
          `/products/${parentWcId}/variations`,
          { sku: product.sku, per_page: '100' },
          creds,
        )
        if (error) return { success: false, error }
        const variations = data as WcVariation[]
        const matches = variations.filter((variation) => variation.sku === product.sku)
        if (matches.length !== 1) {
          return { success: false, error: `Expected exactly one WooCommerce variation for SKU ${product.sku} under ${product.parent.sku}` }
        }
        variationId = matches[0].id
        const persisted = await persistMappingIfVersionMatches(product.id, variationId, syncVersion)
        if (!persisted.ok) {
          return { success: false, error: describeMappingFailure(persisted, product.sku) }
        }
      } else {
        const { data, error } = await wcFetch(`/products/${parentWcId}/variations/${variationId}`, {}, creds)
        if (error) return { success: false, error }
        const variation = data as WcVariation
        if (variation.sku !== product.sku) {
          return { success: false, error: `Cached WooCommerce variation ${variationId} no longer matches SKU ${product.sku}` }
        }
      }

      externalProductId = variationId
      putPath = `/products/${parentWcId}/variations/${variationId}`
    } else {
      let resolvedId = product.externalProductId != null ? Number(product.externalProductId) : null
      if (resolvedId != null) {
        const { data, error } = await wcFetch(`/products/${resolvedId}`, {}, creds)
        if (error) return { success: false, error }
        const wcProduct = data as WcFullProduct
        if (wcProduct.sku !== product.sku) {
          return { success: false, error: `Cached WooCommerce product ${resolvedId} no longer matches SKU ${product.sku}` }
        }
      } else {
        const { data, error } = await wcFetch('/products', { sku: product.sku, per_page: '2' }, creds)
        if (error) return { success: false, error }

        const wcProducts = (data as WcFullProduct[]).filter((wcProduct) => wcProduct.sku === product.sku)
        if (wcProducts.length !== 1) {
          return {
            success: false,
            error: wcProducts.length === 0
              ? `No WC product found for SKU ${product.sku}`
              : `Ambiguous WC products found for SKU ${product.sku}`,
          }
        }
        resolvedId = wcProducts[0].id
        const persisted = await persistMappingIfVersionMatches(product.id, resolvedId, syncVersion)
        if (!persisted.ok) {
          return { success: false, error: describeMappingFailure(persisted, product.sku) }
        }
      }

      externalProductId = resolvedId
      putPath = `/products/${externalProductId}`
    }

    const versionCheck = await ensureWcSettingsVersionMatches(syncVersion)
    if (!versionCheck.ok) {
      return {
        success: false,
        error: `WooCommerce settings changed while syncing ${product.sku}`,
      }
    }

    const { error: putError } = await wcPut(putPath, updateData, creds)
    if (putError) return { success: false, error: putError }

    await db.shoppingSyncLog.create({
      data: {
        direction: 'TO_CONNECTOR',
        status: 'SYNCED',
        entityType: 'Product',
        entityId: productId,
        externalId: String(externalProductId),
        payload: JSON.parse(JSON.stringify(updateData)),
        syncedAt: new Date(),
      },
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Bulk product sync (WC → IMS)
// ---------------------------------------------------------------------------

export async function syncAllWcProducts(
  opts: {
    mode?: 'poll' | 'reconcile' | 'manual_reconcile'
    onProgress?: (progress: ProductSyncProgressSnapshot) => Promise<void> | void
  } = {},
  // o3d-xbt: the bulk path ALWAYS classifies, so callers (and its tests) can read
  // `permanentErrors` without narrowing — the field is optional on SyncResult only
  // because the other producers do not classify yet.
): Promise<SyncResult & { permanentErrors: string[] }> {
  const result: SyncResult & { permanentErrors: string[] } = { synced: 0, skipped: 0, errors: [], permanentErrors: [] }
  const mode = opts.mode ?? 'poll'
  const onProgress = opts.onProgress
  const cursorKey = mode === 'poll' ? 'last_wc_product_sync_at' : 'last_wc_product_reconcile_at'
  const conflictKey = wcProductConflictSettingKey(mode)
  let totalProducts = 0
  let processedProducts = 0

  // o3d-xbt: products whose LAST attempt hit a conflict a retry cannot clear.
  // Carried between runs and re-fetched by id below, which is what lets the
  // cursor move past them without abandoning them.
  const processedIds = new Set<number>()
  const conflictIds = new Set<number>()
  const conflictSkus: string[] = []

  const [lastSyncSetting, existingProduct, conflictSetting] = await Promise.all([
    db.setting.findUnique({ where: { key: cursorKey } }),
    db.product.findFirst({ select: { id: true } }),
    db.setting.findUnique({ where: { key: conflictKey } }),
  ])
  const carriedConflictIds = parseWcProductConflictIds(conflictSetting?.value)

  // After a product reset or on a fresh install, there is nothing local to
  // reconcile against. Ignore any stale cursor and force a full import.
  const modifiedAfter = existingProduct ? (lastSyncSetting?.value ?? null) : null

  let page = 1
  let totalPages = 1

  async function reportProgress(message: string, currentPage = page) {
    if (!onProgress) return
    await onProgress({
      message,
      processed: processedProducts,
      synced: result.synced,
      skipped: result.skipped,
      totalProducts,
      currentPage,
      totalPages,
      errors: [...result.errors],
    })
  }

  /**
   * One place where a per-product outcome is turned into counters (o3d-xbt), so
   * the modified-after pass and the by-id retry pass below cannot classify the
   * same failure differently.
   *
   * A permanent failure lands in BOTH arrays: `errors` because every existing
   * surface renders that one and an operator must still see it, `permanentErrors`
   * because it must not hold the cursor.
   */
  function recordProductOutcome(product: WcFullProduct, outcome: { success: boolean; error?: string; permanent?: boolean }) {
    processedIds.add(product.id)
    if (outcome.success) {
      result.synced++
      return
    }
    const line = `SKU ${product.sku}: ${outcome.error}`
    result.errors.push(line)
    if (outcome.permanent) {
      result.permanentErrors.push(line)
      conflictIds.add(product.id)
      if (product.sku) conflictSkus.push(product.sku)
    }
  }

  await reportProgress('Preparing WooCommerce product import...', 0)

  while (page <= totalPages) {
    await reportProgress(
      `Fetching WooCommerce products... page ${page}${totalPages > 1 ? ` / ${totalPages}` : ''}`,
    )

    const params: Record<string, string> = {
      per_page: '100',
      page: String(page),
      status: 'any',
    }
    if (modifiedAfter) params.modified_after = modifiedAfter

    // Snapshot BEFORE the page fetch, so the version travels with the payload it describes
    // (o3d-mlc7). Fetching first and snapshotting per-product cannot see a rebind that
    // landed between the two.
    const { creds: pageCreds, syncVersion: pageVersion } = await snapshotProductSyncContext()
    const { data, totalPages: tp, totalItems, error } = await wcFetch('/products', params, pageCreds)
    if (error) {
      result.errors.push(error)
      await reportProgress(`Failed to fetch WooCommerce products: ${error}`)
      break
    }

    totalPages = tp
    if (totalItems > 0) totalProducts = totalItems
    const products = data as WcFullProduct[]
    if (totalProducts === 0) totalProducts = products.length

    await reportProgress('Importing WooCommerce products...')

    for (const product of products) {
      if (!product.sku) {
        processedProducts++
        result.skipped++
        await reportProgress(
          totalProducts > 0
            ? `Importing WooCommerce products... ${Math.min(totalProducts, processedProducts)} / ${totalProducts} processed`
            : 'Importing WooCommerce products...',
        )
        continue
      }
      const r = await syncWcProductToIms(product, pageVersion)
      processedProducts++
      recordProductOutcome(product, r)

      await reportProgress(
        totalProducts > 0
          ? `Importing WooCommerce products... ${Math.min(totalProducts, processedProducts)} / ${totalProducts} processed`
          : 'Importing WooCommerce products...',
      )
    }

    page++
  }

  // o3d-xbt: the re-attempt that replaces the pinned cursor.
  //
  // Products that conflicted on a previous run are fetched BY ID, so they are
  // still tried every single run even though the cursor has moved past them —
  // which matters because these conflicts are resolved on the IMS side and
  // change nothing in WooCommerce for a modified-after query to notice.
  // Anything already seen in the pass above is skipped: it has just been tried.
  //
  // o3d-xbt round 2, Codex finding 1 — A CARRIED ID IS ONLY DROPPED ON EVIDENCE.
  //
  // The retry set is the mechanism that stops one permanent conflict pinning the
  // sweep, so the ids ARE the safety net: the cursor has already moved past these
  // products and nothing else will ever fetch them. They used to be re-added to
  // the list only by being re-attempted and re-failing, which meant any run that
  // did not reach them dropped them for good — a re-fetch that errored, or an id
  // the cap could not fit. Losing them is worse than the defect the retry set was
  // built to fix, because it is silent and permanent.
  //
  // So a carried id leaves the list on EVIDENCE and nothing else: it imported
  // cleanly, or WooCommerce answered a by-id fetch without it (deleted, or no
  // longer visible to these credentials). Not reaching it is not evidence.
  //
  // The slice below can never truncate, and that is a property of two constants
  // agreeing rather than a coincidence: parseWcProductConflictIds reads at most
  // WC_PRODUCT_CONFLICT_RETRY_LIMIT ids, so everything carried is attempted. It
  // is stated here — and pinned in tests/wc-product-conflict-cursor.test.ts —
  // because if the read cap ever grew past the retry cap, the overflow would be
  // dropped by this line with nothing said, which is the defect one paragraph up.
  const retryIds = carriedConflictIds.filter((id) => !processedIds.has(id)).slice(0, WC_PRODUCT_CONFLICT_RETRY_LIMIT)
  if (retryIds.length > 0) {
    await reportProgress(`Re-attempting ${retryIds.length} previously conflicted product(s)...`)
    const { creds: retryCreds, syncVersion: retryVersion } = await snapshotProductSyncContext()
    const { data: retryData, error: retryError } = await wcFetch('/products', {
      per_page: String(WC_PRODUCT_CONFLICT_RETRY_LIMIT),
      page: '1',
      status: 'any',
      include: retryIds.join(','),
    }, retryCreds)

    if (retryError) {
      // Transient by nature (transport/auth), so it holds the cursor exactly as a
      // failed page fetch does — this run did not see what the cursor would claim.
      result.errors.push(`Re-attempt of conflicted products failed: ${retryError}`)
      // …and the ids survive it. A failed fetch says nothing about whether these
      // products still conflict, and dropping them here abandoned every one of
      // them permanently (o3d-xbt round 2, finding 1).
      for (const id of retryIds) conflictIds.add(id)
      await reportProgress(`Failed to re-fetch conflicted WooCommerce products: ${retryError}`)
    } else {
      // Ids WooCommerce did not return are deleted (or no longer visible to these
      // credentials). They fall out of the set by not being re-added, so the list
      // shrinks by itself instead of accumulating dead ids forever.
      for (const product of retryData as WcFullProduct[]) {
        if (!product.sku) {
          result.skipped++
          continue
        }
        const r = await syncWcProductToIms(product, retryVersion)
        processedProducts++
        recordProductOutcome(product, r)
      }
      await reportProgress('Re-attempted previously conflicted products.')
    }
  }

  // Only advance the cursor when nothing TRANSIENT failed. A transient failure
  // means this run did not see everything the cursor would claim it saw, and
  // advancing can permanently skip remote changes older than now.
  //
  // PERMANENT failures no longer hold it (o3d-xbt): one conflicted product used
  // to pin the cursor forever, so every cycle re-fetched and re-imported the
  // whole catalogue to re-fail on the same row. They are carried in the conflict
  // set above and re-attempted by id instead, so nothing is abandoned.
  //
  // ORDER MATTERS (o3d-xbt round 2, finding 1). The conflict list is written
  // FIRST, and the cursor only moves if that write landed. The other way round —
  // which is how this was — an unwritable settings row left the cursor advanced
  // past products whose ids were never recorded: nothing re-fetches them, nothing
  // knows they exist, and the sweep reports a clean run. Persisting the safety
  // net before stepping off the ledge is the whole of the fix.
  const { kept: keptConflictIds, dropped: droppedConflictIds } = capWcProductConflictIds(conflictIds)

  // Written on every run, including the clean one that clears it: this row is the
  // live set of conflicted products, not a log of past ones.
  // (Skipped only when there is nothing to say and nothing to clear, so a store
  // that never conflicts does not grow a settings row it will never read.)
  let conflictsPersisted = true
  if (conflictIds.size > 0 || conflictSetting) {
    const serializedConflicts = JSON.stringify(keptConflictIds)
    try {
      await db.setting.upsert({
        where: { key: conflictKey },
        create: { key: conflictKey, value: serializedConflicts },
        update: { value: serializedConflicts },
      })
    } catch (error) {
      conflictsPersisted = false
      const reason = error instanceof Error ? error.message : String(error)
      // TRANSIENT on purpose: it goes in `errors` and NOT in `permanentErrors`,
      // which is on its own enough to hold the cursor through
      // shouldAdvanceWcProductCursor. `conflictsPersisted` below is therefore
      // belt-and-braces TODAY, and it is kept deliberately: "the cursor is held
      // because the error line makes a count comparison unequal" is a coupling
      // nobody would notice breaking, and the rule this enforces — never step
      // past products whose ids were not recorded — deserves to be written down
      // where the cursor is written, not inferred two functions away.
      result.errors.push(`Failed to record the conflicted-product list (${conflictKey}): ${reason}`)
      await logActivity({
        entityType: 'SYNC', action: 'wc_product_sync_conflicts_unrecorded', tag: 'sync', level: 'ERROR',
        description:
          `WC product ${mode === 'poll' ? 'poll' : 'reconciliation'}: the list of ${conflictIds.size} conflicted product(s)`
          + ` could not be written to ${conflictKey} (${reason}). The sync cursor has been HELD so the same products are`
          + ' fetched again next run — nothing is abandoned, but this run did less than it appears to have done.',
        metadata: { mode, conflictedExternalProductIds: keptConflictIds, error: reason },
        resolveUser: false,
      })
      await reportProgress(`Failed to record conflicted WooCommerce products: ${reason}`)
    }
  }

  if (droppedConflictIds.length > 0) {
    // o3d-xbt round 2, finding 2. The cap is deliberate — the retry pass must stay
    // one extra request — but a truncation nobody is told about reads as full
    // coverage. Named ids, not a count: an operator who has to go and look at
    // these needs to know which.
    await logActivity({
      entityType: 'SYNC', action: 'wc_product_sync_conflicts_truncated', tag: 'sync', level: 'WARNING',
      description:
        `WC product ${mode === 'poll' ? 'poll' : 'reconciliation'}: ${conflictIds.size} product(s) conflicted but only`
        + ` ${keptConflictIds.length} can be carried to the next run (one WooCommerce page). ${droppedConflictIds.length}`
        + ` id(s) were DROPPED and will NOT be re-attempted: ${droppedConflictIds.slice(0, 50).join(', ')}`
        + `${droppedConflictIds.length > 50 ? `, +${droppedConflictIds.length - 50} more` : ''}.`
        + ' The cursor has moved past them, so they will only be seen again if they change in WooCommerce or the cursor'
        + ' is reset. Resolve the carried conflicts to make room, or reset the cursor to re-import from scratch.',
      metadata: {
        mode,
        droppedExternalProductIds: droppedConflictIds.slice(0, 200),
        droppedCount: droppedConflictIds.length,
        carriedCount: keptConflictIds.length,
        retryLimit: WC_PRODUCT_CONFLICT_RETRY_LIMIT,
      },
      resolveUser: false,
    })
    result.errors.push(
      `${droppedConflictIds.length} conflicted product(s) exceeded the ${WC_PRODUCT_CONFLICT_RETRY_LIMIT}-id retry list`
      + ` and were dropped: ${droppedConflictIds.slice(0, 20).join(', ')}`
      + `${droppedConflictIds.length > 20 ? `, +${droppedConflictIds.length - 20} more` : ''}`,
    )
    // Permanent as well: a full retry list is not a transport hiccup, and holding
    // the cursor on it would re-import the whole catalogue every cycle — the very
    // defect o3d-xbt exists to fix.
    result.permanentErrors.push(
      `${droppedConflictIds.length} conflicted product(s) exceeded the ${WC_PRODUCT_CONFLICT_RETRY_LIMIT}-id retry list`
      + ` and were dropped: ${droppedConflictIds.slice(0, 20).join(', ')}`
      + `${droppedConflictIds.length > 20 ? `, +${droppedConflictIds.length - 20} more` : ''}`,
    )
  }

  if (conflictsPersisted && shouldAdvanceWcProductCursor(result)) {
    await db.setting.upsert({
      where: { key: cursorKey },
      create: { key: cursorKey, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
  }

  if (conflictIds.size > 0) {
    // The loud line the bulk path never had. Without it a permanent conflict was
    // one entry in an errors array nobody reads, with nothing saying it will
    // never clear on its own.
    await logActivity({
      entityType: 'SYNC', action: 'wc_product_sync_conflicts', tag: 'sync', level: 'WARNING',
      description:
        `WC product ${mode === 'poll' ? 'poll' : 'reconciliation'}: ${conflictIds.size} product(s) cannot be imported until an operator resolves a conflict`
        + `${conflictSkus.length > 0 ? ` — ${conflictSkus.slice(0, 20).join(', ')}${conflictSkus.length > 20 ? `, +${conflictSkus.length - 20} more` : ''}` : ''}.`
        + ' Retrying cannot clear these on its own; they are re-attempted by id on every run until resolved.'
        + ' A structure conflict also carries a row under Sync → Exceptions; a mapping conflict (a GTIN or a WooCommerce id'
        + ' already held by a different IMS product) is recorded in the WooCommerce sync log as PERMANENT_CONFLICT.',
      metadata: { mode, conflictedExternalProductIds: [...conflictIds], skus: conflictSkus.slice(0, 50) },
      resolveUser: false,
    })
  }

  if (result.synced > 0) {
    await logActivity({
      entityType: 'SYNC', action: 'product_sync', tag: 'sync', level: 'INFO',
      description: `WC product ${mode === 'poll' ? 'poll' : 'reconciliation'}: ${result.synced} synced, ${result.skipped} skipped`,
      resolveUser: false,
    })
  }

  return result
}
export async function isWcProductWebhookPrimaryActive(): Promise<boolean> {
  const [secret, lastReceived] = await Promise.all([
    getSettingValue('wc_webhook_secret'),
    db.setting.findUnique({ where: { key: 'wc_product_webhook_last_received_at' } }),
  ])

  if (!secret || !lastReceived?.value) return false
  const ts = Date.parse(lastReceived.value)
  if (!Number.isFinite(ts)) return false
  return (Date.now() - ts) <= WEBHOOK_PRIMARY_FRESH_MS
}
