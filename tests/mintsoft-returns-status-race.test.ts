import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Changing a returns-inbox status must not overwrite RESTOCKED. The action reads the row, then writes:
 * a restock that commits between the two used to be overwritten by an unconditional update, which let
 * a second restock add the stock again. Drives the REAL action over a fake row.
 */
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshAdmin: async () => ({ user: { id: 'user-1' } }),
    requireAdmin: async () => ({ user: { id: 'user-1' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1' } }),
    requireRole: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
  },
})
const logs: string[] = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { logs.push(entry.action) },
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})

type Row = { id: string; connector: string; externalReturnId: string; status: string }
let row: Row
let restockLandsBeforeWrite = false
const db = {
  wmsReturnsInbox: {
    findFirst: async () => ({ ...row }),
    // Honours the status predicate the way Postgres does after waiting on the restock's row lock.
    updateMany: async (args: { where: { id: string; status?: { not: string } }; data: Record<string, unknown> }) => {
      if (restockLandsBeforeWrite) row.status = 'RESTOCKED'
      if (args.where.status && row.status === args.where.status.not) return { count: 0 }
      Object.assign(row, { status: args.data.status })
      return { count: 1 }
    },
    // The old unconditional write.
    update: async (args: { data: Record<string, unknown> }) => {
      if (restockLandsBeforeWrite) row.status = 'RESTOCKED'
      Object.assign(row, { status: args.data.status })
      return row
    },
  },
}
mock.module('@/lib/db', { namedExports: { db } })

const ID = 'ckabcdefghijklmnopqrstuv0'

test('a status change that loses the race to a restock does not overwrite RESTOCKED', async () => {
  const { updateMintsoftReturnInboxStatus } = await import('@/app/actions/mintsoft-sync')
  row = { id: ID, connector: 'mintsoft', externalReturnId: 'R1', status: 'PENDING' }
  restockLandsBeforeWrite = true
  logs.length = 0
  const result = await updateMintsoftReturnInboxStatus(ID, 'DISMISSED')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /already been restocked/)
  assert.equal(row.status, 'RESTOCKED')
  assert.deepEqual(logs, [], 'no status change is logged for a write that did not happen')
})

test('without a race the status change still lands', async () => {
  const { updateMintsoftReturnInboxStatus } = await import('@/app/actions/mintsoft-sync')
  row = { id: ID, connector: 'mintsoft', externalReturnId: 'R1', status: 'PENDING' }
  restockLandsBeforeWrite = false
  const result = await updateMintsoftReturnInboxStatus(ID, 'DISMISSED')
  assert.equal(result.success, true)
  assert.equal(row.status, 'DISMISSED')
})
