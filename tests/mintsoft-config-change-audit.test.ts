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
mock.module('@/lib/db', {
  namedExports: {
    db: {
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
      // The array form: Prisma has already evaluated each delegate call by the time it gets here,
      // so this only has to settle them.
      $transaction: async (operations: unknown[]) => Promise.all(operations),
      setting: {
        findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
          const keys = where?.key?.in
          const rows = [...settingRows].map(([key, value]) => ({ key, value }))
          return keys ? rows.filter((row) => keys.includes(row.key)) : rows
        },
        findUnique: async ({ where }: { where: { key: string } }) =>
          settingRows.has(where.key) ? { key: where.key, value: settingRows.get(where.key) } : null,
        upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
          upserts.push({ key: where.key, value: update.value })
          settingRows.set(where.key, update.value)
          return { key: where.key, value: update.value }
        },
        deleteMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
          const keys = where?.key?.in ?? []
          let count = 0
          for (const key of keys) if (settingRows.delete(key)) count += 1
          deletedSettingKeys.push(...keys)
          return { count }
        },
      },
    },
  },
})

async function loadActions() {
  return import('@/app/actions/mintsoft-sync')
}

function reset() {
  logs.length = 0
  upserts.length = 0
  deletedSettingKeys.length = 0
  bindingUpdates.length = 0
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
  assert.deepEqual(deletedSettingKeys, [], 'an unchanged scope must not restart the delta watermark')
  assert.deepEqual(entry.metadata?.changed, ['defaultCourierServiceId'])
  assert.deepEqual(entry.metadata?.before, { defaultCourierServiceId: '12' })
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
