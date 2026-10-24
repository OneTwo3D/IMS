import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { fakeFxClient, type FakeFxRow } from '@/tests/helpers/fx-fake-client'

let rows: FakeFxRow[] = []
let base: string | null = 'GBP'
let client = fakeFxClient(rows, base)
const logged: Array<Record<string, unknown>> = []

mock.module('@/lib/db', {
  namedExports: { db: new Proxy({}, { get: (_t, k) => (client as never)[k] }) },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (p: Record<string, unknown>) => { logged.push(p) } },
})

// (mocks are installed above; the modules under test are imported lazily so they see them)
const load = async () => ({
  fm: await import('@/lib/connectors/woocommerce/sync/field-mapping'),
  lookup: await import('@/lib/currencies/fx-lookup'),
})

function seed(r: FakeFxRow[], b: string | null = 'GBP') { rows = r; base = b; client = fakeFxClient(rows, base); logged.length = 0 }
const row = (to: string, rate: string, at: string, from = 'GBP'): FakeFxRow => ({ fromCurrency: from, toCurrency: to, rate, fetchedAt: new Date(at) })

test('WC: one error class, shared with the central lookup', async () => {
  const { fm, lookup } = await load()
  assert.equal(fm.MissingFxRateError, lookup.MissingFxRateError)
  assert.equal(fm.isMissingFxRateError(new lookup.MissingFxRateError('x', 'EUR', undefined)), true)
  assert.equal(fm.getFxRateToGbp, fm.getFxRateToBase)
})

test('WC: base currency is 1, case/padding tolerated, no table read', async () => {
  const { fm } = await load()
  seed([])
  assert.equal(await fm.getFxRateToBase(' gbp ', new Date()), 1)
  assert.equal(client.calls.filter((c) => c.op.startsWith('fxRate')).length, 0)
})

test('WC: the rate is bounded by asOf (the order date) and returned as a number', async () => {
  const { fm } = await load()
  seed([row('EUR', '1.10', '2026-06-01T00:00:00Z'), row('EUR', '1.20', '2026-06-10T00:00:00Z')])
  assert.equal(await fm.getFxRateToBase('eur', new Date('2026-06-05T00:00:00Z')), 1.1)
  assert.equal(await fm.getFxRateToBase('EUR', new Date('2026-06-10T00:00:00Z')), 1.2)
})

test('WC: a missing rate logs wc_order_fx_missing and refuses with MissingFxRateError, as before', async () => {
  const { fm } = await load()
  seed([row('EUR', '1.10', '2026-06-01T00:00:00Z')])
  await assert.rejects(fm.getFxRateToBase('USD', new Date('2026-06-05T00:00:00Z')), (e: unknown) => {
    assert.ok(fm.isMissingFxRateError(e))
    assert.equal(e.message, 'Missing GBP FX rate for USD on or before 2026-06-05')
    assert.equal(e.currency, 'USD')
    return true
  })
  assert.equal(logged.length, 1)
  assert.equal(logged[0].action, 'wc_order_fx_missing')
  assert.equal(logged[0].level, 'ERROR')
})

test('WC: asOf is required: an omitted or invalid one refuses (it used to mean "no bound")', async () => {
  const { fm } = await load()
  seed([row('EUR', '1.10', '2026-06-01T00:00:00Z')])
  await assert.rejects((fm.getFxRateToBase as (c: string, a?: Date) => Promise<number>)('EUR'), (e: unknown) => fm.isMissingFxRateError(e) && e.reason === 'invalid_as_of')
  await assert.rejects(fm.getFxRateToBase('EUR', new Date('nope')), fm.isMissingFxRateError)
})

test('WC: the base is the organisation\'s, not GBP', async () => {
  const { fm } = await load()
  seed([row('USD', '1.08', '2026-06-01T00:00:00Z', 'EUR'), row('USD', '1.30', '2026-06-01T00:00:00Z', 'GBP')], 'EUR')
  assert.equal(await fm.getFxRateToBase('USD', new Date('2026-06-05T00:00:00Z')), 1.08)
  assert.equal(await fm.getFxRateToBase('EUR', new Date('2026-06-05T00:00:00Z')), 1)
  // GBP is foreign under an EUR base, and has no EUR->GBP row here
  await assert.rejects(fm.getFxRateToBase('GBP', new Date('2026-06-05T00:00:00Z')), fm.isMissingFxRateError)
})

test('WC: a tie at the latest instant with different rates refuses', async () => {
  const { fm } = await load()
  seed([row('EUR', '1.10', '2026-06-01T00:00:00Z'), row('EUR', '1.11', '2026-06-01T00:00:00Z')])
  await assert.rejects(fm.getFxRateToBase('EUR', new Date('2026-06-05T00:00:00Z')), (e: unknown) => fm.isMissingFxRateError(e) && e.reason === 'ambiguous_rate')
})
