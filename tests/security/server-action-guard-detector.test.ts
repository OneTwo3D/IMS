import assert from 'node:assert/strict'
import test from 'node:test'

import { scanSource } from './server-action-guard-scan'

/**
 * o3d-hic9 — tests for the DETECTOR itself, not for the app tree.
 *
 * o3d-1fel survived because the detector's `isDelegatingFacade` heuristic was
 * never exercised against anything but the live code, where a false negative is
 * invisible by construction: the test simply passes. These fixtures pin both
 * directions — what must be flagged, and what must not be.
 */

const F = 'fixture.ts'
const useServer = (body: string) => `'use server'\n\n${body}\n`

// ---------------------------------------------------------------------------
// The o3d-1fel defect itself
// ---------------------------------------------------------------------------

test('flags a one-statement `return db.<model>.findMany()` — a Prisma call is not a delegate', () => {
  // This is verbatim the shape of xero-sync.ts:getAccountingAccounts.
  const src = useServer(`
export async function getAccountingAccounts() {
  return db.accountingAccount.findMany({ where: { connector: 'xero' } })
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:getAccountingAccounts`])
})

test('flags a one-statement `return prisma.<model>.create()` too', () => {
  const src = useServer(`
export async function writeIt() {
  return prisma.setting.create({ data: {} })
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:writeIt`])
})

test('flags an awaited Prisma one-liner', () => {
  const src = useServer(`
export async function readIt() {
  return await db.user.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:readIt`])
})

// ---------------------------------------------------------------------------
// Prose must neither satisfy nor trip the detector
// ---------------------------------------------------------------------------

test('a guard named only in a doc comment does NOT satisfy the detector', () => {
  // The failure mode this repo has hit before is a guard that matches words in
  // comments. Here the risk runs the other way: prose must not be accepted AS
  // the guard. `requirePermission` appears only as trivia, so the export is
  // still unguarded and must be flagged.
  const src = useServer(`
/**
 * Callers must hold requirePermission('sync') before invoking this.
 * See requireAuth and requireFreshAdmin for the surrounding policy.
 */
export async function looksGuardedInProseOnly() {
  const rows = await db.setting.findMany()
  return rows
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:looksGuardedInProseOnly`])
})

test('a guard named only in a string literal does NOT satisfy the detector', () => {
  const src = useServer(`
export async function stringOnly() {
  const note = 'requireAuth is applied by the caller'
  const rows = await db.setting.findMany()
  return { note, rows }
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:stringOnly`])
})

test('a genuinely guarded export mentioning nothing in prose is NOT flagged', () => {
  const src = useServer(`
export async function guarded() {
  await requirePermission('sync')
  return db.accountingAccount.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('prose in a NON-server module does not produce a violation', () => {
  // No 'use server' prologue: nothing here is an RPC endpoint, and the words
  // "use server" appearing in a comment must not make it one.
  const src = `
// This helper is only ever called from a 'use server' module.
export async function notAnEndpoint() {
  return db.setting.findMany()
}
`
  assert.deepEqual(scanSource(F, src), [])
})

// ---------------------------------------------------------------------------
// The facade escape hatch still works for real facades
// ---------------------------------------------------------------------------

test('a real delegating facade is not flagged', () => {
  const src = useServer(`
export async function getShoppingSyncSettings() {
  return getWcSyncSettings()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a facade delegating through a connector object is not flagged', () => {
  const src = useServer(`
export async function getAccounts() {
  return connector.getAccounts()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a multi-statement dispatcher is flagged unless allowlisted', () => {
  const src = useServer(`
export async function dispatch() {
  const connector = await getActiveConnector()
  return connector.getAccounts()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:dispatch`])
  assert.deepEqual(
    scanSource(F, src, { [`${F}:dispatch`]: 'dispatcher → guarded delegate' }),
    [],
  )
})

// ---------------------------------------------------------------------------
// Allowlist mechanics
// ---------------------------------------------------------------------------

test('a module wildcard suppresses every export in that file', () => {
  const src = useServer(`
export async function a() { return db.x.findMany() }
export async function b() { return db.y.findMany() }`)
  assert.deepEqual(scanSource(F, src), [`${F}:a`, `${F}:b`])
  assert.deepEqual(scanSource(F, src, { [`${F}:*`]: 'reason' }), [])
})

test('a non-exported unguarded function is not flagged', () => {
  const src = useServer(`
async function helper() { return db.x.findMany() }
export async function guarded() {
  await requireAuth()
  return helper()
}`)
  assert.deepEqual(scanSource(F, src), [])
})
