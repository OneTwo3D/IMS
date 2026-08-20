import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------------------------
// o3d-hl8l r4 (Codex r3 finding 1) — THE END OF A MAINTENANCE WINDOW IS THE ONLY MOMENT ON THIS
// PATH THAT IS BOTH AUTHENTICATED AND SAFELY WRITABLE.
//
// The refusal itself cannot be recorded: the webhook fence runs before signature verification (so a
// row would come from an unauthenticated caller) and anything written during the window is being
// replayed over by the restore. So the durable fact has to be stamped when the window CLOSES — the
// restore has finished, and a row written then survives.
// ---------------------------------------------------------------------------------------------

const WMS_BOOKED_IN_RECHECK_DUE_KEY = 'wms_booked_in_recheck_due_since'

const rows = new Map<string, string>()
const upsertOrder: string[] = []
/** Every upsert, tagged with whether it happened inside a transaction. */
const upsertTrace: Array<{ key: string; inTransaction: boolean }> = []
let inTransaction = false
let transactions = 0

const settingDelegate = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
    // Honour the `where`: a double that returns everything cannot tell "the flag was on" from
    // "the flag was off", which is the whole decision under test.
    where.key.in.filter((key) => rows.has(key)).map((key) => ({ key, value: rows.get(key) })),
  upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    rows.set(where.key, update.value)
    upsertOrder.push(where.key)
    upsertTrace.push({ key: where.key, inTransaction })
    return { key: where.key, value: update.value }
  },
}

const db = {
  setting: settingDelegate,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    transactions += 1
    inTransaction = true
    try {
      return await fn({ setting: settingDelegate })
    } finally {
      inTransaction = false
    }
  },
}

mock.module('@/lib/db', { namedExports: { db } })

function loadMaintenance() {
  return import('../lib/maintenance-mode.ts')
}

function reset() {
  rows.clear()
  upsertOrder.length = 0
  upsertTrace.length = 0
  transactions = 0
  inTransaction = false
}

test('o3d-hl8l r4: clearing a REAL maintenance window stamps the booked-in re-check marker', async () => {
  const { disableMaintenanceMode } = await loadMaintenance()
  reset()
  rows.set('system_maintenance_mode', 'true')
  rows.set('system_maintenance_reason', 'Database restore requested by admin u1')

  await disableMaintenanceMode()

  assert.equal(rows.get('system_maintenance_mode'), 'false')
  const marker = rows.get(WMS_BOOKED_IN_RECHECK_DUE_KEY)
  if (!marker) {
    throw new Error(
      'no re-check marker was stamped — callbacks refused during the window are then nobody\'s: '
        + 'the refusal wrote no row, so without this there is nothing for the sweeper to act on',
    )
  }
  assert.ok(!Number.isNaN(Date.parse(marker)), 'the marker records WHEN the window ended, so the audit can say so')
  assert.equal(transactions, 1, 'flag and marker move in one transaction')
  assert.deepEqual(
    upsertTrace.filter((u) => !u.inTransaction),
    [],
    'a cleared flag committed without its marker is exactly the state this exists to prevent, so '
      + 'every write on this path goes in the one transaction',
  )
  assert.ok(upsertOrder.includes(WMS_BOOKED_IN_RECHECK_DUE_KEY))
})

test('o3d-hl8l r4: clearing a flag that was never on stamps NOTHING', async () => {
  // The restore endpoint calls this unconditionally from its `finally`, including on paths where
  // enableMaintenance never applied. A marker for a window that did not happen would re-check every
  // open ASN against the live WMS for nothing.
  const { disableMaintenanceMode } = await loadMaintenance()
  reset()
  rows.set('system_maintenance_mode', 'false')

  await disableMaintenanceMode()

  assert.equal(rows.has(WMS_BOOKED_IN_RECHECK_DUE_KEY), false)
  assert.deepEqual(upsertOrder, ['system_maintenance_mode', 'system_maintenance_reason'])
})

test('o3d-hl8l r4: enabling maintenance mode does not stamp the marker', async () => {
  // Deliberately NOT at enable time: the restore that follows replays over the settings table, so a
  // marker written then may simply be destroyed. The window's END is the writable moment.
  const { enableMaintenanceMode } = await loadMaintenance()
  reset()

  await enableMaintenanceMode('restore')

  assert.equal(rows.get('system_maintenance_mode'), 'true')
  assert.equal(rows.has(WMS_BOOKED_IN_RECHECK_DUE_KEY), false)
})
