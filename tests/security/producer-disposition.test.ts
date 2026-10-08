import assert from 'node:assert/strict'
import test from 'node:test'

import {
  explainProducerDisposition,
  parseProducerCutoff,
  producerDisposition,
  producerGrantCutoffAgreement,
} from '../../lib/security/producer-disposition.ts'
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
  { label: 'blank', value: '   ', klass: 'absent' },
  { label: 'future', value: '2026-12-01T00:00:00Z', klass: 'future' },
  { label: 'past', value: '2026-01-01T00:00:00Z', klass: 'past', at: new Date('2026-01-01T00:00:00Z') },
  { label: 'past, fraction', value: '2026-01-01T00:00:00.250Z', klass: 'past', at: new Date('2026-01-01T00:00:00.250Z') },
  { label: 'past, minutes only', value: '2026-01-01T00:00Z', klass: 'past', at: new Date('2026-01-01T00:00:00Z') },
  { label: 'earlier today (same calendar day)', value: '2026-06-01T11:00:00Z', klass: 'past', at: new Date('2026-06-01T11:00:00Z') },
  { label: 'later today (same calendar day)', value: '2026-06-01T13:00:00Z', klass: 'future' },
  { label: 'garbage', value: 'soon', klass: 'malformed' },
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

function envFor(destination: OutboundConnector, grant: GrantCase, cutoff: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  if (grant !== 'absent') env[OUTBOUND_GRANT_ENV[destination]] = GRANT_VALUE[destination][grant]
  if (cutoff !== undefined) env[PRODUCER_CUTOFF_ENV[destination]] = cutoff
  return env
}

function oracleLive(grant: GrantCase, cutoff: CutoffCase, owner: OwnerCase, obligation: ObligationCase): boolean {
  return grant === 'ok'
    && cutoff.klass === 'past'
    && owner === 'IMS'
    && cutoff.at !== undefined
    && (obligation.value === undefined || (!Number.isNaN(obligation.value.getTime()) && obligation.value.getTime() >= cutoff.at.getTime()))
}

const call = (destination: OutboundConnector, operation: string, obligationAt: Date | undefined, env: Record<string, string | undefined>, now: Date = NOW) =>
  producerDisposition(destination, operation as never, obligationAt, { env, now })

test('truth table: LIVE in exactly the allowed cells, over grant x cut-off x owner x obligationAt x destination', () => {
  const grants: GrantCase[] = ['ok', 'absent', 'unreadable']
  const owners: OwnerCase[] = ['IMS', 'other', 'unknown']
  let cells = 0
  let live = 0
  let expectedLive = 0
  const wrong: string[] = []
  for (const destination of OUTBOUND_CONNECTORS) {
    for (const grant of grants) for (const cutoff of CUTOFF_CASES) for (const owner of owners) for (const obligation of OBLIGATION_CASES) {
      const actual = call(destination, OPERATION[destination][owner], obligation.value, envFor(destination, grant, cutoff.value))
      const expected = oracleLive(grant, cutoff, owner, obligation) ? 'LIVE' : 'SHADOW'
      cells += 1
      if (actual === 'LIVE') live += 1
      if (expected === 'LIVE') expectedLive += 1
      if (actual !== expected) wrong.push(`${destination} grant=${grant} cutoff=${cutoff.label} owner=${owner} obligation=${obligation.label}: got ${actual}, want ${expected}`)
    }
  }
  console.log(`# precondition: cells=${cells} live=${live} expectedLive=${expectedLive}`)
  assert.equal(cells, 3 * 3 * CUTOFF_CASES.length * 3 * OBLIGATION_CASES.length)
  // Derived by hand, not from the oracle: per destination, 3 past cut-offs (Jan 2026) x {absent, 2026-03-01} + the
  // 'earlier today' cut-off x {absent} = 3 x 2 + 1 = 7; three destinations = 21.
  assert.equal(expectedLive, 21)
  assert.ok(expectedLive > 0, 'the table must contain LIVE cells, or "LIVE only in the allowed cells" is vacuous')
  assert.deepEqual(wrong, [])
  assert.equal(live, expectedLive)
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
  const before = call('xero', op, undefined, env, new Date('2026-06-01T12:00:00.000Z'))
  const at = call('xero', op, undefined, env, new Date('2026-06-01T12:00:00.001Z'))
  const after = call('xero', op, undefined, env, new Date('2026-06-01T12:00:00.002Z'))
  console.log(`# arm c: before=${before} at=${at} after=${after}`)
  assert.deepEqual([before, at, after], ['SHADOW', 'LIVE', 'LIVE'])
  const sameDayLater = explainProducerDisposition('xero', op as never, undefined, { env: envFor('xero', 'ok', '2026-06-01T13:00:00Z'), now: NOW })
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
  assert.equal(call('xero', 'purchase.bill', undefined, env), 'LIVE')
})

test('arm e: obligationAt before the cut-off is SHADOW; at the cut-off is LIVE; an unreadable obligationAt is SHADOW', () => {
  const env = envFor('mintsoft', 'ok', '2026-01-01T00:00:00Z')
  const op = OPERATION.mintsoft.IMS
  const cases: Array<[string, Date | undefined, string]> = [
    ['absent', undefined, 'LIVE'],
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

test('arm f: a throwing environment or clock is SHADOW with reason unreadable, and nothing propagates', () => {
  const throwingEnv = new Proxy({}, { get() { throw new Error('env read failed') }, has() { throw new Error('env read failed') }, ownKeys() { throw new Error('env read failed') } }) as Record<string, string | undefined>
  assert.throws(() => throwingEnv.ANYTHING, /env read failed/, 'precondition: the environment really throws')
  const throwingNow = new Date(NOW) as Date
  throwingNow.getTime = () => { throw new Error('clock failed') }
  assert.throws(() => throwingNow.getTime(), /clock failed/, 'precondition: the clock really throws')
  const liveEnv = envFor('xero', 'ok', '2026-01-01T00:00:00Z')
  for (const destination of OUTBOUND_CONNECTORS) {
    const op = OPERATION[destination].IMS as never
    const a = explainProducerDisposition(destination, op, undefined, { env: throwingEnv, now: NOW })
    const b = explainProducerDisposition(destination, op, undefined, { env: envFor(destination, 'ok', '2026-01-01T00:00:00Z'), now: throwingNow })
    const brokenObligation = new Date(NOW)
    brokenObligation.getTime = () => { throw new Error('obligation failed') }
    const c = explainProducerDisposition(destination, op, brokenObligation, { env: envFor(destination, 'ok', '2026-01-01T00:00:00Z'), now: NOW })
    console.log(`# arm f ${destination}: env=${a.reason} clock=${b.reason} obligation=${c.reason}`)
    assert.deepEqual([a.disposition, b.disposition, c.disposition], ['SHADOW', 'SHADOW', 'SHADOW'])
    assert.deepEqual([a.reason, b.reason, c.reason], ['unreadable', 'unreadable', 'unreadable'])
    assert.equal(producerDisposition(destination, op, undefined, { env: throwingEnv }), 'SHADOW')
  }
  assert.equal(call('xero', 'purchase.bill', undefined, liveEnv), 'LIVE', 'isolating arm: the same inputs without the throw are LIVE')
  assert.equal(producerGrantCutoffAgreement('xero', throwingEnv).state, 'unreadable')
})

test('property: never throws, and never LIVE unless the cut-off is a strict instant and the grant is readable (seeded)', () => {
  let seed = 0x5eed
  const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const fragments = ['2026', '-', '01', 'T', ':', 'Z', 'z', '+', '00', '.', ',', ' ', '1', '9', 'x', '\n', '\u0000', '24', '60', '99', '2026-01-01T00:00:00', '0']
  const randomText = () => Array.from({ length: 1 + rand(10) }, () => fragments[rand(fragments.length)]).join('')
  const weirdValues: unknown[] = [undefined, null, 0, 1, NaN, {}, [], 'LIVE', true, () => 1]
  const STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/
  let live = 0
  let strict = 0
  let total = 0
  for (let i = 0; i < 4000; i++) {
    const destination = OUTBOUND_CONNECTORS[rand(3)]!
    const cutoffText = rand(5) === 0 ? '2026-01-01T00:00:00Z' : randomText()
    const grantMode = rand(3)
    const env: Record<string, string | undefined> = { [PRODUCER_CUTOFF_ENV[destination]]: cutoffText }
    if (grantMode === 0) env[OUTBOUND_GRANT_ENV[destination]] = GRANT_VALUE[destination].ok
    if (grantMode === 1) env[OUTBOUND_GRANT_ENV[destination]] = randomText()
    const obligation = rand(4) === 0 ? (weirdValues[rand(weirdValues.length)] as Date | undefined) : (rand(2) ? new Date(rand(2) ? 1_800_000_000_000 : NaN) : undefined)
    const operation = rand(4) === 0 ? (weirdValues[rand(weirdValues.length)] as never) : (OPERATION[destination].IMS as never)
    let result: string
    assert.doesNotThrow(() => { result = producerDisposition(destination, operation, obligation, { env, now: rand(6) === 0 ? new Date(NaN) : NOW }) })
    result = producerDisposition(destination, operation, obligation, { env, now: NOW })
    total += 1
    if (STRICT.test(cutoffText)) strict += 1
    if (result === 'LIVE') {
      live += 1
      assert.ok(STRICT.test(cutoffText.trim()), `LIVE on a malformed cut-off: ${JSON.stringify(cutoffText)}`)
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
