import assert from 'node:assert/strict'
import test from 'node:test'

import {
  explainProducerDisposition,
  parseProducerCutoff,
  producerDisposition,
  producerGrantCutoffAgreement,
  ownerShadowReason,
} from '../../lib/security/producer-disposition.ts'
import { WRITER_OWNERS, WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map.ts'
import { PRODUCER_CUTOFF_ENV } from '../../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_CONNECTORS, OUTBOUND_GRANT_ENV, type OutboundConnector } from '../../lib/security/outbound-write-hold-constants.ts'

/**
 * THE PRODUCER-SIDE HOLD DECISION, AS A CLOSED TRUTH TABLE.
 *
 * LIVE only when: grant readable AND cut-off set, strict and readable AND now >= cut-off AND the ownership
 * map says IMS owns the operation in P2 AND (obligationAt absent OR obligationAt >= cut-off). The oracle
 * below is written independently of the implementation (plain predicates over the table's own labels), and
 * the test also asserts the EXACT number of LIVE cells, so a cell that flips either way is red.
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  a  no-grant            LIVE when the cut-off alone is set (grant check skipped)
 *  b  lenient-cutoff      Date.parse instead of the strict ISO-with-Z parser
 *  c  date-only-compare   compare the cut-off by calendar day, not by instant
 *  d  skip-owner          skip the ownership check
 *  e  ignore-obligation   ignore obligationAt
 *  f  propagate-throw     let an exception escape
 */

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const NOW = new Date('2026-06-01T12:00:00Z')
/** A business-event time after every cut-off used below, for cells that must reach LIVE on a row that requires one. */
const LATE = new Date('2027-01-01T00:00:00Z')

const GRANT_VALUE: Record<OutboundConnector, { ok: string; unreadable: string }> = {
  woocommerce: { ok: 'https://shop.example.com', unreadable: 'https://a.example.com,https://b.example.com' },
  mintsoft: { ok: 'https://api.example.test|89', unreadable: 'true' },
  xero: { ok: TENANT, unreadable: 'true' },
}

type GrantCase = 'ok' | 'absent' | 'unreadable'
type CutoffCase = { label: string; value: string | undefined; klass: 'absent' | 'future' | 'past' | 'malformed'; at?: Date }
type OwnerCase = 'IMS' | 'other' | 'unknown'
type ObligationCase = { label: string; value: Date | undefined; klass: 'absent' | 'before' | 'at' | 'after' | 'invalid' }

const CUTOFF_CASES: CutoffCase[] = [
  { label: 'unset', value: undefined, klass: 'absent' },
  { label: 'empty string', value: '', klass: 'absent' },
  { label: 'future', value: '2026-12-01T00:00:00Z', klass: 'future' },
  { label: 'past', value: '2026-01-01T00:00:00Z', klass: 'past', at: new Date('2026-01-01T00:00:00Z') },
  { label: 'past, fraction', value: '2026-01-01T00:00:00.250Z', klass: 'past', at: new Date('2026-01-01T00:00:00.250Z') },
  { label: 'past, minutes only', value: '2026-01-01T00:00Z', klass: 'past', at: new Date('2026-01-01T00:00:00Z') },
  { label: 'earlier today (same calendar day)', value: '2026-06-01T11:00:00Z', klass: 'past', at: new Date('2026-06-01T11:00:00Z') },
  { label: 'later today (same calendar day)', value: '2026-06-01T13:00:00Z', klass: 'future' },
  { label: 'garbage', value: 'soon', klass: 'malformed' },
  { label: 'whitespace only', value: '   ', klass: 'malformed' },
  { label: 'leading space', value: ' 2026-01-01T00:00:00Z', klass: 'malformed' },
  { label: 'trailing space', value: '2026-01-01T00:00:00Z ', klass: 'malformed' },
  { label: 'trailing tab', value: '2026-01-01T00:00:00Z\t', klass: 'malformed' },
  { label: 'trailing newline', value: '2026-01-01T00:00:00Z\n', klass: 'malformed' },
  { label: 'leading NBSP', value: '\u00a02026-01-01T00:00:00Z', klass: 'malformed' },
  { label: 'trailing zero-width space', value: '2026-01-01T00:00:00Z\u200b', klass: 'malformed' },
  { label: 'sub-millisecond (4 digits)', value: '2026-01-01T00:00:00.0001Z', klass: 'malformed' },
  { label: 'sub-millisecond (9 digits, one ns past noon)', value: '2026-06-01T12:00:00.000000001Z', klass: 'malformed' },
  { label: 'sub-millisecond zeros (6 digits)', value: '2026-01-01T00:00:00.000000Z', klass: 'malformed' },
  { label: 'date only', value: '2026-01-01', klass: 'malformed' },
  { label: 'no zone', value: '2026-01-01T00:00:00', klass: 'malformed' },
  { label: 'offset +00:00', value: '2026-01-01T00:00:00+00:00', klass: 'malformed' },
  { label: 'offset +01:00', value: '2026-01-01T00:00:00+01:00', klass: 'malformed' },
  { label: 'list', value: '2026-01-01T00:00:00Z,2026-02-01T00:00:00Z', klass: 'malformed' },
  { label: 'impossible day', value: '2026-02-30T00:00:00Z', klass: 'malformed' },
  { label: 'impossible month', value: '2026-13-01T00:00:00Z', klass: 'malformed' },
  { label: 'epoch millis', value: '1767225600000', klass: 'malformed' },
  { label: 'lowercase z', value: '2026-01-01T00:00:00z', klass: 'malformed' },
]

const CUTOFF_PAST = new Date('2026-01-01T00:00:00Z')
const OBLIGATION_CASES: ObligationCase[] = [
  { label: 'absent', value: undefined, klass: 'absent' },
  { label: 'before', value: new Date('2025-12-31T23:59:59Z'), klass: 'before' },
  { label: 'after', value: new Date('2026-03-01T00:00:00Z'), klass: 'after' },
  { label: 'invalid date', value: new Date('not a date'), klass: 'invalid' },
]

/** One operation per owner class per destination, read from the map by hand (and re-asserted in the map test). */
const OPERATION: Record<OutboundConnector, Record<OwnerCase, string>> = {
  xero: { IMS: 'purchase.bill', other: 'sales.invoice', unknown: 'no-such-operation' },
  mintsoft: { IMS: 'order.create', other: 'auth.login', unknown: 'no-such-operation' },
  woocommerce: { IMS: 'order.status', other: 'order.withdrawal-outcome', unknown: 'no-such-operation' },
}
/** IMS-owned operations whose row says obligationTime 'not-applicable'. Xero has none: every IMS-owned Xero row needs a document date. */
const OPERATION_NOT_APPLICABLE: Partial<Record<OutboundConnector, string>> = { mintsoft: 'order.cancel', woocommerce: 'stock' }

function envFor(destination: OutboundConnector, grant: GrantCase, cutoff: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  if (grant !== 'absent') env[OUTBOUND_GRANT_ENV[destination]] = GRANT_VALUE[destination][grant]
  if (cutoff !== undefined) env[PRODUCER_CUTOFF_ENV[destination]] = cutoff
  return env
}

function oracleLive(grant: GrantCase, cutoff: CutoffCase, owner: OwnerCase, obligation: ObligationCase, required: boolean): boolean {
  if (required && obligation.value === undefined) return false
  return grant === 'ok'
    && cutoff.klass === 'past'
    && owner === 'IMS'
    && cutoff.at !== undefined
    && (obligation.value === undefined || (!Number.isNaN(obligation.value.getTime()) && obligation.value.getTime() >= cutoff.at.getTime()))
}

const call = (destination: OutboundConnector, operation: string, obligationAt: Date | undefined, env: Record<string, string | undefined>, now: Date = NOW) =>
  producerDisposition(destination, operation as never, obligationAt, { env, now })

test('truth table: LIVE in exactly the allowed cells, over grant x cut-off x owner/applicability x obligationAt x destination', () => {
  const grants: GrantCase[] = ['ok', 'absent', 'unreadable']
  type Variant = { owner: OwnerCase; required: boolean; operation: string; label: string }
  const variantsFor = (destination: OutboundConnector): Variant[] => {
    const variants: Variant[] = [
      { owner: 'IMS', required: true, operation: OPERATION[destination].IMS, label: 'IMS/required' },
      { owner: 'other', required: true, operation: OPERATION[destination].other, label: 'other' },
      { owner: 'unknown', required: true, operation: OPERATION[destination].unknown, label: 'unknown' },
    ]
    const notApplicable = OPERATION_NOT_APPLICABLE[destination]
    if (notApplicable) variants.push({ owner: 'IMS', required: false, operation: notApplicable, label: 'IMS/not-applicable' })
    return variants
  }
  let cells = 0
  let live = 0
  let expectedLive = 0
  const wrong: string[] = []
  for (const destination of OUTBOUND_CONNECTORS) {
    for (const grant of grants) for (const cutoff of CUTOFF_CASES) for (const variant of variantsFor(destination)) for (const obligation of OBLIGATION_CASES) {
      const actual = call(destination, variant.operation, obligation.value, envFor(destination, grant, cutoff.value))
      const expected = oracleLive(grant, cutoff, variant.owner, obligation, variant.required) ? 'LIVE' : 'SHADOW'
      cells += 1
      if (actual === 'LIVE') live += 1
      if (expected === 'LIVE') expectedLive += 1
      if (actual !== expected) wrong.push(`${destination} grant=${grant} cutoff=${cutoff.label} variant=${variant.label} obligation=${obligation.label}: got ${actual}, want ${expected}`)
    }
  }
  console.log(`# precondition: cells=${cells} live=${live} expectedLive=${expectedLive}`)
  // 3 destinations, 3 grants, N cut-offs, 4 obligations, and (3 + 1) variants for mintsoft and woocommerce, 3 for xero = 11.
  assert.equal(cells, 3 * CUTOFF_CASES.length * OBLIGATION_CASES.length * 11)
  // Derived by hand, not from the oracle. Past cut-offs: three in Jan 2026 and 'earlier today' (2026-06-01T11:00).
  // Obligations: absent, 2025-12-31 (before), 2026-03-01 (after Jan, before 'earlier today'), invalid.
  //   IMS/required   : only '2026-03-01' qualifies, and only against the 3 Jan cut-offs      = 3 per destination x 3 = 9
  //   IMS/not-applic.: absent qualifies against all 4 past cut-offs, '2026-03-01' against 3  = 7 for mintsoft and woocommerce = 14
  assert.equal(expectedLive, 9 + 14)
  assert.ok(expectedLive > 0, 'the table must contain LIVE cells, or "LIVE only in the allowed cells" is vacuous')
  assert.deepEqual(wrong, [])
  assert.equal(live, expectedLive)
})

test('arm g: a row that requires the business-event time is SHADOW (obligation_time_required) when the producer omits it', async () => {
  const { ownershipRowFor } = await import('../../lib/security/writer-ownership-map.ts')
  for (const destination of OUTBOUND_CONNECTORS) {
    const required = ownershipRowFor(destination, OPERATION[destination].IMS)
    assert.equal(required?.obligationTime, 'required', `precondition: ${destination}.${OPERATION[destination].IMS} requires it`)
    const env = envFor(destination, 'ok', '2026-01-01T00:00:00Z')
    const omitted = explainProducerDisposition(destination, OPERATION[destination].IMS as never, undefined, { env, now: NOW })
    const given = explainProducerDisposition(destination, OPERATION[destination].IMS as never, new Date('2026-03-01T00:00:00Z'), { env, now: NOW })
    console.log(`# arm g ${destination}: omitted=${omitted.disposition}/${omitted.reason} given=${given.disposition}/${given.reason}`)
    assert.deepEqual([omitted.disposition, omitted.reason], ['SHADOW', 'obligation_time_required'])
    assert.equal(given.disposition, 'LIVE')
    const notApplicable = OPERATION_NOT_APPLICABLE[destination]
    if (notApplicable) {
      assert.equal(ownershipRowFor(destination, notApplicable)?.obligationTime, 'not-applicable')
      assert.equal(call(destination, notApplicable, undefined, env), 'LIVE', 'isolating arm: a not-applicable row is LIVE without it')
    }
  }
})

test('arm h: cut-off precision beyond a millisecond is unreadable, never rounded down into an earlier instant', () => {
  const op = OPERATION.xero.IMS
  const obligation = new Date('2026-07-01T00:00:00Z')
  const env = envFor('xero', 'ok', '2026-06-01T12:00:00.000000001Z')
  const atFloor = new Date('2026-06-01T12:00:00.000Z')
  const decision = explainProducerDisposition('xero', op as never, obligation, { env, now: atFloor })
  console.log(`# arm h: ns cut-off at its millisecond floor => ${decision.disposition}/${decision.reason}`)
  assert.deepEqual([decision.disposition, decision.reason], ['SHADOW', 'unreadable_cutoff'])
  // Boundary: exactly millisecond precision is still read, to the millisecond.
  assert.equal(parseProducerCutoff('2026-06-01T12:00:00.001Z').ok, true)
  assert.equal(parseProducerCutoff('2026-06-01T12:00:00.0010Z').ok, false)
  assert.equal(parseProducerCutoff('2026-06-01T12:00:00.0000Z').ok, false)
})

test('arm i: surrounding whitespace on a cut-off is unreadable (no trimming), and NOT absent', () => {
  const decisions = ['2026-01-01T00:00:00Z ', ' 2026-01-01T00:00:00Z', '\t2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z\n', '\u00a02026-01-01T00:00:00Z', '2026-01-01T00:00:00Z\u200b', '   '].map((value) => {
    const decision = explainProducerDisposition('xero', 'purchase.bill', new Date('2026-03-01T00:00:00Z'), { env: envFor('xero', 'ok', value), now: NOW })
    return { value, ...decision }
  })
  for (const d of decisions) {
    console.log(`# arm i ${JSON.stringify(d.value)}: ${d.disposition}/${d.reason}`)
    assert.deepEqual([d.disposition, d.reason], ['SHADOW', 'unreadable_cutoff'])
  }
  assert.equal(explainProducerDisposition('xero', 'purchase.bill', new Date('2026-03-01T00:00:00Z'), { env: envFor('xero', 'ok', '2026-01-01T00:00:00Z'), now: NOW }).disposition, 'LIVE', 'isolating arm: the same value without the whitespace is LIVE')
  assert.equal(parseProducerCutoff('').ok, false)
  assert.equal(producerGrantCutoffAgreement('xero', envFor('xero', 'ok', '2026-01-01T00:00:00Z ')).state, 'unreadable')
})

test('operation ownership used by the table is what the map says (the table cannot drift from the map)', async () => {
  const { ownershipRowFor } = await import('../../lib/security/writer-ownership-map.ts')
  for (const destination of OUTBOUND_CONNECTORS) {
    assert.equal(ownershipRowFor(destination, OPERATION[destination].IMS)?.owners.P2, 'IMS', `${destination} IMS op`)
    const other = ownershipRowFor(destination, OPERATION[destination].other)?.owners.P2
    assert.ok(other !== undefined && other !== 'IMS' && other !== 'unknown', `${destination} other op owner ${String(other)}`)
    assert.equal(ownershipRowFor(destination, OPERATION[destination].unknown), null)
  }
})

test('arm a: a cut-off alone (no grant) is SHADOW with reason no_grant; and a grant for ANOTHER destination does not count', () => {
  for (const destination of OUTBOUND_CONNECTORS) {
    const env = envFor(destination, 'absent', '2026-01-01T00:00:00Z')
    assert.ok(PRODUCER_CUTOFF_ENV[destination] in env, 'precondition: the cut-off is set')
    assert.ok(!(OUTBOUND_GRANT_ENV[destination] in env), 'precondition: no grant')
    const decision = explainProducerDisposition(destination, OPERATION[destination].IMS as never, undefined, { env, now: NOW })
    console.log(`# arm a ${destination}: ${decision.disposition} ${decision.reason}`)
    assert.equal(decision.disposition, 'SHADOW')
    assert.equal(decision.reason, 'no_grant')
    for (const other of OUTBOUND_CONNECTORS) {
      if (other === destination) continue
      const crossed = { ...envFor(other, 'ok', undefined), [PRODUCER_CUTOFF_ENV[destination]]: '2026-01-01T00:00:00Z' }
      assert.equal(call(destination, OPERATION[destination].IMS, undefined, crossed), 'SHADOW', `${other}'s grant must not open ${destination}`)
    }
  }
})

test('arm b: a cut-off that is not strict ISO-8601 with Z is SHADOW with reason unreadable_cutoff, even in the past', () => {
  let examined = 0
  for (const destination of OUTBOUND_CONNECTORS) {
    for (const cutoff of CUTOFF_CASES.filter((c) => c.klass === 'malformed')) {
      const decision = explainProducerDisposition(destination, OPERATION[destination].IMS as never, undefined, { env: envFor(destination, 'ok', cutoff.value), now: NOW })
      examined += 1
      assert.equal(decision.disposition, 'SHADOW', `${destination} ${cutoff.label}`)
      assert.equal(decision.reason, 'unreadable_cutoff', `${destination} ${cutoff.label}`)
    }
  }
  console.log(`# arm b: ${examined} malformed cut-off cells examined`)
  assert.equal(examined, 3 * CUTOFF_CASES.filter((c) => c.klass === 'malformed').length)
  // The rig can find something: the same instants WITHOUT the offset or garbage ARE read, and Date.parse would read the offset ones.
  assert.ok(Number.isFinite(Date.parse('2026-01-01T00:00:00+01:00')), 'precondition: a lenient parser would accept the offset form')
  assert.equal(parseProducerCutoff('2026-01-01T00:00:00Z').ok, true)
})

test('arm c: a future instant is SHADOW until now >= cut-off, to the millisecond, not the calendar day', () => {
  const env = envFor('xero', 'ok', '2026-06-01T12:00:00.001Z')
  const op = OPERATION.xero.IMS
  const before = call('xero', op, LATE, env, new Date('2026-06-01T12:00:00.000Z'))
  const at = call('xero', op, LATE, env, new Date('2026-06-01T12:00:00.001Z'))
  const after = call('xero', op, LATE, env, new Date('2026-06-01T12:00:00.002Z'))
  console.log(`# arm c: before=${before} at=${at} after=${after}`)
  assert.deepEqual([before, at, after], ['SHADOW', 'LIVE', 'LIVE'])
  const sameDayLater = explainProducerDisposition('xero', op as never, LATE, { env: envFor('xero', 'ok', '2026-06-01T13:00:00Z'), now: NOW })
  assert.equal(sameDayLater.reason, 'before_cutoff')
  assert.equal(sameDayLater.phase, 'P1')
})

test('arm d: an operation IMS does not own is SHADOW even when fully granted and past the cut-off', () => {
  const env = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  const invoice = explainProducerDisposition('xero', 'sales.invoice', undefined, { env, now: NOW })
  console.log(`# arm d: xero.sales.invoice owner=${invoice.owner} phase=${invoice.phase} -> ${invoice.disposition} ${invoice.reason}`)
  assert.equal(invoice.phase, 'P2', 'precondition: the installation is in P2 for xero')
  assert.equal(invoice.owner, 'xeroom')
  assert.equal(invoice.disposition, 'SHADOW')
  assert.equal(invoice.reason, 'not_ims_owned')
  const unmapped = explainProducerDisposition('xero', 'no-such-operation' as never, undefined, { env, now: NOW })
  assert.equal(unmapped.reason, 'owner_unknown')
  const tax = explainProducerDisposition('xero', 'tax-rate', undefined, { env, now: NOW })
  assert.equal(tax.owner, 'unknown')
  assert.equal(tax.reason, 'owner_unknown')
  // Isolating arm: the same environment IS live for an IMS-owned operation.
  assert.equal(call('xero', 'purchase.bill', LATE, env), 'LIVE')
})

test('arm e: obligationAt before the cut-off is SHADOW; at the cut-off is LIVE; an unreadable obligationAt is SHADOW', () => {
  const env = envFor('mintsoft', 'ok', '2026-01-01T00:00:00Z')
  const op = OPERATION.mintsoft.IMS
  const cases: Array<[string, Date | undefined, string]> = [
    ['absent (row requires it)', undefined, 'SHADOW'],
    ['one ms before', new Date('2025-12-31T23:59:59.999Z'), 'SHADOW'],
    ['exactly at', CUTOFF_PAST, 'LIVE'],
    ['after', new Date('2026-03-01T00:00:00Z'), 'LIVE'],
    ['invalid date', new Date('x'), 'SHADOW'],
    ['not a date', '2026-03-01T00:00:00Z' as unknown as Date, 'SHADOW'],
  ]
  for (const [label, value, expected] of cases) {
    const decision = explainProducerDisposition('mintsoft', op as never, value, { env, now: NOW })
    console.log(`# arm e ${label}: ${decision.disposition} ${decision.reason}`)
    assert.equal(decision.disposition, expected, label)
  }
  assert.equal(explainProducerDisposition('mintsoft', op as never, new Date('2025-01-01T00:00:00Z'), { env, now: NOW }).reason, 'obligation_before_cutoff')
  assert.equal(explainProducerDisposition('mintsoft', op as never, new Date('x'), { env, now: NOW }).reason, 'unreadable_obligation')
})

test('arm f: a throwing environment, clock or obligationAt is SHADOW, and nothing propagates', () => {
  const throwingEnv = new Proxy({}, { get() { throw new Error('env read failed') }, has() { throw new Error('env read failed') }, getOwnPropertyDescriptor() { throw new Error('env read failed') }, ownKeys() { throw new Error('env read failed') } }) as Record<string, string | undefined>
  assert.throws(() => throwingEnv.ANYTHING, /env read failed/, 'precondition: the environment really throws')
  const throwingContext = (env: Record<string, string | undefined>) => ({ env, get now(): Date { throw new Error('clock failed') } })
  assert.throws(() => throwingContext({}).now, /clock failed/, 'precondition: the clock really throws')
  // A Proxy of a Date passes instanceof but has no time slot: reading it throws.
  const proxyDate = new Proxy(new Date(NOW), {})
  assert.ok(proxyDate instanceof Date)
  assert.throws(() => Date.prototype.getTime.call(proxyDate), TypeError, 'precondition: the obligation really throws when read')
  const liveEnv = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  for (const destination of OUTBOUND_CONNECTORS) {
    const op = OPERATION[destination].IMS as never
    const a = explainProducerDisposition(destination, op, undefined, { env: throwingEnv, now: NOW })
    const b = explainProducerDisposition(destination, op, LATE, throwingContext(envFor(destination, 'ok', '2026-01-01T00:00:00Z')))
    const c = explainProducerDisposition(destination, op, proxyDate, { env: envFor(destination, 'ok', '2026-01-01T00:00:00Z'), now: NOW })
    console.log(`# arm f ${destination}: env=${a.reason} clock=${b.reason} obligation=${c.reason}`)
    assert.deepEqual([a.disposition, b.disposition, c.disposition], ['SHADOW', 'SHADOW', 'SHADOW'])
    assert.deepEqual([a.reason, b.reason, c.reason], ['unreadable', 'unreadable', 'unreadable_obligation'])
    assert.equal(producerDisposition(destination, op, undefined, { env: throwingEnv }), 'SHADOW')
  }
  assert.equal(call('xero', 'purchase.bill', LATE, liveEnv), 'LIVE', 'isolating arm: the same inputs without the throw are LIVE')
  assert.equal(producerGrantCutoffAgreement('xero', throwingEnv).state, 'unreadable')
})

test('property: never throws, and never LIVE unless the cut-off is a strict instant and the grant is readable (seeded)', () => {
  let seed = 0x5eed
  const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const fragments = ['\t', '\u00a0', '\u200b', '.000000001', '.0001', '2026', '-', '01', 'T', ':', 'Z', 'z', '+', '00', '.', ',', ' ', '1', '9', 'x', '\n', '\u0000', '24', '60', '99', '2026-01-01T00:00:00', '0']
  const randomText = () => Array.from({ length: 1 + rand(10) }, () => fragments[rand(fragments.length)]).join('')
  const weirdValues: unknown[] = [undefined, null, 0, 1, NaN, {}, [], 'LIVE', true, () => 1]
  const STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/
  let live = 0
  let strict = 0
  let total = 0
  for (let i = 0; i < 4000; i++) {
    const destination = OUTBOUND_CONNECTORS[rand(3)]!
    const cutoffText = rand(3) === 0 ? (rand(2) ? ['', ' ', '\t', '\n'][rand(4)]! + '2026-01-01T00:00:00Z' + ['', ' ', '\t', '\n', '\u00a0', '\u200b'][rand(6)]! : '2026-01-01T00:00:00Z') : randomText()
    const grantMode = rand(2) ? 0 : rand(3)
    const env: Record<string, string | undefined> = { [PRODUCER_CUTOFF_ENV[destination]]: cutoffText }
    if (grantMode === 0) env[OUTBOUND_GRANT_ENV[destination]] = GRANT_VALUE[destination].ok
    if (grantMode === 1) env[OUTBOUND_GRANT_ENV[destination]] = randomText()
    const obligation = rand(5) === 0 ? (weirdValues[rand(weirdValues.length)] as Date | undefined) : (rand(5) === 0 ? undefined : new Date(rand(6) === 0 ? NaN : 1_800_000_000_000))
    const operation = rand(4) === 0 ? (weirdValues[rand(weirdValues.length)] as never) : (OPERATION[destination].IMS as never)
    let result: string
    assert.doesNotThrow(() => { result = producerDisposition(destination, operation, obligation, { env, now: rand(6) === 0 ? new Date(NaN) : NOW }) })
    result = producerDisposition(destination, operation, obligation, { env, now: NOW })
    total += 1
    if (STRICT.test(cutoffText)) strict += 1
    if (result === 'LIVE') {
      live += 1
      assert.ok(STRICT.test(cutoffText), `LIVE on a malformed cut-off: ${JSON.stringify(cutoffText)}`)
      assert.ok(obligation instanceof Date && !Number.isNaN(obligation.getTime()), 'LIVE on a required row without a valid obligationAt')
      assert.equal(grantMode, 0, 'LIVE without a readable grant')
    }
  }
  assert.equal(producerDisposition('nowhere' as never, 'x' as never, undefined, { env: {}, now: NOW }), 'SHADOW')
  assert.equal(producerDisposition(undefined as never, undefined as never), 'SHADOW')
  console.log(`# property: total=${total} strictCutoffs=${strict} live=${live}`)
  assert.ok(live > 0, 'the generator must reach LIVE at least once, or "never LIVE on malformed input" is vacuous')
})

test('grant/cut-off agreement: both absent held, both readable live, exactly one inconsistent, unreadable flagged', () => {
  const table: Array<[GrantCase, string | undefined, string]> = [
    ['absent', undefined, 'agreed_held'],
    ['ok', '2026-01-01T00:00:00Z', 'agreed_live'],
    ['ok', '2099-01-01T00:00:00Z', 'agreed_live'],
    ['ok', undefined, 'inconsistent'],
    ['absent', '2026-01-01T00:00:00Z', 'inconsistent'],
    ['unreadable', undefined, 'unreadable'],
    ['unreadable', '2026-01-01T00:00:00Z', 'unreadable'],
    ['ok', 'garbage', 'unreadable'],
    ['absent', 'garbage', 'unreadable'],
  ]
  let cells = 0
  for (const connector of OUTBOUND_CONNECTORS) {
    for (const [grant, cutoff, expected] of table) {
      const agreement = producerGrantCutoffAgreement(connector, envFor(connector, grant, cutoff))
      cells += 1
      assert.equal(agreement.state, expected, `${connector} grant=${grant} cutoff=${String(cutoff)}`)
      assert.ok(agreement.text.includes(connector === 'woocommerce' ? 'WooCommerce' : connector === 'mintsoft' ? 'Mintsoft' : 'Xero'))
      if (expected === 'inconsistent') assert.match(agreement.text, /INCONSISTENT/)
      // A state other than agreed_live is never LIVE.
      if (expected !== 'agreed_live') assert.equal(call(connector, OPERATION[connector].IMS, undefined, envFor(connector, grant, cutoff)), 'SHADOW')
    }
  }
  console.log(`# agreement: ${cells} cells`)
  assert.equal(cells, 3 * table.length)
})

/** A Date whose own getTime answers with `answer` (or throws), while its real time value is `real`. */
function spoofed(real: string, answer: unknown | 'throw'): Date {
  const date = new Date(real)
  ;(date as { getTime: () => unknown }).getTime = () => { if (answer === 'throw') throw new Error('getTime failed'); return answer }
  return date
}
const FAKE_ANSWERS: Array<[string, unknown]> = [['Infinity', Infinity], ['-Infinity', -Infinity], ['undefined', undefined], ['null', null], ['a string', '9999999999999'], ['NaN', NaN], ['throws', 'throw']]

test('arm j: an unreadable clock or obligationAt can never pass a time gate (non-finite, undefined, null, string, throwing, non-Date)', () => {
  const op = OPERATION.xero.IMS
  const env2099 = envFor('xero', 'ok', '2099-01-01T00:00:00Z')
  const envPast = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  let examined = 0
  for (const [label, answer] of FAKE_ANSWERS) {
    // now: a 2026 clock whose getTime lies, against a 2099 cut-off, must not be LIVE.
    const nowSpoof = spoofed('2026-06-01T12:00:00Z', answer)
    const a = explainProducerDisposition('xero', op as never, LATE, { env: env2099, now: nowSpoof })
    // obligationAt whose getTime lies, against a past cut-off with a real obligation time BEFORE it.
    const obligationSpoof = spoofed('2025-01-01T00:00:00Z', answer)
    const b = explainProducerDisposition('xero', op as never, obligationSpoof, { env: envPast, now: NOW })
    examined += 2
    console.log(`# arm j ${label}: now=${a.disposition}/${a.reason} obligation=${b.disposition}/${b.reason}`)
    assert.equal(a.disposition, 'SHADOW', `now getTime -> ${label}`)
    assert.equal(b.disposition, 'SHADOW', `obligationAt getTime -> ${label}`)
    assert.equal(b.reason, 'obligation_before_cutoff', `the REAL time value (2025) is what is read, not the lie (${label})`)
  }
  // Non-Date objects that merely quack like one.
  for (const fake of [{ getTime: () => 1e15 }, { getTime: () => Infinity }, Object.create(null), 1e15, '2099-01-01T00:00:00Z']) {
    const a = explainProducerDisposition('xero', op as never, LATE, { env: envPast, now: fake as unknown as Date })
    const b = explainProducerDisposition('xero', op as never, fake as unknown as Date, { env: envPast, now: NOW })
    examined += 2
    assert.deepEqual([a.disposition, a.reason, b.disposition, b.reason], ['SHADOW', 'unreadable', 'SHADOW', 'unreadable_obligation'])
  }
  // The infinity clock against a 2099 cut-off specifically (the reported bypass), with the real value in 2026.
  assert.equal(producerDisposition('xero', op as never, LATE, { env: env2099, now: spoofed('2026-06-01T12:00:00Z', Infinity) }), 'SHADOW')
  // Isolating arm: a genuine Date is read, and its real value decides (2100 clock whose getTime lies low is still LIVE: the lie is ignored).
  assert.equal(producerDisposition('xero', op as never, new Date('2100-01-01T00:00:00Z'), { env: env2099, now: spoofed('2100-01-01T00:00:00Z', -Infinity) }), 'LIVE')
  assert.equal(producerDisposition('xero', op as never, LATE, { env: envPast, now: NOW }), 'LIVE')
  console.log(`# arm j: ${examined} cells examined`)
  assert.equal(examined, FAKE_ANSWERS.length * 2 + 10)
})

test('arm k: a patched Date.prototype.getTime (installed AFTER import) cannot move the clock, the cut-off or the obligation time', () => {
  const original = Date.prototype.getTime
  const op = OPERATION.xero.IMS
  const env2099 = envFor('xero', 'ok', '2099-01-01T00:00:00Z')
  const envPast = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  const results: string[] = []
  try {
    Date.prototype.getTime = function patched(this: Date) { return 4_102_444_800_000 } // 2100-01-01, always finite
    assert.equal(new Date(NOW).getTime(), 4_102_444_800_000, 'precondition: the patch is in force')
    const clock = explainProducerDisposition('xero', op as never, LATE, { env: env2099, now: NOW })
    const obligation = explainProducerDisposition('xero', op as never, new Date('2025-01-01T00:00:00Z'), { env: envPast, now: NOW })
    const live = explainProducerDisposition('xero', op as never, LATE, { env: envPast, now: NOW })
    results.push(`clock=${clock.disposition}/${clock.reason}`, `obligation=${obligation.disposition}/${obligation.reason}`, `control=${live.disposition}`)
    assert.deepEqual([clock.disposition, clock.reason], ['SHADOW', 'before_cutoff'])
    assert.deepEqual([obligation.disposition, obligation.reason], ['SHADOW', 'obligation_before_cutoff'])
    assert.equal(live.disposition, 'LIVE', 'isolating arm: the intrinsic still reads real values, so a past cut-off is LIVE')
  } finally {
    Date.prototype.getTime = original
  }
  console.log(`# arm k: ${results.join(' ')}`)
  assert.equal(Date.prototype.getTime, original, 'the patch was restored')
})

test('arm l: only an ABSENT clock defaults to the current time; null, NaN, numbers, strings and objects are SHADOW unreadable', () => {
  const op = OPERATION.xero.IMS
  const env = envFor('xero', 'ok', '2020-01-01T00:00:00Z') // far in the past: a real clock would be LIVE
  const cases: Array<[string, unknown, string, string]> = [
    ['absent (key missing)', 'ABSENT', 'LIVE', 'live'],
    ['undefined', undefined, 'LIVE', 'live'],
    ['null', null, 'SHADOW', 'unreadable'],
    ['Invalid Date', new Date(NaN), 'SHADOW', 'unreadable'],
    ['number', 1_800_000_000_000, 'SHADOW', 'unreadable'],
    ['string', '2026-06-01T12:00:00Z', 'SHADOW', 'unreadable'],
    ['zero', 0, 'SHADOW', 'unreadable'],
    ['empty string', '', 'SHADOW', 'unreadable'],
    ['plain object', {}, 'SHADOW', 'unreadable'],
  ]
  for (const [label, now, disposition, reason] of cases) {
    const context = now === 'ABSENT' ? { env } : { env, now: now as Date }
    const decision = explainProducerDisposition('xero', op as never, LATE, context)
    console.log(`# arm l ${label}: ${decision.disposition}/${decision.reason}`)
    assert.deepEqual([decision.disposition, decision.reason], [disposition, reason], label)
  }
})

const TENANT_ENV = (destination: OutboundConnector) => envFor(destination, 'ok', '2026-01-01T00:00:00Z')

test('arm m: an INHERITED env (polluted Object.prototype, or a context whose prototype carries one) cannot change SHADOW to LIVE', () => {
  const op = OPERATION.xero.IMS
  const liveEnv = TENANT_ENV('xero')
  const names = [OUTBOUND_GRANT_ENV.xero, PRODUCER_CUTOFF_ENV.xero]
  const results: string[] = []
  try {
    ;(Object.prototype as Record<string, unknown>).env = liveEnv
    // The inherited property is really visible, so the guard below proves something.
    assert.equal(({} as { env?: unknown }).env, liveEnv, 'precondition: Object.prototype.env is polluted')
    const a = explainProducerDisposition('xero', op as never, LATE, { now: NOW })
    const b = explainProducerDisposition('xero', op as never, LATE, Object.create({ env: liveEnv, now: NOW }))
    results.push(`proto.env=${a.reason}`, `inherited context env=${b.reason}`)
    assert.deepEqual([a.disposition, b.disposition], ['SHADOW', 'SHADOW'])
  } finally {
    delete (Object.prototype as Record<string, unknown>).env
  }
  try {
    for (const name of names) (Object.prototype as Record<string, unknown>)[name] = liveEnv[name]
    assert.equal((process.env as Record<string, unknown>)[names[0]!], liveEnv[names[0]!], 'precondition: process.env sees the polluted prototype variable')
    const fromProcessEnv = explainProducerDisposition('xero', op as never, LATE, { now: NOW })
    const fromSuppliedEnv = explainProducerDisposition('xero', op as never, LATE, { env: {}, now: NOW })
    results.push(`process.env=${fromProcessEnv.reason}`, `supplied {}=${fromSuppliedEnv.reason}`)
    assert.deepEqual([fromProcessEnv.disposition, fromSuppliedEnv.disposition], ['SHADOW', 'SHADOW'])
    assert.equal(producerGrantCutoffAgreement('xero', {}).state, 'agreed_held', 'the agreement reader is not fooled either')
  } finally {
    for (const name of names) delete (Object.prototype as Record<string, unknown>)[name]
  }
  console.log(`# arm m: ${results.join(' ')}`)
  assert.equal(({} as { env?: unknown }).env, undefined, 'the pollution was removed')
  assert.equal(explainProducerDisposition('xero', op as never, LATE, { env: liveEnv, now: NOW }).disposition, 'LIVE', 'isolating arm: an OWN env is honoured')
})

test('arm n: an INHERITED clock is ignored; the real clock is used', () => {
  const op = OPERATION.xero.IMS
  const env2099 = envFor('xero', 'ok', '2099-01-01T00:00:00Z')
  const future = new Date('2100-01-01T00:00:00Z')
  try {
    ;(Object.prototype as Record<string, unknown>).now = future
    assert.equal(({} as { now?: unknown }).now, future, 'precondition: Object.prototype.now is polluted')
    const a = explainProducerDisposition('xero', op as never, LATE, { env: env2099 })
    const b = explainProducerDisposition('xero', op as never, LATE, Object.create({ now: future, env: env2099 }))
    console.log(`# arm n: ${a.disposition}/${a.reason} ${b.disposition}/${b.reason}`)
    assert.deepEqual([a.disposition, a.reason], ['SHADOW', 'before_cutoff'])
    assert.equal(b.disposition, 'SHADOW')
    assert.equal(explainProducerDisposition('xero', op as never, new Date('2101-01-01T00:00:00Z'), { env: env2099, now: future }).disposition, 'LIVE', 'isolating arm: an OWN clock in 2100 is LIVE')
  } finally {
    delete (Object.prototype as Record<string, unknown>).now
  }
})

test('arm o: only primitive strings are names and cut-offs; objects that coerce to valid ones are SHADOW invalid_input', () => {
  const coercing = (value: string) => ({ toString: () => value, valueOf: () => value, [Symbol.toPrimitive]: () => value })
  const env = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  const cases: Array<[string, unknown, unknown]> = [
    ['destination object', coercing('xero'), 'purchase.bill'],
    ['operation object', 'xero', coercing('purchase.bill')],
    ['destination array', ['xero'], 'purchase.bill'],
    ['operation array', 'xero', ['purchase.bill']],
    ['String object', new String('xero'), 'purchase.bill'],
    ['operation String object', 'xero', new String('purchase.bill')],
    ['number', 5, 6],
  ]
  for (const [label, destination, operation] of cases) {
    const decision = explainProducerDisposition(destination as never, operation as never, LATE, { env, now: NOW })
    console.log(`# arm o ${label}: ${decision.disposition}/${decision.reason}`)
    assert.deepEqual([decision.disposition, decision.reason], ['SHADOW', 'invalid_input'], label)
  }
  const objectCutoff = { ...env, [PRODUCER_CUTOFF_ENV.xero]: coercing('2026-01-01T00:00:00Z') as unknown as string }
  const cutoffDecision = explainProducerDisposition('xero', 'purchase.bill', LATE, { env: objectCutoff, now: NOW })
  console.log(`# arm o cut-off object: ${cutoffDecision.disposition}/${cutoffDecision.reason}`)
  assert.equal(cutoffDecision.disposition, 'SHADOW')
  assert.equal(parseProducerCutoff(coercing('2026-01-01T00:00:00Z') as unknown as string).ok, false)
  assert.equal(parseProducerCutoff(new String('2026-01-01T00:00:00Z') as unknown as string).ok, false)
  assert.equal(producerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW }), 'LIVE', 'isolating arm: the same names as primitive strings are LIVE')
})

test('arm p: patching Map.prototype.get AFTER import cannot forge an ownership row', async () => {
  const { ownershipRowFor } = await import('../../lib/security/writer-ownership-map.ts')
  const original = Map.prototype.get
  const env = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  try {
    Map.prototype.get = function forged() { return { destination: 'xero', operation: 'x', owners: { P0: 'nobody', P1: 'IMS', P2: 'IMS' }, obligationTime: 'not-applicable', note: 'forged' } } as never
    assert.ok(new Map().get('anything'), 'precondition: the patch is in force')
    const unmapped = explainProducerDisposition('xero', 'no-such-operation' as never, undefined, { env, now: NOW })
    const invoice = explainProducerDisposition('xero', 'sales.invoice', LATE, { env, now: NOW })
    console.log(`# arm p: unmapped=${unmapped.disposition}/${unmapped.reason} sales.invoice=${invoice.disposition}/${invoice.reason} row=${String(ownershipRowFor('xero', 'no-such-operation'))}`)
    assert.deepEqual([unmapped.disposition, unmapped.reason], ['SHADOW', 'owner_unknown'])
    assert.deepEqual([invoice.disposition, invoice.reason], ['SHADOW', 'not_ims_owned'])
    assert.equal(ownershipRowFor('xero', 'no-such-operation'), null)
  } finally {
    Map.prototype.get = original
  }
  assert.equal(Map.prototype.get, original)
  assert.equal(producerDisposition('xero', 'purchase.bill', LATE, { env, now: NOW }), 'LIVE', 'isolating arm: restored, an IMS row is LIVE')
})

/**
 * EVERY OWNER KIND RESOLVES THE SAME WAY: ONLY `IMS` CAN BE LIVE.
 * Named mutation (PR): treat one non-IMS owner kind (qoblex-native) as IMS in ownerShadowReason => red.
 */
test('every owner kind: only IMS may produce live; unknown is owner_unknown; every other kind is not_ims_owned', () => {
  const resolved = WRITER_OWNERS.map((owner) => `${owner}=${String(ownerShadowReason(owner))}`)
  console.log(`# owner kinds: ${WRITER_OWNERS.length}: ${resolved.join(' ')}`)
  assert.ok(WRITER_OWNERS.length >= 11, 'precondition: the owner list was read')
  let imsKinds = 0
  let notImsOwned = 0
  for (const owner of WRITER_OWNERS) {
    const reason = ownerShadowReason(owner)
    if (owner === 'IMS') { assert.equal(reason, null); imsKinds += 1 } else if (owner === 'unknown') assert.equal(reason, 'owner_unknown')
    else { assert.equal(reason, 'not_ims_owned', owner); notImsOwned += 1 }
  }
  console.log(`# owner kinds: ims=${imsKinds} unknown=1 not_ims_owned=${notImsOwned}`)
  assert.equal(imsKinds, 1)
  assert.equal(notImsOwned, WRITER_OWNERS.length - 2)
  for (const kind of ['operator-manual', 'qoblex-native', 'aelia', 'woocommerce-native']) {
    assert.equal(ownerShadowReason(kind as never), 'not_ims_owned', `${kind} is a writer IMS must not duplicate`)
  }
})

test('every connector row, every phase: the decision reports that phase\'s owner and is LIVE only where P2 is IMS', () => {
  const rows = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).filter((row) => (OUTBOUND_CONNECTORS as readonly string[]).includes(row.destination))
  const seenKinds = new Set<string>()
  let cells = 0
  let live = 0
  for (const row of rows) {
    const destination = row.destination as OutboundConnector
    const operation = row.operation as never
    const held = explainProducerDisposition(destination, operation, LATE, { env: envFor(destination, 'absent', undefined), now: NOW })
    const beforeCutoff = explainProducerDisposition(destination, operation, LATE, { env: envFor(destination, 'ok', '2026-12-01T00:00:00Z'), now: NOW })
    const p2 = explainProducerDisposition(destination, operation, LATE, { env: envFor(destination, 'ok', '2026-01-01T00:00:00Z'), now: NOW })
    for (const decision of [held, beforeCutoff]) {
      assert.equal(decision.disposition, 'SHADOW', `${destination}.${row.operation} P1`)
      assert.equal(decision.phase, 'P1')
      assert.equal(decision.owner, row.owners.P1, `${destination}.${row.operation} P1 owner`)
    }
    assert.equal(p2.phase, 'P2')
    assert.equal(p2.owner, row.owners.P2)
    const expectedLive = row.owners.P2 === 'IMS'
    assert.equal(p2.disposition, expectedLive ? 'LIVE' : 'SHADOW', `${destination}.${row.operation} P2`)
    if (!expectedLive) assert.equal(p2.reason, ownerShadowReason(row.owners.P2))
    seenKinds.add(row.owners.P1); seenKinds.add(row.owners.P2)
    cells += 3
    if (p2.disposition === 'LIVE') live += 1
  }
  console.log(`# rows=${rows.length} cells=${cells} live=${live} owner kinds in use: ${[...seenKinds].sort().join(',')}`)
  assert.ok(rows.length > 25, 'precondition: connector rows were read')
  for (const kind of ['operator-manual', 'qoblex-native', 'aelia']) assert.ok(seenKinds.has(kind), `${kind} is used by a connector row`)
  assert.equal(live, rows.filter((row) => row.owners.P2 === 'IMS').length)
})
