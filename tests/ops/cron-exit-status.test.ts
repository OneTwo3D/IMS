import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCronResult,
  cronResponseStatusFor,
  runCronWithLogging,
  type CronRunLog,
} from '../../lib/ops/cron-run.ts'
import { cronResultResponse, cronRunResponse } from '../../lib/ops/cron-response.ts'
import { OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'

/**
 * THE EXIT-STATUS CONTRACT OF /api/cron/*: ok, skipped and held answer 2xx; only failed answers non-2xx. The crontab wrapper runs
 * `curl -sf`, so the status is what the scheduler (and Healthchecks) sees.
 */

process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

const heldText = (target = 'https://shop.example.test/wp-json/wc/v3/products/1'): string => new OutboundWriteHeldError(
  { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target, granted: null, attempted: null, basis: 'test' },
  0,
).message

const writeLog = async (): Promise<void> => undefined

test('the hold text used by the tests is recognised as held (the fixture is not vacuous)', () => {
  assert.equal(classifyCronResult({ errors: [heldText()] }).outcomeClass, 'held')
})

test('ok: a clean result is 2xx', () => {
  assert.equal(classifyCronResult({ synced: 3, errors: [] }).outcomeClass, 'ok')
  assert.equal(cronResponseStatusFor('ok'), 200)
})

test('skipped: skipped by design is 2xx, whatever else the result carries', () => {
  const result = { skipped: true, reason: 'WC sync disabled' }
  assert.equal(classifyCronResult(result).outcomeClass, 'skipped')
  assert.equal(cronResultResponse(result).status, 200)
  assert.equal(cronResponseStatusFor('skipped'), 200)
})

test('failed: a genuine failure is non-2xx, in each place a failure is reported', () => {
  for (const result of [
    { error: 'Initial order import has not been completed yet' },
    { errors: ['Stock push failed'] },
    { errors: [{ message: 'inventory failed' }] },
    { failed: [{ code: 'E1' }] },
    { success: false },
    { status: 'partial_failure' },
    { orders: { success: false, error: 'Order sync failed' } },
    { stock: { sync: { errors: ['Stock push failed'] } } },
  ]) {
    assert.equal(classifyCronResult(result).outcomeClass, 'failed', JSON.stringify(result))
    assert.equal(cronResultResponse(result).status, 500, JSON.stringify(result))
  }
})

test('held: a result whose only failures are held writes is 2xx', () => {
  for (const result of [
    { processed: 2, synced: 0, failed: 2, errors: [heldText(), heldText('https://shop.example.test/wp-json/wc/v3/products/2')] },
    { queued: { processed: 1, errors: [heldText()] }, orders: { imported: 4 } },
    { stock: { error: 'Held by the producer', held: true } },
    { errors: [{ message: 'x', held: true }] },
    { failed: [{ code: 'H', held: true }] },
    { error: `Failed to push product 7: ${heldText()}` },
  ]) {
    assert.equal(classifyCronResult(result).outcomeClass, 'held', JSON.stringify(result))
    assert.equal(cronResultResponse(result).status, 200, JSON.stringify(result))
  }
})

test('mixed: a held write next to a genuine failure is non-2xx', () => {
  for (const result of [
    { errors: [heldText(), 'Stock push failed'] },
    { queued: { errors: [heldText()] }, orders: { success: false, error: 'Order sync failed' } },
    { errors: [heldText(), { code: 'no message' }] },
    { stock: { error: 'WooCommerce said no' } , queued: { errors: [heldText()] } },
  ]) {
    assert.equal(classifyCronResult(result).outcomeClass, 'failed', JSON.stringify(result))
    assert.equal(cronResultResponse(result).status, 500, JSON.stringify(result))
  }
})

test('held is recognised by the hold itself: a destination echoing the words without the reference is a failure', () => {
  assert.equal(classifyCronResult({ errors: ['Outbound write HELD (woocommerce): something'] }).outcomeClass, 'failed')
  assert.equal(classifyCronResult({ errors: [`${heldText()}`.replace(/\[hold-ref [0-9a-f]{18}\]/, '[hold-ref 000000000000000000]')] }).outcomeClass, 'failed')
})

test('the status reason still names the held writes', () => {
  assert.match(classifyCronResult({ errors: [heldText()] }).statusReason ?? '', /Outbound write HELD/)
})

test('runCronWithLogging: held-only is recorded failed but answers 2xx; a real failure answers 500', async () => {
  const held = await runCronWithLogging({ jobName: 'wc-reconcile', writeLog, run: async () => ({ queued: { errors: [heldText()] }, orders: { imported: 1 } }) })
  assert.equal(held.log.status, 'failed')
  assert.equal(held.outcomeClass, 'held')
  assert.equal(cronRunResponse(held).status, 200)

  const failed = await runCronWithLogging({ jobName: 'wc-reconcile', writeLog, run: async () => ({ error: 'Initial order import has not been completed yet' }) })
  assert.equal(failed.log.status, 'failed')
  assert.equal(failed.outcomeClass, 'failed')
  assert.equal(failed.responseStatus, 500)
  assert.equal(cronRunResponse(failed).status, 500)

  const mixed = await runCronWithLogging({ jobName: 'wc-reconcile', writeLog, run: async () => ({ errors: [heldText(), 'boom'] }) })
  assert.equal(cronRunResponse(mixed).status, 500)

  const skipped = await runCronWithLogging({ jobName: 'wc-reconcile', writeLog, run: async () => ({ skipped: true, reason: 'Shopping plugin disabled' }) })
  assert.equal(skipped.log.status, 'skipped')
  assert.equal(cronRunResponse(skipped).status, 200)

  const ok = await runCronWithLogging({ jobName: 'wc-reconcile', writeLog, run: async () => ({ synced: 1 }) })
  assert.equal(cronRunResponse(ok).status, 200)
})

test('runCronWithLogging: a route-stated status is honoured when it says failed, and an explicit completed stays 2xx', async () => {
  const explicitFailed = await runCronWithLogging({ jobName: 'j', writeLog, run: async () => ({ x: 1 }), getOutcome: () => ({ status: 'failed' }) })
  assert.equal(cronRunResponse(explicitFailed).status, 500)
  const explicitCompleted = await runCronWithLogging({ jobName: 'j', writeLog, run: async () => ({ errors: ['partial'] }), getOutcome: () => ({ status: 'completed' }) })
  assert.equal(cronRunResponse(explicitCompleted).status, 200)
  const explicit503 = await runCronWithLogging({ jobName: 'j', writeLog, run: async () => ({ errors: ['x'] }), getOutcome: () => ({ responseStatus: 503 }) })
  assert.equal(cronRunResponse(explicit503).status, 503)
  const never2xx = await runCronWithLogging({ jobName: 'j', writeLog, run: async () => ({ errors: ['x'] }), getOutcome: () => ({ responseStatus: 200 }) })
  assert.equal(cronRunResponse(never2xx).status, 500)
})

test('runCronWithLogging: a thrown hold is recorded and answers 2xx; any other throw still propagates', async () => {
  const logs: CronRunLog[] = []
  const refusal = { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.test/x', granted: null, attempted: null, basis: 't' } as const
  const run = await runCronWithLogging({
    jobName: 'j',
    writeLog: async (log) => { logs.push(log) },
    run: async () => { throw new OutboundWriteHeldError(refusal, 0) },
  })
  assert.equal(run.outcomeClass, 'held')
  assert.equal(logs[0]?.status, 'failed')
  assert.equal(cronRunResponse(run).status, 200)

  await assert.rejects(runCronWithLogging({ jobName: 'j', writeLog, run: async () => { throw new Error('boom') } }), /boom/)
})

test('cronResultResponse: an explicit outcome class overrides the result, and the response is not cacheable', () => {
  const response = cronResultResponse({ status: 'FAILED' }, { outcomeClass: 'failed' })
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(cronResultResponse({ ok: true }, { outcomeClass: 'held' }).status, 200)
})
