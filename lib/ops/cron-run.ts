import { randomUUID } from 'node:crypto'

import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

export type CronRunStatus = 'completed' | 'failed' | 'skipped'

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
): Promise<{ runId: string; result: T; log: CronRunLog; responseStatus?: number }> {
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
    throw error
  }

  const outcome = {
    ...inferCronRunOutcome(result),
    ...(options.getOutcome?.(result) ?? {}),
  }
  const finishedAtDate = now()
  const log = buildCronRunLog({
    runId,
    jobName: options.jobName,
    startedAt,
    finishedAt: finishedAtDate.toISOString(),
    durationMs: durationMs(startedAtDate, finishedAtDate),
    status: outcome.status ?? 'completed',
    counts: outcome.counts ?? null,
    statusReason: outcome.statusReason ?? null,
  })

  // CronRun is the canonical audit record for successful cron execution. If
  // the structured row cannot be written, surface the persistence failure.
  await writeLog(log)

  return {
    runId,
    result: outcome.result ?? result,
    log,
    responseStatus: outcome.responseStatus,
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
  const statusValue = typeof result.status === 'string' ? result.status : null
  const statusReason = summarizeResultError(result)

  if (result.skipped === true) {
    return {
      status: 'skipped',
      counts: getCounts(result),
      statusReason: typeof result.reason === 'string' ? result.reason : null,
    }
  }

  if (statusReason || statusValue === 'failed' || statusValue === 'partial_failure') {
    return {
      status: 'failed',
      counts: getCounts(result),
      statusReason: statusReason ?? statusValue,
    }
  }

  return {
    status: 'completed',
    counts: getCounts(result),
    statusReason: null,
  }
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

function summarizeResultError(result: Record<string, unknown>): string | null {
  const summaries = collectResultErrors(result)
  if (summaries.length === 0) return null

  return summaries.join('; ').slice(0, MAX_STATUS_REASON_LENGTH)
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, MAX_STATUS_REASON_LENGTH)
  if (typeof error === 'string' && error.trim()) return error.slice(0, MAX_STATUS_REASON_LENGTH)
  return 'Unknown cron run failure'
}

function collectResultErrors(value: unknown, path: string[] = []): string[] {
  if (!isRecord(value)) return []

  const summaries: string[] = []
  const label = path.join('.')
  const initialLength = summaries.length

  if (typeof value.error === 'string' && value.error.trim()) {
    summaries.push(formatResultError(label, value.error.trim()))
  }

  if (Array.isArray(value.errors) && value.errors.length > 0) {
    summaries.push(formatResultError(label, summarizeErrorArray(value.errors)))
  }

  if (Array.isArray(value.failed) && value.failed.length > 0) {
    summaries.push(formatResultError(label, summarizeFailedArray(value.failed)))
  }

  if (value.success === false && summaries.length === initialLength) {
    summaries.push(formatResultError(label, 'success false'))
  }

  if (
    path.length > 0 &&
    typeof value.status === 'string' &&
    ['failed', 'partial_failure'].includes(value.status) &&
    summaries.length === initialLength
  ) {
    summaries.push(formatResultError(label, value.status))
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (['error', 'errors', 'failed', 'success', 'status'].includes(key)) continue
    if (!isRecord(nestedValue) && !Array.isArray(nestedValue)) continue
    summaries.push(...collectNestedResultErrors(nestedValue, [...path, key]))
  }

  return summaries
}

function collectNestedResultErrors(value: unknown, path: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectNestedResultErrors(entry, [...path, String(index)]))
  }

  return collectResultErrors(value, path)
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
