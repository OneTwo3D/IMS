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
test('MANAGER holds `sync` and is STILL refused by the Xero CREDENTIAL delegate — the stricter branch the dispatcher note relies on', async () => {
  // SUPERSEDED SUBJECT (o3d-m3gy): this used to assert the refusal on `getAccountingAccounts`, a
  // READ, because round 3 applied the ADMIN role to every export in xero-sync.ts. The claim it is
  // making — that a stricter frame exists behind the dispatcher — is unchanged and is now asserted on
  // `testXeroConnection`, which exercises the tenant's stored OAuth credentials against Xero. That is
  // the surface the dispatcher note is actually about ("saveXeroSettings → requireRole('ADMIN')") and
  // round 3's own justification ("connector OAuth credentials are ADMIN business").
  //
  // WHY THE READS CAME BACK TO 'sync', and it is not a softening. On current `development` the /sync
  // page treats a denial from ANY of its reads as FATAL (o3d-osl8) — a partial page is a dishonest
  // answer to a denial — and seven of those reads route through this module. An ADMIN-only read
  // surface therefore does not narrow MANAGER's reach, it replaces the whole /sync page (QuickBooks
  // half included) with the generic error boundary, which is the opposite of round 3's stated reach
  // change: "It keeps the whole QuickBooks branch". tests/accounting/dashboard-read-gates.test.ts
  // measures that outcome directly, and the counter-guard below pins the reads that must keep working.
  currentRole = 'MANAGER'
  recorder.reset()
  const { testXeroConnection } = await import('@/app/actions/xero-sync')

  await assert.rejects(
    () => testXeroConnection(),
    (error: unknown) => {
      // The ROLE decision, and critically a DIFFERENT refusal from the 'sync' one above: a role
      // denial carries `permission: null` (it was not about a permission), where a permission denial
      // names it. If this ever comes back as `permission === 'sync'` the ADMIN check has been dropped
      // again; if it comes back `undefined` the denial has lost its ability to say which kind it is.
      assert.equal((error as { permission?: string | null }).permission, null)
      assert.match(String((error as Error).message), /^Forbidden$/)
      return true
    },
  )

  recorder.assertNoReads('MANAGER calling testXeroConnection')
})

test('MANAGER is refused by every Xero CREDENTIAL export, not just the one', async () => {
  // SUPERSEDED LIST (o3d-m3gy): this enumerated the six READ exports. It now enumerates the
  // credential surface, for the reason given on the test above. The shape of the claim — "not just
  // the one", i.e. the ADMIN frame is on the whole surface rather than on whichever export a reviewer
  // happened to check — is exactly preserved; what changed is which surface it is.
  //
  // The `save*` / `connect*` exports catch their own errors and return `{ success: false }` (they
  // report to a form, not to an error boundary), so they are asserted on the RESULT. A refusal that
  // arrives as a value is still a refusal; what would not be acceptable is `success: true`.
  currentRole = 'MANAGER'
  const mod = await import('@/app/actions/xero-sync')

  recorder.reset()
  await assert.rejects(() => mod.testXeroConnection(), (error: unknown) => {
    assert.match(String((error as Error).message), /^Forbidden$/, 'testXeroConnection must refuse MANAGER')
    return true
  })
  recorder.assertNoReads('MANAGER calling testXeroConnection')

  const swallowing: Array<[string, () => Promise<{ success: boolean }>]> = [
    ['saveXeroSettings', () => mod.saveXeroSettings({ xero_client_id: 'x' })],
    ['saveXeroConnectionSettings', () => mod.saveXeroConnectionSettings('id', 'secret')],
    ['connectXero', () => mod.connectXero('id', 'secret', 'https://ims.example', '/sync')],
    ['disconnectXero', () => mod.disconnectXero()],
  ]
  for (const [name, call] of swallowing) {
    recorder.reset()
    const result = await call()
    assert.equal(result.success, false, `${name} must refuse MANAGER`)
  }
})

test('o3d-m3gy: MANAGER KEEPS every Xero read the /sync page performs', async () => {
  // The counter-guard the scoping needs, and the one the merge exists for. "The credential surface is
  // ADMIN" must not drift back into "the module is ADMIN": each of these is a read
  // app/(dashboard)/sync/page.tsx performs, the page fails WHOLE on any denial, and MANAGER holds the
  // page's own permission. A refusal here is not a tighter gate, it is a 500 where the page was owed.
  currentRole = 'MANAGER'
  const mod = await import('@/app/actions/xero-sync')
  const reads: Array<[string, () => Promise<unknown>]> = [
    ['getXeroSettingsMasked', () => mod.getXeroSettingsMasked()],
    ['getXeroConnectionStatus', () => mod.getXeroConnectionStatus()],
    ['getXeroSyncLogs', () => mod.getXeroSyncLogs(5)],
    ['getXeroSyncReadiness', () => mod.getXeroSyncReadiness()],
    ['getXeroConnectionTestState', () => mod.getXeroConnectionTestState()],
    ['getAccountingAccounts', () => mod.getAccountingAccounts()],
  ]
  for (const [name, read] of reads) {
    recorder.reset()
    await assert.doesNotReject(read, `${name} must admit MANAGER — the /sync page cannot render without it`)
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
