import { randomUUID } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { isOutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'

export type CronRunStatus = 'completed' | 'failed' | 'skipped'

/**
 * HOW A CRON RUN ENDS, as far as the scheduler's exit status is concerned (the wrapper's `curl -f` turns a non-2xx into a failing
 * run, which is what Healthchecks sees).
 *
 *  - ok      the run did its work.
 *  - skipped nothing to do by design: a plugin or sync switched off, maintenance, nothing configured.
 *  - held    the only things that went wrong are writes this installation's outbound-write hold refused before they left (a
 *            staging installation has no grant, by design). Not a fault: the work stays queued and runs once a grant exists.
 *  - failed  a genuine failure, or a failure mixed in with held writes.
 *
 * ok, skipped and held answer 2xx; only failed answers non-2xx. The recorded cron_runs status is unchanged ('failed' for a
 * held-only run too), so the audit trail still shows what was held; only the HTTP status tells the two apart.
 */
export type CronOutcomeClass = 'ok' | 'skipped' | 'held' | 'failed'

/** Status of a run that failed. 500, not 503: a failed run is a fault of this installation, not a request to retry later. */
export const CRON_FAILED_RESPONSE_STATUS = 500

export function cronResponseStatusFor(outcome: CronOutcomeClass): number {
  return outcome === 'failed' ? CRON_FAILED_RESPONSE_STATUS : 200
}

const MAX_STATUS_REASON_LENGTH = 500

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export type CronRunLog = {
  runId: string
  jobName: string
  startedAt: string
  finishedAt: string
  durationMs: number
  status: CronRunStatus
  counts: JsonObject | null
  statusReason: string | null
}

export type CronRunRecord = {
  id: string
  runId: string
  jobName: string
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
  status: CronRunStatus
  countsJson: unknown
  statusReason: string | null
  createdAt: Date
}

export type CronRunContext = {
  runId: string
  startedAt: string
}

export type CronRunOutcome<T> = {
  status?: CronRunStatus
  counts?: JsonObject | null
  statusReason?: string | null
  /** How the run ended for the exit status. Derived from `status` and the result when not given. */
  outcomeClass?: CronOutcomeClass
  responseStatus?: number
  result?: T
}

export type CronRunLogWriter = (log: CronRunLog) => Promise<void>

export type CronRunPersistenceTransactionClient = {
  cronRun: {
    create(args: unknown): Promise<unknown>
  }
  activityLog: {
    create(args: unknown): Promise<unknown>
  }
}

export type CronRunPersistenceClient = {
  cronRun: {
    create(args: unknown): Promise<unknown>
    findUnique(args: unknown): Promise<CronRunRecord | null>
    findMany(args: unknown): Promise<CronRunRecord[]>
  }
  activityLog: {
    create(args: unknown): Promise<unknown>
  }
  $transaction<T>(fn: (tx: CronRunPersistenceTransactionClient) => Promise<T>): Promise<T>
}

export type RunCronWithLoggingOptions<T extends Record<string, unknown>> = {
  jobName: string
  run: (context: CronRunContext) => Promise<T>
  now?: () => Date
  createRunId?: () => string
  getOutcome?: (result: T) => CronRunOutcome<T>
  /** The route's own mapping of its result to an exit-status class (lib/ops/cron-outcomes.ts). When given it decides the class and the recorded status. */
  outcomeOf?: (result: NoInfer<T>) => CronOutcomeClass
  writeLog?: CronRunLogWriter
}

export function cronRunResponseInit(init: ResponseInit = {}): ResponseInit {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')

  return {
    ...init,
    headers,
  }
}

export async function runCronWithLogging<T extends Record<string, unknown>>(
  options: RunCronWithLoggingOptions<T>,
): Promise<{ runId: string; result: T; log: CronRunLog; outcomeClass: CronOutcomeClass; responseStatus?: number }> {
  const now = options.now ?? (() => new Date())
  const writeLog = options.writeLog ?? persistCronRunLog
  const runId = options.createRunId?.() ?? randomUUID()
  const startedAtDate = now()
  const startedAt = startedAtDate.toISOString()

  let result: T
  try {
    result = await options.run({ runId, startedAt })
  } catch (error) {
    const finishedAtDate = now()
    const log = buildCronRunLog({
      runId,
      jobName: options.jobName,
      startedAt,
      finishedAt: finishedAtDate.toISOString(),
      durationMs: durationMs(startedAtDate, finishedAtDate),
      status: 'failed',
      counts: null,
      statusReason: summarizeError(error),
    })

    await safeWriteCronRunLog(writeLog, log)
    // A refused outbound write is a hold, not a fault: it is recorded (above) and answered 2xx. Recognised by its class, and only when it PROVES
    // nothing was sent (hop 0): a refusal at a redirect hop follows a request that went out, so its outcome is unknown and it is a failure.
    if (isOutboundWriteHeldError(error) && error.nothingSent === true) {
      return { runId, result: { error: log.statusReason, held: true } as unknown as T, log, outcomeClass: 'held' }
    }
    throw error
  }

  const inferred = inferCronRunOutcome(result)
  const explicit = options.getOutcome?.(result) ?? {}
  const outcome = { ...inferred, ...explicit }
  // A route that states its own status decides the class from it; otherwise the result's own classification stands.
  const routeClass = options.outcomeOf?.(result)
  const outcomeClass: CronOutcomeClass = routeClass
    ?? explicit.outcomeClass
    ?? (explicit.status === undefined
      ? inferred.outcomeClass
      : explicit.status === 'failed' ? 'failed' : explicit.status === 'skipped' ? 'skipped' : 'ok')
    ?? 'ok'
  const finishedAtDate = now()
  // The route's own class decides what is recorded: a run it calls failed (or held) is never recorded completed.
  const recordedStatus: CronRunStatus | undefined = routeClass === undefined
    ? outcome.status
    : routeClass === 'skipped' ? 'skipped' : routeClass === 'ok' ? 'completed' : 'failed'
  const log = buildCronRunLog({
    runId,
    jobName: options.jobName,
    startedAt,
    finishedAt: finishedAtDate.toISOString(),
    durationMs: durationMs(startedAtDate, finishedAtDate),
    status: recordedStatus ?? 'completed',
    counts: outcome.counts ?? null,
    statusReason: outcome.statusReason
      ?? (routeClass === 'failed' ? 'The run reported failures' : routeClass === 'held' ? 'The only failures were writes held by the outbound-write hold' : null),
  })

  // CronRun is the canonical audit record for successful cron execution. If
  // the structured row cannot be written, surface the persistence failure.
  await writeLog(log)

  return {
    runId,
    result: outcome.result ?? result,
    log,
    outcomeClass,
    // A status the route set itself wins when it is an error; a route can never answer 2xx for a failed run.
    responseStatus: outcome.responseStatus !== undefined && outcome.responseStatus >= 400
      ? outcome.responseStatus
      : cronResponseStatusFor(outcomeClass),
  }
}

function durationMs(startedAt: Date, finishedAt: Date): number {
  // Wall-clock duration; clamped to 0 to survive NTP backward adjustments. This is sufficient for cron-scale timing.
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}

export function appendCronRunId<T extends Record<string, unknown>>(result: T, runId: string): T & { runId: string } {
  return {
    ...result,
    runId,
  }
}

export async function persistCronRunLog(
  log: CronRunLog,
  client: CronRunPersistenceClient = db as unknown as CronRunPersistenceClient,
): Promise<void> {
  assertCronRunCounts(log.counts)

  const cronRunCreate = {
    data: {
      runId: log.runId,
      jobName: log.jobName,
      startedAt: new Date(log.startedAt),
      finishedAt: new Date(log.finishedAt),
      durationMs: log.durationMs,
      status: log.status,
      // Prisma rejects a bare JS `null` for nullable Json columns; translate to the
      // documented JsonNull sentinel so failed runs (counts === null) still persist.
      countsJson: log.counts === null ? Prisma.JsonNull : log.counts,
      statusReason: log.statusReason,
    },
  }

  const activityLogCreate = {
    data: {
      entityType: 'SYSTEM',
      entityId: log.runId,
      action: 'cron_run',
      tag: 'system',
      level: log.status === 'failed' ? 'ERROR' : 'INFO',
      description: `${log.jobName} cron run ${log.status} (${log.runId})`,
      metadata: log,
    },
  }

  await client.$transaction(async (tx) => {
    await tx.cronRun.create(cronRunCreate)
    await tx.activityLog.create(activityLogCreate)
  })
}

export async function findCronRunByRunId(
  runId: string,
  client: CronRunPersistenceClient = db as unknown as CronRunPersistenceClient,
): Promise<CronRunRecord | null> {
  return client.cronRun.findUnique({ where: { runId } })
}

export async function listRecentCronRuns(
  options: { jobName?: string; status?: CronRunStatus; limit?: number } = {},
  client: CronRunPersistenceClient = db as unknown as CronRunPersistenceClient,
): Promise<CronRunRecord[]> {
  const requestedLimit = Math.floor(options.limit ?? 50)
  const take = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50

  return client.cronRun.findMany({
    where: {
      ...(options.jobName ? { jobName: options.jobName } : {}),
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take,
  })
}

export function inferCronRunOutcome<T extends Record<string, unknown>>(result: T): CronRunOutcome<T> {
  const classified = classifyCronResult(result)

  if (classified.outcomeClass === 'skipped') {
    return {
      status: 'skipped',
      outcomeClass: 'skipped',
      counts: getCounts(result),
      statusReason: typeof result.reason === 'string' ? result.reason : null,
    }
  }

  if (classified.outcomeClass === 'failed' || classified.outcomeClass === 'held') {
    return {
      status: 'failed',
      outcomeClass: classified.outcomeClass,
      counts: getCounts(result),
      statusReason: classified.statusReason,
    }
  }

  return {
    status: 'completed',
    outcomeClass: 'ok',
    counts: getCounts(result),
    statusReason: null,
  }
}

/**
 * Classify a finished run's result. Pure. Failures are collected from the usual places (`error`, `errors[]`, `failed[]`, `success:
 * false`, a nested `status` of failed or partial_failure); each is HELD when it is the hold's own text (recognised by the hold's
 * authenticated reference, which a destination's reply cannot forge) or is marked `held: true`. The result is held only when every
 * collected failure is held; one genuine failure among them makes it failed.
 */
export function classifyCronResult(result: Record<string, unknown>): { outcomeClass: CronOutcomeClass; statusReason: string | null } {
  if (result.skipped === true) return { outcomeClass: 'skipped', statusReason: typeof result.reason === 'string' ? result.reason : null }

  const issues = collectResultIssues(result)
  const statusValue = typeof result.status === 'string' ? result.status : null
  const rootFailed = statusValue === 'failed' || statusValue === 'partial_failure'
  if (issues.length === 0 && !rootFailed) return { outcomeClass: 'ok', statusReason: null }

  const statusReason = (issues.length > 0 ? issues.map((issue) => issue.text).join('; ') : statusValue)?.slice(0, MAX_STATUS_REASON_LENGTH) ?? null
  const genuine = issues.some((issue) => !issue.held)
  const rootOnly = issues.length === 0 && rootFailed
  if (genuine || (rootOnly && result.held !== true)) return { outcomeClass: 'failed', statusReason }
  return { outcomeClass: 'held', statusReason }
}

function buildCronRunLog(input: CronRunLog): CronRunLog {
  return input
}

function assertCronRunCounts(counts: JsonObject | null): void {
  if (counts !== null && !isJsonObject(counts)) {
    throw new Error(`cron run counts must be a JSON object, got ${Array.isArray(counts) ? 'array' : typeof counts}`)
  }
}

async function safeWriteCronRunLog(writeLog: CronRunLogWriter, log: CronRunLog): Promise<void> {
  try {
    await writeLog(log)
  } catch (error) {
    console.error('Failed to persist cron run log', error)
  }
}

function getCounts(result: Record<string, unknown>): JsonObject | null {
  if (isJsonObject(result.counts)) return result.counts
  if (isJsonObject(result.summary)) return result.summary

  const numericCounts = getNestedCounts(result)

  return Object.keys(numericCounts).length > 0 ? numericCounts : null
}

function getNestedCounts(result: Record<string, unknown>): JsonObject {
  const counts: JsonObject = {}

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      counts[key] = value
      continue
    }

    if (isRecord(value)) {
      const nested = getNestedCounts(value)
      if (Object.keys(nested).length > 0) counts[key] = nested
    }
  }

  return counts
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, MAX_STATUS_REASON_LENGTH)
  if (typeof error === 'string' && error.trim()) return error.slice(0, MAX_STATUS_REASON_LENGTH)
  return 'Unknown cron run failure'
}

type ResultIssue = { text: string; held: boolean }

function collectResultIssues(value: unknown, path: string[] = []): ResultIssue[] {
  if (!isRecord(value)) return []

  const issues: ResultIssue[] = []
  const label = path.join('.')

  if (typeof value.error === 'string' && value.error.trim()) {
    const text = value.error.trim()
    // `{ error, held: true }` is the connector clients' shape for a write the hold refused before it left.
    issues.push({ text: formatResultError(label, text), held: value.held === true || isOutboundWriteHeldText(text) })
  }

  if (Array.isArray(value.errors) && value.errors.length > 0) {
    issues.push(...entryIssues(label, value.errors, summarizeErrorArray))
  }

  if (Array.isArray(value.failed) && value.failed.length > 0) {
    issues.push(...entryIssues(label, value.failed, summarizeFailedArray))
  }

  if (value.success === false && issues.length === 0) {
    issues.push({ text: formatResultError(label, 'success false'), held: value.held === true })
  }

  if (
    path.length > 0 &&
    typeof value.status === 'string' &&
    ['failed', 'partial_failure'].includes(value.status) &&
    issues.length === 0
  ) {
    issues.push({ text: formatResultError(label, value.status), held: value.held === true })
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (['error', 'errors', 'failed', 'success', 'status'].includes(key)) continue
    if (!isRecord(nestedValue) && !Array.isArray(nestedValue)) continue
    issues.push(...collectNestedResultIssues(nestedValue, [...path, key]))
  }

  return issues
}

function collectNestedResultIssues(value: unknown, path: string[]): ResultIssue[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectNestedResultIssues(entry, [...path, String(index)]))
  }

  return collectResultIssues(value, path)
}

/** Split a list of failures into the held ones and the rest, so a held entry never hides (or is counted as) a genuine one. */
function entryIssues(label: string, entries: unknown[], summarize: (entries: unknown[]) => string): ResultIssue[] {
  const held = entries.filter(entryIsHeld)
  const rest = entries.filter((entry) => !entryIsHeld(entry))
  const issues: ResultIssue[] = []
  if (rest.length > 0) issues.push({ text: formatResultError(label, summarize(rest)), held: false })
  if (held.length > 0) issues.push({ text: formatResultError(label, summarize(held)), held: true })
  return issues
}

function entryIsHeld(entry: unknown): boolean {
  if (typeof entry === 'string') return isOutboundWriteHeldText(entry)
  if (isRecord(entry)) {
    if (entry.held === true) return true
    return typeof entry.message === 'string' && isOutboundWriteHeldText(entry.message)
  }
  return false
}

function summarizeErrorArray(errors: unknown[]): string {
  const summary = errors
    .map((error) => {
      if (typeof error === 'string') return error
      if (isJsonObject(error) && typeof error.message === 'string') return error.message
      return null
    })
    .filter((message): message is string => Boolean(message))
    .join('; ')

  return summary || `${errors.length} error(s)`
}

function summarizeFailedArray(failed: unknown[]): string {
  const summary = failed
    .map((failure) => {
      if (typeof failure === 'string') return failure
      if (isJsonObject(failure) && typeof failure.message === 'string') return failure.message
      if (isJsonObject(failure) && typeof failure.code === 'string') return failure.code
      return null
    })
    .filter((message): message is string => Boolean(message))
    .join(', ')

  return summary ? `failed: ${summary}` : `${failed.length} failed item(s)`
}

function formatResultError(path: string, message: string): string {
  return path ? `${path}: ${message}` : message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value == null) return true
  if (['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}
