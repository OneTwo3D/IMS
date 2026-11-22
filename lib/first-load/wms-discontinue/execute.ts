/**
 * THE FIRST-LOAD WMS ARCHIVE WRITE: carries out a confirmed archive plan (lib/first-load/wms-discontinue/plan.ts), one WOULD_ARCHIVE SKU at a time.
 * PURE ORCHESTRATION: every request goes through the injected WMS writer (the connector module names the WMS and holds the vetted request shape), every
 * record through the injected IMS target, every pause through the injected sleep. No file, clock, network or database module is imported here.
 *
 * PER SKU, in this order, and the run STOPS at the first answer that is not exactly the expected one (nothing after it is attempted):
 *   1. re-read the product by its id: it must be the plan's product (same id, EXACTLY the same SKU, our client), not a bundle, and not discontinued;
 *   2. re-read its physical stock across the configured warehouses: a stock row must exist and the total must be exactly 0;
 *   3. read the system switch again (it must still read on), read the target's newest switchover-check record again (it must still pass, judged by the
 *      writer: an M rollback that resumed the incumbent is caught here once a failing check is recorded, even in a run started before it) and record the
 *      attempt in the IMS activity log (a failed record stops the run before anything is sent);
 *   4. send the discontinue request, and require the WMS to say it succeeded (a 200 alone proves nothing). A failure says whether the request may have
 *      left: refused before it left (nothing was sent) or dispatched without a usable answer (it may have reached the WMS);
 *   5. re-read the product: the flag must now read discontinued and NO other field may differ from the read of step 1 (the writer names the fields that
 *      are allowed to move with any update, such as a last-updated stamp);
 *   6. record the verified write (or the failure) in the activity log, with the SKU, the WMS product id, the flag before and after, the operator, the
 *      evidence that the WMS step is live in the target and the target-resident evidence that the incumbent product sync is retired there. Every attempt
 *      that was recorded gets its outcome recorded, sent or not.
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

/** The answer to the discontinue request. A failure says whether the request may have reached the WMS: `false` refused before it left, `'unknown'` dispatched. */
export type WmsDiscontinueAnswer = { ok: true; value: { accepted: boolean; message: string } } | { ok: false; problem: string; sent: false | 'unknown' }

/**
 * The newest retirement attestation of the kind the command names (WmsArchiveExecuteDeps.retirementEvidenceKind), as the TARGET installation holds it,
 * read in the same READ ONLY transaction as the import proof; null when none is recorded there. `attestedAt` is an ISO instant (UTC).
 */
export interface ArchiveRetirementRow {
  attestedAt: string
  payload: unknown
}

/**
 * The newest switchover-check record of the TARGET (the `writers_check_recorded` activity-log row the installation's own scheduled `writers:check`
 * writes), read in the same READ ONLY transaction as the import proof and again before each write; null when none is recorded there. `level` is the
 * activity-log level (INFO only for a passing check), `createdAt` an ISO instant (UTC), `metadata` the stored record (`{ report }`).
 */
export interface ArchiveSwitchoverCheckRow {
  level: string
  createdAt: string
  metadata: unknown
}

export type ArchiveEvidence = { ok: true; evidence: string } | { ok: false; problem: string }

/** What the preflight judges besides the target's environment: the target-resident evidence and the instant of the run. */
export interface ArchivePreflightFacts {
  retirement: ArchiveRetirementRow | null
  switchoverCheck: ArchiveSwitchoverCheckRow | null
  now: Date
}

/** The WMS side of the write, supplied by the connector module (the only place the WMS is named). */
export interface WmsArchiveWriter {
  label: string
  readProduct(productId: string): Promise<WmsStep<WmsProductRead>>
  /** The physical stock of the product summed over the configured warehouses, and whether any of them has a stock row for it. */
  readStock(productId: string, sku: string): Promise<WmsStep<{ stockRow: boolean; onHand: number }>>
  /** Sends the discontinue request. `accepted` is the WMS's own verdict on the answer body (never the HTTP status alone); `message` is short and carries no credential. */
  setDiscontinued(productId: string, sku: string): Promise<WmsDiscontinueAnswer>
  /** The fields of the two product answers that differ, except the discontinued flag and the fields any update moves (named by the connector). */
  changedFields(before: unknown, after: unknown): string[]
  /**
   * Once, before anything is read for the write: whether the write may leave at all under the TARGET installation's rules (the WMS step live, the hold,
   * the grant) and its own evidence that the incumbent's product sync is retired (`facts.retirement`, read from the target). Both evidences are
   * recorded with every write.
   */
  preflight(facts: ArchivePreflightFacts): { ok: true; evidence: string; retirementEvidence: string; switchoverEvidence: string } | { ok: false; problem: string }
  /** The writer's judgement of one switchover-check record at an instant (the preflight uses it, and the run again before each write). */
  judgeSwitchoverCheck(row: ArchiveSwitchoverCheckRow | null, now: Date): ArchiveEvidence
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
  /** Why the write was allowed to leave: the WMS step live in the target, as the writer's preflight found it. */
  stepEvidence: string
  /** The target-resident evidence that the incumbent's product sync is retired, as the writer's preflight found it. */
  retirementEvidence: string
  /** The target's passing switchover-check record, as judged right before this row's write (the preflight's for a row that did not get that far). */
  switchoverEvidence: string
  problem: string | null
}

export interface ArchiveExecuteDeps {
  writer: WmsArchiveWriter
  /** Writes one activity-log entry in its own transaction; throws when it could not. */
  record: (entry: ArchiveWriteRecord) => Promise<void>
  /** The IMS product id of each SKU written (from the import proof). */
  imsProductIdOf: (sku: string) => string
  operator: string
  /** The writer's preflight evidence, recorded with every write. */
  stepEvidence: string
  /** The writer's preflight retirement evidence, recorded with every write. */
  retirementEvidence: string
  /** The writer's preflight switchover-check evidence; each row records the evidence of its own re-check. */
  switchoverEvidence: string
  /** Reads the target's newest switchover-check record again and judges it (the writer's judgement). Called before each request that writes. */
  switchoverCheckStillPasses: () => Promise<ArchiveEvidence>
  /** Reads the system switch again; true only when it still reads on. Called before each request that writes. */
  switchStillOn: () => Promise<boolean>
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
    const base = { sku: row.sku, imsProductId: deps.imsProductIdOf(row.sku), wmsProductId: productId, wms: label, discontinuedBefore: false, operator: deps.operator, planToken: plan.token, sheetId: plan.sheetId, stepEvidence: deps.stepEvidence, retirementEvidence: deps.retirementEvidence, switchoverEvidence: deps.switchoverEvidence }
    let attempted = false
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
      // 3. the switch, read again, and the attempt, recorded before anything is sent
      let on = false
      try {
        on = await deps.switchStillOn()
      } catch {
        throw new Stop('the system switch could not be read again, so nothing was sent', false)
      }
      if (!on) throw new Stop('the system switch no longer reads on in the target, so nothing was sent', false)
      let check: ArchiveEvidence
      try {
        check = await deps.switchoverCheckStillPasses()
      } catch {
        throw new Stop('the target\'s newest switchover-check entry could not be read again, so nothing was sent', false)
      }
      if (!check.ok) throw new Stop(`the target's switchover check no longer passes, so nothing was sent: ${check.problem}`, false)
      base.switchoverEvidence = check.evidence
      try {
        await deps.record({ ...base, outcome: 'ATTEMPT', discontinuedAfter: null, problem: null })
      } catch {
        throw new Stop('the attempt could not be recorded in the IMS activity log, so nothing was sent', false)
      }
      attempted = true
      // 4. the write
      const answer = await writer.setDiscontinued(productId, row.sku)
      if (!answer.ok) throw new Stop(`the ${label} discontinue request for product ${productId} failed: ${answer.problem}`, answer.sent !== false)
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
      if (attempted) {
        // Best effort: the failure is printed in any case. The flag is read back only when the request may have left.
        let flag: boolean | null = null
        if (error.sent) {
          const after = await writer.readProduct(productId).catch(() => null)
          flag = after !== null && after.ok ? after.value.discontinued : null
        }
        await deps.record({ ...base, outcome: 'FAILED', discontinuedAfter: flag, problem: `${error.problem}${error.sent ? ' (the request was sent)' : ' (nothing was sent)'}` }).catch(() => undefined)
      }
      return { verified, stopped: { row, problem: error.problem, sent: error.sent }, notAttempted: targets.slice(index + 1) }
    }
  }
  return { verified, stopped: null, notAttempted: [] }
}
