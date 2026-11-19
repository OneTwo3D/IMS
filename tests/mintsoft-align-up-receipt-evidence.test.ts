import assert from 'node:assert/strict'
import test from 'node:test'

import {
  alignUpReceiptEvidenceEnabledValue,
  asnHasReceiptEvidence,
  MINTSOFT_ALIGN_UP_RECEIPT_EVIDENCE_SETTING,
  readAlignUpReceiptEvidenceEnabled,
} from '@/lib/connectors/mintsoft/settings/align-up-receipt-evidence'

test('an ASN the warehouse has not touched is not evidence of a receipt; a booked-in status or a callback is', () => {
  assert.equal(asnHasReceiptEvidence({ status: 'OPEN', lastCallbackAt: null }), false)
  assert.equal(asnHasReceiptEvidence({ status: 'CREATE_PENDING', lastCallbackAt: null }), false)
  assert.equal(asnHasReceiptEvidence({ status: 'PARTIALLY_BOOKED_IN', lastCallbackAt: null }), true)
  assert.equal(asnHasReceiptEvidence({ status: 'BOOKED_IN', lastCallbackAt: null }), true)
  assert.equal(asnHasReceiptEvidence({ status: 'OPEN', lastCallbackAt: new Date() }), true)
})

test('the switch reads ON only for the exact string true, and reads the documented key', async () => {
  for (const off of [undefined, null, '', 'false', 'TRUE', 'yes', '1']) assert.equal(alignUpReceiptEvidenceEnabledValue(off), false)
  assert.equal(alignUpReceiptEvidenceEnabledValue('true'), true)
  const keys: string[] = []
  const reader = { setting: { findUnique: async ({ where }: { where: { key: string } }) => { keys.push(where.key); return { value: 'true' } } } }
  assert.equal(await readAlignUpReceiptEvidenceEnabled(reader), true)
  assert.deepEqual(keys, [MINTSOFT_ALIGN_UP_RECEIPT_EVIDENCE_SETTING])
  assert.equal(await readAlignUpReceiptEvidenceEnabled({ setting: { findUnique: async () => null } }), false)
})
