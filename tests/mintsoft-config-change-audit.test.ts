import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// q66in.7.2: the ACTIONS, not just the diff helper. Connection and binding saves logged
// after-values only; the courier-map and order-dispatch saves logged nothing at all. These pin
// that each save now emits an activity entry carrying the BEFORE half.

type LogEntry = {
  action: string
  description: string
  level?: string
  metadata?: Record<string, unknown>
}

const logs: LogEntry[] = []
const settingRows = new Map<string, string>()
const upserts: Array<{ key: string; value: string }> = []
const deletedSettingKeys: string[] = []
let existingBindingRow: Record<string, unknown> | null = null
const bindingUpdates: Array<Record<string, unknown>> = []

// q66in.7.2 / Codex r10 #2 — the harness models WHEN a value is read, not just what it holds.
//
// `trace` records every settings operation in order, tagged with whether it happened inside the
// write transaction. `concurrentWrite` fires ONCE, immediately after the first read that happens
// OUTSIDE the transaction: that is the interleaving the row lock exists to exclude — another save
// committing between your snapshot and your write. A save that takes its before-image outside the
// transaction sees the pre-concurrent value and audits a transition that never happened; one that
// reads under the lock sees what it is actually replacing.
const trace: string[] = []
let lockedKeys: string[] = []
let inTransaction = false
let concurrentWrite: Map<string, string> | null = null

function applyConcurrentWrite(): void {
  if (!concurrentWrite) return
  for (const [key, value] of concurrentWrite) settingRows.set(key, value)
  concurrentWrite = null
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'user-1' } }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LogEntry) => { logs.push(entry) },
    logActivityPersisted: async (entry: LogEntry) => { logs.push(entry); return true },
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
const db: Record<string, unknown> = {
  wmsConnection: {
    findFirst: async () => ({ id: 'conn-1' }),
    create: async () => ({ id: 'conn-1' }),
    updateMany: async () => ({ count: 0 }),
  },
  externalWmsBinding: {
    findFirst: async () => existingBindingRow,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      bindingUpdates.push(data)
      return { id: 'bind-1' }
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      bindingUpdates.push(data)
      return { id: 'bind-new' }
    },
  },
  adjustmentReason: { findUnique: async () => ({ active: true, accountCode: '5000' }) },
  shoppingOrderLink: { findMany: async () => [] },
  // BOTH forms. Prisma's array form has already evaluated each delegate call by the time it
  // gets here, so that branch only settles them; the callback form is the one the dispatch save
  // uses, and it must hand back a client that can take the row lock — a double without
  // $executeRaw/$queryRaw would force the production code back out of the transaction.
  $transaction: async (arg: unknown) => {
    if (typeof arg !== 'function') return Promise.all(arg as unknown[])
    inTransaction = true
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(txClient)
    } finally {
      inTransaction = false
    }
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ')
    if (!/INSERT INTO settings/i.test(sql) || !/ON CONFLICT/i.test(sql)) {
      throw new Error(`unexpected $executeRaw: ${sql}`)
    }
    trace.push('materialise')
    for (const key of values[0] as string[]) if (!settingRows.has(key)) settingRows.set(key, '')
    // The LAST legal moment for the competing save: after this transaction has touched the table
    // and before it holds the lock. Once FOR UPDATE returns, Postgres would make the other writer
    // wait, which is the whole point of taking it.
    applyConcurrentWrite()
    return 0
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ')
    if (!/FOR UPDATE/i.test(sql)) throw new Error(`the before-image read must take a row lock: ${sql}`)
    if (!inTransaction) throw new Error('the row lock must be taken INSIDE the write transaction')
    lockedKeys = [...(values[0] as string[])].sort()
    trace.push('locked-read')
    return lockedKeys
      .filter((key) => settingRows.has(key))
      .map((key) => ({ key, value: settingRows.get(key) ?? '' }))
  },
  setting: {
    findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
      const keys = where?.key?.in
      const rows = [...settingRows].map(([key, value]) => ({ key, value }))
      const result = keys ? rows.filter((row) => keys.includes(row.key)) : rows
      trace.push(inTransaction ? 'tx-findMany' : 'unlocked-findMany')
      if (!inTransaction) applyConcurrentWrite()
      return result
    },
    findUnique: async ({ where }: { where: { key: string } }) => {
      const row = settingRows.has(where.key) ? { key: where.key, value: settingRows.get(where.key) } : null
      trace.push(inTransaction ? 'tx-findUnique' : 'unlocked-findUnique')
      if (!inTransaction) applyConcurrentWrite()
      return row
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      upserts.push({ key: where.key, value: update.value })
      settingRows.set(where.key, update.value)
      trace.push(`upsert:${where.key}`)
      return { key: where.key, value: update.value }
    },
    deleteMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
      const keys = where?.key?.in ?? []
      let count = 0
      for (const key of keys) if (settingRows.delete(key)) count += 1
      deletedSettingKeys.push(...keys)
      trace.push('deleteMany')
      return { count }
    },
  },
}

// A transaction client is the same delegate surface, minus the transaction control Prisma strips.
const txClient = db

mock.module('@/lib/db', { namedExports: { db } })

async function loadActions() {
  return import('@/app/actions/mintsoft-sync')
}

function reset() {
  logs.length = 0
  upserts.length = 0
  deletedSettingKeys.length = 0
  bindingUpdates.length = 0
  trace.length = 0
  lockedKeys = []
  inTransaction = false
  concurrentWrite = null
  existingBindingRow = null
  settingRows.clear()
}

test('saving the courier service map now writes an audit entry naming added/changed/REMOVED routes', async () => {
  const { saveMintsoftCourierServiceMap } = await loadActions()
  reset()
  settingRows.set('mintsoft_courier_service_map', JSON.stringify({ 'Next Day': 12, 'Standard': 3, 'Saturday': 44 }))

  const result = await saveMintsoftCourierServiceMap(JSON.stringify({ 'Next Day': 99, 'Standard': 3, 'Express': 7 }))
  assert.equal(result.success, true)

  // Before o3d/q66in.7.2 this action produced NO activity entry at all.
  const entry = logs.find((log) => log.action === 'mintsoft_courier_map_updated')
  if (!entry) throw new Error(`no courier-map audit entry was written (saw: ${logs.map((l) => l.action).join(', ') || 'nothing'})`)

  assert.deepEqual(entry.metadata?.added, ['Express'])
  assert.deepEqual(entry.metadata?.changed, ['Next Day'])
  assert.deepEqual(entry.metadata?.removed, ['Saturday'])
  // The BEFORE half — the thing that did not exist.
  assert.deepEqual(entry.metadata?.before, { 'Next Day': 12, 'Standard': 3, 'Saturday': 44 })
  assert.deepEqual(entry.metadata?.after, { 'Next Day': 99, 'Standard': 3, 'Express': 7 })
  // A dropped entry silently falls back to the default courier id, so it is raised, not just noted.
  assert.equal(entry.level, 'WARNING')
  assert.match(entry.description, /1 added, 1 changed, 1 removed/)
})

test('a courier-map save that removes nothing is INFO, not a warning', async () => {
  const { saveMintsoftCourierServiceMap } = await loadActions()
  reset()
  settingRows.set('mintsoft_courier_service_map', JSON.stringify({ 'Standard': 3 }))

  await saveMintsoftCourierServiceMap(JSON.stringify({ 'Standard': 3, 'Express': 7 }))

  const entry = logs.find((log) => log.action === 'mintsoft_courier_map_updated')
  if (!entry) throw new Error('no courier-map audit entry was written')
  assert.equal(entry.level, 'INFO')
  assert.deepEqual(entry.metadata?.removed, [])
  assert.deepEqual(entry.metadata?.added, ['Express'])
})

test('a REJECTED courier map is not written and not audited', async () => {
  const { saveMintsoftCourierServiceMap } = await loadActions()
  reset()
  settingRows.set('mintsoft_courier_service_map', JSON.stringify({ 'Standard': 3 }))

  const result = await saveMintsoftCourierServiceMap('{"Standard": "not-an-id"}')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /positive integer courier service id/)
  assert.deepEqual(upserts, [], 'nothing was persisted')
  assert.deepEqual(logs, [], 'and a rejected save must not leave an audit entry claiming a change')
})

test('q66in.7.2 r4: the COURIER-MAP before-image is read under a lock inside the write transaction', async () => {
  // Codex r3 #3. Round 1 gave this save an audit entry and left its before-image where it had always
  // been: an unlocked read outside any transaction. That is the identical defect the dispatch save
  // was restructured to remove, still standing on the other writer — and this one is the routing
  // table itself. Two saves in flight: this one reads map A, another commits B, this one commits A
  // back. Taken outside the lock the entry says "no change" while the transition it actually caused
  // (B -> A) reroutes live parcels onto different courier services and is recorded nowhere.
  const { saveMintsoftCourierServiceMap } = await loadActions()
  reset()
  settingRows.set('mintsoft_courier_service_map', JSON.stringify({ 'Next Day': 12 }))
  concurrentWrite = new Map([['mintsoft_courier_service_map', JSON.stringify({ 'Next Day': 55 })]])

  const result = await saveMintsoftCourierServiceMap(JSON.stringify({ 'Next Day': 12 }))
  assert.equal(result.success, true)

  const entry = logs.find((log) => log.action === 'mintsoft_courier_map_updated')
  if (!entry) throw new Error('no courier-map audit entry was written')
  assert.deepEqual(
    entry.metadata?.before,
    { 'Next Day': 55 },
    'the entry must name the map it actually replaced, not one a concurrent save had already moved on from',
  )
  assert.deepEqual(entry.metadata?.after, { 'Next Day': 12 })
  assert.deepEqual(
    entry.metadata?.changed,
    ['Next Day'],
    'and it must report the real 55 -> 12 reroute, not the "no change" a stale before-image produces',
  )

  // No unlocked read of the settings table happened on this path at all.
  assert.equal(
    trace.some((step) => step.startsWith('unlocked-')),
    false,
    `an unlocked settings read is the defect itself; trace was ${trace.join(' -> ')}`,
  )
})

test('q66in.7.2 r4: the courier-map lock is taken on the row the upsert replaces, before it writes', async () => {
  const { saveMintsoftCourierServiceMap } = await loadActions()
  reset()
  settingRows.set('mintsoft_courier_service_map', JSON.stringify({ Standard: 3 }))

  await saveMintsoftCourierServiceMap(JSON.stringify({ Standard: 4 }))

  assert.deepEqual(
    lockedKeys,
    ['mintsoft_courier_service_map'],
    'exactly the key this save overwrites — and only it, so the map save and the dispatch save '
      + 'hold disjoint rows and cannot deadlock against each other',
  )
  assert.deepEqual(
    trace,
    ['materialise', 'locked-read', 'upsert:mintsoft_courier_service_map'],
    'lock, then read, then write — in one transaction',
  )
})

test('saving the order dispatch settings audits the delta-scope move and the cursor reset', async () => {
  const { saveMintsoftOrderDispatchSettings } = await loadActions()
  reset()
  settingRows.set('mintsoft_client_id', '89')
  settingRows.set('mintsoft_channel_id', '')
  settingRows.set('mintsoft_warehouse_id', '')
  settingRows.set('mintsoft_default_courier_service_id', '12')
  settingRows.set('mintsoft_admin_order_url_template', '')

  const result = await saveMintsoftOrderDispatchSettings({
    adminOrderUrlTemplate: '',
    defaultCourierServiceId: '12',
    clientId: '101',
    channelId: '',
    warehouseId: '',
  })
  assert.equal(result.success, true)

  const entry = logs.find((log) => log.action === 'mintsoft_order_dispatch_settings_updated')
  if (!entry) throw new Error(`no dispatch-settings audit entry was written (saw: ${logs.map((l) => l.action).join(', ') || 'nothing'})`)

  assert.deepEqual(entry.metadata?.changed, ['clientId'])
  assert.deepEqual(entry.metadata?.before, { clientId: '89' })
  assert.deepEqual(entry.metadata?.after, { clientId: '101' })
  // A scope change discards the delta watermark; a silently-restarted cursor is otherwise
  // indistinguishable from a sweep that simply ran again.
  assert.equal(entry.metadata?.scopeChanged, true)
  assert.equal(entry.metadata?.cursorsReset, true)
  assert.deepEqual(deletedSettingKeys, ['mintsoft_order_delta_since', 'mintsoft_order_reconcile_at'])
  // o3d-hl8l r5: deleting the rows was never the whole reset. Unless the save also MINTS the next
  // generation, an in-flight sweep re-upserts the cursors it read and the reset is undone — and the
  // audit entry above then claims a reset that did not survive the minute it was written in.
  assert.equal(
    settingRows.get('mintsoft_order_delta_generation'),
    '1',
    'the reset arms the fence in the same transaction that clears the cursors',
  )
  assert.equal(entry.level, 'WARNING')
  assert.match(entry.description, /delta cursors reset/)
})

test('an order-dispatch save that leaves the delta scope alone is INFO with no cursor reset', async () => {
  const { saveMintsoftOrderDispatchSettings } = await loadActions()
  reset()
  settingRows.set('mintsoft_client_id', '89')
  settingRows.set('mintsoft_channel_id', '')
  settingRows.set('mintsoft_warehouse_id', '')
  settingRows.set('mintsoft_default_courier_service_id', '12')
  settingRows.set('mintsoft_admin_order_url_template', '')

  await saveMintsoftOrderDispatchSettings({
    adminOrderUrlTemplate: '',
    defaultCourierServiceId: '34',
    clientId: '89',
    channelId: '',
    warehouseId: '',
  })

  const entry = logs.find((log) => log.action === 'mintsoft_order_dispatch_settings_updated')
  if (!entry) throw new Error('no dispatch-settings audit entry was written')
  assert.equal(entry.level, 'INFO')
  assert.equal(entry.metadata?.scopeChanged, false)
  assert.equal(entry.metadata?.cursorsReset, false)
  assert.equal(
    settingRows.get('mintsoft_order_delta_generation'),
    undefined,
    'a save that resets nothing must not move the generation — every bump refuses a sweep that is '
      + 'in flight, so bumping without a reset throws away a legitimate advance for nothing',
  )
  assert.deepEqual(deletedSettingKeys, [], 'an unchanged scope must not restart the delta watermark')
  assert.deepEqual(entry.metadata?.changed, ['defaultCourierServiceId'])
  assert.deepEqual(entry.metadata?.before, { defaultCourierServiceId: '12' })
})


test('the dispatch before-image is read under a lock INSIDE the write transaction, not before it', async () => {
  // Codex r10 #2. Two saves in flight: this one reads `clientId = 89`, another commits `101`, and
  // this one commits `89` back. A snapshot taken outside the transaction says "nothing changed" —
  // an audit entry describing a transition that never occurred, while the one it DID cause
  // (101 -> 89) is recorded nowhere. Under the row lock the other save cannot commit in that
  // window, so what this reads is what it replaces.
  const { saveMintsoftOrderDispatchSettings } = await loadActions()
  reset()
  settingRows.set('mintsoft_client_id', '89')
  settingRows.set('mintsoft_channel_id', '')
  settingRows.set('mintsoft_warehouse_id', '')
  settingRows.set('mintsoft_default_courier_service_id', '12')
  settingRows.set('mintsoft_admin_order_url_template', '')
  concurrentWrite = new Map([['mintsoft_client_id', '101']])

  const result = await saveMintsoftOrderDispatchSettings({
    adminOrderUrlTemplate: '',
    defaultCourierServiceId: '12',
    clientId: '89',
    channelId: '',
    warehouseId: '',
  })
  assert.equal(result.success, true)

  const entry = logs.find((log) => log.action === 'mintsoft_order_dispatch_settings_updated')
  if (!entry) throw new Error('no dispatch-settings audit entry was written')
  assert.deepEqual(
    entry.metadata?.before,
    { clientId: '101' },
    'the entry must name the value it actually replaced, not one a concurrent save had already moved on from',
  )
  assert.deepEqual(entry.metadata?.after, { clientId: '89' })
  assert.deepEqual(entry.metadata?.changed, ['clientId'])

  // ...and the SAME snapshot decides the cursor reset. Deciding it from the stale read would leave
  // the delta watermark pointing at the 101 scope while the connector queries the 89 one.
  assert.equal(entry.metadata?.scopeChanged, true)
  assert.equal(entry.metadata?.cursorsReset, true)
  assert.deepEqual(deletedSettingKeys, ['mintsoft_order_delta_since', 'mintsoft_order_reconcile_at'])

  // No unlocked read of the settings table happened at all on this path.
  assert.equal(
    trace.some((step) => step.startsWith('unlocked-')),
    false,
    `an unlocked settings read is the defect itself; trace was ${trace.join(' -> ')}`,
  )
})

test('the dispatch lock covers exactly the five keys the save overwrites, before it writes any of them', async () => {
  const { saveMintsoftOrderDispatchSettings } = await loadActions()
  reset()
  settingRows.set('mintsoft_client_id', '89')

  await saveMintsoftOrderDispatchSettings({
    adminOrderUrlTemplate: '',
    defaultCourierServiceId: '',
    clientId: '89',
    channelId: '',
    warehouseId: '',
  })

  assert.deepEqual(lockedKeys, [
    'mintsoft_admin_order_url_template',
    'mintsoft_channel_id',
    'mintsoft_client_id',
    'mintsoft_default_courier_service_id',
    'mintsoft_warehouse_id',
  ], 'a key left out of the lock is a key another save can move under this one')

  // Rows are MATERIALISED before they are locked — FOR UPDATE locks only rows that exist, so an
  // absent key could otherwise be INSERTed by a concurrent writer between the read and the upsert
  // and the before-image would report "unset" for a value that had just been set.
  assert.equal(trace.indexOf('materialise') >= 0, true)
  assert.ok(trace.indexOf('materialise') < trace.indexOf('locked-read'))
  assert.ok(
    trace.indexOf('locked-read') < trace.findIndex((step) => step.startsWith('upsert:')),
    'a lock taken after the write it protects protects nothing',
  )
})

// ---------------------------------------------------------------------------
// The case the issue actually names: a BINDING save. It logged after-values only — five of them —
// so "somebody moved this binding out of ALIGN_TO_WMS" left no record of what it had been.
// ---------------------------------------------------------------------------

const BASE_BINDING = {
  id: 'bind-1',
  warehouseId: 'wh-1',
  externalWarehouseId: '7',
  active: true,
  stockSyncMode: 'NOTIFICATION_ONLY',
  stockMasterSystem: 'IMS',
  bundleSyncDirection: 'DISABLED',
  returnsMode: 'DISABLED',
  syncFrequencyMinutes: 60,
  discrepancyThresholds: null,
  reportRecipients: ['ops@example.test'],
  alignDownReasonId: null,
  alignmentConfirmedAt: null,
}

test('a binding save records what each field moved FROM, not just its new value', async () => {
  const { saveMintsoftBinding } = await loadActions()
  reset()
  existingBindingRow = { ...BASE_BINDING }

  const result = await saveMintsoftBinding({
    id: 'bind-1',
    warehouseId: 'wh-1',
    externalWarehouseId: '7',
    active: true,
    stockSyncMode: 'NOTIFICATION_ONLY',
    stockMasterSystem: 'IMS',
    bundleSyncDirection: 'DISABLED',
    returnsMode: 'POLL',
    syncFrequencyMinutes: 15,
    reportRecipients: ['ops@example.test', 'wh@example.test'],
  })
  assert.equal(result.success, true)

  const entry = logs.find((log) => log.action === 'mintsoft_binding_updated')
  if (!entry) throw new Error(`no binding audit entry was written (saw: ${logs.map((l) => l.action).join(', ') || 'nothing'})`)

  assert.equal(entry.metadata?.created, false)
  assert.deepEqual(entry.metadata?.changed, ['reportRecipients', 'returnsMode', 'syncFrequencyMinutes'])
  // THE HALF THAT DID NOT EXIST BEFORE.
  assert.deepEqual(entry.metadata?.before, {
    reportRecipients: ['ops@example.test'],
    returnsMode: 'DISABLED',
    syncFrequencyMinutes: 60,
  })
  assert.deepEqual(entry.metadata?.after, {
    reportRecipients: ['ops@example.test', 'wh@example.test'],
    returnsMode: 'POLL',
    syncFrequencyMinutes: 15,
  })
  // Untouched fields stay out of the diff — the entry says what changed, not what the row contains.
  assert.equal('externalWarehouseId' in (entry.metadata?.before as object), false)
  assert.match(entry.description, /changed reportRecipients, returnsMode, syncFrequencyMinutes/)
})

test('creating a binding is audited as created, with an empty before half', async () => {
  const { saveMintsoftBinding } = await loadActions()
  reset()
  existingBindingRow = null

  const result = await saveMintsoftBinding({
    warehouseId: 'wh-2',
    externalWarehouseId: '9',
    stockSyncMode: 'NOTIFICATION_ONLY',
  })
  assert.equal(result.success, true)

  const entry = logs.find((log) => log.action === 'mintsoft_binding_created')
  if (!entry) throw new Error('no binding-created audit entry was written')
  assert.equal(entry.metadata?.created, true)
  assert.deepEqual(entry.metadata?.before, {})
  assert.equal((entry.metadata?.after as Record<string, unknown>).externalWarehouseId, '9')
  assert.equal(entry.metadata?.warehouseId, 'wh-2')
})
