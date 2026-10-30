/**
 * THE IMS TO WOOCOMMERCE TAX-RATE WRITER, HELD AT P1. Operator-confirmed; reads the store with GET only and writes it only when the producer hold says LIVE.
 *
 * WHAT IT DOES. `readWooTaxPlan` computes the plan (lib/connectors/woocommerce/tax-rate-plan.ts: the changes that would make the WooCommerce side of the R13 VAT set identity hold) and its
 * digest; it writes nothing, anywhere. `applyWooTaxPlan` sends a plan the operator confirmed by its digest.
 *
 * THE HOLD (ownership map: woocommerce `tax-rate`, P1 owner operator-manual, P2 owner IMS)
 *   - Hold NOT enforced for WooCommerce: the apply is REFUSED (HOLD_NOT_ENFORCED). This writer is new: there is no earlier behaviour to preserve, so "unenforced" is never a licence to send.
 *   - Hold enforced and the decision SHADOW (P1: the owner corrects the store by hand): each change is recorded as an outbound shadow (`outbound_shadow_writes`) and NOTHING is sent and NOTHING
 *     else is written: no change record, no mapping row. A re-run only adds to the shadow's occurrence count.
 *   - Hold enforced and the decision LIVE (P2 for the destination, and IMS the owner of the operation): the changes are sent through the injected port, one at a time, in plan order. The apply
 *     asks wooProducerSeam for EACH change before it sends it, and the transport (wcPost, wcPut) has its own last barrier behind that.
 *
 * THE APPLY
 *   1. `confirm` must be the exact 64-hex digest of the plan the operator saw. Checked before anything is read.
 *   2. The single-runner lock (WOO_TAX_RATE_WRITE_LOCK_KEY) is taken and held to the end. A second apply waits for it, then reads the store as the first left it: usually nothing to do.
 *   3. Under the lock the plan is REBUILT from the IMS database and the store. No changes: nothing to do (a re-run after success writes nothing and sends nothing). Another digest: refused
 *      (DIGEST_MISMATCH), nothing written. A blocker: refused (BLOCKED).
 *   4. Per change: seam, then send, then ONE transaction that writes the change record (`woo_tax_rate_writes`) and creates or updates the mapping row. A store refusal stops the run, records
 *      a FAILED row and leaves what was already done done: preview again for the rest.
 *
 * LIMITS (disclosed, not hidden)
 *   - The IMS rates are not locked across the sends (network calls cannot sit in a transaction): an IMS edit between the plan and the send is not seen until the next preview. The digest binds
 *     what the operator confirmed, and the sends follow it immediately.
 *   - A store write that succeeded but whose record could not be committed leaves a store rate without a record and (for a CREATE) without a mapping row. The apply stops and says so; the next
 *     plan then reports that rate as an UNMAPPED_TWIN blocker until the owner maps it. Nothing is created twice.
 *   - Store tax classes must exist in the store: the store refuses a rate of a class it does not have, and the apply stops with its answer.
 *   - A mapping row is kept when its store rate is deleted (historic orders still resolve their tax lines through it); it is simply no longer a counterpart.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { WOO_TAX_RATE_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockWaiting, AdvisoryLockLostError, AdvisoryLockWaitTimeoutError } from '@/lib/db/pinned-advisory-lock'
import type { ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { producerSeamVerdict } from '@/lib/security/producer-seam'
import type { TaxComponentRateRow, TaxRateRow } from '@/lib/reconciliation-pack/ims-readers'
import type { WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { planAdoption, planWooTaxRates, ownedWooIdsFromRecords, identityOfMapping, identityOfWoo, revalidateWooTaxChange, REVALIDATION_FAILURES, sameRateIdentity, type AdoptionPlan, type FieldChange, type WooTaxChange, type WooTaxMappingRow, type WooTaxPlan, type WooTaxRateFields } from './tax-rate-plan'
import { wooProducerSeam } from './producer-seam'

const DIGEST_RE = /^[0-9a-f]{64}$/
const APPLY_WAIT_MS = 120_000

/** What the store answered to one write. `held` means the transport's last barrier refused it before it left IMS. */
export type WooTaxPortResult = { ok: true; id?: string } | { ok: false; error: string; held?: true }

/** The write side of the store, as the writer needs it. The real one is lib/connectors/woocommerce/tax-rate-port.ts; tests inject a fake. */
export interface WooTaxRateWritePort {
  create(fields: WooTaxRateFields): Promise<WooTaxPortResult>
  update(wooId: string, changed: Readonly<Partial<WooTaxRateFields>>): Promise<WooTaxPortResult>
  remove(wooId: string): Promise<WooTaxPortResult>
}

export type WooTaxReadResult = { ok: true; rates: WooTaxRateDetail[] } | { ok: false }

export type WooTaxWriterDeps = {
  /** The proven, GET-only read of the store's tax rates. */
  readWoo: () => Promise<WooTaxReadResult>
  /**
   * The normalised URL of the store the run's PINNED credentials point at (`normaliseStoreIdentity`), or null when none is usable. Every ownership source, and the digest, are bound to it.
   * The reads (`readWoo`, `readWooRate`) and the `port` must use those same pinned credentials (lib/connectors/woocommerce/tax-rate-session.ts builds all of them from one resolution).
   */
  storeIdentity: () => Promise<string | null>
  /** Required by an apply: the normalised URL of the store configured RIGHT NOW (the settings read again). Differing from `storeIdentity` refuses the apply and stops a running one. */
  configuredStoreIdentity?: () => Promise<string | null>
  /** Required by an apply: ONE store rate read again (GET only, the pinned credentials: the proven walk, then that rate), checked immediately before each UPDATE or DELETE is sent. */
  readWooRate?: (wooId: string) => Promise<{ ok: true; rate: WooTaxRateDetail } | { ok: false }>
  /** Required by an apply. */
  port?: WooTaxRateWritePort
  /** Test seam: the environment and clock the producer decision reads (default: the process). */
  context?: ProducerDecisionContext
}

export type WooTaxHold = {
  mode: 'held' | 'live' | 'not-enforced'
  detail: string
}

/** Where the hold stands for the tax-rate operation, in words. Pure over the environment. */
export function wooTaxHold(context?: ProducerDecisionContext): WooTaxHold {
  const verdict = producerSeamVerdict('woocommerce', 'tax-rate', undefined, context)
  if (verdict.kind === 'legacy') return { mode: 'not-enforced', detail: 'PRODUCER_HOLD_ENFORCED_DESTINATIONS does not name woocommerce, so the producer-side hold is not enforced: an apply is refused' }
  if (verdict.kind === 'shadow') return { mode: 'held', detail: `held (${verdict.decision.reason}, owner ${verdict.decision.owner}): an apply records shadows and sends nothing` }
  return { mode: 'live', detail: 'LIVE: an apply sends the planned changes to WooCommerce' }
}

export const WOO_TAX_REFUSALS = {
  CONFIRM_REQUIRED: 'an apply needs the exact 64-character plan digest the operator saw in the preview',
  PORT_MISSING: 'no WooCommerce write port (or no way to re-read a store rate or the configured store before a send) was given to the apply',
  STORE_CHANGED: 'the store configured now is not the store the plan and the credentials of this run were bound to; nothing was sent. Preview again',
  HOLD_NOT_ENFORCED: 'the producer-side hold is not enforced for WooCommerce, so this writer does not run (it has no earlier behaviour to preserve)',
  BUSY: 'another apply of the WooCommerce tax rates is running and did not finish in time',
  IMS_UNREADABLE: 'the IMS tax rates, mappings or the writer record could not be read',
  STORE_UNIDENTIFIED: 'the store configured now has no usable URL, so ownership cannot be tied to a store',
  ADOPTION_FAILED: 'the adoption could not stamp every row (a mapping row changed or went away meanwhile); nothing was stamped',
  WOO_UNREADABLE: 'the WooCommerce tax rates could not be read and proven (no credentials, a refused or failed request, or pages that disagree)',
  DIGEST_MISMATCH: 'the plan changed since it was previewed (or this is not its digest); preview again. Nothing was written',
  BLOCKED: 'the plan has a blocker (see it in the preview); resolve it and preview again. Nothing was written',
  LOCK_LOST: 'the single-runner lock was lost while the apply was running; it stopped',
} as const
export type WooTaxRefusalCode = keyof typeof WOO_TAX_REFUSALS

export type AppliedChange = { key: string; kind: WooTaxChange['kind']; wooId: string | null }
export type FailedChange = { key: string; kind: WooTaxChange['kind']; error: string }

export type WooTaxApplyResult =
  | { outcome: 'REFUSED'; code: WooTaxRefusalCode; plan: WooTaxPlan | null }
  | { outcome: 'NOTHING_TO_DO'; plan: WooTaxPlan }
  | {
      outcome: 'DONE'
      plan: WooTaxPlan
      /** Changes sent and recorded. */
      applied: AppliedChange[]
      /** Changes the hold kept as shadows: nothing sent, nothing else written. */
      shadowed: string[]
      /** Shadow records that could not be written (lost evidence, not lost work). */
      shadowUnrecorded: number
      /** A change the store refused (the run stopped there), or one that was sent but could not be recorded. */
      failed: FailedChange | null
      /** A change that WAS sent but could not be recorded (the mapping row it rests on is not the one planned, or the commit failed): the run stopped there. */
      unrecorded: { key: string; reason: string } | null
      /** A change NOT sent because what it rested on changed after the plan (checked immediately before the send): the run stopped there and nothing later was sent. */
      stopped?: { key: string; reason: string } | null
    }

type ReadClient = Pick<Prisma.TransactionClient, 'taxRate' | 'taxRateComponent' | 'shoppingTaxRateMapping' | 'wooTaxRateWrite'>

type ImsState = {
  rates: TaxRateRow[]
  componentRates: TaxComponentRateRow[]
  mappings: WooTaxMappingRow[]
  recordedOwnedWooIds: Set<string>
}

/** The mapping row a send rests on is not the planned one, or the commit failed after the send. */
class UnrecordedSendError extends Error {}

async function readImsState(client: ReadClient, storeIdentity: string): Promise<ImsState> {
  const rates = await client.taxRate.findMany({
    select: { id: true, name: true, rate: true, usedFor: true, reverseCharge: true, active: true, accountingTaxType: true, countryCode: true, reportingCategory: true, isCompound: true, taxCategory: true },
    orderBy: { id: 'asc' },
  })
  const components = await client.taxRateComponent.findMany({ select: { taxRateId: true, rate: true, compoundOnPrevious: true, active: true, sortOrder: true }, orderBy: [{ taxRateId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }] })
  const mappings = await client.shoppingTaxRateMapping.findMany({
    where: { connector: 'woocommerce' },
    select: { externalTaxRateId: true, taxRateId: true, externalName: true, externalCountry: true, externalRatePct: true, externalClass: true, storeIdentity: true },
    orderBy: { externalTaxRateId: 'asc' },
  })
  const writes = await client.wooTaxRateWrite.findMany({
    select: { kind: true, status: true, wooTaxRateId: true, storeIdentity: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const owned = ownedWooIdsFromRecords(writes, storeIdentity)
  return {
    rates: rates.map((row) => ({
      id: row.id, name: row.name, rate: row.rate.toFixed(4), usedFor: row.usedFor, reverseCharge: row.reverseCharge, active: row.active, accountingTaxType: row.accountingTaxType,
      countryCode: row.countryCode, reportingCategory: row.reportingCategory, isCompound: row.isCompound, taxCategory: row.taxCategory,
    })),
    componentRates: components.map((row) => ({ taxRateId: row.taxRateId, rate: row.rate.toFixed(4), compoundOnPrevious: row.compoundOnPrevious, active: row.active, sortOrder: row.sortOrder })),
    mappings: mappings.map((row) => ({ ...row, externalRatePct: row.externalRatePct.toFixed(4) })),
    recordedOwnedWooIds: owned,
  }
}

type PlanRead = { ok: true; plan: WooTaxPlan; storeIdentity: string } | { ok: false; code: 'IMS_UNREADABLE' | 'WOO_UNREADABLE' | 'STORE_UNIDENTIFIED' }

/** IMS in one repeatable-read read-only transaction, then the store (a paced walk must not hold a transaction open), then the pure plan. Writes nothing. */
async function readState(deps: WooTaxWriterDeps): Promise<{ ok: true; ims: ImsState; woo: WooTaxRateDetail[]; storeIdentity: string } | { ok: false; code: 'IMS_UNREADABLE' | 'WOO_UNREADABLE' | 'STORE_UNIDENTIFIED' }> {
  const storeIdentity = await deps.storeIdentity().catch(() => null)
  if (storeIdentity === null) return { ok: false, code: 'STORE_UNIDENTIFIED' }
  let ims: ImsState
  try {
    ims = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      return readImsState(tx, storeIdentity)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 20_000 })
  } catch {
    return { ok: false, code: 'IMS_UNREADABLE' }
  }
  const woo = await deps.readWoo()
  if (!woo.ok) return { ok: false, code: 'WOO_UNREADABLE' }
  return { ok: true, ims, woo: woo.rates, storeIdentity }
}

async function readPlan(deps: WooTaxWriterDeps): Promise<PlanRead> {
  const state = await readState(deps)
  if (!state.ok) return state
  const { ims, woo, storeIdentity } = state
  return { ok: true, storeIdentity, plan: planWooTaxRates({ woo, rates: ims.rates, mappings: ims.mappings, componentRates: ims.componentRates, recordedOwnedWooIds: ims.recordedOwnedWooIds, storeIdentity }) }
}

export type WooTaxPreview = { hold: WooTaxHold } & ({ refused: null; plan: WooTaxPlan } | { refused: 'IMS_UNREADABLE' | 'WOO_UNREADABLE' | 'STORE_UNIDENTIFIED'; plan: null })

/** The dry run. Reads IMS and the store; writes nothing and sends nothing. */
export async function readWooTaxPlan(deps: WooTaxWriterDeps): Promise<WooTaxPreview> {
  const hold = wooTaxHold(deps.context)
  const read = await readPlan(deps)
  return read.ok ? { hold, refused: null, plan: read.plan } : { hold, refused: read.code, plan: null }
}

function changedFields(fields: readonly FieldChange[]): Partial<WooTaxRateFields> {
  const out: Record<string, string | boolean> = {}
  for (const change of fields) out[change.field] = change.after
  return out as Partial<WooTaxRateFields>
}

function summaryOf(change: WooTaxChange): Record<string, string | number | boolean | null> {
  return { kind: change.kind, imsRate: change.imsRateName.slice(0, 120), wooId: 'wooId' in change ? change.wooId : null }
}

/** The mapping row fields the store rate will carry. The class is stored as the store states it. */
function mappingFields(after: WooTaxRateFields): { externalName: string; externalCountry: string | null; externalRatePct: string; externalClass: string } {
  return { externalName: after.name, externalCountry: after.country === '' ? null : after.country, externalRatePct: after.rate, externalClass: after.class }
}

/** Sends one change. The fakes and the real port answer in the same closed shape. */
async function send(port: WooTaxRateWritePort, change: WooTaxChange): Promise<WooTaxPortResult> {
  switch (change.kind) {
    case 'CREATE': return port.create(change.after)
    case 'UPDATE': return port.update(change.wooId, changedFields(change.fields))
    case 'DELETE': return port.remove(change.wooId)
  }
}

/**
 * The check made under the lock IMMEDIATELY before a send: the store configured now is still the pinned one; the IMS rows the change rests on are read again (they cannot change under the lock);
 * for an UPDATE or DELETE the one store rate is read again. Returns why the change must NOT be sent, or null.
 */
async function recheckBeforeSend(deps: WooTaxWriterDeps, change: WooTaxChange, storeIdentity: string): Promise<string | null> {
  const configured = await deps.configuredStoreIdentity!().catch(() => null)
  if (configured !== storeIdentity) return 'STORE_CHANGED: the store configured now is not the store this run was bound to'
  let ims: ImsState
  try {
    ims = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      return readImsState(tx, storeIdentity)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 20_000 })
  } catch {
    return 'IMS_UNREADABLE: the IMS rows could not be read again'
  }
  let live: WooTaxRateDetail | undefined
  if (change.kind !== 'CREATE') {
    const read = await deps.readWooRate!(change.wooId).catch(() => ({ ok: false as const }))
    if (!read.ok) return 'WOO_UNREADABLE: the store rate could not be read again'
    live = read.rate
  }
  const failure = revalidateWooTaxChange({ change, storeIdentity, rate: ims.rates.find((r) => r.id === change.imsRateId), componentRates: ims.componentRates, mappings: ims.mappings, live })
  if (failure !== null) return `${failure}: ${REVALIDATION_FAILURES[failure]}`
  // A duplicate DELETE is only safe while another counterpart of the IMS rate is still in the store: a mapping that is still stamped says nothing about a store rate removed since the plan. So the other
  // counterparts are read again (GET only), and one of them must exist and still be the rate its mapping snapshot describes; otherwise the delete would remove the last live counterpart.
  if (change.kind === 'DELETE' && change.reason === 'DUPLICATE_COUNTERPART') {
    const keepers = ims.mappings.filter((m) => m.taxRateId === change.imsRateId && m.externalTaxRateId !== change.wooId && m.storeIdentity === storeIdentity)
    for (const mapping of keepers) {
      const read = await deps.readWooRate!(mapping.externalTaxRateId).catch(() => ({ ok: false as const }))
      if (read.ok && sameRateIdentity(identityOfMapping(mapping), identityOfWoo(read.rate))) return null
    }
    return 'KEEPER_GONE: no other counterpart of the IMS rate is still in the store as its mapping describes it, so this delete would remove the last one'
  }
  return null
}

async function recordApplied(digest: string, change: WooTaxChange, newId: string | null, storeIdentity: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const wooId = change.kind === 'CREATE' ? newId : change.wooId
    await tx.wooTaxRateWrite.create({
      data: {
        planDigest: digest, kind: change.kind, changeKey: change.key, wooTaxRateId: wooId, imsTaxRateId: change.imsRateId, status: 'APPLIED', storeIdentity,
        change: JSON.parse(JSON.stringify(change)) as Prisma.InputJsonValue,
      },
    })
    if (change.kind === 'CREATE') {
      await tx.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: newId!, taxRateId: change.imsRateId, storeIdentity, ...mappingFields(change.after) } })
      return
    }
    // The mapping row the change rests on must still be EXACTLY the planned one (this rate id, this IMS rate, this store) and must be hit exactly once: a row that went away or was re-pointed
    // between the plan and now leaves the store changed with nothing to show for it, so the record is rolled back and the run says so.
    const target = { connector: 'woocommerce', externalTaxRateId: change.wooId, taxRateId: change.imsRateId, storeIdentity }
    // A DELETE keeps its mapping row (historic orders still resolve their tax lines through it) but ENDS its stamp in this same write: the rate is gone, and if the store ever gives that id to
    // another rate (even one that looks identical) it is not ours until the operator adopts it.
    const hit = (await tx.shoppingTaxRateMapping.updateMany({ where: target, data: change.kind === 'UPDATE' ? mappingFields(change.after) : { storeIdentity: null } })).count
    if (hit !== 1) throw new UnrecordedSendError(`the mapping row of store rate ${change.wooId} is not the planned one any more (${hit} row(s) matched its id, IMS rate and store)`)
  })
}

async function recordFailed(digest: string, change: WooTaxChange, error: string, storeIdentity: string): Promise<void> {
  await db.wooTaxRateWrite.create({
    data: {
      planDigest: digest, kind: change.kind, changeKey: change.key, wooTaxRateId: 'wooId' in change ? change.wooId : null, imsTaxRateId: change.imsRateId, status: 'FAILED', storeIdentity,
      change: JSON.parse(JSON.stringify(change)) as Prisma.InputJsonValue, error: error.slice(0, 500),
    },
  })
}

export async function applyWooTaxPlan(deps: WooTaxWriterDeps, options: { confirm: string | undefined }): Promise<WooTaxApplyResult> {
  const refuse = (code: WooTaxRefusalCode, plan: WooTaxPlan | null = null): WooTaxApplyResult => ({ outcome: 'REFUSED', code, plan })
  // Before the database is touched: an apply with no digest never reads anything.
  if (options.confirm === undefined || !DIGEST_RE.test(options.confirm)) return refuse('CONFIRM_REQUIRED')
  if (deps.port === undefined || deps.readWooRate === undefined || deps.configuredStoreIdentity === undefined) return refuse('PORT_MISSING')
  if (wooTaxHold(deps.context).mode === 'not-enforced') return refuse('HOLD_NOT_ENFORCED')

  let lock
  try {
    lock = await acquirePinnedAdvisoryLockWaiting(WOO_TAX_RATE_WRITE_LOCK_KEY, { timeoutMs: APPLY_WAIT_MS })
  } catch (error) {
    if (error instanceof AdvisoryLockWaitTimeoutError) return refuse('BUSY')
    throw error
  }
  try {
    const read = await readPlan(deps)
    if (!read.ok) return refuse(read.code)
    // The credentials of this run were resolved once; the settings may have been changed since. A plan confirmed for one store is never sent to another.
    if ((await deps.configuredStoreIdentity().catch(() => null)) !== read.storeIdentity) return refuse('STORE_CHANGED')
    const plan = read.plan
    if (plan.changes.length === 0) return { outcome: 'NOTHING_TO_DO', plan }
    if (plan.digest !== options.confirm) return refuse('DIGEST_MISMATCH', plan)
    if (plan.blockers.length > 0) return refuse('BLOCKED', plan)

    const result: Extract<WooTaxApplyResult, { outcome: 'DONE' }> = { outcome: 'DONE', plan, applied: [], shadowed: [], shadowUnrecorded: 0, failed: null, unrecorded: null }
    for (const change of plan.changes) {
      lock.assertHeld(`sending ${change.key}`)
      // THE SEAM, before the first effect of the change. A shadow records what would have been sent and answers; nothing else happens for this change.
      const answer = await wooProducerSeam({
        operation: 'tax-rate', subjectType: 'WooTaxRate', subjectId: change.key, payload: change, summary: summaryOf(change), context: deps.context,
      })
      if (!answer.proceed) {
        result.shadowed.push(change.key)
        if (!answer.recorded) result.shadowUnrecorded += 1
        continue
      }
      // THE RE-CHECK, inside the lock that keeps every mapping writer out and immediately before the send (which cannot be undone): what the change rests on is read again and must be what the plan saw.
      const changed = await recheckBeforeSend(deps, change, read.storeIdentity)
      if (changed !== null) {
        result.stopped = { key: change.key, reason: changed }
        break
      }
      const sent = await send(deps.port, change)
      if (!sent.ok) {
        result.failed = { key: change.key, kind: change.kind, error: sent.error }
        await recordFailed(plan.digest, change, sent.error, read.storeIdentity).catch(() => undefined)
        break
      }
      const newId = change.kind === 'CREATE' ? (sent.id ?? null) : null
      if (change.kind === 'CREATE' && (newId === null || !/^[1-9][0-9]{0,17}$/.test(newId))) {
        result.unrecorded = { key: change.key, reason: 'the store answered a created rate without a usable id' }
        break
      }
      try {
        await recordApplied(plan.digest, change, newId, read.storeIdentity)
      } catch (error) {
        result.unrecorded = { key: change.key, reason: error instanceof UnrecordedSendError ? error.message : 'the change record could not be committed' }
        break
      }
      result.applied.push({ key: change.key, kind: change.kind, wooId: change.kind === 'CREATE' ? newId : change.wooId })
    }
    return result
  } catch (error) {
    if (error instanceof AdvisoryLockLostError) return refuse('LOCK_LOST')
    throw error
  } finally {
    await lock.release().catch(() => undefined)
  }
}


// ---------------------------------------------------------------------------
// The adoption step (stamps mapping rows with the store identity; sends nothing to WooCommerce)
// ---------------------------------------------------------------------------

export type WooAdoptionPreview = { refused: null; plan: AdoptionPlan } | { refused: 'IMS_UNREADABLE' | 'WOO_UNREADABLE' | 'STORE_UNIDENTIFIED'; plan: null }

async function readAdoptionPlan(deps: WooTaxWriterDeps): Promise<WooAdoptionPreview> {
  const state = await readState(deps)
  if (!state.ok) return { refused: state.code, plan: null }
  return { refused: null, plan: planAdoption({ woo: state.woo, rates: state.ims.rates, mappings: state.ims.mappings, storeIdentity: state.storeIdentity }) }
}

/** The dry run of the adoption: which mapping rows would be stamped, with the snapshot and the live rate side by side. Writes nothing. */
export const readWooAdoptionPlan = readAdoptionPlan

export type WooAdoptionResult =
  | { outcome: 'REFUSED'; code: WooTaxRefusalCode; plan: AdoptionPlan | null }
  | { outcome: 'NOTHING_TO_DO'; plan: AdoptionPlan }
  | { outcome: 'ADOPTED'; plan: AdoptionPlan; adopted: number }

/**
 * Stamps the rows of an adoption plan the operator confirmed by its digest: store identity and a snapshot rewritten from the live rate, one ADOPT record each, all in ONE transaction under the
 * same single-runner lock (a row that is not hit exactly once rolls everything back). It is IMS bookkeeping: nothing is sent to WooCommerce, so the producer hold does not govern it.
 */
export async function applyWooAdoption(deps: WooTaxWriterDeps, options: { confirm: string | undefined }): Promise<WooAdoptionResult> {
  const refuse = (code: WooTaxRefusalCode, plan: AdoptionPlan | null = null): WooAdoptionResult => ({ outcome: 'REFUSED', code, plan })
  if (options.confirm === undefined || !DIGEST_RE.test(options.confirm)) return refuse('CONFIRM_REQUIRED')
  let lock
  try {
    lock = await acquirePinnedAdvisoryLockWaiting(WOO_TAX_RATE_WRITE_LOCK_KEY, { timeoutMs: APPLY_WAIT_MS })
  } catch (error) {
    if (error instanceof AdvisoryLockWaitTimeoutError) return refuse('BUSY')
    throw error
  }
  try {
    const read = await readAdoptionPlan(deps)
    if (read.plan === null) return refuse(read.refused)
    // A stamp is bound to the store of the run's pinned credentials; if the configured store moved on, nothing is stamped.
    if (deps.configuredStoreIdentity !== undefined && (await deps.configuredStoreIdentity().catch(() => null)) !== read.plan.storeIdentity) return refuse('STORE_CHANGED')
    const plan = read.plan
    if (plan.rows.length === 0) return { outcome: 'NOTHING_TO_DO', plan }
    if (plan.digest !== options.confirm) return refuse('DIGEST_MISMATCH', plan)
    try {
      await db.$transaction(async (tx) => {
        for (const row of plan.rows) {
          const hit = await tx.shoppingTaxRateMapping.updateMany({
            where: { connector: 'woocommerce', externalTaxRateId: row.wooId, taxRateId: row.imsRateId },
            data: { storeIdentity: plan.storeIdentity, externalName: row.live.name, externalCountry: row.live.country === '' ? null : row.live.country, externalRatePct: row.live.rate, externalClass: row.live.class },
          })
          if (hit.count !== 1) throw new UnrecordedSendError(row.wooId)
          await tx.wooTaxRateWrite.create({
            data: {
              planDigest: plan.digest, kind: 'ADOPT', changeKey: `adopt:${row.wooId}`, wooTaxRateId: row.wooId, imsTaxRateId: row.imsRateId, status: 'APPLIED', storeIdentity: plan.storeIdentity,
              change: JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue,
            },
          })
        }
      }, { timeout: 60_000, maxWait: 20_000 })
    } catch (error) {
      if (error instanceof UnrecordedSendError) return refuse('ADOPTION_FAILED', plan)
      throw error
    }
    return { outcome: 'ADOPTED', plan, adopted: plan.rows.length }
  } catch (error) {
    if (error instanceof AdvisoryLockLostError) return refuse('LOCK_LOST')
    throw error
  } finally {
    await lock.release().catch(() => undefined)
  }
}
