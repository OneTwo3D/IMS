import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

/**
 * o3d-1fel — action-level authorization on the accounting reads.
 *
 * A `'use server'` export is a directly POST-callable HTTP endpoint. Several
 * reads in app/actions/xero-sync.ts had no guard at all; the only thing
 * "hiding" them was that the connector-facade allowlist in
 * server-action-guard-coverage.test.ts covered the whole module with a `*`.
 * An allowlist entry is not access control.
 *
 * These tests drive the REAL requirePermission/hasPermission by mocking only
 * the session source, so what is asserted is the actual RBAC decision:
 *   - WHICH principal is refused,
 *   - WHICH permission the refusal names,
 *   - and that the database was never touched on the refused path.
 *
 * The last point is the one that matters: a guard that throws only AFTER the
 * read has already run still leaks. Round 3 makes it mean something — the
 * recorder in ./recording-db.ts will not certify an empty touch list until it has
 * PROVED, in this process, that it can see a read (Codex round 3, finding 6).
 * Four of the refusals below asserted nothing about reads at all.
 */

type Role = 'ADMIN' | 'MANAGER' | 'FINANCE' | 'WAREHOUSE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  currentRole = 'ADMIN'
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')
  await recorder.prove(() => getAccountingAccounts())
})

test('getAccountingAccounts refuses a WAREHOUSE session, naming the sync permission, without reading the chart of accounts', async () => {
  currentRole = 'WAREHOUSE'
  recorder.reset()
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')

  await assert.rejects(
    () => getAccountingAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected an Error')
      // The specific refusal, not merely "it threw".
      assert.equal((error as { permission?: string }).permission, 'sync')
      assert.match(error.message, /Forbidden: missing permission sync/)
      return true
    },
  )

  recorder.assertNoReads('WAREHOUSE calling getAccountingAccounts')
})

test('getAccountingAccounts reads the chart of accounts for an ADMIN session', async () => {
  // The guard must refuse the unauthorized role WITHOUT breaking the authorized
  // one — otherwise the test above would also pass on a permanently broken action.
  currentRole = 'ADMIN'
  recorder.reset()
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')

  await getAccountingAccounts()
  recorder.assertCalls(['accountingAccount.findMany'], 'ADMIN calling getAccountingAccounts')
})

/**
 * o3d-512h round 3, Codex finding 4 — the gate accounting-sync.ts SAYS this
 * module applies.
 *
 * The dispatcher note in app/actions/accounting-sync.ts gates each dispatcher on
 * the LOOSEST of its two branches' gates, and justifies that by saying the
 * stricter branch — Xero — "keeps enforcing its own on top", naming
 * requireRole('ADMIN'). It did not. xero-sync.ts's module-local `requireAdmin`
 * was `requirePermission('sync')` verbatim, so MANAGER passed the dispatcher and
 * then passed the delegate too, and the whole loosest-gate argument rested on a
 * frame that was not there.
 *
 * This is the executable version of that claim. It is the third round in which
 * this sentence has appeared; it is the first in which the code makes it true.
 */
test('MANAGER holds `sync` and is STILL refused by the Xero delegate — the stricter branch the dispatcher note relies on', async () => {
  currentRole = 'MANAGER'
  recorder.reset()
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')

  await assert.rejects(
    () => getAccountingAccounts(),
    (error: unknown) => {
      // requireRole carries no permission name in this codebase, so the assertion
      // is on the ROLE decision — and, critically, that it is a different refusal
      // from the 'sync' one above. If this ever comes back as
      // `permission === 'sync'` the ADMIN check has been dropped again.
      assert.equal((error as { permission?: string }).permission, undefined)
      assert.match(String((error as Error).message), /^Forbidden$/)
      return true
    },
  )

  recorder.assertNoReads('MANAGER calling getAccountingAccounts')
})

test('MANAGER is refused by every Xero export, not just the one', async () => {
  currentRole = 'MANAGER'
  const mod = await import('@/app/actions/xero-sync')
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['getXeroSettingsMasked', () => mod.getXeroSettingsMasked()],
    ['getXeroConnectionStatus', () => mod.getXeroConnectionStatus()],
    ['getXeroSyncLogs', () => mod.getXeroSyncLogs(5)],
    ['getXeroSyncReadiness', () => mod.getXeroSyncReadiness()],
    ['fetchXeroTaxRates', () => mod.fetchXeroTaxRates()],
    ['getXeroConnectionTestState', () => mod.getXeroConnectionTestState()],
  ]
  for (const [name, call] of calls) {
    recorder.reset()
    await assert.rejects(call, (error: unknown) => {
      assert.match(String((error as Error).message), /^Forbidden$/, `${name} must refuse MANAGER`)
      return true
    })
    recorder.assertNoReads(`MANAGER calling ${name}`)
  }
})

for (const role of ['WAREHOUSE', 'READONLY', 'FINANCE', 'SUPPLIER'] as const) {
  test(`every Xero read refuses a ${role} session by NAME, before touching the database`, async () => {
    // FINANCE is the interesting one: it holds no 'sync', so it is refused at the
    // permission frame like the rest — while syncAccountingAccountBalanceSnapshots
    // (requireRole ADMIN,FINANCE) still admits it. Two gates in one module that
    // deliberately disagree, and both are load-bearing.
    currentRole = role
    const mod = await import('@/app/actions/xero-sync')
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['getAccountingAccounts', () => mod.getAccountingAccounts()],
      ['getXeroSettingsMasked', () => mod.getXeroSettingsMasked()],
      ['getXeroConnectionStatus', () => mod.getXeroConnectionStatus()],
      ['getXeroSyncLogs', () => mod.getXeroSyncLogs(5)],
      ['getXeroSyncReadiness', () => mod.getXeroSyncReadiness()],
      ['fetchXeroTaxRates', () => mod.fetchXeroTaxRates()],
    ]
    for (const [name, call] of calls) {
      recorder.reset()
      await assert.rejects(call, (error: unknown) => {
        assert.equal(
          (error as { permission?: string }).permission,
          'sync',
          `${name} must refuse ${role} by naming the sync permission`,
        )
        return true
      })
      recorder.assertNoReads(`${role} calling ${name}`)
    }
  })
}

test('fetchXeroTaxRates refuses before making the outbound Xero call', async () => {
  // Not only a data leak: an open endpoint that calls the tenant's Xero org is
  // request amplification against a rate-limited third party.
  currentRole = 'WAREHOUSE'
  recorder.reset()
  const { fetchXeroTaxRates } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => fetchXeroTaxRates(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
  recorder.assertNoReads('WAREHOUSE calling fetchXeroTaxRates')
})
