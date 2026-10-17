import assert from 'node:assert/strict'
import test from 'node:test'

import { createdBeforeCutoffFloor, producerCutoffFloor } from '../../lib/security/producer-seam.ts'
import {
  PRODUCER_CUTOFF_ENV,
  PRODUCER_HOLD_ENFORCED_ENV,
  PRODUCER_UNKNOWN_OUTCOME_PREFIX,
  producerBeforeCutoffNotice,
  producerRetiredShadowNotice,
  producerUnknownOutcomeNotice,
} from '../../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_CONNECTORS, OUTBOUND_GRANT_ENV, outboundHeldMessage } from '../../lib/security/outbound-write-hold-constants.ts'
import { xeroBeforeCutoffRefusal, xeroNotBeforeCutoffWhere } from '../../lib/domain/accounting/xero-producer-seam.ts'
import { outboxBeforeCutoffWhere, outboxRowBeforeCutoff } from '../../lib/domain/integrations/outbox.ts'
import {
  classifyWmsPushLink,
  classifyOutboxJob,
  classifyXeroSyncRow,
  resolveRetirementCutoffs,
} from '../../lib/domain/outbound-shadow/retire-held-backlog.ts'
import { clampRecreateWindowToCutoff } from '../../lib/domain/accounting/daily-batch-retention.ts'
import { unconditionalMoneySentences, unlicensedHistoryClaims } from '../helpers/unconditional-instruction.ts'

/**
 * THE WRITER-SIDE CUT-OFF: THE SHARED FLOOR, ITS TWO QUERY FRAGMENTS AND THE RETIREMENT'S PROOFS.
 *
 * The floor is the one answer every claim, selection and re-queue asks (lib/security/producer-seam.ts producerCutoffFloor). It is
 * non-null ONLY when the hold is enforced for the destination AND the destination is in its live phase. These tests pin that, the
 * fail-closed reading of a row's creation time, and the exact fragments the queries spread (empty when there is no floor, so the
 * legacy query is untouched).
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  a  floor-without-enforcement   the floor ignores the enforcement switch: the "switch off is byte-identical" arm goes red
 *  b  floor-in-the-held-phase     the floor is returned before the instant is reached: the held-phase arm goes red
 *  c  retirement-ignores-the-stamp  classifyXeroSyncRow forgets remoteAttemptedAt on a money row: the "maybe-sent is PARKED" arm goes red
 *  e  outbox-fragment-forgets-internal  the outbox fragment also matches internal operations: the internal-operation arm goes red
 */

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const NOW = new Date('2026-12-02T12:00:00Z')
const CUTOFF = '2026-12-01T00:00:00Z'
const live = (extra: Record<string, string> = {}) => ({
  [PRODUCER_HOLD_ENFORCED_ENV]: 'xero',
  [OUTBOUND_GRANT_ENV.xero]: TENANT,
  [PRODUCER_CUTOFF_ENV.xero]: CUTOFF,
  ...extra,
})

test('the floor exists only when the hold is enforced AND the destination is in its live phase; every other posture reads null (no filter at all)', () => {
  const cases: Array<[string, Record<string, string>, Date, boolean]> = [
    ['switch off, fully granted', { [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: CUTOFF }, NOW, false],
    ['enforced, nothing set (the held phase)', { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, NOW, false],
    ['enforced, cut-off without a grant', { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [PRODUCER_CUTOFF_ENV.xero]: CUTOFF }, NOW, false],
    ['enforced, grant without a cut-off', { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero', [OUTBOUND_GRANT_ENV.xero]: TENANT }, NOW, false],
    ['enforced, both, but the instant is in the future', live(), new Date('2026-11-30T00:00:00Z'), false],
    ['enforced, both, unreadable cut-off', live({ [PRODUCER_CUTOFF_ENV.xero]: '2026-12-01' }), NOW, false],
    ['enforced for a DIFFERENT destination', live({ [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce' }), NOW, false],
    ['enforced, both, instant reached', live(), NOW, true],
    ['enforced for all, both, instant reached', live({ [PRODUCER_HOLD_ENFORCED_ENV]: 'all' }), NOW, true],
    ['a typo in the switch enforces every destination, instant reached', live({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xerro' }), NOW, true],
  ]
  let live2 = 0
  for (const [label, env, now, expectFloor] of cases) {
    const floor = producerCutoffFloor('xero', { env, now })
    console.log(`# floor ${label}: ${floor ? floor.toISOString() : 'null'}`)
    if (expectFloor) { assert.equal(floor?.toISOString(), '2026-12-01T00:00:00.000Z', label); live2 += 1 } else assert.equal(floor, null, label)
  }
  assert.equal(live2, 3, 'precondition: the arms that expect a floor were reached')
  for (const connector of OUTBOUND_CONNECTORS.filter((c) => c !== 'xero')) {
    assert.equal(producerCutoffFloor(connector, { env: live(), now: NOW }), null, `${connector} is not enforced: no floor`)
  }
})

test('a row\'s creation time is read fail-closed: no floor never refuses; with a floor an unreadable time is "before"', () => {
  const floor = new Date(CUTOFF)
  assert.equal(createdBeforeCutoffFloor(new Date('2026-11-30T23:59:59.999Z'), floor), true)
  assert.equal(createdBeforeCutoffFloor(new Date(CUTOFF), floor), false, 'created AT the instant is not before it')
  assert.equal(createdBeforeCutoffFloor(new Date('2026-12-01T00:00:00.001Z'), floor), false)
  assert.equal(createdBeforeCutoffFloor(new Date('2020-01-01T00:00:00Z'), null), false, 'no floor: never')
  assert.equal(createdBeforeCutoffFloor(undefined, floor), true, 'a missing row is not a post-cut-off row')
  assert.equal(createdBeforeCutoffFloor(null, floor), true)
  assert.equal(createdBeforeCutoffFloor(new Date(Number.NaN), floor), true)
})

test('Xero: the refusal sentence and the where-fragment agree, exempt a PDF fetch and an e-mail, and are absent without a floor', () => {
  const before = new Date('2026-11-01T00:00:00Z')
  const env = live()
  assert.equal(xeroBeforeCutoffRefusal({ createdAt: before, type: 'BILL_PAYMENT' }, { env, now: NOW }) !== null, true)
  assert.equal(xeroBeforeCutoffRefusal({ createdAt: new Date('2026-12-01T00:00:00Z'), type: 'BILL_PAYMENT' }, { env, now: NOW }), null)
  assert.equal(xeroBeforeCutoffRefusal({ createdAt: before, type: 'INVOICE_PDF' }, { env, now: NOW }), null, 'a GET of a PDF is not a write')
  assert.equal(xeroBeforeCutoffRefusal({ createdAt: before, type: 'INVOICE_EMAIL' }, { env, now: NOW }), null)
  assert.notEqual(xeroBeforeCutoffRefusal({ createdAt: before }, { env, now: NOW }), null, 'an unknown type is treated as a write')
  assert.equal(xeroBeforeCutoffRefusal({ createdAt: before, type: 'BILL_PAYMENT' }, { env: {}, now: NOW }), null, 'switch off: nothing is refused')
  assert.deepEqual(xeroNotBeforeCutoffWhere(null), {}, 'no floor: the spread adds nothing')
  const fragment = xeroNotBeforeCutoffWhere(new Date(CUTOFF)) as { NOT: { createdAt: { lt: Date }; type: { notIn: string[] } } }
  assert.equal(fragment.NOT.createdAt.lt.toISOString(), '2026-12-01T00:00:00.000Z')
  assert.deepEqual([...fragment.NOT.type.notIn].sort(), ['INVOICE_EMAIL', 'INVOICE_PDF'])
  const text = xeroBeforeCutoffRefusal({ createdAt: before, type: 'BILL_PAYMENT' }, { env, now: NOW })!
  assert.deepEqual(unconditionalMoneySentences(text), [], text)
  assert.match(text, /check Xero before acting/)
  assert.match(text, /^Not sent by IMS: this was queued before writes to Xero went live on this installation \(2026-12-01T00:00:00\.000Z\)/)
})

test('Outbox: the fragment names each enforced-and-live connector once, exempts internal operations, and is null without a floor', () => {
  assert.equal(outboxBeforeCutoffWhere({ now: NOW }), null, 'nothing is enforced in this process: no fragment')
  const saved = { ...process.env }
  try {
    process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'woocommerce,mintsoft'
    process.env[OUTBOUND_GRANT_ENV.woocommerce] = 'https://shop.example.test'
    process.env[PRODUCER_CUTOFF_ENV.woocommerce] = CUTOFF
    process.env[OUTBOUND_GRANT_ENV.mintsoft] = 'https://wms.example.test|89'
    process.env[PRODUCER_CUTOFF_ENV.mintsoft] = '2026-12-01T06:00:00Z'
    const fragment = outboxBeforeCutoffWhere({ now: NOW }) as { OR: Array<{ connector: string; createdAt: { lt: Date }; operation?: { notIn: string[] } }> }
    console.log(`# outbox fragment: ${JSON.stringify(fragment)}`)
    assert.deepEqual(fragment.OR.map((clause) => clause.connector).sort(), ['mintsoft', 'woocommerce'])
    const mintsoft = fragment.OR.find((clause) => clause.connector === 'mintsoft')!
    assert.deepEqual(mintsoft.operation?.notIn, ['inbound.booked-in'], 'a local effect is never matched')
    assert.equal(mintsoft.createdAt.lt.toISOString(), '2026-12-01T06:00:00.000Z', 'each connector has its own instant')
    const wc = fragment.OR.find((clause) => clause.connector === 'woocommerce')!
    assert.equal(wc.operation, undefined, 'every woocommerce operation is a vendor write')
    // The same rule on one row.
    const row = { connector: 'woocommerce', operation: 'stock.push', createdAt: new Date('2026-11-01T00:00:00Z') }
    assert.equal(outboxRowBeforeCutoff(row, { now: NOW })?.toISOString(), '2026-12-01T00:00:00.000Z')
    assert.equal(outboxRowBeforeCutoff({ ...row, createdAt: new Date('2026-12-01T00:00:01Z') }, { now: NOW }), null)
    assert.equal(outboxRowBeforeCutoff({ ...row, connector: 'mintsoft', operation: 'inbound.booked-in' }, { now: NOW }), null, 'internal operation')
    assert.equal(outboxRowBeforeCutoff({ ...row, connector: 'accounting', operation: 'landed-cost.adjustment-journal' }, { now: NOW }), null, 'not a destination')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test('retirement cut-offs: an explicit instant wins; otherwise the destination\'s own variable, only when readable', () => {
  const explicit = new Date('2026-05-01T00:00:00Z')
  const got = resolveRetirementCutoffs({ xero: explicit }, { [PRODUCER_CUTOFF_ENV.xero]: CUTOFF, [PRODUCER_CUTOFF_ENV.woocommerce]: CUTOFF, [PRODUCER_CUTOFF_ENV.mintsoft]: 'next tuesday' })
  assert.equal(got.xero?.toISOString(), explicit.toISOString())
  assert.equal(got.woocommerce?.toISOString(), '2026-12-01T00:00:00.000Z')
  assert.equal(got.mintsoft, undefined, 'an unreadable variable selects nothing')
})

// ---------------------------------------------------------------------------------------------
// The retirement's proofs. SHADOW needs a positive record; everything else is PARKED.
// ---------------------------------------------------------------------------------------------

const LONG_AGO = new Date('2026-09-01T00:00:00Z')
const xeroRow = (over: Partial<Parameters<typeof classifyXeroSyncRow>[0]> = {}) => ({
  type: 'STOCK_RECEIPT', status: 'PENDING', externalTransactionId: null, createDispatchedAt: null, attemptRevision: 0, retryCount: 0,
  remoteAttemptedAt: null, attemptStampingCustodyAt: LONG_AGO, claimStartedAt: null, ...over,
})

test('Xero retirement: SHADOW only on a positive record that nothing was attempted; every maybe-sent row is PARKED', () => {
  const shadow = (row: ReturnType<typeof xeroRow>) => classifyXeroSyncRow(row, NOW).disposition
  assert.equal(shadow(xeroRow()), 'SHADOW', 'never claimed, in custody, no retry')
  assert.equal(shadow(xeroRow({ attemptStampingCustodyAt: null })), 'PARK', 'revision 0 on a row an old binary handled proves nothing')
  assert.equal(shadow(xeroRow({ attemptRevision: 1 })), 'PARK', 'a claim has been taken')
  assert.equal(shadow(xeroRow({ retryCount: 2 })), 'PARK', 'a retry was counted')
  assert.equal(shadow(xeroRow({ externalTransactionId: 'X-1' })), 'PARK', 'a document id')
  assert.equal(shadow(xeroRow({ createDispatchedAt: LONG_AGO })), 'PARK', 'a create was dispatched')
  assert.equal(shadow(xeroRow({ status: 'PROCESSING', claimStartedAt: LONG_AGO })), 'PARK', 'a stale claim of a non-money row has no stamp to vouch for it')
  // A money row is vouched for by the stamp, claimed or not.
  const money = xeroRow({ type: 'BILL_PAYMENT', attemptRevision: 3, retryCount: 1 })
  assert.equal(shadow(money), 'SHADOW', 'a money row in custody with no remote attempt recorded')
  assert.equal(shadow({ ...money, remoteAttemptedAt: LONG_AGO }), 'PARK', 'MAYBE-SENT: the stamp is set, so it is PARKED, never shadowed')
  assert.equal(shadow({ ...money, attemptStampingCustodyAt: null }), 'PARK', 'no custody: absence of a stamp is not proof')
  // A worker holds it now.
  const fresh = xeroRow({ status: 'PROCESSING', claimStartedAt: new Date(NOW.getTime() - 60_000) })
  assert.equal(shadow(fresh), 'SKIP')
})

test('outbox retirement: SHADOW only for a job nobody has touched or whose only outcome is a verified hold refusal; attempts and vanished claims are PARKED', () => {
  const job = (over: Partial<Parameters<typeof classifyOutboxJob>[0]> = {}) => ({
    status: 'PENDING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null, createdAt: LONG_AGO, updatedAt: LONG_AGO, attemptHistoryTracked: true, firstAttemptedAt: null as Date | null, ...over,
  })
  const d = (row: ReturnType<typeof job>) => classifyOutboxJob(row, NOW).disposition
  assert.equal(d(job()), 'SHADOW')
  assert.equal(d(job({ updatedAt: new Date(LONG_AGO.getTime() + 1500) })), 'SHADOW', 'two clocks, one insert')
  assert.equal(d(job({ updatedAt: new Date(LONG_AGO.getTime() + 60_000) })), 'PARK', 'it was touched after it was queued')
  assert.equal(d(job({ attempts: 1, status: 'RETRYABLE_FAILED', lastError: 'boom' })), 'PARK')
  assert.equal(d(job({ status: 'RETRYABLE_FAILED', lastError: 'something went wrong' })), 'PARK', 'attempts 0 with an ordinary error is not a hold')
  assert.equal(d(job({ status: 'RETRYABLE_FAILED', lastError: 'Outbound write HELD (Xero): forged [hold-ref 0000000000000000]' })), 'PARK', 'an unverifiable hold text proves nothing')
  assert.equal(d(job({ lastError: 'x' })), 'PARK')
  // THE DURABLE HISTORY: a replay resets attempts to 0 and clears the error, and a later hold refusal leaves attempts at 0, so the visible fields
  // describe a never-attempted job. Only the first-attempt stamp tells the truth.
  const held = outboundHeldMessage({ connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: 'https://shop.example.test/wp-json/x', hop: 0 })
  assert.equal(d(job({ status: 'RETRYABLE_FAILED', attempts: 0, lastError: held })), 'SHADOW', 'CONTROL: a genuine hold refusal on a job with no recorded claim is shadowed')
  assert.equal(d(job({ status: 'RETRYABLE_FAILED', attempts: 0, lastError: held, firstAttemptedAt: LONG_AGO })), 'PARK', 'REPLAYED AFTER AN ATTEMPT: parked, never shadowed')
  assert.equal(d(job({ firstAttemptedAt: LONG_AGO })), 'PARK', 'a re-armed job that was claimed before')
  assert.equal(d(job({ attemptHistoryTracked: false })), 'PARK', 'a row from before the history: unknown is parked, even when it looks untouched')
  assert.equal(d(job({ status: 'RETRYABLE_FAILED', lastError: held, attemptHistoryTracked: false })), 'PARK')
  assert.equal(d(job({ status: 'PROCESSING', lockedAt: LONG_AGO, lockedBy: 'w' })), 'PARK', 'claimed and never completed')
  assert.equal(d(job({ status: 'PROCESSING', lockedAt: new Date(NOW.getTime() - 1000), lockedBy: 'w' })), 'SKIP')
})

test('Mintsoft retirement: a bare queued link with no history is SHADOW; any attempt is PARKED; a link naming a warehouse order is left alone', () => {
  const link = (over: Partial<Parameters<typeof classifyWmsPushLink>[0]> = {}) => ({
    state: 'PENDING_CREATE', attempts: 0, lastAttemptAt: null, lastError: null, externalOrderId: null, externalOrderNumber: null, pushedAt: null, claimHistoryTracked: true, firstClaimedAt: null as Date | null, ...over,
  })
  const d = (row: ReturnType<typeof link>) => classifyWmsPushLink(row).disposition
  assert.equal(d(link()), 'SHADOW')
  assert.equal(d(link({ attempts: 1 })), 'PARK')
  assert.equal(d(link({ firstClaimedAt: LONG_AGO })), 'PARK', 'a release or replay cleared attempts and the attempt time, but not the durable claim')
  assert.equal(d(link({ claimHistoryTracked: false })), 'PARK', 'a link from before the history: unknown is parked')
  assert.equal(d(link({ lastAttemptAt: LONG_AGO })), 'PARK')
  assert.equal(d(link({ lastError: 'timeout' })), 'PARK')
  assert.equal(d(link({ externalOrderId: 'M-9' })), 'SKIP')
  assert.equal(d(link({ pushedAt: LONG_AGO })), 'SKIP')
  assert.equal(d(link({ state: 'SYNCED' })), 'SKIP')
})

test('the retirement sentences: a shadow names its proof and still says nothing about the destination; a parked row claims nothing was or was not sent', () => {
  for (const connector of OUTBOUND_CONNECTORS) {
    const retired = producerRetiredShadowNotice({ connector, proof: 'it has not been claimed or changed since it was queued' })
    const parked = producerUnknownOutcomeNotice({ connector, why: 'The record does not show it was never sent: 1 attempt(s) were counted against it and it was not completed.' })
    const queued = producerBeforeCutoffNotice({ connector, cutoff: new Date(CUTOFF) })
    for (const text of [retired, parked, queued]) {
      assert.deepEqual(unconditionalMoneySentences(text), [], text)
      assert.match(text, /check \w+ before acting/)
    }
    // Only the retired shadow may say IMS made no attempt, and only with its proof in the same sentence.
    assert.deepEqual(unlicensedHistoryClaims(parked, null), [], `a parked row makes no history claim: ${parked}`)
    assert.deepEqual(unlicensedHistoryClaims(queued, null), [], queued)
    assert.ok(parked.includes(`${PRODUCER_UNKNOWN_OUTCOME_PREFIX} ${connector === 'woocommerce' ? 'WooCommerce' : connector === 'xero' ? 'Xero' : 'Mintsoft'} before acting`), parked)
    assert.ok(!/made no attempt/.test(parked) && !/never sent/.test(parked.replace('was never sent:', '')), 'a parked row never says nothing was sent')
  }
  // The checker CAN fail: the dishonest wording is caught.
  assert.ok(unlicensedHistoryClaims('This was never sent to Xero.', null).length > 0, 'precondition: the history-claim checker finds the dishonest shape')
})

test('the recreate window is clamped to the cut-off: the later of the retention bound and the floor; no floor returns the window itself', () => {
  const retention = new Date('2026-06-01T00:00:00Z')
  const floor = new Date(CUTOFF)
  const base = { cutoff: retention, dateFilter: { gte: retention } as { gte: Date } | { not: null } }
  assert.equal(clampRecreateWindowToCutoff(base, null), base, 'no floor: the SAME object, so the legacy window is untouched')
  assert.deepEqual(clampRecreateWindowToCutoff(base, floor), { cutoff: floor, dateFilter: { gte: floor } })
  const recent = new Date('2026-12-02T00:00:00Z')
  assert.deepEqual(clampRecreateWindowToCutoff({ cutoff: recent, dateFilter: { gte: recent } }, floor), { cutoff: recent, dateFilter: { gte: recent } }, 'a retention bound later than the floor wins')
  assert.deepEqual(clampRecreateWindowToCutoff({ cutoff: null, dateFilter: { not: null } }, floor), { cutoff: floor, dateFilter: { gte: floor } }, 'retention disabled: the floor still bounds it')
})
