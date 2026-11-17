import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// o3d-ngmt.22 — the order page's Refunds section: a Delete refund action with a confirmation, shown only when the switch is on and the refund is eligible; otherwise the reason.

const CLIENT = 'app/(dashboard)/sales/[id]/so-detail-client.tsx'

test('the control is gated on the server verdict: enabled and eligible shows Delete refund, otherwise the reason is shown', async () => {
  const client = await readFile(CLIENT, 'utf8')
  assert.match(client, /getRefundDeleteEligibility\(so\.id\)/, 'the page asks the server, which owns every rule')
  assert.match(client, /deleteEligibility\?\.enabled && deleteEligibility\.refunds\[r\.id\]/, 'nothing is rendered while the switch is off or the verdict is unknown')
  assert.match(client, /deleteEligibility\.refunds\[r\.id\]\.eligible \?[\s\S]{0,400}Delete refund/, 'an eligible refund offers the action')
  assert.match(client, /Cannot be deleted: \{deleteEligibility\.refunds\[r\.id\]\.refusals\.map\(\(refusal\) => refusal\.message\)\.join\(' '\)\}/, 'an ineligible refund shows the reasons')
})

test('the question is only asked of a user who holds the refund permission, and only when there is a refund', async () => {
  const client = await readFile(CLIENT, 'utf8')
  assert.match(client, /if \(!canRetryRefundAccounting \|\| refundCount === 0\) \{ setDeleteEligibility\(null\); return \}/)
  assert.match(client, /const canRetryRefundAccounting = hasPermission\(currentUserRole, 'sales\.refund'\)/, 'the existing refund permission key')
})

test('the delete is confirmed in a dialog that says what it does, and calls only the delete action', async () => {
  const client = await readFile(CLIENT, 'utf8')
  assert.match(client, /function DeleteRefundDialog/)
  assert.match(client, /await deleteRefund\(refund\.id, reason\)/)
  assert.match(client, /This cannot be undone/)
  assert.match(client, /credit note is voided in the accounting system \(queued, not sent immediately\)/)
  assert.match(client, /\{deleteTarget && <DeleteRefundDialog refund=\{deleteTarget\} onClose=\{\(\) => setDeleteTarget\(null\)\} \/>\}/)
})

test('the action file gates both exports on the refund permission before anything else', async () => {
  const action = await readFile('app/actions/refund-delete.ts', 'utf8')
  const exported = [...action.matchAll(/export async function (\w+)\([\s\S]*?\{\n  (?:const session = )?await requirePermission\('sales\.refund'\)/g)].map((m) => m[1])
  assert.deepEqual(exported.sort(), ['deleteRefund', 'getRefundDeleteEligibility'])
  assert.match(action, /^'use server'/)
})
