import { randomUUID } from 'node:crypto'

import { db } from '@/lib/db'

export type CronRunStatus = 'completed' | 'failed' | 'skipped'

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
  if (typeof result.error === 'string' && result.error.trim()) return result.error
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors
      .map((error) => {
        if (typeof error === 'string') return error
        if (isJsonObject(error) && typeof error.message === 'string') return error.message
        return null
      })
      .filter((message): message is string => Boolean(message))
      .join('; ')
      .slice(0, 500) || `${result.errors.length} error(s)`
  }
  return null
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 500)
  if (typeof error === 'string' && error.trim()) return error.slice(0, 500)
  return 'Unknown cron run failure'
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
