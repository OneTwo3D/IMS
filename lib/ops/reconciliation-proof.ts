import {
  VOID_MIRROR_CONTRADICTIONS_TRUNCATED,
  readReconciliationCompleteness,
} from '@/lib/domain/accounting/reconciliation'

/**
 * o3d-6e4v — IS THE ACCOUNTING RECONCILIATION PROVEN COMPLETE? A QUESTION ABOUT THE HISTORY, NOT THE
 * NEWEST RUN.
 *
 * The rollout-readiness gate read the newest run's STATUS and finding COUNTS, so a run whose report was
 * truncated — its own positive statement that findings were omitted — read as clean whenever the page it
 * kept held no warning or critical row. o3d-11rf's rounds 5–9 then tried predicates over the newest run and
 * each was defeated by an earlier run: r8's "the newest run spans the default lookback" is satisfied by a
 * 90-day run ending today that does not cover a 90-day run which truncated three months ago. The finding
 * that made this an issue (o3d-6e4v §4): clearing a truncation needs a LATER run, recorded complete for the
 * truncated check, WHOSE INTERVAL CONTAINS THE TRUNCATED ONE. That quantifies over earlier runs, so the
 * evidence is the run history and this module evaluates it.
 *
 * THE PRIOR-TRUNCATION STATE IS THE RUN TABLE ITSELF. Every run already persists its interval
 * (`fromDate`, `toDate`) and its truncation record (`truncations`, written only by
 * persistAccountingReconciliationReport). A truncation is UNRESOLVED until later recorded runs cover it;
 * deriving that from the rows every run already writes means there is no second copy of the state to drift
 * from the first, and nothing to backfill.
 *
 * COVERAGE, PER CHECK:
 *   · A truncated check is covered by LATER runs whose completeness is RECORDED (not NULL, not
 *     unreadable) and which did NOT truncate that same check.
 *   · WINDOWED checks (every sentinel but the void-mirror one, and any code this build does not know):
 *     the union of those later runs' [fromDate, toDate] must contain the truncated run's interval.
 *     Composable — two later clean runs that together span it cover it (o3d-6e4v "proposed shape").
 *   · WHOLE-TABLE checks (VOID_MIRROR_CONTRADICTIONS_TRUNCATED, which is asked of every row with no
 *     window): any later such run covers it, because it re-asked the whole question.
 *   · An UNREADABLE run says nothing about which check it lost, so it is covered only by later runs that
 *     recorded NO truncation at all, whose intervals contain it.
 *   · A run with no interval cannot be contained and so cannot be covered; a later run with no interval
 *     covers only whole-table checks.
 *
 * THE FOUR STATES (o3d-6e4v §1), and what each costs the gate:
 *   truncated, unreadable   BLOCK until covered — a blocker, because `?allowWarnings=true` converts every
 *                           warning to HTTP 200 with no reason and no audit (o3d-yby2, folded into
 *                           o3d-6e4v), so a warning here would be no protection at all.
 *   not-recorded (NULL)     on the NEWEST run: WARN — every row that predates the column is NULL, and so is
 *                           a row a predecessor binary writes across the deploy that ships it, so blocking
 *                           would be unsatisfiable on a correct deploy. ESCALATED to a blocker when a
 *                           recorded run already exists BEFORE it: then recording had begun, and a NULL
 *                           row is evidence of a writer that is not recording completeness (the condition
 *                           o3d-10rk asked to be stated). Older NULL rows are not carried: they make no
 *                           statement, and carrying them would block every system that has history.
 *   complete                the only positive statement.
 */

export type ReconciliationHistoryRun = {
  id: string
  createdAt: string
  fromDate: string | null
  toDate: string | null
  /** The raw `truncations` column. Interpreted ONLY through readReconciliationCompleteness. */
  truncations: unknown
}

export type ReconciliationHistory = {
  /**
   * Every run with a RECORDED-or-unreadable (non-NULL) truncations column created at or after the oldest
   * run that is truncated or unreadable, oldest first. Empty when no such run exists.
   */
  runs: ReconciliationHistoryRun[]
  /** True when more runs exist than the reader will evaluate — the history cannot then be proven. */
  overflow: boolean
  /** True when a run with a non-NULL truncations column exists OLDER than the newest run. */
  recordedBeforeNewest: boolean
}

/** Checks asked of every row with no window, so any later recorded run re-asks the whole question. */
const WHOLE_TABLE_TRUNCATION_CODES: ReadonlySet<string> = new Set([VOID_MIRROR_CONTRADICTIONS_TRUNCATED])
/** Stands for "every check" on a run whose record is unreadable. */
const EVERY_CHECK = '*'

export type UnresolvedTruncation = {
  runId: string
  createdAt: string
  fromDate: string | null
  toDate: string | null
  /** The truncated check's code, or `*` for a run whose record could not be read. */
  code: string
}

export type ReconciliationProof =
  | { state: 'proven' }
  | {
    state: 'not-proven'
    /** Truncations (or unreadable records) no later recorded run covers. Blockers. */
    unresolved: UnresolvedTruncation[]
    /** The history could not be evaluated in full. A blocker. */
    overflow: boolean
    /** The NEWEST run's column: NULL (not-recorded) or a readable/unreadable state. */
    newest: 'complete' | 'truncated' | 'not-recorded' | 'unreadable'
    /** The newest run is NULL although recording had already begun before it. A blocker. */
    notRecordedAfterRecording: boolean
  }

type Interval = { from: number; to: number }

function interval(run: { fromDate: string | null; toDate: string | null }): Interval | null {
  if (!run.fromDate || !run.toDate) return null
  const from = Date.parse(run.fromDate)
  const to = Date.parse(run.toDate)
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null
}

/** Whether the union of `covers` contains `target` entirely. */
export function unionContains(target: Interval, covers: readonly Interval[]): boolean {
  const sorted = [...covers].sort((a, b) => a.from - b.from)
  let reached = target.from
  for (const cover of sorted) {
    if (cover.from > reached) break
    if (cover.to > reached) reached = cover.to
    if (reached >= target.to) return true
  }
  return reached >= target.to
}

function truncatedCodes(truncations: unknown): string[] | 'unreadable' | 'not-recorded' {
  const completeness = readReconciliationCompleteness(truncations)
  switch (completeness.state) {
    case 'complete':
      return []
    case 'truncated':
      return [...new Set(completeness.truncations.map((entry) => entry.code))]
    case 'unknown':
      return completeness.reason
    default: {
      const never: never = completeness
      return never
    }
  }
}

export function evaluateReconciliationProof(
  newest: { id: string; truncations?: unknown },
  history: ReconciliationHistory,
): ReconciliationProof {
  const runs = [...history.runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
  const read = runs.map((run) => ({ run, codes: truncatedCodes(run.truncations) }))
  const unresolved: UnresolvedTruncation[] = []

  read.forEach(({ run, codes }, index) => {
    if (codes === 'not-recorded') return
    const lost = codes === 'unreadable' ? [EVERY_CHECK] : codes
    if (lost.length === 0) return
    const later = read.slice(index + 1)
    for (const code of lost) {
      const coveringRuns = later.filter(({ codes: laterCodes }) => {
        if (laterCodes === 'not-recorded' || laterCodes === 'unreadable') return false
        return code === EVERY_CHECK ? laterCodes.length === 0 : !laterCodes.includes(code)
      }).map(({ run: laterRun }) => laterRun)
      const covered = WHOLE_TABLE_TRUNCATION_CODES.has(code)
        ? coveringRuns.length > 0
        : (() => {
          const target = interval(run)
          if (!target) return false
          return unionContains(target, coveringRuns.map(interval).filter((i): i is Interval => i !== null))
        })()
      if (!covered) {
        unresolved.push({ runId: run.id, createdAt: run.createdAt, fromDate: run.fromDate, toDate: run.toDate, code })
      }
    }
  })

  const newestCodes = truncatedCodes(newest.truncations)
  const newestState = newestCodes === 'not-recorded' || newestCodes === 'unreadable'
    ? newestCodes
    : newestCodes.length === 0 ? 'complete' as const : 'truncated' as const
  // The newest run is truncated or unreadable but not in the history the reader returned: evaluate it as
  // its own uncovered entry rather than trust a history that missed it (fail closed).
  if ((newestState === 'truncated' || newestState === 'unreadable') && !runs.some((run) => run.id === newest.id)) {
    unresolved.push({ runId: newest.id, createdAt: '', fromDate: null, toDate: null, code: newestState === 'unreadable' ? EVERY_CHECK : '(newest run, not in history)' })
  }
  const notRecordedAfterRecording = newestState === 'not-recorded' && history.recordedBeforeNewest

  if (unresolved.length === 0 && !history.overflow && newestState === 'complete') return { state: 'proven' }
  return { state: 'not-proven', unresolved, overflow: history.overflow, newest: newestState, notRecordedAfterRecording }
}
