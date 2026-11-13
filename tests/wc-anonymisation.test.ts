import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { isPlaceholderEmail, isPlaceholderName, isWcOrderAnonymised, wcPayloadCarriesIdentity } from '@/lib/connectors/woocommerce/sync/anonymisation'
import { mapWcCustomer } from '@/lib/connectors/woocommerce/sync/field-mapping'

const meta = (key: string, value: unknown) => ({ meta_data: [{ id: 1, key, value }] })

test('the marker is exactly _anonymized = yes, never inferred from placeholders', () => {
  assert.equal(isWcOrderAnonymised(meta('_anonymized', 'yes')), true)
  assert.equal(isWcOrderAnonymised(meta('_anonymized', ' YES ')), true)
  for (const v of ['no', '', 'true', '1', 1, true, null, undefined]) assert.equal(isWcOrderAnonymised(meta('_anonymized', v)), false, String(v))
  assert.equal(isWcOrderAnonymised(meta('anonymized', 'yes')), false)
  assert.equal(isWcOrderAnonymised({ meta_data: [] }), false)
  assert.equal(isWcOrderAnonymised({} as never), false)
})

test('placeholder emails are matched on the reserved .invalid TLD, not one literal', () => {
  for (const e of ['deleted@site.invalid', 'erased@erased.invalid', 'X@Anything.INVALID', 'a@invalid', 'a@b.invalid.']) assert.equal(isPlaceholderEmail(e), true, e)
  for (const e of ['a@example.test', 'a@invalid.com', 'plain', '', null, undefined]) assert.equal(isPlaceholderEmail(e), false, String(e))
  assert.equal(isPlaceholderName('[deleted]'), true)
  assert.equal(isPlaceholderName(' [Deleted] '), true)
  assert.equal(isPlaceholderName('Deleted'), false)
})

test('mapWcCustomer drops placeholders so they can never be stored or matched on', () => {
  const addr = { first_name: '[deleted]', last_name: '[deleted]', company: '', email: 'deleted@site.invalid', phone: '+000000000000' }
  const c = mapWcCustomer({ customer_id: 0, billing: addr, shipping: addr } as never)
  assert.deepEqual([c.firstName, c.lastName, c.email, c.externalCustomerId], ['', '', null, null])
  const real = mapWcCustomer({ customer_id: 7, billing: { ...addr, first_name: 'Ada', email: 'ada@example.test' }, shipping: addr } as never)
  assert.deepEqual([real.firstName, real.email, real.externalCustomerId], ['Ada', 'ada@example.test', 7])
})

test('wcPayloadCarriesIdentity ignores placeholders, phone and customer_note', () => {
  const anon = { first_name: '[deleted]', last_name: '[deleted]', address_1: '[deleted]', postcode: '[deleted]', email: 'deleted@site.invalid', phone: '+000' }
  assert.equal(wcPayloadCarriesIdentity({ billing: anon, shipping: anon } as never), false)
  assert.equal(wcPayloadCarriesIdentity({ billing: { ...anon, last_name: 'Smith' }, shipping: anon } as never), true)
  assert.equal(wcPayloadCarriesIdentity({ billing: anon, shipping: { ...anon, email: 'a@example.test' } } as never), true)
})

test('census: every caller of extractWcTracking is classified (WooCommerce keeps tracking items on an anonymised order)', () => {
  // completion-flow.ts WRITES the numbers onto a shipment: it withholds them for an erased order (pinned by the concurrency test).
  // order-webhook-echo.ts only COMPARES them with what IMS pushed and writes nothing. A new caller must be classified here deliberately.
  const out = execFileSync('git', ['grep', '-n', 'extractWcTracking', '--', 'lib', 'app'], { encoding: 'utf8' })
  const files = new Set(out.split('\n').filter((l) => l.trim() && !l.includes('export function extractWcTracking')).map((l) => l.split(':')[0]))
  assert.deepEqual([...files].sort(), [
    'lib/connectors/woocommerce/sync/completion-flow.ts',
    'lib/connectors/woocommerce/sync/order-webhook-echo.ts',
  ])
})

test('census: the erasure sweep rides the 15-minute wc-withdrawal-sweep job, last, and neither runWcReconcile, the wc-reconcile cron nor syncNewWcOrders runs it', async () => {
  const { readFileSync } = await import('node:fs')
  const route = readFileSync('app/api/cron/wc-withdrawal-sweep/route.ts', 'utf8')
  assert.ok(route.includes('runWithErasureSweepAlways(') && route.indexOf('runWithErasureSweepAlways(') < route.indexOf('sweepWithdrawalSuppressions()'), 'the host job\'s own work runs INSIDE the always-sweep wrapper, so a withdrawal failure cannot starve the sweep')
  assert.ok(!readFileSync('app/api/cron/wc-reconcile/route.ts', 'utf8').includes('anonymisation-sweep'), 'the daily reconcile cron is unchanged')
  assert.ok(!readFileSync('lib/connectors/woocommerce/sync/reconcile.ts', 'utf8').includes('anonymisation-sweep'), 'and so are the reconcile steps')
  assert.ok(!readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8').includes('anonymisation-sweep'), 'and the existing order sweep does not run the backstop, so its request pattern is unchanged')
  for (const file of ['app/api/shopping/manual-sync/route.ts', 'app/actions/wc-sync.ts']) {
    assert.ok(readFileSync(file, 'utf8').includes('runWcErasureSweep'), `${file} runs the backstop after a manual order reconcile`)
  }
})

test('runWithErasureSweepAlways: the sweep is attempted even when the host work throws, the failure is re-raised with the outcome attached, and a sweep that throws never hides a host result', async () => {
  const { runWithErasureSweepAlways } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  let swept = 0
  const sweep = async () => { swept += 1; return { pages: 1 } }
  await assert.rejects(
    () => runWithErasureSweepAlways(async () => { throw new Error('1 withdrawal suppression(s) could not be resolved') }, sweep as never),
    (e: Error) => /could not be resolved/.test(e.message) && /erasure sweep: \{"pages":1\}/.test(e.message),
  )
  assert.equal(swept, 1, 'the sweep ran although the host work failed')
  const ok = await runWithErasureSweepAlways(async () => ({ scanned: 3 }), sweep as never)
  assert.deepEqual(ok, { scanned: 3, erasureSweep: { pages: 1 } })
  const ok2 = await runWithErasureSweepAlways(async () => ({ scanned: 3 }), async () => { throw new Error('boom') })
  assert.equal(ok2.scanned, 3)
  assert.match(JSON.stringify(ok2.erasureSweep), /sweep failed: Error/)
})

test('census: the webhook\'s initial-import-pending branch mirrors a marked delivery before it acknowledges it', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/webhooks.ts', 'utf8')
  const pending = src.indexOf('async function handleOrderWebhook')
  const mirror = src.indexOf('mirrorWcAnonymisationIfHeld', pending)
  const ack = src.indexOf("skipped: 'initial_import_pending'", pending)
  assert.ok(pending > 0 && mirror > pending && ack > mirror, 'the marked-delivery mirror sits before the initial_import_pending acknowledgement')
  assert.match(src.slice(Math.max(0, mirror - 200), mirror), /isWcOrderAnonymised\(payload as WcFullOrder\)/, 'and is guarded by the marker')
})
