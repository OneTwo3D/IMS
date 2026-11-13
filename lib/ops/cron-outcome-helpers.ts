/**
 * The vocabulary the per-route exit-status mappings are written in (see lib/ops/cron-outcomes.ts). Pure.
 */

import { classifyCronResult, type CronOutcomeClass } from './cron-run'

export type Rec = Record<string, unknown>

export const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
export const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const RANK: Record<CronOutcomeClass, number> = { skipped: 0, ok: 1, held: 2, failed: 3 }

/** The worst of the classes: failed, then held, then ok, then skipped. */
export function worstOutcome(...classes: CronOutcomeClass[]): CronOutcomeClass {
  return classes.reduce<CronOutcomeClass>((worst, next) => (RANK[next] > RANK[worst] ? next : worst), 'skipped')
}

/** Error text, error lists, `success: false` and a lowercase failed status, at any depth; held-aware. Skipped is not decided here. */
export function structural(result: unknown): CronOutcomeClass {
  if (!isRec(result)) return 'ok'
  const { outcomeClass } = classifyCronResult({ ...result, skipped: undefined })
  return outcomeClass === 'skipped' ? 'ok' : outcomeClass
}

/** A status of FAILED or PARTIAL is a failure; SKIPPED is skipped. A failing status whose errors are all held writes is held. */
export function enumStatus(result: unknown): CronOutcomeClass | null {
  if (!isRec(result)) return null
  const status = result.status
  if (status === 'SKIPPED') return 'skipped'
  if (status !== 'FAILED' && status !== 'PARTIAL') return null
  const errors = num(result.errors)
  return errors > 0 && errors <= num(result.outboundHeld) ? 'held' : 'failed'
}

/** Counts of failures: `failed`, `errors` or others as numbers, with the held ones subtracted from `heldCounter` only, in the record and every record nested in it. */
export function counts(result: unknown, keys: readonly string[], heldCounter = 'failed'): CronOutcomeClass {
  if (Array.isArray(result)) return worstOutcome('ok', ...result.map((entry) => counts(entry, keys, heldCounter)))
  if (!isRec(result) || result.skipped === true) return 'ok'
  const held = num(result.outboundHeld)
  const classes: CronOutcomeClass[] = ['ok']
  for (const key of keys) {
    // A list of error texts next to the count is the better evidence (held-aware): structural() reads it.
    if (Array.isArray(result[key])) continue
    const count = num(result[key])
    // `outboundHeld` is part of ONE counter (named by heldCounter) and is subtracted from that counter only: any other counter above
    // zero (a dead-lettered push, say) is a genuine failure whatever was held.
    if (count > 0) classes.push(key === heldCounter && count <= held ? 'held' : 'failed')
  }
  for (const value of Object.values(result)) {
    if (isRec(value) || Array.isArray(value)) classes.push(counts(value, keys, heldCounter))
  }
  return worstOutcome(...classes)
}

/** Lists of failures a run reports apart from `errors`, because re-running gives the same answer until an operator acts: any non-empty one, at any depth, is a failure. */
export function permanentLists(result: unknown, keys: readonly string[]): CronOutcomeClass {
  if (Array.isArray(result)) return worstOutcome('ok', ...result.map((entry) => permanentLists(entry, keys)))
  if (!isRec(result) || result.skipped === true) return 'ok'
  const classes: CronOutcomeClass[] = ['ok']
  for (const [key, value] of Object.entries(result)) {
    if (keys.includes(key) && Array.isArray(value) && value.length > 0) classes.push('failed')
    else if (isRec(value) || Array.isArray(value)) classes.push(permanentLists(value, keys))
  }
  return worstOutcome(...classes)
}

/** A top-level skip: `skipped: true`, or a skip reason in `skipped` (a string) or `skippedReason`. */
export function skippedByDesign(result: unknown): boolean {
  if (!isRec(result)) return false
  return result.skipped === true || (typeof result.skipped === 'string' && result.skipped !== '')
}

/** A route whose result carries no failure signal (it reports what it did; a failure is a throw): ok, or skipped when it says so. */
export const noFailureSignal = (result: object): CronOutcomeClass => (skippedByDesign(result) ? 'skipped' : 'ok')

export function from(result: unknown, ...parts: Array<CronOutcomeClass | null>): CronOutcomeClass {
  if (skippedByDesign(result)) return 'skipped'
  return worstOutcome('ok', ...parts.filter((part): part is CronOutcomeClass => part !== null))
}

/** A status-enum result: SKIPPED is skipped; otherwise the enum, the counts and the error texts decide. */
export function enumResult(result: unknown, keys: readonly string[]): CronOutcomeClass {
  const status = enumStatus(result)
  if (status === 'skipped') return 'skipped'
  return from(result, status, counts(result, keys, 'errors'), structural(result))
}

