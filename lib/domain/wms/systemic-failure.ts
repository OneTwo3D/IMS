/**
 * The systemic-failure circuit breaker for the WMS sweeps that PARK records after exhausted retries.
 *
 * Parking is isolation, and isolation only makes sense when the thing isolated is the exception. A
 * warehouse schema change, a broken endpoint or an expired credential fails every record at once;
 * parking them one at a time quarantines the whole tenant and demands a manual replay after the
 * dependency has recovered, which turns a transient outage into an operations incident.
 *
 * So a pass where enough of what it touched failed at once is read as a CONNECTOR fault instead of N
 * record faults: one loud incident, nothing parked, every record stays eligible for automatic
 * recovery. The rule is the one the woo-mintsoft sync plugin runs (MINTSOFT_SYSTEMIC_*), ported
 * parameter for parameter so the two halves of the parity epic classify the same event the same way.
 *
 * This module is PURE (no database, no clock, no network) so the decision is unit-testable. The
 * persistence and the incident live in systemic-failure-store.ts; the sweeps call `runSystemicPass`
 * with a store.
 */

/** BOTH this floor and the ratio must hold: the ratio alone misfires on a quiet tick, the floor alone on a big store. */
export const SYSTEMIC_FAILURE_MIN_RECORDS = 3
export const SYSTEMIC_FAILURE_RATIO = 0.5
/**
 * Suppression is BOUNDED. Three permanently-broken records in a three-record cohort would otherwise read as systemic on every
 * pass for ever, never be isolated, and pile up in the capped active query: the bounded-retry guarantee defeated by the
 * mechanism meant to protect it. After this many consecutive systemic verdicts the sweep parks them anyway, because a fault
 * that never clears is indistinguishable from records that are simply broken.
 */
export const SYSTEMIC_MAX_CONSECUTIVE = 5
/**
 * Consecutive passes an endpoint may fail EVERY one of its callers before an outage is reported whatever the cohort size. A
 * one-record tenant can never meet the floor, so without this a total outage there would be silent for ever.
 */
export const SYSTEMIC_ENDPOINT_FAILURE_PASSES = 3

export type SystemicParams = {
  minRecords: number
  ratio: number
  maxConsecutive: number
  endpointFailurePasses: number
}

export const DEFAULT_SYSTEMIC_PARAMS: SystemicParams = {
  minRecords: SYSTEMIC_FAILURE_MIN_RECORDS,
  ratio: SYSTEMIC_FAILURE_RATIO,
  maxConsecutive: SYSTEMIC_MAX_CONSECUTIVE,
  endpointFailurePasses: SYSTEMIC_ENDPOINT_FAILURE_PASSES,
}

/**
 * What one pass observed, counted over the WHOLE pass.
 *
 * `failed` is every record that failed this pass, NOT only those that ran out of retries. Retry clocks start whenever each
 * record first failed, so during an outage three old records may exhaust while ninety-seven equally broken newer ones have not;
 * scoring only the exhausted subset would read 3/100, call it record-local, and park the three in the middle of the outage.
 */
export type SystemicPassOutcomes = {
  /** Records this pass actually tried (a record the outbound-write hold refused, or one it never reached, is not an attempt). */
  attempted: number
  /** Of those, how many failed. */
  failed: number
  /** Of those, how many have run out of retries and WOULD be parked. Nothing is at stake unless this is above zero. */
  exhausted: number
}

/** What persists between passes. */
export type SystemicState = {
  /** Consecutive passes whose parking was suppressed (the bound counts these). */
  consecutive: number
  /** Consecutive passes in which every attempt failed (the endpoint-outage rule). */
  outagePasses: number
  /** When the open incident was raised (ISO), or null when none is open. */
  incidentOpenedAt: string | null
  /** True once the incident was escalated because the suppression bound ran out. */
  isolating: boolean
  /** The last pass's evidence, for the operator. */
  lastSeenAt: string | null
  attempted: number
  failed: number
  exhausted: number
  reason: string | null
}

export const EMPTY_SYSTEMIC_STATE: SystemicState = {
  consecutive: 0,
  outagePasses: 0,
  incidentOpenedAt: null,
  isolating: false,
  lastSeenAt: null,
  attempted: 0,
  failed: 0,
  exhausted: 0,
  reason: null,
}

export type SystemicDecision = {
  /**
   * 'systemic': park NOTHING this pass.
   * 'per-record': isolate the exhausted records as before (this includes a pass with nothing exhausted).
   */
  verdict: 'systemic' | 'per-record'
  /** The pass failed on enough records at once (floor AND ratio), whether or not anything exhausted. */
  massFailure: boolean
  /** Mass failure with records to park, but the suppression budget is spent: isolating anyway. */
  boundExceeded: boolean
  /** Every attempt this pass failed, for ENDPOINT_FAILURE_PASSES passes running: an outage at any cohort size. */
  outage: boolean
  /** What to do with the incident. */
  incident: 'open' | 'escalate' | 'resolve' | 'keep'
  /** The counters to persist. */
  next: Pick<SystemicState, 'consecutive' | 'outagePasses'>
}

/**
 * Is this pass's failure connector-wide? Floor AND ratio, over the pass's own attempts.
 *
 * 0 attempts is never mass failure (there is nothing to be a ratio of).
 */
export function isMassFailure(outcomes: SystemicPassOutcomes, params: SystemicParams = DEFAULT_SYSTEMIC_PARAMS): boolean {
  if (outcomes.attempted <= 0) return false
  if (outcomes.failed < params.minRecords) return false
  return outcomes.failed / outcomes.attempted >= params.ratio
}

/**
 * Decide one pass: connector fault (park nothing) or record faults (isolate).
 *
 * `prior` is the persisted state going in. The decision never reads a clock.
 *
 * Counter rules:
 *   - a SUPPRESSED pass (mass failure with something to park, inside the bound) increments `consecutive`;
 *   - a mass-failure pass past the bound isolates and leaves `consecutive` SATURATED, so the next pass of the same fault
 *     isolates too rather than starting another five suppressed passes;
 *   - a mass-failure pass with nothing exhausted yet changes nothing: parking was not at stake, and resetting there would let
 *     an outage that spends several passes below the retry bound defeat its own counter;
 *   - a clean pass or a per-record pass (attempts, not mass failure) resets it and resolves the incident;
 *   - a quiet pass (nothing attempted) is no evidence either way and changes nothing.
 */
export function decideSystemicFailure(
  outcomes: SystemicPassOutcomes,
  prior: Pick<SystemicState, 'consecutive' | 'outagePasses'>,
  params: SystemicParams = DEFAULT_SYSTEMIC_PARAMS,
): SystemicDecision {
  const mass = isMassFailure(outcomes, params)
  const hasAttempts = outcomes.attempted > 0

  // The endpoint rule is its own streak: every caller failed, pass after pass.
  const allFailed = hasAttempts && outcomes.failed >= outcomes.attempted
  const outagePasses = !hasAttempts ? prior.outagePasses : allFailed ? prior.outagePasses + 1 : 0
  const outage = outagePasses >= params.endpointFailurePasses

  const atStake = outcomes.exhausted > 0
  const withinBound = prior.consecutive < params.maxConsecutive
  const systemic = mass && atStake && withinBound
  const boundExceeded = mass && atStake && !withinBound

  let consecutive = prior.consecutive
  if (systemic) consecutive = prior.consecutive + 1
  else if (boundExceeded) consecutive = prior.consecutive
  else if (hasAttempts && !mass) consecutive = 0

  let incident: SystemicDecision['incident'] = 'keep'
  if (boundExceeded) incident = 'escalate'
  else if (systemic || outage) incident = 'open'
  else if (hasAttempts && !mass) incident = 'resolve'

  return {
    verdict: systemic ? 'systemic' : 'per-record',
    massFailure: mass,
    boundExceeded,
    outage,
    incident,
    next: { consecutive, outagePasses },
  }
}

/** The sentence an operator reads. Names the evidence, what was NOT done, and when the budget runs out. */
export function describeSystemicIncident(input: {
  sweep: string
  connector: string
  decision: Pick<SystemicDecision, 'verdict' | 'boundExceeded' | 'outage'>
  outcomes: SystemicPassOutcomes
  consecutive: number
  outagePasses: number
  reason: string | null
  params?: SystemicParams
}): string {
  const params = input.params ?? DEFAULT_SYSTEMIC_PARAMS
  const { outcomes } = input
  const evidence = `${outcomes.failed} of ${outcomes.attempted} records failed in one ${input.sweep} pass on ${input.connector}`
  const sample = input.reason ? ` Last error: ${input.reason}` : ''
  if (input.decision.boundExceeded) {
    return `${evidence}, for ${input.consecutive} passes running. The suppression limit (${params.maxConsecutive}) is spent, so the `
      + `records that ran out of retries are being isolated one by one again: a fault that never clears is indistinguishable from `
      + `broken records. They appear in the exception inbox for replay.${sample}`
  }
  if (input.decision.verdict === 'systemic') {
    return `${evidence}${input.consecutive > 1 ? `, ${input.consecutive} passes running` : ''}. This looks like a connector-wide fault `
      + `rather than broken orders, so NOTHING was parked: every record stays eligible and recovers automatically once the fault is `
      + `fixed. After ${params.maxConsecutive} consecutive passes the sweep isolates per record anyway.${sample}`
  }
  return `Every attempt failed in ${input.outagePasses} ${input.sweep} passes running on ${input.connector} (${outcomes.failed} of `
    + `${outcomes.attempted} in the latest). That is an outage however few records there are.${sample}`
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Unreadable state is NO state: start from zero rather than infer a streak that was never observed. */
export function parseSystemicState(raw: string | null | undefined): SystemicState {
  if (!raw) return { ...EMPTY_SYSTEMIC_STATE }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SYSTEMIC_STATE }
    return {
      consecutive: intOr(parsed.consecutive, 0),
      outagePasses: intOr(parsed.outagePasses, 0),
      incidentOpenedAt: strOrNull(parsed.incidentOpenedAt),
      isolating: parsed.isolating === true,
      lastSeenAt: strOrNull(parsed.lastSeenAt),
      attempted: intOr(parsed.attempted, 0),
      failed: intOr(parsed.failed, 0),
      exhausted: intOr(parsed.exhausted, 0),
      reason: strOrNull(parsed.reason),
    }
  } catch {
    return { ...EMPTY_SYSTEMIC_STATE }
  }
}

/** What a sweep tells the store when it opens or escalates an incident. */
export type SystemicIncident = {
  sweep: string
  connector: string
  /** 'open' the first time, 'escalate' when suppression ran out and the sweep went back to isolating. */
  kind: 'open' | 'escalate'
  message: string
  consecutive: number
  outcomes: SystemicPassOutcomes
  reason: string | null
}

/** The persistence and the operator-facing side effects. The production store is in systemic-failure-store.ts. */
export interface SystemicFailureStore {
  load(sweep: string): Promise<SystemicState>
  /** Resolves true only when the state REACHED the database. */
  save(sweep: string, state: SystemicState): Promise<boolean>
  raise(incident: SystemicIncident): Promise<void>
  resolve(info: { sweep: string; connector: string; consecutive: number }): Promise<void>
}

export type SystemicPassResult = {
  decision: SystemicDecision
  /** True when the verdict is 'systemic': the caller must park NOTHING. */
  suppress: boolean
  /** The state could not be read or written, so the sweep isolated rather than suppress without a count. */
  degraded: boolean
}

/**
 * Run the breaker for one pass: load, decide, persist, and only then raise or resolve the incident.
 *
 * FAIL TOWARD THE OLD BEHAVIOUR. Suppression is only safe while it is counted: an unreadable or unwritable counter would let a
 * persistent fault suppress for ever, which is the unbounded hole the bound exists to close. So when the state cannot be read,
 * or the suppressing verdict cannot be saved, the pass falls back to per-record isolation and says so. The breaker must never
 * be able to make the sweep worse than having no breaker.
 *
 * Never throws: a failure here must not fail the sweep it protects.
 */
export async function runSystemicPass(
  store: SystemicFailureStore,
  input: {
    sweep: string
    connector: string
    outcomes: SystemicPassOutcomes
    now: Date
    /** A sample of what the connector actually said, for the incident. */
    reason?: string | null
    params?: SystemicParams
    /** Called with a description when the breaker had to stand down. */
    onDegraded?: (message: string) => void
  },
): Promise<SystemicPassResult> {
  const params = input.params ?? DEFAULT_SYSTEMIC_PARAMS
  let prior: SystemicState
  let degraded = false
  try {
    prior = await store.load(input.sweep)
  } catch (error) {
    degraded = true
    input.onDegraded?.(`could not read the systemic-failure state (${error instanceof Error ? error.message : String(error)}); isolating per record`)
    return { decision: decideSystemicFailure(input.outcomes, { consecutive: params.maxConsecutive, outagePasses: 0 }, params), suppress: false, degraded }
  }

  const decision = decideSystemicFailure(input.outcomes, prior, params)
  const reason = input.reason ?? null
  const nowIso = input.now.toISOString()

  const opening = (decision.incident === 'open' && prior.incidentOpenedAt === null)
  const escalating = decision.incident === 'escalate' && !prior.isolating
  const resolving = decision.incident === 'resolve' && prior.incidentOpenedAt !== null

  const next: SystemicState = {
    consecutive: decision.next.consecutive,
    outagePasses: decision.next.outagePasses,
    incidentOpenedAt: resolving ? null : opening || (decision.incident === 'escalate' && prior.incidentOpenedAt === null) ? nowIso : prior.incidentOpenedAt,
    isolating: resolving ? false : decision.incident === 'escalate' ? true : decision.incident === 'open' ? false : prior.isolating,
    lastSeenAt: decision.incident === 'keep' && prior.incidentOpenedAt === null ? prior.lastSeenAt : nowIso,
    attempted: input.outcomes.attempted,
    failed: input.outcomes.failed,
    exhausted: input.outcomes.exhausted,
    reason: resolving ? null : reason ?? prior.reason,
  }

  const changed = JSON.stringify(next) !== JSON.stringify(prior)
  let saved = !changed
  if (changed) {
    try {
      saved = await store.save(input.sweep, next)
    } catch {
      saved = false
    }
  }
  if (!saved) {
    degraded = true
    input.onDegraded?.('could not persist the systemic-failure state')
    // An uncounted suppression is an unbounded one. Isolate this pass instead.
    if (decision.verdict === 'systemic') {
      return { decision: { ...decision, verdict: 'per-record' }, suppress: false, degraded }
    }
    return { decision, suppress: false, degraded }
  }

  try {
    if (opening || (decision.incident === 'escalate' && (escalating || prior.incidentOpenedAt === null))) {
      await store.raise({
        sweep: input.sweep,
        connector: input.connector,
        kind: decision.incident === 'escalate' ? 'escalate' : 'open',
        message: describeSystemicIncident({
          sweep: input.sweep,
          connector: input.connector,
          decision,
          outcomes: input.outcomes,
          consecutive: next.consecutive,
          outagePasses: next.outagePasses,
          reason,
          params,
        }),
        consecutive: next.consecutive,
        outcomes: input.outcomes,
        reason,
      })
    } else if (resolving) {
      await store.resolve({ sweep: input.sweep, connector: input.connector, consecutive: prior.consecutive })
    }
  } catch (error) {
    // The decision stands (it is already durable); the announcement is retried by clearing the marker it keys on.
    degraded = true
    input.onDegraded?.(`the incident announcement failed (${error instanceof Error ? error.message : String(error)}); it is retried next pass`)
    try {
      await store.save(input.sweep, { ...next, incidentOpenedAt: resolving ? prior.incidentOpenedAt : null, isolating: resolving ? prior.isolating : false })
    } catch {
      degraded = true
    }
  }

  return { decision, suppress: decision.verdict === 'systemic', degraded }
}
