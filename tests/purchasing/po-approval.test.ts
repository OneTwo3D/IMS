import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  approvalSpendBase, approverIsRequester, assertPoApprovedForSend, editInvalidatesApproval, evaluatePoApproval, parseApprovalThreshold,
  PoApprovalRequiredError, validateApprovalThresholdInput, type PoApprovalFacts, type PoApprovalGateDb,
} from '@/lib/domain/purchasing/po-approval'
import { hasPermission, ROLES } from '@/lib/permissions'

const D = (v: string) => new Prisma.Decimal(v)

function facts(over: Partial<PoApprovalFacts> = {}): PoApprovalFacts {
  return {
    type: 'GOODS', supplierId: 's1', currency: 'GBP', totalBase: '1200', taxBase: '200',
    approvedAt: null, approvedTotalBase: null, approvedSupplierId: null, approvedCurrency: null, ...over,
  }
}
const APPROVED = { approvedAt: new Date(), approvedTotalBase: '1000', approvedSupplierId: 's1', approvedCurrency: 'GBP' }

test('threshold parsing: unset, blank, zero, negative and junk all mean no gate', () => {
  for (const raw of [undefined, null, '', '  ', '0', '0.00', '-5', 'abc', '1e3', '10,5']) assert.equal(parseApprovalThreshold(raw), null, String(raw))
  assert.equal(parseApprovalThreshold('1000')?.toFixed(), '1000')
  assert.equal(parseApprovalThreshold(' 2500.5 ')?.toFixed(), '2500.5')
})

test('threshold input validation clears on blank or zero and rejects junk', () => {
  assert.deepEqual(validateApprovalThresholdInput(''), { ok: true, stored: '' })
  assert.deepEqual(validateApprovalThresholdInput('0'), { ok: true, stored: '' })
  assert.deepEqual(validateApprovalThresholdInput('1500.50'), { ok: true, stored: '1500.5' })
  assert.equal(validateApprovalThresholdInput('-1').ok, false)
  assert.equal(validateApprovalThresholdInput('12abc').ok, false)
})

test('the compared figure is the total ex VAT in base currency', () => {
  assert.equal(approvalSpendBase({ totalBase: '1200', taxBase: '200' }).toFixed(), '1000')
})

test('below the threshold, or with no threshold, nothing is required', () => {
  assert.deepEqual(evaluatePoApproval(facts(), null), { required: false, approved: false, reason: 'no_threshold' })
  assert.deepEqual(evaluatePoApproval(facts(), D('1000.01')), { required: false, approved: false, reason: 'below_threshold' })
  assert.deepEqual(evaluatePoApproval(facts({ type: 'FREIGHT' }), D('1')), { required: false, approved: false, reason: 'not_goods' })
})

test('at the threshold approval is required (inclusive), and an unapproved order is not satisfied', () => {
  assert.deepEqual(evaluatePoApproval(facts(), D('1000')), { required: true, approved: false, reason: 'never_approved' })
})

test('an approval covers the order only while the total, supplier and currency match the snapshot', () => {
  const threshold = D('500')
  assert.deepEqual(evaluatePoApproval(facts(APPROVED), threshold), { required: true, approved: true })
  assert.deepEqual(evaluatePoApproval(facts({ ...APPROVED, totalBase: '1500' }), threshold), { required: true, approved: false, reason: 'total_raised' })
  assert.deepEqual(evaluatePoApproval(facts({ ...APPROVED, supplierId: 's2' }), threshold), { required: true, approved: false, reason: 'supplier_changed' })
  assert.deepEqual(evaluatePoApproval(facts({ ...APPROVED, currency: 'EUR' }), threshold), { required: true, approved: false, reason: 'currency_changed' })
  // A lower total keeps the approval.
  assert.deepEqual(evaluatePoApproval(facts({ ...APPROVED, totalBase: '600' }), threshold), { required: true, approved: true })
})

test('self-approval: the creator is refused, another user and an unknown creator are not', () => {
  assert.equal(approverIsRequester('u1', 'u1'), true)
  assert.equal(approverIsRequester('u1', 'u2'), false)
  assert.equal(approverIsRequester(null, 'u2'), false)
})

test('an edit clears approval when it raises the total or moves supplier or currency, not when it lowers or keeps it', () => {
  const before = { totalBase: '1200', taxBase: '200' }
  const approved = facts(APPROVED)
  assert.equal(editInvalidatesApproval(before, { ...approved, totalBase: '1320' }), true)
  assert.equal(editInvalidatesApproval(before, { ...approved, supplierId: 's2' }), true)
  assert.equal(editInvalidatesApproval(before, { ...approved, currency: 'USD' }), true)
  assert.equal(editInvalidatesApproval(before, { ...approved, totalBase: '1100' }), false)
  assert.equal(editInvalidatesApproval(before, approved), false)
  assert.equal(editInvalidatesApproval(before, facts({ totalBase: '9999' })), false, 'nothing to clear when not approved')
})

function gateDb(threshold: string | null, po: PoApprovalFacts | null): PoApprovalGateDb {
  return {
    setting: { findUnique: async () => (threshold == null ? null : { value: threshold }) },
    purchaseOrder: { findUnique: async () => po },
  }
}

test('the send gate: refuses an unapproved order at or above the threshold with the operator message, lets everything else through', async () => {
  await assert.rejects(() => assertPoApprovedForSend(gateDb('1000', facts()), 'p'), (e: unknown) => e instanceof PoApprovalRequiredError && /needs approval before it can be sent/.test(e.message))
  await assertPoApprovedForSend(gateDb(null, facts()), 'p') // unset: unchanged
  await assertPoApprovedForSend(gateDb('0', facts()), 'p') // 0: unchanged
  await assertPoApprovedForSend(gateDb('1001', facts()), 'p') // below
  await assertPoApprovedForSend(gateDb('1000', facts(APPROVED)), 'p') // approved
})

test('purchasing.approve is held by ADMIN and MANAGER only', () => {
  const holders = ROLES.filter((r) => hasPermission(r, 'purchasing.approve'))
  assert.deepEqual(holders.sort(), ['ADMIN', 'MANAGER'])
})
