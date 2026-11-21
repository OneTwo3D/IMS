/**
 * THE FIRST-LOAD WMS ARCHIVE WRITE: carries out a confirmed archive plan (lib/first-load/wms-discontinue/plan.ts), one WOULD_ARCHIVE SKU at a time.
 * PURE ORCHESTRATION: every request goes through the injected WMS writer (the connector module names the WMS and holds the vetted request shape), every
 * record through the injected IMS target, every pause through the injected sleep. No file, clock, network or database module is imported here.
 *
 * PER SKU, in this order, and the run STOPS at the first answer that is not exactly the expected one (nothing after it is attempted):
 *   1. re-read the product by its id: it must be the plan's product (same id, EXACTLY the same SKU, our client), not a bundle, and not discontinued;
 *   2. re-read its physical stock across the configured warehouses: a stock row must exist and the total must be exactly 0;
 *   3. record the attempt in the IMS activity log (a failed record stops the run before anything is sent);
 *   4. send the discontinue request, and require the WMS to say it succeeded (a 200 alone proves nothing);
 *   5. re-read the product: the flag must now read discontinued and NO other field may differ from the read of step 1 (the writer names the fields that
 *      are allowed to move with any update, such as a last-updated stamp);
 *   6. record the verified write (or the failure) in the activity log, with the SKU, the WMS product id, the flag before and after, and the operator.
 */
import type { ArchivePlan, ArchivePlanRow } from './plan'

export type WmsStep<T> = { ok: true; value: T } | { ok: false; problem: string }

/** One product as the WMS answers for it by id, reduced to what the checks need; `snapshot` is the whole answer, compared field by field after the write. */
export interface WmsProductRead {
  productId: string
  sku: string
  /** null when the answer does not say. */
  bundle: boolean | null
  /** null when the answer carries no discontinued flag (or not a boolean). */
  discontinued: boolean | null
  /** The answer names the client (tenant) the credentials are for. */
  ownClient: boolean
  snapshot: unknown
}

/** The WMS side of the write, supplied by the connector module (the only place the WMS is named). */
export interface WmsArchiveWriter {
  label: string
  readProduct(productId: string): Promise<WmsStep<WmsProductRead>>
  /** The physical stock of the product summed over the configured warehouses, and whether any of them has a stock row for it. */
  readStock(productId: string, sku: string): Promise<WmsStep<{ stockRow: boolean; onHand: number }>>
  /** Sends the discontinue request. `accepted` is the WMS's own verdict on the answer body (never the HTTP status alone); `message` is short and carries no credential. */
  setDiscontinued(productId: string, sku: string): Promise<WmsStep<{ accepted: boolean; message: string }>>
  /** The fields of the two product answers that differ, except the discontinued flag and the fields any update moves (named by the connector). */
  changedFields(before: unknown, after: unknown): string[]
}

export type ArchiveWriteOutcome = 'ATTEMPT' | 'VERIFIED' | 'FAILED'

/** One activity-log entry of the write. */
export interface ArchiveWriteRecord {
  outcome: ArchiveWriteOutcome
  sku: string
  /** The IMS product id (the activity log's entity). */
  imsProductId: string
  wmsProductId: string
  wms: string
  discontinuedBefore: boolean
  /** The flag as read back after the write, or null when it was not read back. */
  discontinuedAfter: boolean | null
  operator: string
  planToken: string
  sheetId: string
  problem: string | null
}

export interface ArchiveExecuteDeps {
  writer: WmsArchiveWriter
  /** Writes one activity-log entry in its own transaction; throws when it could not. */
  record: (entry: ArchiveWriteRecord) => Promise<void>
  /** The IMS product id of each SKU written (from the import proof). */
  imsProductIdOf: (sku: string) => string
  operator: string
  /** Called once per line of progress. */
  progress: (line: string) => void
}

export interface ArchiveExecuteResult {
  verified: ArchivePlanRow[]
  /** The row the run stopped at and why, or null when every row was verified. */
  stopped: { row: ArchivePlanRow; problem: string; sent: boolean } | null
  /** WOULD_ARCHIVE rows after the stop, never attempted. */
  notAttempted: ArchivePlanRow[]
}

class Stop extends Error {
  constructor(readonly problem: string, readonly sent: boolean) {
    super(problem)
  }
}

export async function executeArchivePlan(plan: ArchivePlan, deps: ArchiveExecuteDeps): Promise<ArchiveExecuteResult> {
  const { writer } = deps
  const label = writer.label
  const targets = plan.rows.filter((r) => r.outcome === 'WOULD_ARCHIVE')
  const verified: ArchivePlanRow[] = []
  for (let index = 0; index < targets.length; index++) {
    const row = targets[index]!
    const productId = row.productId!
    const base = { sku: row.sku, imsProductId: deps.imsProductIdOf(row.sku), wmsProductId: productId, wms: label, discontinuedBefore: false, operator: deps.operator, planToken: plan.token, sheetId: plan.sheetId }
    try {
      // 1. the product, read again right before the write
      const before = await writer.readProduct(productId)
      if (!before.ok) throw new Stop(`the ${label} product ${productId} could not be read again: ${before.problem}`, false)
      const b = before.value
      if (b.productId !== productId) throw new Stop(`the ${label} answer for product ${productId} names product ${b.productId}`, false)
      if (b.sku !== row.sku) throw new Stop(`the ${label} product ${productId} now holds the SKU ${JSON.stringify(b.sku)}, not exactly ${JSON.stringify(row.sku)}`, false)
      if (!b.ownClient) throw new Stop(`the ${label} product ${productId} does not name our client`, false)
      if (b.bundle !== false) throw new Stop(b.bundle === true ? `the ${label} product ${productId} is a bundle` : `the ${label} product ${productId} does not say whether it is a bundle`, false)
      if (b.discontinued !== false) throw new Stop(b.discontinued === true ? `the ${label} product ${productId} is already discontinued (it was not when the plan was made)` : `the ${label} product ${productId} carries no discontinued flag`, false)
      // 2. its physical stock, read again live
      const stock = await writer.readStock(productId, row.sku)
      if (!stock.ok) throw new Stop(`the ${label} stock of product ${productId} could not be read again: ${stock.problem}`, false)
      if (!stock.value.stockRow) throw new Stop(`no configured ${label} warehouse has a stock row for product ${productId} now: its stock is unknown`, false)
      if (stock.value.onHand !== 0) throw new Stop(`the ${label} product ${productId} now shows physical stock ${stock.value.onHand}: never archived unless it is exactly 0`, false)
      // 3. the attempt, recorded before anything is sent
      try {
        await deps.record({ ...base, outcome: 'ATTEMPT', discontinuedAfter: null, problem: null })
      } catch {
        throw new Stop('the attempt could not be recorded in the IMS activity log, so nothing was sent', false)
      }
      // 4. the write
      const answer = await writer.setDiscontinued(productId, row.sku)
      if (!answer.ok) throw new Stop(`the ${label} discontinue request for product ${productId} failed: ${answer.problem}`, true)
      if (!answer.value.accepted) throw new Stop(`${label} did not accept the discontinue request for product ${productId}: ${answer.value.message}`, true)
      // 5. the read-back
      const after = await writer.readProduct(productId)
      if (!after.ok) throw new Stop(`the ${label} product ${productId} could not be read back after the write: ${after.problem}`, true)
      if (after.value.discontinued !== true) throw new Stop(`the ${label} product ${productId} does not read discontinued after a write ${label} accepted`, true)
      const changed = writer.changedFields(b.snapshot, after.value.snapshot)
      if (changed.length > 0) throw new Stop(`the write changed other fields of the ${label} product ${productId} as well: ${changed.join(', ')}`, true)
      // 6. the verified write
      try {
        await deps.record({ ...base, outcome: 'VERIFIED', discontinuedAfter: true, problem: null })
      } catch {
        throw new Stop(`the ${label} product ${productId} was set discontinued and verified, but the IMS activity log entry could not be written`, true)
      }
      verified.push(row)
      deps.progress(`  ${row.sku}: ${label} product ${productId} set discontinued and verified (${index + 1} of ${targets.length})`)
    } catch (error) {
      if (!(error instanceof Stop)) throw error
      if (error.sent) {
        // Best effort: the failure is printed in any case.
        const after = await writer.readProduct(productId).catch(() => null)
        const flag = after !== null && after.ok ? after.value.discontinued : null
        await deps.record({ ...base, outcome: 'FAILED', discontinuedAfter: flag, problem: error.problem }).catch(() => undefined)
      }
      return { verified, stopped: { row, problem: error.problem, sent: error.sent }, notAttempted: targets.slice(index + 1) }
    }
  }
  return { verified, stopped: null, notAttempted: [] }
}
