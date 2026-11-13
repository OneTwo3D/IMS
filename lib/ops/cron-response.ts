import { NextResponse } from 'next/server'

import {
  appendCronRunId,
  cronResponseStatusFor,
  cronRunResponseInit,
  type CronOutcomeClass,
} from './cron-run'

/**
 * THE ONE PLACE A /api/cron/* ROUTE TURNS ITS RESULT INTO A RESPONSE.
 *
 * The crontab wrapper runs `curl -sf`, so a non-2xx answer is a failing run and a 2xx one is a healthy run, which is all the
 * scheduler (and Healthchecks behind it) ever sees. The mapping, from lib/ops/cron-run.ts: ok, skipped and held answer 200; failed
 * answers 500. A route does not choose a status itself; it passes the outcome class when it has its own idea of failure.
 * tests/ops/cron-response-census.test.ts holds every route under app/api/cron to this module.
 */

/** A run that went through runCronWithLogging. A route-set error status (>= 400) is kept; a failed run can never answer 2xx. */
export function cronRunResponse(
  run: { runId: string; result: object; outcomeClass: CronOutcomeClass; responseStatus?: number },
  init: ResponseInit = {},
): NextResponse {
  const status = run.responseStatus !== undefined && run.responseStatus >= 400
    ? run.responseStatus
    : cronResponseStatusFor(run.outcomeClass)
  return NextResponse.json(appendCronRunId(run.result as Record<string, unknown>, run.runId), cronRunResponseInit({ ...init, status }))
}

/** A run that is not logged as a cron run. The route states the class from its own mapping (`cronOutcome` in lib/ops/cron-outcomes.ts). */
export function cronResultResponse(
  result: unknown,
  options: { outcomeClass: CronOutcomeClass } & ResponseInit,
): NextResponse {
  const { outcomeClass, ...init } = options
  const status = cronResponseStatusFor(outcomeClass)
  return NextResponse.json(result, cronRunResponseInit({ ...init, status }))
}

/** A run that did nothing by design (a plugin or sync switched off, nothing configured): 200, and never a failure. */
export function cronSkippedResponse(reason: string, extra: Record<string, unknown> = {}): NextResponse {
  return cronResultResponse({ skipped: true, reason, ...extra }, { outcomeClass: 'skipped' })
}
