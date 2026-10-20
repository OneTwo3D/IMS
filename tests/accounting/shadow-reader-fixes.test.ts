import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { settlementStatus } from '@/lib/domain/accounting/settlement-status'
import { latestBatchStatusLabel } from '@/lib/ops/health'
import { resolveStagedAllocationDebit } from '@/lib/domain/accounting/allocated-inventory-debit'
import { xeroNotNeverDeliverablePendingWhere, xeroNotBeforeCutoffWhere } from '@/lib/domain/accounting/xero-producer-seam'
import { toAdminIntegrationOutboxRow } from '@/lib/domain/integrations/outbox-admin'
import { decideWmsPushReplay } from '@/lib/domain/wms/push-recovery-affordance'
import { mintsoftAsnCreateShadowNotice } from '@/lib/connectors/mintsoft/producer-seam'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * THE READERS OF A SHADOW, ONE ARM EACH, EACH WITH A CONTROL THAT DIFFERS ONLY IN THE THING UNDER TEST.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  settlement-reads-shadow-as-attempt   settlementStatus loses its shadow arm: the settlement arms go red
 *  b  label-bare-status                    latestBatchStatusLabel returns the bare status for a shadow: the label arm goes red
 *  c  never-deliverable-blocks             xeroNotNeverDeliverablePendingWhere returns {} under a floor: the starvation arm goes red
 *  d  admin-unmarked                       toAdminIntegrationOutboxRow stops marking a pre-cutoff job: the admin arm goes red
 *  e  debit-calls-shadow-abandoned         resolveStagedAllocationDebit drops its shadow branch: the A2 reason arm goes red
 *  f  replay-ignores-producer              decideWmsPushReplay ignores the producer facts: the replay arms go red
 *  g  asn-notice-null                      mintsoftAsnCreateShadowNotice always answers null: the ASN arm goes red
 */

const shadowRow = { status: 'CANCELLED' as const, externalTransactionId: null, settlementBasis: 'HELD_SHADOW', abandonedBeforeRemoteCall: true }
const orphanRow = { status: 'CANCELLED' as const, externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: true }

test('SETTLEMENT VERDICT: a shadowed payment registration is its own answer in both directions, never an attempt, never a payment the ledger names; the orphan-sweep row (same shape, other basis) keeps the old answers', () => {
  const verdict = (paidLocally: boolean, payment: typeof shadowRow | typeof orphanRow) =>
    settlementStatus({ paidLocally, syncEnabled: true, documentPosted: true, payment })
  for (const paidLocally of [true, false]) {
    const shadow = verdict(paidLocally, shadowRow)
    console.log(`# paidLocally=${paidLocally}: ${shadow.status} discrepancy=${shadow.discrepancy}`)
    assert.equal(shadow.status, 'LEDGER_UNDECIDED')
    assert.equal(shadow.discrepancy, false)
    assert.equal(shadow.basis, 'NONE')
    assert.match(shadow.detail, /recorded this payment registration as a shadow and did not send it/)
    assert.doesNotMatch(shadow.detail, /ATTEMPTED|still names ledger payment|orphan sweep/)
    const control = verdict(paidLocally, orphanRow)
    assert.notDeepEqual(control, shadow, 'CONTROL: the orphan-sweep row does not get the shadow answer')
    assert.equal(control.status === 'LEDGER_UNDECIDED' && control.discrepancy === false && /shadow/.test(control.detail), false)
  }
})

test('HEALTH LABEL: a shadowed latest batch is labelled as a shadow, not as a bare CANCELLED; other standings keep their labels', () => {
  assert.match(latestBatchStatusLabel('CANCELLED', 'SHADOW_NOT_SENT_BY_IMS'), /^SHADOWED \(not sent by IMS/)
  assert.equal(latestBatchStatusLabel('CANCELLED', 'PROVEN_NOT_POSTED'), 'CANCELLED', 'CONTROL')
  assert.equal(latestBatchStatusLabel('SYNCED', 'CONFIRMED_POSTED'), 'SYNCED', 'CONTROL')
  assert.match(latestBatchStatusLabel('SYNCED', 'ASSERTED_POSTED'), /asserted by an operator/, 'CONTROL')
})

test('STARVATION FRAGMENT: with a floor a PENDING row created before it is not earlier work; a PROCESSING one still is (nothing here names it); no floor adds nothing', () => {
  assert.deepEqual(xeroNotNeverDeliverablePendingWhere(null), {}, 'CONTROL: the legacy read is untouched')
  const floor = new Date('2026-12-01T00:00:00Z')
  const fragment = xeroNotNeverDeliverablePendingWhere(floor) as { NOT: { status: string; createdAt: { lt: Date }; type: { notIn: string[] } } }
  assert.equal(fragment.NOT.status, 'PENDING', 'only PENDING is excluded: a claim in flight across the switch keeps blocking')
  assert.equal(fragment.NOT.createdAt.lt.toISOString(), floor.toISOString())
  assert.ok(fragment.NOT.type.notIn.length > 0, 'the non-write types stay exempt')
  assert.notDeepEqual(fragment, xeroNotBeforeCutoffWhere(floor), 'it is NOT the claim fragment: that one would drop PROCESSING rows too')
})

test('ADMIN OUTBOX LIST: a job queued before a live destination\'s instant is marked; a newer job, and every job with the switch off, is not', async () => {
  const saved = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.xero, PRODUCER_CUTOFF_ENV.xero].map((key) => [key, process.env[key]] as const)
  const { XERO_ACCOUNTING_POST_OPERATION, XERO_OUTBOX_CONNECTOR } = await import('@/lib/connectors/xero/outbox')
  const row = (createdAt: string) => ({
    id: 'job', connector: XERO_OUTBOX_CONNECTOR, operation: XERO_ACCOUNTING_POST_OPERATION, idempotencyKey: 'k', payloadJson: {}, status: 'PENDING',
    attempts: 0, nextAttemptAt: null, lastError: null, lockedAt: null, lockedBy: null, createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    attemptHistoryTracked: false, firstAttemptedAt: null,
  })
  try {
    delete process.env[PRODUCER_HOLD_ENFORCED_ENV]
    assert.equal('beforeCutoff' in toAdminIntegrationOutboxRow(row('2026-01-01T00:00:00Z') as never), false, 'CONTROL: switch off, byte-identical shape')
    process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'xero'
    process.env[OUTBOUND_GRANT_ENV.xero] = '4f7f0c6e-1111-4222-8333-944455556666'
    process.env[PRODUCER_CUTOFF_ENV.xero] = '2026-06-01T00:00:00Z'
    const old = toAdminIntegrationOutboxRow(row('2026-05-01T00:00:00Z') as never)
    assert.equal(old.beforeCutoff, '2026-06-01T00:00:00.000Z')
    assert.equal('beforeCutoff' in toAdminIntegrationOutboxRow(row('2026-07-01T00:00:00Z') as never), false, 'CONTROL: a newer job is deliverable')
    assert.equal('beforeCutoff' in toAdminIntegrationOutboxRow({ ...row('2026-05-01T00:00:00Z'), status: 'SHADOWED' } as never), false, 'a retired (SHADOWED) job is a record, not a stuck job')
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('A2 DEBIT REASON: a shadowed journal is described as a shadow (stamp still standing); an abandoned CANCELLED row keeps the abandonment sentence', async () => {
  const clientFor = (journal: Record<string, unknown>) => ({ accountingSyncLog: { findUnique: async () => journal as never } })
  const order = { inventoryAllocatedDate: new Date('2026-07-01T00:00:00Z'), allocationBatchAmount: 12.5, allocationBatchSyncLogId: 'j1' }
  const shadow = await resolveStagedAllocationDebit(clientFor({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'HELD_SHADOW', abandonedBeforeRemoteCall: true }), order)
  const abandoned = await resolveStagedAllocationDebit(clientFor({ status: 'CANCELLED', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: true }), order)
  assert.equal(shadow.standing, true, 'the stamp still stands: nothing is cleared')
  assert.match(shadow.reason, /recorded as a SHADOW/)
  assert.doesNotMatch(shadow.reason, /abandoned/)
  assert.equal(abandoned.standing, true)
  assert.match(abandoned.reason, /abandoned/, 'CONTROL')
  assert.doesNotMatch(abandoned.reason, /SHADOW/, 'CONTROL')
})

test('WAREHOUSE REPLAY AFFORDANCE: a dead letter is not replayable while the hold stands or when paid before the floor; with no producer facts it is the legacy decision', () => {
  const link = { connector: 'mintsoft', state: 'DEAD_LETTER', attempts: 3, externalOrderId: null, pushedAt: null }
  assert.deepEqual(decideWmsPushReplay(link, 'SO-1'), { replayable: true }, 'CONTROL: legacy')
  assert.deepEqual(decideWmsPushReplay(link, 'SO-1', undefined, { held: false, floor: null, paidAt: null }), { replayable: true }, 'CONTROL: facts that say nothing')
  const held = decideWmsPushReplay(link, 'SO-1', undefined, { held: true, floor: null, paidAt: null })
  assert.equal(held.replayable, false)
  assert.equal(!held.replayable && held.reason, 'create-held')
  const floor = new Date('2026-06-01T00:00:00Z')
  const before = decideWmsPushReplay(link, 'SO-1', undefined, { held: false, floor, paidAt: new Date('2026-05-01T00:00:00Z') })
  assert.equal(!before.replayable && before.reason, 'pre-cutover')
  assert.deepEqual(decideWmsPushReplay(link, 'SO-1', undefined, { held: false, floor, paidAt: new Date('2026-07-01T00:00:00Z') }), { replayable: true }, 'CONTROL: paid after the floor')
  // The decision order is unchanged: an already-linked dead letter keeps its own refusal.
  const linked = decideWmsPushReplay({ ...link, externalOrderId: 'wms-9' }, 'SO-1', undefined, { held: true })
  assert.equal(!linked.replayable && linked.reason, 'already-linked')
})

test('ASN STATE: the Create control is blocked with the shadow sentence exactly when ASN creation is shadowed, and both state readers ask for it', () => {
  assert.equal(mintsoftAsnCreateShadowNotice({ env: {} }), null, 'CONTROL: switch off')
  const held = mintsoftAsnCreateShadowNotice({ env: { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' } })
  assert.match(held ?? '', /Not sent by IMS|held/i)
  assert.equal(mintsoftAsnCreateShadowNotice({ env: { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' } }), null, 'CONTROL: another destination')
  const source = readFileSync('app/actions/mintsoft-sync.ts', 'utf8')
  assert.equal(source.split('blockedReason = mintsoftAsnCreateShadowNotice()').length - 1, 2, 'both the purchase-order and the transfer reader block on it')
})

test('THE CUT-OFF IS ASKED BY ALL THREE ORDERING READS: the pre-filter, the locked claim read and the update ordering (the claim is not reachable without a database)', () => {
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const occurrences = source.split('xeroNotNeverDeliverablePendingWhere(xeroCutoffFloor())').length - 1
  assert.equal(occurrences, 3)
  // The locked read must take the floor INSIDE the transaction that holds the order lock, not from a variable captured before it.
  const locked = source.slice(source.indexOf('await lockSalesOrder(tx, entry.referenceId)'))
  assert.ok(locked.indexOf('xeroNotNeverDeliverablePendingWhere(xeroCutoffFloor())') > 0 && locked.indexOf('xeroNotNeverDeliverablePendingWhere(xeroCutoffFloor())') < locked.indexOf('decideInvoicePaymentClaim'))
})
