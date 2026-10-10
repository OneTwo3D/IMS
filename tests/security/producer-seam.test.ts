import assert from 'node:assert/strict'
import test from 'node:test'

import { readProducerEnforcement, producerSeamVerdict } from '../../lib/security/producer-seam.ts'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV, PRODUCER_REASONS, WRITER_OWNER_LABEL, producerHeldNotice, producerShadowNotice } from '../../lib/security/producer-disposition-constants.ts'
import { OUTBOUND_CONNECTORS, OUTBOUND_GRANT_ENV } from '../../lib/security/outbound-write-hold-constants.ts'
import { WRITER_OWNERS } from '../../lib/security/writer-ownership-map.ts'
import { unconditionalMoneySentences } from '../helpers/unconditional-instruction.ts'

/**
 * THE PRODUCER SEAM'S SWITCH AND ITS THREE ANSWERS (legacy / live / shadow).
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  a  unset-enforces      an unset variable enforces (the default flips): the legacy-by-default arm goes red
 *  b  typo-enforces-none  an unknown destination in the list enforces nothing: the fail-closed arm goes red
 *  c  live-without-grant  producerSeamVerdict answers live when the grant is absent: the no-grant arm goes red
 *  d  enforcement-ignored the destination list is not consulted: the per-destination arm goes red
 */

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const NOW = new Date('2026-06-01T12:00:00Z')
const LATE = new Date('2027-01-01T00:00:00Z')
const PAST_CUTOFF = '2026-01-01T00:00:00Z'

const live = (extra: Record<string, string> = {}) => ({
  [PRODUCER_HOLD_ENFORCED_ENV]: 'xero',
  [OUTBOUND_GRANT_ENV.xero]: TENANT,
  [PRODUCER_CUTOFF_ENV.xero]: PAST_CUTOFF,
  ...extra,
})

test('the switch: unset and empty enforce nothing; a list names destinations; all names every one', () => {
  const cases: Array<[string, string | undefined, 'none' | string[]]> = [
    ['unset', undefined, 'none'],
    ['empty', '', 'none'],
    ['one', 'xero', ['xero']],
    ['two with a space', 'xero, woocommerce', ['xero', 'woocommerce']],
    ['all', 'all', [...OUTBOUND_CONNECTORS]],
    ['all among others', 'xero,all', [...OUTBOUND_CONNECTORS]],
  ]
  for (const [label, value, expected] of cases) {
    const env: Record<string, string> = value === undefined ? {} : { [PRODUCER_HOLD_ENFORCED_ENV]: value }
    const got = readProducerEnforcement(env)
    console.log(`# enforcement ${label}: ${JSON.stringify(value)} -> ${got.enforced ? [...got.destinations].sort().join('+') : 'none'}`)
    if (expected === 'none') assert.deepEqual(got, { enforced: false }, label)
    else {
      assert.ok(got.enforced, label)
      assert.deepEqual([...got.destinations].sort(), [...expected].sort(), label)
    }
  }
})

test('FAIL CLOSED: anything that is not a list of known destinations enforces EVERY destination', () => {
  const bad = ['xerro', 'Xero', 'xero;woocommerce', 'xero,', ',xero', 'xero,,mintsoft', ' ', 'true', '1', 'none', 'off', 'xero woocommerce']
  for (const value of bad) {
    const got = readProducerEnforcement({ [PRODUCER_HOLD_ENFORCED_ENV]: value })
    assert.ok(got.enforced, `${JSON.stringify(value)} must not read as "off"`)
    assert.equal(got.readable, false, JSON.stringify(value))
    assert.deepEqual([...got.destinations].sort(), [...OUTBOUND_CONNECTORS].sort(), JSON.stringify(value))
  }
  console.log(`# fail-closed values examined: ${bad.length}`)
  assert.ok(bad.length >= 10)
})

test('LEGACY BY DEFAULT: with the switch unset the seam answers legacy for every cell, including the cells the decision would shadow', () => {
  let cells = 0
  for (const destination of OUTBOUND_CONNECTORS) {
    // No grant, no cut-off: the decision is SHADOW for everything, and still the seam says legacy (the pre-seam behaviour).
    const verdict = producerSeamVerdict(destination, destination === 'xero' ? 'purchase.bill' : destination === 'mintsoft' ? 'order.create' : 'stock', LATE, { env: {}, now: NOW })
    assert.deepEqual(verdict, { kind: 'legacy' }, destination)
    cells += 1
  }
  console.log(`# legacy cells: ${cells}`)
  assert.equal(cells, OUTBOUND_CONNECTORS.length)
})

test('ENFORCED, NO GRANT: the seam answers shadow with the reason and the owner, never live', () => {
  const verdict = producerSeamVerdict('xero', 'purchase.bill', LATE, { env: { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }, now: NOW })
  console.log(`# enforced, no grant: ${JSON.stringify(verdict)}`)
  assert.equal(verdict.kind, 'shadow')
  assert.ok(verdict.kind === 'shadow')
  assert.equal(verdict.decision.reason, 'no_grant')
  assert.equal(verdict.decision.owner, 'qoblex-native')
})

test('ENFORCED, GRANT + CUT-OFF + IMS-OWNED + OBLIGATION AFTER THE CUT-OFF: live', () => {
  const verdict = producerSeamVerdict('xero', 'purchase.bill', LATE, { env: live(), now: NOW })
  console.log(`# fully granted, IMS-owned: ${JSON.stringify(verdict)}`)
  assert.equal(verdict.kind, 'live')
})

test('ENFORCED + GRANTED but the operation belongs to another writer: shadow (the invoice stays with Xeroom in every phase)', () => {
  const verdict = producerSeamVerdict('xero', 'sales.invoice', LATE, { env: live(), now: NOW })
  assert.ok(verdict.kind === 'shadow')
  assert.equal(verdict.decision.reason, 'not_ims_owned')
  assert.equal(verdict.decision.owner, 'xeroom')
})

test('ENFORCED + GRANTED but the business event is before the cut-off: shadow', () => {
  const verdict = producerSeamVerdict('xero', 'purchase.bill', new Date('2025-12-31T23:59:59Z'), { env: live(), now: NOW })
  assert.ok(verdict.kind === 'shadow')
  assert.equal(verdict.decision.reason, 'obligation_before_cutoff')
})

test('PER DESTINATION: naming one destination leaves the others legacy', () => {
  const env = live({ [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce' })
  assert.deepEqual(producerSeamVerdict('xero', 'sales.invoice', LATE, { env, now: NOW }), { kind: 'legacy' })
  assert.deepEqual(producerSeamVerdict('mintsoft', 'order.create', LATE, { env, now: NOW }), { kind: 'legacy' })
  assert.notDeepEqual(producerSeamVerdict('woocommerce', 'stock', undefined, { env, now: NOW }), { kind: 'legacy' })
})

test('a granted destination whose switch is unset is legacy even for an operation another writer owns (the pre-seam behaviour is preserved, not improved)', () => {
  const env = { [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: PAST_CUTOFF }
  assert.deepEqual(producerSeamVerdict('xero', 'sales.invoice', LATE, { env, now: NOW }), { kind: 'legacy' })
})

test('the seam never throws: hostile env and clock objects answer shadow (when enforced) rather than an exception', () => {
  const hostileEnv = new Proxy({}, { get() { throw new Error('boom') }, has() { throw new Error('boom') }, getOwnPropertyDescriptor() { throw new Error('boom') } }) as Record<string, string>
  assert.doesNotThrow(() => producerSeamVerdict('xero', 'purchase.bill', LATE, { env: hostileEnv, now: NOW }))
  const verdict = producerSeamVerdict('xero', 'purchase.bill', LATE, { env: hostileEnv, now: NOW })
  assert.equal(verdict.kind, 'shadow', 'an environment that cannot be read is enforced and shadowed, not trusted')
  const badClock = { env: live(), now: 'yesterday' as unknown as Date }
  assert.equal(producerSeamVerdict('xero', 'purchase.bill', LATE, badClock).kind, 'shadow')
})

test('OPERATOR TEXT is single-sourced, names the destination, owner and reason, and gives no unconditional money instruction for any reason or owner', () => {
  let texts = 0
  for (const connector of OUTBOUND_CONNECTORS) for (const owner of WRITER_OWNERS) for (const reason of PRODUCER_REASONS) {
    if (reason === 'live') continue
    const text = producerShadowNotice({ connector, reason, owner })
    texts += 1
    // The claim boundary's sentence (a queued row handed back unsent) obeys the same rules and claims no shadow was kept.
    const held = producerHeldNotice({ connector, reason, owner })
    assert.deepEqual(unconditionalMoneySentences(held), [], held)
    assert.doesNotMatch(held, /shadow record/)
    assert.match(held, /handed back unsent and is not sent while the hold stands/)
    assert.match(text, /^Not sent by IMS: writes to \w+ are held on this installation \(/)
    assert.ok(text.includes(WRITER_OWNER_LABEL[owner]), `${owner} is named`)
    assert.deepEqual(unconditionalMoneySentences(text), [], `${connector}/${owner}/${reason}: ${text}`)
    assert.ok(!/nothing (was|has been) (posted|sent|debited)/i.test(text), 'claims nothing about the destination')
    assert.match(text, /check \w+ before acting/)
  }
  console.log(`# operator texts examined: ${texts}`)
  assert.equal(texts, OUTBOUND_CONNECTORS.length * WRITER_OWNERS.length * (PRODUCER_REASONS.length - 1))
  // The checker can fail: an unconditional instruction is caught.
  assert.ok(unconditionalMoneySentences('Reverse the journal in Xero.').length > 0)
})
