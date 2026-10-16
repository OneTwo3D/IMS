import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  destinationAndOperationForSyncType,
  xeroObligationAt,
  xeroProducerSeamVerdict,
} from '@/lib/domain/accounting/xero-producer-seam'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { ACCOUNTING_SYNC_TYPE_EXCLUSIONS, WRITER_OWNERSHIP_MAP, type OwnershipRow } from '@/lib/security/writer-ownership-map'

/**
 * THE XERO SEAM'S TYPE -> (DESTINATION, OPERATION) MAPPING IS THE OWNERSHIP MAP'S, AND TOTAL.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  type-unmapped-live   an unmapped type answers legacy while enforced: the unmapped arm goes red
 *  b  date-first           the document date is read before the payment date: the obligation-date arm goes red
 *  c  quickbooks-asked     the seam asks for a non-Xero connector: the connector arm goes red
 */

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const NOW = new Date('2026-06-01T12:00:00Z')
const ENFORCED = { [PRODUCER_HOLD_ENFORCED_ENV]: 'xero' }
const FULL = { ...ENFORCED, [OUTBOUND_GRANT_ENV.xero]: TENANT, [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }

const ALL_TYPES = Object.values(AccountingSyncType) as string[]

test('EVERY AccountingSyncType is either excluded (not a write) or maps to exactly one (destination, operation) of the ownership map', () => {
  const owners = new Map<string, string[]>()
  for (const entry of WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]) {
    for (const type of entry.accountingSyncTypes ?? []) owners.set(type, [...(owners.get(type) ?? []), `${entry.destination}.${entry.operation}`])
  }
  let mapped = 0
  let excluded = 0
  for (const type of ALL_TYPES) {
    if (Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, type)) { excluded += 1; continue }
    const claimed = owners.get(type) ?? []
    assert.equal(claimed.length, 1, `${type} must be claimed by exactly one ownership-map row, found ${JSON.stringify(claimed)}`)
    const target = destinationAndOperationForSyncType(type)
    assert.ok(target, type)
    assert.equal(`${target.destination}.${target.operation}`, claimed[0])
    mapped += 1
  }
  console.log(`# sync types: ${ALL_TYPES.length} total, ${mapped} mapped, ${excluded} excluded`)
  assert.ok(mapped >= 25 && excluded === 2)
  assert.equal(mapped + excluded, ALL_TYPES.length)
})

test('WC_INVOICE_NOTE is the one sync type whose destination is WooCommerce, and it follows the WooCommerce switch', () => {
  assert.deepEqual(destinationAndOperationForSyncType('WC_INVOICE_NOTE'), { destination: 'woocommerce', operation: 'order.invoice-note' })
  const onlyXero = xeroProducerSeamVerdict({ connector: 'xero', type: 'WC_INVOICE_NOTE', payload: { date: '2026-06-01' }, env: ENFORCED, now: NOW })
  assert.deepEqual(onlyXero, { kind: 'legacy' }, 'WooCommerce is not enforced, so the note is untouched')
  const all = xeroProducerSeamVerdict({ connector: 'xero', type: 'WC_INVOICE_NOTE', payload: { date: '2026-06-01' }, env: { [PRODUCER_HOLD_ENFORCED_ENV]: 'all' }, now: NOW })
  assert.equal(all.kind, 'shadow')
})

test('LEGACY BY DEFAULT: with the switch unset every sync type is legacy, whatever the grants say', () => {
  for (const env of [{}, { [OUTBOUND_GRANT_ENV.xero]: TENANT }, { [PRODUCER_CUTOFF_ENV.xero]: '2026-01-01T00:00:00Z' }]) {
    for (const type of ALL_TYPES) {
      assert.deepEqual(xeroProducerSeamVerdict({ connector: 'xero', type, payload: { date: '2026-06-01' }, env, now: NOW }), { kind: 'legacy' }, `${type} ${JSON.stringify(env)}`)
    }
  }
})

test('ENFORCED with no grant and no cut-off: every writing type is SHADOW, and the two non-writes stay legacy (the P0/P1 posture)', () => {
  let shadowed = 0
  let legacy = 0
  for (const type of ALL_TYPES) {
    const verdict = xeroProducerSeamVerdict({ connector: 'xero', type, payload: { date: '2026-06-01' }, env: ENFORCED, now: NOW })
    if (Object.prototype.hasOwnProperty.call(ACCOUNTING_SYNC_TYPE_EXCLUSIONS, type)) {
      assert.deepEqual(verdict, { kind: 'legacy' }, type)
      legacy += 1
      continue
    }
    const target = destinationAndOperationForSyncType(type)!
    if (target.destination === 'woocommerce') {
      assert.deepEqual(verdict, { kind: 'legacy' }, `${type} is a WooCommerce write and WooCommerce is not enforced`)
      legacy += 1
      continue
    }
    assert.equal(verdict.kind, 'shadow', type)
    assert.ok(verdict.kind === 'shadow')
    assert.equal(verdict.decision.reason, 'no_grant')
    assert.match(verdict.notice, /^Not sent by IMS: writes to Xero are held/)
    shadowed += 1
  }
  console.log(`# enforced, ungranted: ${shadowed} shadowed, ${legacy} legacy (2 non-writes + 1 WooCommerce note)`)
  assert.equal(legacy, 3)
  assert.equal(shadowed, ALL_TYPES.length - 3)
})

test('FULLY GRANTED: IMS-owned types are LIVE with a payload dated after the cut-off, and SHADOW when the date is missing, before the cut-off or the operation belongs to another writer', () => {
  const live = (type: string, payload: unknown) => xeroProducerSeamVerdict({ connector: 'xero', type, payload, env: FULL, now: NOW })
  assert.equal(live('PURCHASE_INVOICE', { date: '2026-05-30' }).kind, 'live')
  assert.equal(live('DAILY_BATCH_GROUP_B', { date: '2026-05-31', batchDate: '2026-05-31' }).kind, 'live')
  assert.equal(live('INVOICE_PAYMENT', { paymentDate: '2026-05-30', date: '2025-01-01' }).kind, 'live', 'the payment date is read before the document date')
  const noDate = live('PURCHASE_INVOICE', { amount: 5 })
  assert.ok(noDate.kind === 'shadow')
  assert.equal(noDate.decision.reason, 'obligation_time_required')
  const early = live('PURCHASE_INVOICE', { date: '2025-12-31' })
  assert.ok(early.kind === 'shadow')
  assert.equal(early.decision.reason, 'obligation_before_cutoff')
  const invoice = live('SALES_INVOICE', { date: '2026-05-30' })
  assert.ok(invoice.kind === 'shadow')
  assert.equal(invoice.decision.reason, 'not_ims_owned')
  const taxRate = live('TAX_RATE_SYNC', {})
  assert.ok(taxRate.kind === 'shadow', 'Xero is the master for tax rates: no component writes them')
})

test('an enforced type the ownership map does not name is SHADOW (a posting nobody classified is not produced); not enforced it is legacy', () => {
  const on = xeroProducerSeamVerdict({ connector: 'xero', type: 'A_TYPE_ADDED_LATER', payload: {}, env: FULL, now: NOW })
  assert.ok(on.kind === 'shadow')
  assert.equal(on.operation, 'unmapped:A_TYPE_ADDED_LATER')
  assert.equal(xeroProducerSeamVerdict({ connector: 'xero', type: 'A_TYPE_ADDED_LATER', payload: {}, env: {}, now: NOW }).kind, 'legacy')
})

test('only connector xero is asked', () => {
  assert.deepEqual(xeroProducerSeamVerdict({ connector: 'quickbooks', type: 'PURCHASE_INVOICE', payload: { date: '2026-06-01' }, env: ENFORCED, now: NOW }), { kind: 'legacy' })
})

test('the business-event date: payment date, then document date, then invoice date; a date without a time is the start of that UTC day; garbage is undefined', () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ['document date', { date: '2026-05-30' }, '2026-05-30T00:00:00.000Z'],
    ['payment date wins', { paymentDate: '2026-05-29', date: '2026-05-30' }, '2026-05-29T00:00:00.000Z'],
    ['full instant', { date: '2026-05-30T10:15:00Z' }, '2026-05-30T10:15:00.000Z'],
    ['invoice date', { invoiceDate: '2026-05-28' }, '2026-05-28T00:00:00.000Z'],
    ['unreadable payment date falls through to the document date', { paymentDate: 'soon', date: '2026-05-30' }, '2026-05-30T00:00:00.000Z'],
    ['impossible date', { date: '2026-13-45' }, undefined],
    ['not a string', { date: 20260530 }, undefined],
    ['no date', { amount: 5 }, undefined],
    ['null payload', null, undefined],
    ['array payload', [{ date: '2026-05-30' }], undefined],
  ]
  for (const [label, payload, expected] of cases) {
    const got = xeroObligationAt(payload)
    console.log(`# obligation ${label}: ${got?.toISOString() ?? 'undefined'}`)
    assert.equal(got?.toISOString(), expected, label)
  }
})
