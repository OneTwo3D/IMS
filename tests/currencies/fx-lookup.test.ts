import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  MissingFxRateError,
  endOfBusinessDateUtc,
  getFxRateToBase,
  getFxRatesToBase,
  isMissingFxRateError,
  resolveFxRatesToBase,
  selectFxRateFromRows,
} from '@/lib/currencies/fx-lookup'
import { fakeFxClient, type FakeFxRow } from '@/tests/helpers/fx-fake-client'

const T = (s: string) => new Date(s)
const row = (to: string, rate: unknown, at: string, extra: Partial<FakeFxRow> = {}): FakeFxRow =>
  ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: T(at), ...extra })

async function reason(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    assert.ok(e instanceof MissingFxRateError, `expected MissingFxRateError, got ${String(e)}`)
    return e.reason
  }
  assert.fail('expected a refusal, got a rate')
}

test('base currency is 1 and flagged isBase, with no rate query', async () => {
  const c = fakeFxClient([])
  const r = await getFxRateToBase(c, { currency: 'GBP', asOf: T('2026-01-01T00:00:00Z') })
  assert.equal(r.isBase, true)
  assert.ok(r.rate.equals(1))
  assert.equal(c.calls.some((x) => x.op.startsWith('fxRate')), false)
})

test('latest row on or before asOf: exactly-at counts, just-after does not', async () => {
  const rows = [row('EUR', '1.10', '2026-01-01T00:00:00Z'), row('EUR', '1.20', '2026-01-02T00:00:00Z')]
  const at = await getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-01-02T00:00:00Z') })
  assert.ok(at.rate.equals('1.2'))
  assert.equal(at.isBase, false)
  assert.equal(at.fetchedAt.toISOString(), '2026-01-02T00:00:00.000Z')
  const before = await getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-01-01T23:59:59.999Z') })
  assert.ok(before.rate.equals('1.1'))
  const after = await getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-01-02T00:00:00.001Z') })
  assert.ok(after.rate.equals('1.2'))
})

test('a row before the first rate does not exist for asOf: refuses no_rate', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-01-02T00:00:00Z')])
  assert.equal(await reason(getFxRateToBase(c, { currency: 'EUR', asOf: T('2026-01-01T00:00:00Z') })), 'no_rate')
})

test('missing-rate message keeps the wording the callers have always thrown', async () => {
  await assert.rejects(
    getFxRateToBase(fakeFxClient([]), { currency: 'EUR', asOf: T('2026-03-04T10:00:00Z') }),
    { message: 'Missing GBP FX rate for EUR on or before 2026-03-04' },
  )
})

test('a tie at the latest fetchedAt with DIFFERENT rates throws ambiguous_rate (never picks one)', async () => {
  const rows = [row('EUR', '1.10', '2026-01-02T00:00:00Z'), row('EUR', '1.11', '2026-01-02T00:00:00Z'), row('EUR', '1.05', '2026-01-01T00:00:00Z')]
  assert.equal(await reason(getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })), 'ambiguous_rate')
  // a tie on an EARLIER instant is not ambiguous: it is not the latest
  const older = [row('EUR', '1.10', '2026-01-01T00:00:00Z'), row('EUR', '1.11', '2026-01-01T00:00:00Z'), row('EUR', '1.2', '2026-01-02T00:00:00Z')]
  assert.ok((await getFxRateToBase(fakeFxClient(older), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })).rate.equals('1.2'))
})

test('a three-way tie is ambiguous when ANY member differs', async () => {
  const rows = [row('EUR', '1.1', '2026-01-02T00:00:00Z'), row('EUR', '1.1', '2026-01-02T00:00:00Z'), row('EUR', '1.2', '2026-01-02T00:00:00Z')]
  assert.equal(await reason(getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })), 'ambiguous_rate')
})

test('a tie with EQUAL rates (numerically, whatever the scale) is accepted', async () => {
  const rows = [row('EUR', '1.10', '2026-01-02T00:00:00Z', { source: 'frankfurter' }), row('EUR', new Prisma.Decimal('1.1'), '2026-01-02T00:00:00Z', { source: 'manual', manualOverride: true })]
  const r = await getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })
  assert.ok(r.rate.equals('1.1'))
  assert.equal(r.manualOverride, true)
})

test('zero, negative and non-finite stored rates refuse', async () => {
  for (const [bad, why] of [['0', 'non_positive_rate'], ['-1.2', 'non_positive_rate'], [Number.NaN, 'non_finite_rate'], ['abc', 'non_finite_rate'], [Number.POSITIVE_INFINITY, 'non_finite_rate']] as const) {
    const c = fakeFxClient([row('EUR', bad, '2026-01-01T00:00:00Z')])
    assert.equal(await reason(getFxRateToBase(c, { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })), why, String(bad))
  }
})

test('a bad rate among tied rows refuses even if another tied row is fine', async () => {
  const rows = [row('EUR', '0', '2026-01-02T00:00:00Z'), row('EUR', '1.2', '2026-01-02T00:00:00Z')]
  assert.equal(await reason(getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })), 'non_positive_rate')
})

test('an older good rate is NOT used when the latest row is bad', async () => {
  const rows = [row('EUR', '1.2', '2026-01-01T00:00:00Z'), row('EUR', '0', '2026-01-02T00:00:00Z')]
  assert.equal(await reason(getFxRateToBase(fakeFxClient(rows), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })), 'non_positive_rate')
})

test('invalid currency codes refuse before any query', async () => {
  for (const bad of ['eur', 'EU', 'EURO', ' EUR', 'E1R', '', 'EU R']) {
    const c = fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z')])
    assert.equal(await reason(getFxRateToBase(c, { currency: bad, asOf: T('2026-02-01T00:00:00Z') })), 'invalid_currency', JSON.stringify(bad))
    assert.equal(c.calls.length, 0)
  }
})

test('asOf must be a real Date: undefined, invalid and non-Date all refuse', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z')])
  for (const bad of [undefined, null, new Date('nope'), '2026-01-01', 1767225600000]) {
    assert.equal(await reason(getFxRateToBase(c, { currency: 'EUR', asOf: bad as unknown as Date })), 'invalid_as_of', String(bad))
  }
})

test('base currency comes from the organisation; a non-GBP base proves nothing is hard-coded', async () => {
  const rows: FakeFxRow[] = [
    { fromCurrency: 'EUR', toCurrency: 'GBP', rate: '0.85', fetchedAt: T('2026-01-01T00:00:00Z') },
    { fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', fetchedAt: T('2026-01-01T00:00:00Z') },
    row('USD', '1.25', '2026-01-01T00:00:00Z'), // a GBP-based row that must be ignored under an EUR base
  ]
  const c = fakeFxClient(rows, 'EUR')
  const usd = await getFxRateToBase(c, { currency: 'USD', asOf: T('2026-02-01T00:00:00Z') })
  assert.ok(usd.rate.equals('1.08'))
  const eur = await getFxRateToBase(c, { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })
  assert.equal(eur.isBase, true)
  // GBP is just another foreign currency under an EUR base
  const gbp = await getFxRateToBase(c, { currency: 'GBP', asOf: T('2026-02-01T00:00:00Z') })
  assert.equal(gbp.isBase, false)
  assert.ok(gbp.rate.equals('0.85'))
  // and with no GBP->EUR row under EUR base, GBP refuses rather than returning 1
  assert.equal(await reason(getFxRateToBase(fakeFxClient([], 'EUR'), { currency: 'GBP', asOf: T('2026-02-01T00:00:00Z') })), 'no_rate')
})

test('an explicit baseCurrency skips the organisation read; a malformed base refuses', async () => {
  const c = fakeFxClient([{ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', fetchedAt: T('2026-01-01T00:00:00Z') }], 'GBP')
  const r = await getFxRateToBase(c, { currency: 'USD', asOf: T('2026-02-01T00:00:00Z'), baseCurrency: 'EUR' })
  assert.ok(r.rate.equals('1.08'))
  assert.equal(c.calls.some((x) => x.op === 'organisation.findFirst'), false)
  assert.equal(await reason(getFxRateToBase(c, { currency: 'USD', asOf: T('2026-02-01T00:00:00Z'), baseCurrency: 'eur' })), 'invalid_base_currency')
})

test('manualOverride and source pass through from the chosen row', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z', { source: 'manual', manualOverride: true })])
  const r = await getFxRateToBase(c, { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })
  assert.equal(r.manualOverride, true)
  assert.equal(r.source, 'manual')
  const d = await getFxRateToBase(fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z')]), { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })
  assert.equal(d.manualOverride, false)
})

test('the query side cannot widen the answer: rows after asOf from a misbehaving client are ignored', () => {
  const r = selectFxRateFromRows(
    [{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: '9', fetchedAt: T('2027-01-01T00:00:00Z'), source: 'x', manualOverride: false },
     { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.1', fetchedAt: T('2026-01-01T00:00:00Z'), source: 'x', manualOverride: false }],
    { baseCurrency: 'GBP', currency: 'EUR', asOf: T('2026-06-01T00:00:00Z') })
  assert.ok(r.rate.equals('1.1'))
  // and rows of another pair are ignored
  assert.throws(() => selectFxRateFromRows(
    [{ fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.3', fetchedAt: T('2026-01-01T00:00:00Z'), source: 'x', manualOverride: false }],
    { baseCurrency: 'GBP', currency: 'EUR', asOf: T('2026-06-01T00:00:00Z') }), isMissingFxRateError)
})

test('batch: one answer per currency, same semantics as the single lookup', async () => {
  const rows = [
    row('EUR', '1.1', '2026-01-01T00:00:00Z'), row('EUR', '1.2', '2026-01-02T00:00:00Z'),
    row('USD', '1.3', '2026-01-01T00:00:00Z'),
    row('JPY', '150', '2026-01-02T00:00:00Z'), row('JPY', '151', '2026-01-02T00:00:00Z'),
  ]
  const asOf = T('2026-01-02T00:00:00Z')
  const c = fakeFxClient(rows)
  const out = await resolveFxRatesToBase(c, { currencies: ['EUR', 'USD', 'JPY', 'CHF', 'GBP', 'bad', 'EUR'], asOf })
  assert.equal(c.calls.filter((x) => x.op.startsWith('fxRate')).length, 2, 'two queries however many currencies')
  const get = (k: string) => out.get(k)!
  assert.equal(get('EUR').ok && (get('EUR') as { rate: Prisma.Decimal }).rate.toString(), '1.2')
  assert.equal(get('GBP').ok && (get('GBP') as { isBase: boolean }).isBase, true)
  const err = (k: string) => (get(k) as { ok: false; error: MissingFxRateError }).error.reason
  assert.equal(err('JPY'), 'ambiguous_rate')
  assert.equal(err('CHF'), 'no_rate')
  assert.equal(err('bad'), 'invalid_currency')
  assert.equal(out.size, 6)
  for (const k of ['EUR', 'USD']) {
    const single = await getFxRateToBase(fakeFxClient(rows), { currency: k, asOf })
    const b = get(k) as { rate: Prisma.Decimal; fetchedAt: Date }
    assert.ok(single.rate.equals(b.rate)); assert.equal(single.fetchedAt.getTime(), b.fetchedAt.getTime())
  }
})

test('getFxRatesToBase refuses if ANY currency is unresolved', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z')])
  assert.equal(await reason(getFxRatesToBase(c, { currencies: ['EUR', 'USD'], asOf: T('2026-02-01T00:00:00Z') })), 'no_rate')
  const ok = await getFxRatesToBase(c, { currencies: ['EUR'], asOf: T('2026-02-01T00:00:00Z') })
  assert.ok(ok.get('EUR')!.rate.equals('1.1'))
})

test('batch with no currencies issues no query', async () => {
  const c = fakeFxClient([])
  assert.equal((await resolveFxRatesToBase(c, { currencies: [], asOf: T('2026-02-01T00:00:00Z') })).size, 0)
  assert.equal(c.calls.filter((x) => x.op.startsWith('fxRate')).length, 0)
})

test('business-date rule: a DATE maps to 23:59:59.999 UTC of that day', () => {
  assert.equal(endOfBusinessDateUtc('2026-03-04').toISOString(), '2026-03-04T23:59:59.999Z')
  assert.equal(endOfBusinessDateUtc(new Date('2026-03-04T00:00:00Z')).toISOString(), '2026-03-04T23:59:59.999Z')
  // the UTC calendar date of an instant, not the server's local day
  assert.equal(endOfBusinessDateUtc(new Date('2026-03-04T23:30:00-05:00')).toISOString(), '2026-03-05T23:59:59.999Z')
  assert.equal(endOfBusinessDateUtc('2028-02-29').toISOString(), '2028-02-29T23:59:59.999Z')
  for (const bad of ['2026-02-30', '2026-3-4', '', '2026-03-04T10:00:00Z', 'x']) assert.throws(() => endOfBusinessDateUtc(bad), isMissingFxRateError, bad)
  assert.throws(() => endOfBusinessDateUtc(new Date('nope')), isMissingFxRateError)
})

test('a rate set at 09:00 on the day is visible to that day\'s end but not to the day before', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-03-04T09:00:00Z')])
  const r = await getFxRateToBase(c, { currency: 'EUR', asOf: endOfBusinessDateUtc('2026-03-04') })
  assert.ok(r.rate.equals('1.1'))
  assert.equal(await reason(getFxRateToBase(c, { currency: 'EUR', asOf: endOfBusinessDateUtc('2026-03-03') })), 'no_rate')
})

test('selectFxRateFromRows: latest wins whatever the row order, older rows never join a tie, other bases are ignored', () => {
  const mk = (from: string, rate: string, at: string) => ({ fromCurrency: from, toCurrency: 'EUR', rate, fetchedAt: T(at), source: 's', manualOverride: false })
  const p = { baseCurrency: 'GBP', currency: 'EUR', asOf: T('2026-06-01T00:00:00Z') }
  assert.ok(selectFxRateFromRows([mk('GBP', '1.1', '2026-01-01T00:00:00Z'), mk('GBP', '1.2', '2026-01-02T00:00:00Z')], p).rate.equals('1.2'))
  assert.ok(selectFxRateFromRows([mk('GBP', '1.2', '2026-01-02T00:00:00Z'), mk('GBP', '1.1', '2026-01-01T00:00:00Z')], p).rate.equals('1.2'))
  // a row of ANOTHER base at the very same, latest instant must neither win nor make a tie
  assert.ok(selectFxRateFromRows([mk('GBP', '1.1', '2026-01-01T00:00:00Z'), mk('USD', '9', '2026-01-02T00:00:00Z')], p).rate.equals('1.1'))
})

test('the row query is scoped to the base currency as well as the instant', async () => {
  const c = fakeFxClient([row('EUR', '1.1', '2026-01-01T00:00:00Z')])
  await getFxRateToBase(c, { currency: 'EUR', asOf: T('2026-02-01T00:00:00Z') })
  const q = c.calls.filter((x) => x.op.startsWith('fxRate')).map((x) => (x.args as { where: { fromCurrency?: string } }).where.fromCurrency)
  assert.deepEqual(q, ['GBP', 'GBP'])
})
