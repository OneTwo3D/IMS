/**
 * The pure half of the WooCommerce initial-import rehearsal (scripts/rehearse-woo-import.ts).
 *
 * Everything that DECIDES something lives here, free of processes, files and the database, so a test
 * can feed it a wrong answer and watch it say RED:
 *
 *   - the exit codes and the one sentence each means (docs/installation.md prints this table; a test
 *     compares the two);
 *   - the operator text, in one place (the owner decision, what the rehearsal does and does not prove);
 *   - the step catalogue;
 *   - the assessors: R9 (exact order count, value per order), R4 (reservations equal allocations), the
 *     read-only proof, the stamp, idempotency, the resolved status list and the OD-4 landing;
 *   - the report and its Markdown.
 *
 * The rehearsal reuses the fresh-install rehearsal's step, teardown and guard types so the two reports
 * read the same way.
 */
import {
  REHEARSAL_EXIT,
  type Assessment,
  type RehearsalExitCode,
  type StepResult,
  type TeardownResult,
  isRed,
  teardownIncomplete,
} from '@/lib/ops/first-install-rehearsal'

// ---------------------------------------------------------------------------------------------
// Exit codes. Documented once, in docs/installation.md ("WooCommerce initial-import rehearsal").
// ---------------------------------------------------------------------------------------------

export const WOO_IMPORT_EXIT = {
  OK: REHEARSAL_EXIT.OK,
  RED: REHEARSAL_EXIT.RED,
  REFUSED: REHEARSAL_EXIT.REFUSED,
  TEARDOWN_INCOMPLETE: REHEARSAL_EXIT.TEARDOWN_INCOMPLETE,
} as const

export const WOO_IMPORT_EXIT_MEANING: Record<RehearsalExitCode, string> = {
  [WOO_IMPORT_EXIT.OK]: 'GREEN: every required step passed and the teardown left nothing behind.',
  [WOO_IMPORT_EXIT.RED]: 'RED: a required step failed, was skipped, or threw. The report says which.',
  [WOO_IMPORT_EXIT.REFUSED]: 'Refused to start: bad arguments, no PostgreSQL server binaries, run as root, or the work directory is on a RAM-backed file system. Nothing was created.',
  [WOO_IMPORT_EXIT.TEARDOWN_INCOMPLETE]: 'The teardown could not remove everything it created (cluster, env file, directory or a process). The report names what is left. Takes precedence over RED.',
}

// ---------------------------------------------------------------------------------------------
// Operator text. One place; the docs quote it and a test checks they agree.
// ---------------------------------------------------------------------------------------------

/** The statuses the owner decision (D7) imports: open and unfulfilled. Completed, cancelled and refunded are abandoned on purpose. */
export const DECIDED_IMPORT_STATUSES = ['on-hold', 'pending', 'processing'] as const

/** The statuses D7 abandons on purpose, which the fake store holds so the rehearsal can prove they are never asked for. */
export const ABANDONED_STATUSES = ['cancelled', 'completed', 'failed', 'refunded'] as const

export const R9_VALUE_TOLERANCE = 0.01
export const R4_QUANTITY_TOLERANCE = 0.0001

export const REHEARSAL_STAMP_STATEMENT =
  'A rehearsal pass never writes the one-shot completion stamp (wc_initial_import_completed) or the order-sync cursor (last_wc_order_sync_at). Only a real pass does, and a real pass cannot be undone.'

export const REHEARSAL_NOT_PROVEN_STATEMENT =
  'This rehearsal runs the real import against a SYNTHETIC store. It does not prove how your real store answers (payload quirks, plugin meta keys, a page past the last one), which customers the import creates, whether a real product link resolves by SKU, or how your tax-rate mappings copy. Run it on recorded orders before relying on it.'

// ---------------------------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------------------------

export type WooStepId =
  | 'migrate-deploy'
  | 'seed'
  | 'prepare'
  | 'outbound-held-before'
  | 'rehearsal-import'
  | 'status-selection'
  | 'pass-complete'
  | 'no-stamp-on-rehearsal'
  | 'r9-orders'
  | 'r4-reservations'
  | 'allocations-derived'
  | 'unallocatable-list'
  | 'idempotent-second-pass'
  | 'stock-lands-later'
  | 'real-pass-stamps'
  | 'start-declines-after-stamp'
  | 'read-only-proof'
  | 'invariant-preflight'

export type WooStepDefinition = { id: WooStepId; title: string; prerequisite: boolean }

export const WOO_STEP_CATALOGUE: readonly WooStepDefinition[] = [
  { id: 'migrate-deploy', title: 'Every migration applied by migrate deploy', prerequisite: true },
  { id: 'seed', title: 'npm run db:seed', prerequisite: true },
  { id: 'prepare', title: 'IMS-side fixtures: products, opening stock, tax mappings, FX rate, store settings', prerequisite: true },
  { id: 'outbound-held-before', title: 'No outbound-write grant exists: outbound:status reports every connector held', prerequisite: false },
  { id: 'rehearsal-import', title: 'The real initial-import pass runs as a rehearsal (no stamp)', prerequisite: true },
  { id: 'status-selection', title: 'The resolved status list equals the owner decision', prerequisite: false },
  { id: 'pass-complete', title: 'The pass judges itself COMPLETE on its own terms (no unread page, no truncated read, no unrecorded refusal)', prerequisite: false },
  { id: 'no-stamp-on-rehearsal', title: 'A rehearsal wrote neither the completion stamp nor the sync cursor', prerequisite: false },
  { id: 'r9-orders', title: 'R9: exact order count in the selected statuses; value within tolerance per order', prerequisite: false },
  { id: 'r4-reservations', title: 'R4: reserved quantity equals the sum of allocations, per stock row', prerequisite: false },
  { id: 'allocations-derived', title: 'Every allocation row was derived by the allocation service (none seeded by hand)', prerequisite: false },
  { id: 'unallocatable-list', title: 'Orders and lines that imported but could not be allocated are listed', prerequisite: false },
  { id: 'idempotent-second-pass', title: 'A second pass imports nothing new', prerequisite: false },
  { id: 'stock-lands-later', title: 'OD-4: orders that could not be allocated are allocated when stock lands', prerequisite: false },
  { id: 'real-pass-stamps', title: 'A real pass stamps completion and the sync cursor (once)', prerequisite: false },
  { id: 'start-declines-after-stamp', title: 'After the stamp the import button declines to run again', prerequisite: false },
  { id: 'read-only-proof', title: 'Read-only: no request other than GET reached the store, none was unmodelled, the hold refused nothing', prerequisite: false },
  { id: 'invariant-preflight', title: 'npm run invariant-check:preflight exits 0 on the imported data', prerequisite: false },
]

// ---------------------------------------------------------------------------------------------
// Facts the orchestrator gathers, and the assessors that judge them.
// ---------------------------------------------------------------------------------------------

/** One order of the store, as the FAKE holds it (the independent side of every comparison). */
export type StoreOrderFact = {
  id: number
  status: string
  currency: string
  /** The order total WooCommerce states, as a decimal string. */
  total: string
  /** The GBP rate the rehearsal seeded for the order's currency (1 GBP = x currency); 1 for GBP. */
  fxPerGbp: number
  /** What the fixture says should happen. */
  expectation: 'imports' | 'imports-with-unallocatable-lines' | 'fails-to-import' | 'abandoned-by-status'
}

/** One order as IMS holds it after the import. Null fields mean "no such order". */
export type ImportedOrderFact = {
  externalOrderId: number
  salesOrderId: string
  status: string
  currency: string
  totalForeign: number
  totalBase: number
  subtotalForeign: number
  taxForeign: number
  shippingForeign: number
  orderLevelDiscountForeign: number
  lineTotalForeignSum: number
  lineCount: number
  linesWithoutProduct: number
  hasCustomer: boolean
}

/** What allocation did for one imported order, from the rows the allocation service wrote. */
export type AllocationFact = {
  imsStatus: string
  orderNumber: string
  /** Lines with no product link: a SKU IMS does not hold, a line with no SKU, a fee. They can never be allocated. */
  noProductLines: number
  /** Lines with a product whose allocation is short of the quantity ordered: they wait for stock. */
  shortLines: number
  /** The quantity those lines are short by. */
  shortQty: number
}

export type OrderRow = {
  externalOrderId: number
  status: string
  currency: string
  expectation: StoreOrderFact['expectation']
  outcome: 'imported' | 'not-imported'
  wcTotal: number
  importedTotalForeign: number | null
  valueDiffForeign: number | null
  valueDiffBase: number | null
  componentsDiffForeign: number | null
  withinTolerance: boolean | null
  imsStatus: string | null
  noProductLines: number
  shortLines: number
  shortQty: number
  /** For an order in a selected status that did not import: is a durable retry row recorded for it? */
  retryRecorded: boolean | null
  reason?: string
}

export type R9Result = {
  assessment: Assessment
  /** Orders the store holds in the selected statuses: the exact count the import must reach. */
  expectedCount: number
  /** Of those, the ones a fixture declares known to fail (expected NOT to import). */
  knownBadCount: number
  importedCount: number
  /** Orders in the selected statuses that did not import and were not declared known-bad. */
  missing: number[]
  /** Declared known-bad orders that imported anyway (the probe would then prove nothing). */
  knownBadThatImported: number[]
  /** Orders in a status that was not selected that IMS nevertheless holds. */
  importedFromAbandonedStatus: number[]
  overTolerance: number[]
  maxValueDiffForeign: number
  maxValueDiffBase: number
  maxComponentsDiff: number
  rows: OrderRow[]
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

/**
 * R9. The COUNT is exact: every order the store holds in a selected status must be in IMS, except those
 * a fixture declares known to fail, which must NOT be (a probe that imports proves nothing). The VALUE is
 * per order: the imported total equals the total WooCommerce stated, in the order's currency and again
 * in GBP at the seeded rate, and the order's own parts add up to its total, each within `tolerance`.
 */
export function assessR9(input: {
  store: readonly StoreOrderFact[]
  imported: readonly ImportedOrderFact[]
  selectedStatuses: readonly string[]
  tolerance?: number
  allocation?: ReadonlyMap<number, AllocationFact>
  /** External order ids that have a durable retry row (the pending-FX queue). A selected order that did not import must have one, or the stamp strands it. */
  retryRecorded?: ReadonlySet<number>
}): R9Result {
  const tolerance = input.tolerance ?? R9_VALUE_TOLERANCE
  const failures: string[] = []
  const byId = new Map(input.imported.map((fact) => [fact.externalOrderId, fact]))
  const selected = input.store.filter((order) => input.selectedStatuses.includes(order.status))
  const selectedIds = new Set(selected.map((order) => order.id))
  const knownBad = selected.filter((order) => order.expectation === 'fails-to-import')
  const mustImport = selected.filter((order) => order.expectation !== 'fails-to-import')

  const missing = mustImport.filter((order) => !byId.has(order.id)).map((order) => order.id)
  const knownBadThatImported = knownBad.filter((order) => byId.has(order.id)).map((order) => order.id)
  const importedFromAbandonedStatus = input.imported.filter((fact) => !selectedIds.has(fact.externalOrderId)).map((fact) => fact.externalOrderId)

  const rows: OrderRow[] = []
  const overTolerance: number[] = []
  let maxForeign = 0
  let maxBase = 0
  let maxComponents = 0
  for (const order of input.store) {
    const fact = byId.get(order.id)
    const alloc = input.allocation?.get(order.id)
    const wcTotal = Number(order.total)
    if (!fact) {
      rows.push({
        externalOrderId: order.id,
        status: order.status,
        currency: order.currency,
        expectation: order.expectation,
        outcome: 'not-imported',
        wcTotal,
        importedTotalForeign: null,
        valueDiffForeign: null,
        valueDiffBase: null,
        componentsDiffForeign: null,
        withinTolerance: null,
        imsStatus: null,
        noProductLines: 0,
        shortLines: 0,
        shortQty: 0,
        retryRecorded: input.selectedStatuses.includes(order.status) ? (input.retryRecorded?.has(order.id) ?? false) : null,
        reason: !input.selectedStatuses.includes(order.status)
          ? `status ${order.status} is not selected: abandoned by decision, never asked for`
          : order.expectation === 'fails-to-import'
            ? `declared known to fail (probe); ${input.retryRecorded?.has(order.id) ? 'a durable retry row is recorded, so the stamp does not strand it' : 'NO durable retry row: the stamp would strand it'}`
            : 'MISSING',
      })
      continue
    }
    const diffForeign = round4(Math.abs(fact.totalForeign - wcTotal))
    const diffBase = round4(Math.abs(fact.totalBase - wcTotal / order.fxPerGbp))
    // The order's own parts: line nets + tax + shipping - order-level discount must be its total.
    const components = fact.lineTotalForeignSum + fact.taxForeign + fact.shippingForeign - fact.orderLevelDiscountForeign
    const componentsDiff = round4(Math.abs(components - fact.totalForeign))
    const within = diffForeign <= tolerance && diffBase <= tolerance && componentsDiff <= tolerance
    if (!within) overTolerance.push(order.id)
    maxForeign = Math.max(maxForeign, diffForeign)
    maxBase = Math.max(maxBase, diffBase)
    maxComponents = Math.max(maxComponents, componentsDiff)
    rows.push({
      externalOrderId: order.id,
      status: order.status,
      currency: order.currency,
      expectation: order.expectation,
      outcome: 'imported',
      wcTotal,
      importedTotalForeign: fact.totalForeign,
      valueDiffForeign: diffForeign,
      valueDiffBase: diffBase,
      componentsDiffForeign: componentsDiff,
      withinTolerance: within,
      imsStatus: alloc?.imsStatus ?? fact.status,
      noProductLines: alloc?.noProductLines ?? fact.linesWithoutProduct,
      shortLines: alloc?.shortLines ?? 0,
      shortQty: alloc?.shortQty ?? 0,
      retryRecorded: null,
    })
  }

  if (missing.length > 0) failures.push(`${missing.length} order(s) in the selected statuses are not in IMS: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`)
  if (knownBadThatImported.length > 0) failures.push(`${knownBadThatImported.length} order(s) declared known to fail imported anyway (the probe proves nothing): ${knownBadThatImported.join(', ')}`)
  if (importedFromAbandonedStatus.length > 0) failures.push(`${importedFromAbandonedStatus.length} order(s) outside the selected statuses are in IMS: ${importedFromAbandonedStatus.join(', ')}`)
  const stranded = knownBad.filter((order) => !byId.has(order.id) && !(input.retryRecorded?.has(order.id) ?? false)).map((order) => order.id)
  if (stranded.length > 0) failures.push(`${stranded.length} order(s) that did not import have no durable retry row, so the stamp would strand them for good: ${stranded.join(', ')}`)
  if (overTolerance.length > 0) failures.push(`${overTolerance.length} order(s) differ from WooCommerce by more than ${tolerance}: ${overTolerance.slice(0, 10).join(', ')}`)
  if (selected.length === 0) failures.push('the store holds no order in any selected status, so the count proves nothing')

  return {
    assessment: { ok: failures.length === 0, failures },
    expectedCount: selected.length,
    knownBadCount: knownBad.length,
    importedCount: input.imported.length,
    missing,
    knownBadThatImported,
    importedFromAbandonedStatus,
    overTolerance,
    maxValueDiffForeign: maxForeign,
    maxValueDiffBase: maxBase,
    maxComponentsDiff: maxComponents,
    rows,
  }
}

export type StockRowFact = { productId: string; sku: string; warehouseId: string; reservedQty: number; allocationSum: number }

export type R4Result = { assessment: Assessment; rowsChecked: number; rowsWithReservations: number; worstDiff: number; mismatches: Array<{ sku: string; reservedQty: number; allocationSum: number }> }

/** R4: StockLevel.reservedQty equals the sum of OrderAllocation.qty, per stock row, within the tolerance. */
export function assessR4(rows: readonly StockRowFact[], tolerance = R4_QUANTITY_TOLERANCE): R4Result {
  const mismatches = rows
    .filter((row) => Math.abs(row.reservedQty - row.allocationSum) > tolerance)
    .map((row) => ({ sku: row.sku, reservedQty: row.reservedQty, allocationSum: row.allocationSum }))
  const failures: string[] = []
  const withReservations = rows.filter((row) => row.reservedQty > 0 || row.allocationSum > 0).length
  if (mismatches.length > 0) failures.push(`${mismatches.length} stock row(s) where reservedQty differs from the allocation sum: ${mismatches.map((m) => `${m.sku} ${m.reservedQty} vs ${m.allocationSum}`).join('; ')}`)
  if (rows.length === 0) failures.push('no stock rows were read, so R4 proves nothing')
  if (rows.length > 0 && withReservations === 0) failures.push('no stock row holds any reservation, so R4 examined nothing (the import allocated nothing)')
  return { assessment: { ok: failures.length === 0, failures }, rowsChecked: rows.length, rowsWithReservations: withReservations, worstDiff: rows.reduce((worst, row) => Math.max(worst, Math.abs(row.reservedQty - row.allocationSum)), 0), mismatches }
}

export type RequestFact = { method: string; path: string; modelled: boolean; status: number; authenticated: boolean }

export type ReadOnlyResult = {
  assessment: Assessment
  totalRequests: number
  byRoute: Record<string, number>
  nonGet: RequestFact[]
  unmodelled: RequestFact[]
  unauthenticated: number
  holdRefusals: Record<string, number | null>
}

/**
 * READ-ONLY. Every request the store saw was a GET (or HEAD), the store modelled every route the import
 * used, every request carried the credentials, and the outbound-write hold recorded no refusal (a refusal
 * would mean the import TRIED to write and was stopped, which this assessor treats as a write attempt).
 */
export function assessReadOnly(input: { requests: readonly RequestFact[]; holdRefusals: Record<string, number | null> }): ReadOnlyResult {
  const byRoute: Record<string, number> = {}
  for (const request of input.requests) {
    const key = `${request.method} ${request.path.replace(/\/\d+(?=\/|$)/g, '/{id}')}`
    byRoute[key] = (byRoute[key] ?? 0) + 1
  }
  const nonGet = input.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
  const unmodelled = input.requests.filter((r) => !r.modelled)
  const unauthenticated = input.requests.filter((r) => !r.authenticated).length
  const failures: string[] = []
  if (input.requests.length === 0) failures.push('the store saw no request at all, so "no write reached it" proves nothing')
  if (nonGet.length > 0) failures.push(`${nonGet.length} non-GET request(s) reached the store: ${nonGet.slice(0, 5).map((r) => `${r.method} ${r.path}`).join(', ')}`)
  if (unmodelled.length > 0) failures.push(`${unmodelled.length} request(s) were for routes the fake does not model: ${[...new Set(unmodelled.map((r) => `${r.method} ${r.path}`))].slice(0, 5).join(', ')}`)
  if (unauthenticated > 0) failures.push(`${unauthenticated} request(s) did not carry the store credentials`)
  for (const [connector, count] of Object.entries(input.holdRefusals)) {
    if (count === null) failures.push(`the outbound-write hold's refusal count for ${connector} was unavailable`)
    else if (count > 0) failures.push(`the outbound-write hold refused ${count} write(s) for ${connector}: the import tried to write`)
  }
  return { assessment: { ok: failures.length === 0, failures }, totalRequests: input.requests.length, byRoute, nonGet, unmodelled, unauthenticated, holdRefusals: input.holdRefusals }
}

export type StampFacts = { completed: string | null; cursor: string | null }

/** A rehearsal pass leaves the stamp exactly as it found it: absent. */
export function assessNoStampAfterRehearsal(input: { before: StampFacts; after: StampFacts; stampedFlag: boolean }): Assessment {
  const failures: string[] = []
  if (input.before.completed !== null || input.before.cursor !== null) failures.push('precondition failed: a stamp already existed before the rehearsal pass, so it cannot show the pass left none')
  if (input.stampedFlag) failures.push('the pass reports that it stamped completion')
  if (input.after.completed !== null) failures.push(`wc_initial_import_completed was written (${input.after.completed}) by a rehearsal pass`)
  if (input.after.cursor !== null) failures.push(`last_wc_order_sync_at was written (${input.after.cursor}) by a rehearsal pass`)
  return { ok: failures.length === 0, failures }
}

/** A real pass judged complete stamps both keys. */
export function assessRealStamp(input: { before: StampFacts; after: StampFacts; stampedFlag: boolean; outcome: string }): Assessment {
  const failures: string[] = []
  if (input.outcome !== 'complete') failures.push(`the real pass ended ${input.outcome}, not complete`)
  if (input.before.completed !== null) failures.push('precondition failed: the stamp was already set before the real pass')
  if (!input.stampedFlag) failures.push('the real pass reports that it did not stamp')
  if (input.after.completed !== 'true') failures.push(`wc_initial_import_completed is ${JSON.stringify(input.after.completed)} after the real pass, not "true"`)
  if (input.after.cursor === null || Number.isNaN(Date.parse(input.after.cursor))) failures.push(`last_wc_order_sync_at is ${JSON.stringify(input.after.cursor)} after the real pass, not a timestamp`)
  return { ok: failures.length === 0, failures }
}

export type PassFacts = {
  outcome: string
  imported: number
  skipped: number
  errors: string[]
  unrecordedRefusals: number
  statuses: string[]
}

/** The pass must call itself complete, and any per-order error must be a known-bad probe. */
export function assessPassComplete(pass: PassFacts, knownBadIds: readonly number[]): Assessment {
  const failures: string[] = []
  if (pass.outcome !== 'complete') failures.push(`the pass ended ${pass.outcome}, not complete`)
  if (pass.unrecordedRefusals > 0) failures.push(`${pass.unrecordedRefusals} refusal(s) could not be recorded`)
  const unexpected = pass.errors.filter((message) => !knownBadIds.some((id) => message.includes(`#${id}:`)))
  if (unexpected.length > 0) failures.push(`${unexpected.length} error(s) the fixtures did not declare: ${unexpected.slice(0, 3).join(' | ')}`)
  return { ok: failures.length === 0, failures }
}

/** The second pass imports nothing and creates nothing. */
export function assessIdempotency(input: { first: PassFacts; second: PassFacts; ordersAfterFirst: number; ordersAfterSecond: number; linesAfterFirst: number; linesAfterSecond: number; knownBadCount: number }): Assessment {
  const failures: string[] = []
  if (input.first.imported <= 0) failures.push('precondition failed: the first pass imported nothing, so a second pass importing nothing proves nothing')
  if (input.second.imported !== 0) failures.push(`the second pass imported ${input.second.imported} order(s); it must import none`)
  if (input.ordersAfterSecond !== input.ordersAfterFirst) failures.push(`sales orders went from ${input.ordersAfterFirst} to ${input.ordersAfterSecond}`)
  if (input.linesAfterSecond !== input.linesAfterFirst) failures.push(`sales order lines went from ${input.linesAfterFirst} to ${input.linesAfterSecond}`)
  // The second pass re-reads everything: the orders already in IMS are skipped, and the known-bad probes are retried (and fail again).
  if (input.second.skipped < input.first.imported) failures.push(`the second pass skipped ${input.second.skipped} order(s) as already imported but the first imported ${input.first.imported}`)
  const secondErrors = input.second.errors.length
  if (secondErrors !== input.knownBadCount) failures.push(`the second pass reported ${secondErrors} error(s); only the ${input.knownBadCount} declared known-bad order(s) may fail again`)
  return { ok: failures.length === 0, failures }
}

/** The resolved status list the Sync page prints must equal the owner decision. */
export function assessStatusSelection(resolved: readonly string[], decided: readonly string[] = DECIDED_IMPORT_STATUSES): Assessment {
  const failures: string[] = []
  const a = [...resolved].sort()
  const b = [...decided].sort()
  if (a.join(',') !== b.join(',')) failures.push(`the resolved status list is [${a.join(', ')}], the owner decision is [${b.join(', ')}]`)
  for (const abandoned of ABANDONED_STATUSES) if (resolved.includes(abandoned)) failures.push(`the resolved list includes ${abandoned}, which the owner decision abandons`)
  return { ok: failures.length === 0, failures }
}

/** The IMS order statuses the backorder allocator and the reallocation sweep act on (lib/fulfillment/reallocation-sweep-selection.ts). */
export const STOCK_LANDING_ELIGIBLE_STATUSES = ['PROCESSING', 'ALLOCATED'] as const

export type LandingFacts = {
  /** Order numbers of imported orders with at least one product line short of stock, at each stage. */
  beforeLanding: string[]
  afterLandingBeforeTrigger: string[]
  afterBackorderAllocator: string[]
  afterSweep: string[]
  /** IMS status of every order that was waiting before the stock landed. */
  statusByOrder: Record<string, string>
}

export type LandingAssessment = {
  assessment: Assessment
  /** Waiting orders in a status neither mechanism looks at: they stay unallocated after the stock lands. */
  notPickedUp: Array<{ orderNumber: string; imsStatus: string }>
  pickedUp: string[]
}

/**
 * OD-4. Orders that could not be allocated at import must become allocated when stock lands. Recorded
 * stage by stage because the stages are different mechanisms: stock on the shelf alone allocates nothing;
 * the event-driven backorder allocator picks up the SKUs it is told about; the cron sweep picks up the rest.
 * Both look only at PROCESSING and ALLOCATED orders, so a waiting order in another status (ON_HOLD,
 * PENDING) is NOT picked up: that is reported as `notPickedUp`, never hidden, and it does not fail the
 * step, because it is what the application does today; it is the finding the owner needs to see.
 */
export function assessLanding(input: LandingFacts): LandingAssessment {
  const failures: string[] = []
  const eligible = (order: string): boolean => (STOCK_LANDING_ELIGIBLE_STATUSES as readonly string[]).includes(input.statusByOrder[order] ?? '')
  const waitingEligible = input.beforeLanding.filter(eligible)
  if (waitingEligible.length === 0) failures.push('precondition failed: no PROCESSING/ALLOCATED order was waiting for stock before it landed, so nothing was proved')
  const allocatedByBareLanding = input.beforeLanding.filter((order) => !input.afterLandingBeforeTrigger.includes(order))
  if (allocatedByBareLanding.length > 0) failures.push(`stock landing alone allocated ${allocatedByBareLanding.length} order(s) without any trigger (the stages below would then prove nothing): ${allocatedByBareLanding.slice(0, 5).join(', ')}`)
  const stuck = waitingEligible.filter((order) => input.afterSweep.includes(order))
  if (stuck.length > 0) failures.push(`${stuck.length} PROCESSING/ALLOCATED order(s) are still waiting after the stock landed and both mechanisms ran: ${stuck.slice(0, 8).join(', ')}`)
  const pickedUp = input.beforeLanding.filter((order) => !input.afterSweep.includes(order))
  const notPickedUp = input.beforeLanding.filter((order) => !eligible(order) && input.afterSweep.includes(order)).map((orderNumber) => ({ orderNumber, imsStatus: input.statusByOrder[orderNumber] ?? 'unknown' }))
  return { assessment: { ok: failures.length === 0, failures }, notPickedUp, pickedUp }
}

// ---------------------------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------------------------

export type SideEffects = {
  customersCreated: number
  customerLinksCreated: number
  ordersWithoutCustomer: number
  linesLinkedToProduct: number
  linesWithoutProduct: number
  ordersWithTaxRateFallback: number
  /** Rows the import queued for the accounting connector, by `type/status`: queued, not sent. */
  accountingQueue: Record<string, number>
  stockSyncJobs: number
  integrationOutbox: number
  emailOutbox: number
}

export type WooImportReport = {
  schemaVersion: 1
  tool: 'rehearse-woo-import'
  runId: string
  verdict: 'GREEN' | 'RED'
  exitCode: RehearsalExitCode
  startedAt: string
  finishedAt: string
  durationMs: number
  host: { node: string; postgresServer: string | null }
  cluster: { root: string; port: number | null; role: string | null; scramVerified: boolean; database: string }
  store: { kind: 'synthetic-fake'; bind: string; ordersTotal: number; ordersByStatus: Record<string, number> }
  statuses: { resolved: string[]; decided: string[]; abandoned: string[] }
  tallies: {
    fetchedFromStore: number | null
    importedFirstPass: number | null
    skippedFirstPass: number | null
    errorsFirstPass: number | null
    importedSecondPass: number | null
    ordersInIms: number | null
    abandonedByStatus: number | null
    knownBadProbes: number | null
  }
  r9: { expectedCount: number; importedCount: number; knownBadCount: number; missing: number[]; maxValueDiffForeign: number; maxValueDiffBase: number; maxComponentsDiff: number; tolerance: number } | null
  r4: { rowsChecked: number; rowsWithReservations: number; worstDiff: number; tolerance: number; afterLanding: { rowsChecked: number; worstDiff: number } | null } | null
  orders: OrderRow[]
  skippedWithReason: Array<{ externalOrderId: number; reason: string }>
  /** Imported orders that could not be fully allocated at import, and what became of them when stock landed. */
  unallocatable: Array<{
    externalOrderId: number
    orderNumber: string
    imsStatus: string
    noProductLines: number
    shortLines: number
    shortQty: number
    afterLanding: 'allocated-when-stock-landed' | 'still-waiting' | 'never-allocatable-lines-without-product' | 'not-run'
  }>
  /** What the first pass left in IMS beyond orders and allocations: customers, product links, and rows queued for connectors (queued, never sent). */
  sideEffects: SideEffects | null
  /** Things the owner must read that do not make the run RED. */
  findings: Array<{ code: string; text: string; orders: string[] }>
  landing: LandingFacts | null
  stamp: { afterRehearsal: StampFacts | null; afterRealPass: StampFacts | null }
  readOnly: { totalRequests: number; byRoute: Record<string, number>; nonGetRequests: number; unmodelledRequests: number; holdRefusals: Record<string, number | null> } | null
  steps: StepResult[]
  teardown: TeardownResult | null
  notes: string[]
  interrupted: string | null
}

export function wooImportExitCode(steps: readonly StepResult[], teardown: TeardownResult | null, interrupted: string | null = null): RehearsalExitCode {
  if (teardown !== null && teardownIncomplete(teardown)) return WOO_IMPORT_EXIT.TEARDOWN_INCOMPLETE
  if (interrupted !== null || isRed(steps)) return WOO_IMPORT_EXIT.RED
  return WOO_IMPORT_EXIT.OK
}

export function buildWooImportReport(input: Omit<WooImportReport, 'schemaVersion' | 'tool' | 'verdict' | 'exitCode' | 'durationMs'>): WooImportReport {
  const exitCode = wooImportExitCode(input.steps, input.teardown, input.interrupted)
  return {
    schemaVersion: 1,
    tool: 'rehearse-woo-import',
    verdict: exitCode === WOO_IMPORT_EXIT.OK ? 'GREEN' : 'RED',
    exitCode,
    durationMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt),
    ...input,
  }
}

const cell = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderWooImportMarkdown(report: WooImportReport): string {
  const lines: string[] = []
  lines.push(`# WooCommerce initial-import rehearsal: ${report.verdict}`)
  lines.push('')
  lines.push(`Run ${report.runId}, exit code ${report.exitCode}, ${report.startedAt} to ${report.finishedAt} (${report.durationMs} ms).`)
  lines.push('')
  lines.push(`> ${REHEARSAL_NOT_PROVEN_STATEMENT}`)
  lines.push('')
  lines.push(`> ${REHEARSAL_STAMP_STATEMENT}`)
  lines.push('')
  lines.push('## Steps')
  lines.push('')
  lines.push('| Step | Result | Detail |')
  lines.push('| --- | --- | --- |')
  for (const step of report.steps) lines.push(`| ${cell(step.title)} | ${step.status.toUpperCase()}${step.required ? '' : ' (optional)'} | ${cell(step.reason ?? '')} |`)
  lines.push('')
  lines.push('## Status selection')
  lines.push('')
  lines.push(`Resolved list (what the Sync page prints before the button): ${report.statuses.resolved.join(', ') || '(none)'}.`)
  lines.push(`Owner decision: ${report.statuses.decided.join(', ')}. Abandoned on purpose: ${report.statuses.abandoned.join(', ')}.`)
  lines.push('')
  lines.push('## Tallies')
  lines.push('')
  lines.push('| Measure | Value |')
  lines.push('| --- | --- |')
  for (const [key, value] of Object.entries(report.tallies)) lines.push(`| ${key} | ${value === null ? 'n/a' : value} |`)
  lines.push('')
  if (report.r9) {
    lines.push('## R9: orders')
    lines.push('')
    lines.push(`Expected in the selected statuses: ${report.r9.expectedCount}; imported: ${report.r9.importedCount}; declared known to fail: ${report.r9.knownBadCount}; missing: ${report.r9.missing.length}.`)
    lines.push(`Worst difference to WooCommerce: ${report.r9.maxValueDiffForeign} (order currency), ${report.r9.maxValueDiffBase} (GBP), ${report.r9.maxComponentsDiff} (parts vs total); tolerance ${report.r9.tolerance}.`)
    lines.push('')
  }
  if (report.r4) {
    lines.push('## R4: reservations')
    lines.push('')
    lines.push(`${report.r4.rowsChecked} stock row(s) checked, ${report.r4.rowsWithReservations} with reservations; worst |reserved - allocated| ${report.r4.worstDiff} (tolerance ${report.r4.tolerance}).${report.r4.afterLanding ? ` After stock landed: ${report.r4.afterLanding.rowsChecked} row(s), worst ${report.r4.afterLanding.worstDiff}.` : ''}`)
    lines.push('')
  }
  lines.push('## Skipped with reason')
  lines.push('')
  if (report.skippedWithReason.length === 0) lines.push('None.')
  else {
    lines.push('| Order | Reason |')
    lines.push('| --- | --- |')
    for (const row of report.skippedWithReason) lines.push(`| ${row.externalOrderId} | ${cell(row.reason)} |`)
  }
  lines.push('')
  lines.push('## Imported but not (fully) allocatable')
  lines.push('')
  if (report.unallocatable.length === 0) lines.push('None.')
  else {
    lines.push('Lines without a product link (a SKU IMS does not hold, a line with no SKU, a fee) can never be allocated. Lines with a product that are short of stock wait for it.')
    lines.push('')
    lines.push('| Order | IMS status | Lines without a product | Lines short of stock | Quantity short | After stock landed |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const row of report.unallocatable) lines.push(`| ${row.externalOrderId} | ${cell(row.imsStatus)} | ${row.noProductLines} | ${row.shortLines} | ${row.shortQty} | ${row.afterLanding} |`)
  }
  lines.push('')
  if (report.findings.length > 0) {
    lines.push('## Findings (do not fail the run; read them)')
    lines.push('')
    for (const finding of report.findings) lines.push(`- **${finding.code}**: ${cell(finding.text)}${finding.orders.length > 0 ? ` Orders: ${finding.orders.slice(0, 20).join(', ')}${finding.orders.length > 20 ? ', ...' : ''}.` : ''}`)
    lines.push('')
  }
  if (report.landing) {
    lines.push('## OD-4: stock lands after the import')
    lines.push('')
    lines.push(`Waiting before stock landed: ${report.landing.beforeLanding.length}. After stock landed, before anything was triggered: ${report.landing.afterLandingBeforeTrigger.length}. After the backorder allocator: ${report.landing.afterBackorderAllocator.length}. After the cron sweep: ${report.landing.afterSweep.length}.`)
    lines.push('')
  }
  if (report.sideEffects) {
    const e = report.sideEffects
    lines.push('## What the first pass left behind besides orders')
    lines.push('')
    lines.push(`Customers created: ${e.customersCreated} (links to WooCommerce customers: ${e.customerLinksCreated}); orders with no customer: ${e.ordersWithoutCustomer}. Lines linked to a product by SKU: ${e.linesLinkedToProduct}; lines with no product: ${e.linesWithoutProduct}. Orders that used the default tax rate because WooCommerce's rate id was not mapped: ${e.ordersWithTaxRateFallback}.`)
    lines.push(`Queued for connectors, never sent (the outbound-write hold refuses the send): accounting queue ${JSON.stringify(e.accountingQueue)}; stock-sync jobs ${e.stockSyncJobs}; integration outbox ${e.integrationOutbox}; email outbox ${e.emailOutbox}.`)
    lines.push('')
  }
  lines.push('## Stamp')
  lines.push('')
  lines.push(`After the rehearsal pass: ${report.stamp.afterRehearsal ? JSON.stringify(report.stamp.afterRehearsal) : 'n/a'}. After the real pass: ${report.stamp.afterRealPass ? JSON.stringify(report.stamp.afterRealPass) : 'n/a'}.`)
  lines.push('')
  if (report.readOnly) {
    lines.push('## Read-only proof')
    lines.push('')
    lines.push(`${report.readOnly.totalRequests} request(s) reached the store; ${report.readOnly.nonGetRequests} were not GET; ${report.readOnly.unmodelledRequests} were for routes the fake does not model. The outbound-write hold refused: ${JSON.stringify(report.readOnly.holdRefusals)}.`)
    lines.push('')
    lines.push('| Route | Requests |')
    lines.push('| --- | --- |')
    for (const [route, count] of Object.entries(report.readOnly.byRoute)) lines.push(`| ${cell(route)} | ${count} |`)
    lines.push('')
  }
  lines.push('## Per order')
  lines.push('')
  lines.push('| Order | Status | Currency | Outcome | WooCommerce total | IMS total | Diff | Parts diff | Within tolerance | Note |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of report.orders) {
    lines.push(`| ${row.externalOrderId} | ${row.status} | ${row.currency} | ${row.outcome} | ${row.wcTotal} | ${row.importedTotalForeign ?? ''} | ${row.valueDiffForeign ?? ''} | ${row.componentsDiffForeign ?? ''} | ${row.withinTolerance === null ? '' : row.withinTolerance ? 'yes' : 'NO'} | ${cell(row.reason ?? '')} |`)
  }
  lines.push('')
  if (report.teardown) {
    lines.push('## Teardown')
    lines.push('')
    lines.push(`Cluster stopped: ${report.teardown.clusterStopped}; env file shredded: ${report.teardown.envFileShredded}; run directory removed: ${report.teardown.rootRemoved}; orphan processes: ${report.teardown.orphanPids.length === 0 ? 'none' : report.teardown.orphanPids.join(', ')}.`)
    for (const error of report.teardown.errors) lines.push(`- ${cell(error)}`)
    lines.push('')
  }
  if (report.notes.length > 0) {
    lines.push('## Notes')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${cell(note)}`)
    lines.push('')
  }
  return lines.join('\n')
}
