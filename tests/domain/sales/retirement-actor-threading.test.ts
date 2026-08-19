import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * o3d-6zr2: the pending-shipment retirement record is written by `reconcilePendingShipments` through
 * the TRANSACTION client, which cannot resolve a session — so `userId` has to be threaded down from
 * the action boundary. `updateAllocation` and `deallocateOrder` already did; `deleteSalesOrder` and
 * `autoAllocateOrder` held an AuthSession and simply did not pass it, so a draft shipment (and the
 * tracking number an operator has to cancel with the carrier) retired by an operator's delete or
 * re-allocation was attributed to nobody.
 *
 * The behaviour itself is pinned in allocation-service.test.ts ("carries the acting user" / "records
 * no user"); what cannot be reached from there is the ACTION's own wiring, so it is pinned here at
 * the source, scoped to the one function in each file.
 */

async function functionBody(path: string, name: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  const start = text.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `${name} not found in ${path}`)
  const next = text.indexOf('\nexport ', start + 1)
  return text.slice(start, next === -1 ? undefined : next)
}

test('deleteSalesOrder hands its session user to the in-transaction retirement record', async () => {
  const body = await functionBody('app/actions/sales.ts', 'deleteSalesOrder')

  assert.match(
    body,
    /const session = await requirePermission\('sales\.create'\)/,
    'the session must be captured, not discarded — it is the only place the acting user is known',
  )
  assert.match(
    body,
    /releaseOrderAllocationsInTx\(tx, id, \{[\s\S]{0,400}?userId: session\.user\.id/,
    'the delete path must pass the acting user down to the retirement record',
  )
})

test('autoAllocateOrder passes the acting user, and leaves cron/batch callers null', async () => {
  const body = await functionBody('app/actions/allocation.ts', 'autoAllocateOrder')

  assert.match(
    body,
    /let actingUserId: string \| null = null/,
    'the bypass (cron/backstop) path has no session and must stay null, not invent a user',
  )
  assert.match(
    body,
    /const session = await requirePermission\('sales\.process'\)\s*\n\s*actingUserId = session\.user\.id \?\? null/,
    'the user-triggered path must resolve the acting user from the permission check it already runs',
  )
  assert.match(
    body,
    /allocateSalesOrder\(db, \{[\s\S]{0,600}?userId: actingUserId,/,
    'and hand it to allocateSalesOrder, which forwards it to reconcilePendingShipments',
  )
})
