import { randomUUID } from 'node:crypto'

import { db } from '@/lib/db'

export type CronRunStatus = 'completed' | 'failed' | 'skipped'

const MAX_ERROR_SUMMARY_LENGTH = 500

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export type CronRunLog = {
  runId: string
  jobName: string
  startedAt: string
  finishedAt: string
  status: CronRunStatus
  counts: JsonObject | null
  errorSummary: string | null
}

export type CronRunContext = {
  runId: string
  startedAt: string
}

export type CronRunOutcome<T> = {
  status?: CronRunStatus
  counts?: JsonObject | null
  errorSummary?: string | null
  responseStatus?: number
  result?: T
}

export type CronRunLogWriter = (log: CronRunLog) => Promise<void>

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
  const startedAt = now().toISOString()

  try {
    const result = await options.run({ runId, startedAt })
    const outcome = {
      ...inferCronRunOutcome(result),
      ...(options.getOutcome?.(result) ?? {}),
    }
    const log = buildCronRunLog({
      runId,
      jobName: options.jobName,
      startedAt,
      finishedAt: now().toISOString(),
      status: outcome.status ?? 'completed',
      counts: outcome.counts ?? null,
      errorSummary: outcome.errorSummary ?? null,
    })

    await safeWriteCronRunLog(writeLog, log)

    return {
      runId,
      result: outcome.result ?? result,
      log,
      responseStatus: outcome.responseStatus,
    }
  } catch (error) {
    const log = buildCronRunLog({
      runId,
      jobName: options.jobName,
      startedAt,
      finishedAt: now().toISOString(),
      status: 'failed',
      counts: null,
      errorSummary: summarizeError(error),
    })

    await safeWriteCronRunLog(writeLog, log)
    throw error
  }
}

export function appendCronRunId<T extends Record<string, unknown>>(result: T, runId: string): T & { runId: string } {
  return {
    ...result,
    runId,
  }
}

export async function persistCronRunLog(log: CronRunLog): Promise<void> {
  await db.activityLog.create({
    data: {
      entityType: 'SYSTEM',
      entityId: log.runId,
      action: 'cron_run',
      tag: 'system',
      level: log.status === 'failed' ? 'ERROR' : log.status === 'skipped' ? 'INFO' : 'INFO',
      description: `${log.jobName} cron run ${log.status} (${log.runId})`,
      metadata: log,
    },
  })
}

export function inferCronRunOutcome<T extends Record<string, unknown>>(result: T): CronRunOutcome<T> {
  const statusValue = typeof result.status === 'string' ? result.status : null
  const errorSummary = summarizeResultError(result)

  if (result.skipped === true) {
    return {
      status: 'skipped',
      counts: getCounts(result),
      errorSummary: typeof result.reason === 'string' ? result.reason : null,
    }
  }

  if (errorSummary || statusValue === 'failed' || statusValue === 'partial_failure') {
    return {
      status: 'failed',
      counts: getCounts(result),
      errorSummary: errorSummary ?? statusValue,
    }
  }

  return {
    status: 'completed',
    counts: getCounts(result),
    errorSummary: null,
  }
}

function buildCronRunLog(input: CronRunLog): CronRunLog {
  return input
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

  const numericCounts = Object.fromEntries(
    Object.entries(result).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean'),
  ) as JsonObject

  return Object.keys(numericCounts).length > 0 ? numericCounts : null
}

function summarizeResultError(result: Record<string, unknown>): string | null {
  const summaries = collectResultErrors(result)
  if (summaries.length === 0) return null

  return summaries.join('; ').slice(0, MAX_ERROR_SUMMARY_LENGTH)
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, MAX_ERROR_SUMMARY_LENGTH)
  if (typeof error === 'string' && error.trim()) return error.slice(0, MAX_ERROR_SUMMARY_LENGTH)
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
    if (['error', 'errors', 'success', 'status'].includes(key)) continue
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
