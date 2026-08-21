import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { createRecordingDb } from './recording-db'

/**
 * o3d-512h round 2, finding 3 — app/actions/accounting-sync.ts dispatchers.
 *
 * These exports were allowlisted in server-action-guard-coverage.test.ts with a
 * reason naming the delegate whose guard each "inherits". A dispatcher that
 * answers `if (!connector) return …` never reaches that delegate, so on exactly
 * the path an unauthorized caller takes there was no guard at all — the
 * justification was false where it mattered. Reaching the `!connector` branch
 * also means `isIntegrationPluginEnabled` already ran, i.e. the refused caller
 * got a database read and an oracle for whether an accounting integration is
 * configured.
 *
 * A written justification is not access control; neither is an allowlist entry.
 * Every dispatcher now carries the delegate's own gate, and the allowlist
 * entries are deleted.
 *
 * As with the other tests in this directory, only the session source is mocked
 * so the assertions are about the real RBAC decision: which principal, which
 * permission, and that nothing was read.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// Round 3 (Codex finding 6): a recorder that has PROVED it can see a read. An
// empty touch list from a mock that was never wired to the module under test is
// indistinguishable from a real refusal, and every "nothing was read" assertion
// in this file rested on not being able to tell those apart.
const recorder = createRecordingDb([])
mock.module('@/lib/db', { namedExports: { db: recorder.db } })

before(async () => {
  currentRole = 'ADMIN'
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  await recorder.prove(() => getAccountingSettingsMasked())
})

/**
 * The dispatchers whose `!connector` arm returns without ever reaching a
 * delegate — the ones the allowlist reason was actually false about. Each is
 * called with the arguments a real caller would pass.
 */
const EARLY_RETURN_DISPATCHERS: Array<{
  name: string
  call: (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
}> = [
  { name: 'getAccountingConnectionTestState', call: (m) => m.getAccountingConnectionTestState() },
  { name: 'testAccountingConnection', call: (m) => m.testAccountingConnection() },
  { name: 'saveAccountingConnectionSettings', call: (m) => m.saveAccountingConnectionSettings(...(['id', 'secret'] as never[])) },
  { name: 'connectAccountingConnector', call: (m) => m.connectAccountingConnector(...(['id', 'secret', 'https://ims.example.test'] as never[])) },
]

for (const { name, call } of EARLY_RETURN_DISPATCHERS) {
  test(`${name} refuses a WAREHOUSE session, naming the sync permission, without reaching the plugin-state read`, async () => {
    currentRole = 'WAREHOUSE'
    recorder.reset()
    const mod = await import('@/app/actions/accounting-sync')

    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'sync')
        assert.match(error.message, /Forbidden: missing permission sync/)
        return true
      },
    )

    recorder.assertNoReads(`${name} refusing this principal`)
  })
}

test('a refused dispatcher does not answer with the "Enable Xero or QuickBooks first" oracle', async () => {
  // The early-return arm is a fact about the tenant's configuration. Under the
  // old allowlist a WAREHOUSE session got that fact as a normal, non-throwing
  // result, which is why "it delegates to a guarded action" was never true here.
  currentRole = 'WAREHOUSE'
  const { testAccountingConnection } = await import('@/app/actions/accounting-sync')
  const outcome = await testAccountingConnection().then(
    (value) => ({ returned: value }),
    (error: unknown) => ({ threw: error }),
  )
  assert.ok('threw' in outcome, `expected a refusal, got: ${JSON.stringify(outcome)}`)
})

test('getAccountingSettingsMasked refuses a READONLY session naming the sync permission', async () => {
  currentRole = 'READONLY'
  recorder.reset()
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => getAccountingSettingsMasked(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
  recorder.assertNoReads('refused dispatcher')
})

test('getAccountingSyncLogs refuses a SUPPLIER session naming the sync permission, before any plugin-state read', async () => {
  // This dispatcher always falls back to a delegate, so it refused even before
  // the fix — but only AFTER resolving the active connector, i.e. after a
  // database read on behalf of a principal that may not read anything here. The
  // no-reads assertion is what distinguishes "the delegate eventually said no"
  // from "the dispatcher said no first".
  currentRole = 'SUPPLIER'
  recorder.reset()
  const { getAccountingSyncLogs } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => getAccountingSyncLogs(5),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
  recorder.assertNoReads('refused dispatcher')
})

test('previewMissingAccountingTaxRates refuses a MANAGER session, naming settings.company', async () => {
  // MANAGER holds 'sync' but not 'settings.company'. The dispatcher must match
  // the delegate it routes to (settings.ts:previewMissingXeroTaxRates), not the
  // permission its neighbours use — a guard copied from the wrong sibling would
  // widen reach while looking correct.
  currentRole = 'MANAGER'
  recorder.reset()
  const { previewMissingAccountingTaxRates } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => previewMissingAccountingTaxRates(),
    (error: unknown) => {
      assert.equal((error as { permission?: string }).permission, 'settings.company')
      return true
    },
  )
  recorder.assertNoReads('refused dispatcher')
})

test('MANAGER keeps the sync reach it legitimately had', async () => {
  // Too tight is also a defect. MANAGER holds 'sync', so the guarded dispatcher
  // must still run for them and return the ordinary not-configured answer.
  currentRole = 'MANAGER'
  const { getAccountingConnectionTestState } = await import('@/app/actions/accounting-sync')
  assert.deepEqual(await getAccountingConnectionTestState(), {
    status: 'never', testedAt: null, message: '', fingerprint: null,
  })
})

test('syncAccountingAccountBalanceSnapshots refuses a WAREHOUSE session before reading plugin state', async () => {
  // This one's delegate gates on requireRole('ADMIN','FINANCE'), which throws a
  // plain 'Forbidden' — requireRole carries no permission name in this codebase,
  // so the assertion is on the role decision and on nothing being read.
  currentRole = 'WAREHOUSE'
  recorder.reset()
  const { syncAccountingAccountBalanceSnapshots } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => syncAccountingAccountBalanceSnapshots(),
    (error: unknown) => {
      assert.match(String((error as Error).message), /^Forbidden$/)
      return true
    },
  )
  recorder.assertNoReads('refused dispatcher')
})

test('syncAccountingAccountBalanceSnapshots still runs for FINANCE, which holds no sync permission', async () => {
  // The delegate admits ADMIN and FINANCE. Gating the dispatcher on 'sync' —
  // the permission every neighbouring dispatcher uses — would have locked
  // FINANCE out of its own balance snapshots. This is the case that proves the
  // guard matches the delegate rather than the file.
  currentRole = 'FINANCE'
  const { syncAccountingAccountBalanceSnapshots } = await import('@/app/actions/accounting-sync')
  const result = await syncAccountingAccountBalanceSnapshots()
  assert.deepEqual(result.errors, ['Enable Xero or QuickBooks first.'])
})

test('ADMIN reaches every guarded dispatcher', async () => {
  currentRole = 'ADMIN'
  const mod = await import('@/app/actions/accounting-sync')
  assert.deepEqual(await mod.testAccountingConnection(), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
  assert.deepEqual(await mod.saveAccountingConnectionSettings('id', 'secret'), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
  assert.deepEqual(await mod.connectAccountingConnector('id', 'secret', 'https://ims.example.test'), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
})

// ---------------------------------------------------------------------------
// app/actions/accounting-batch.ts — the same defect, found while checking
// whether the accounting-sync allowlist reason was true anywhere else.
//
// These three carried NO guard and sat under `'accounting-batch.ts:*': connector
// facade → guarded daily-batch actions`. With neither connector active they
// answer from their own module (`emptyAccountingBatchPreview()` / `[]`), so on
// that arm there is no delegate to inherit from — after
// getActiveAccountingConnectorInfo has already read plugin state. Both branches'
// delegates gate on requirePermission('sync'), so that is now on the dispatcher
// and the allowlist entry is deleted.
// ---------------------------------------------------------------------------

const BATCH_DISPATCHERS: Array<{
  name: string
  call: (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
}> = [
  { name: 'getAccountingBatchPreview', call: (m) => m.getAccountingBatchPreview() },
  { name: 'getAccountingBatchHistory', call: (m) => m.getAccountingBatchHistory() },
  { name: 'refreshAccountingBatchPreview', call: (m) => m.refreshAccountingBatchPreview() },
]

for (const { name, call } of BATCH_DISPATCHERS) {
  test(`${name} refuses a WAREHOUSE session, naming the sync permission, without reading plugin state`, async () => {
    currentRole = 'WAREHOUSE'
    recorder.reset()
    const mod = await import('@/app/actions/accounting-batch')

    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'sync')
        assert.match(error.message, /Forbidden: missing permission sync/)
        return true
      },
    )

    recorder.assertNoReads(`${name} refusing this principal`)
  })

  test(`${name} refuses a READONLY session too`, async () => {
    currentRole = 'READONLY'
    const mod = await import('@/app/actions/accounting-batch')
    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => (error as { permission?: string }).permission === 'sync',
    )
  })
}

test('MANAGER keeps the daily-batch reach its delegate grants it', async () => {
  // Both delegates gate on 'sync', which MANAGER holds. Copying the ADMIN-only
  // gate the Xero *sync* actions use would have taken the batch dashboard away
  // from a role entitled to it.
  currentRole = 'MANAGER'
  const { getAccountingBatchHistory } = await import('@/app/actions/accounting-batch')
  assert.deepEqual(await getAccountingBatchHistory(), [])
})

test('ADMIN reaches the batch preview and gets the ordinary no-connector answer', async () => {
  currentRole = 'ADMIN'
  const { getAccountingBatchPreview } = await import('@/app/actions/accounting-batch')
  const preview = await getAccountingBatchPreview()
  assert.equal(typeof preview, 'object')
  assert.ok(preview !== null)
})

// ---------------------------------------------------------------------------
// o3d-512h round 3, Codex finding 4 — the loosest-gate argument, made executable.
//
// The dispatcher note in app/actions/accounting-sync.ts gates every dispatcher on
// the LOOSEST gate its two branches' delegates apply, and justifies that with
// "the stricter branch keeps enforcing its own on top", naming the Xero delegates'
// requireRole('ADMIN'). For two rounds that stricter frame did not exist:
// xero-sync.ts's module-local `requireAdmin` was `requirePermission('sync')`, the
// same gate as the dispatcher, so a MANAGER passed both.
//
// The pair below is the whole argument in two assertions: MANAGER gets THROUGH
// the dispatcher (so the loosest gate really is loose) and is refused by the Xero
// delegate (so the strictness really is enforced somewhere). If either half
// stops holding, the note above the dispatchers has become false again.
// ---------------------------------------------------------------------------

test('MANAGER passes the accounting dispatcher and is refused by the XERO CREDENTIAL delegate behind it', async () => {
  // SUPERSEDED SUBJECT (o3d-m3gy): this used to make the argument on `getAccountingSettingsMasked`,
  // a READ, because round 3 applied the ADMIN role to every export in xero-sync.ts. It now makes the
  // identical argument on the CREDENTIAL surface — the one the dispatcher note's own sentence is
  // about ("saveXeroSettings → requireRole('ADMIN'), which still applies on its own path").
  //
  // WHY THE SUBJECT MOVED, and it is not a softening. `development`'s /sync page treats a denial from
  // ANY of its reads as FATAL (o3d-osl8), and seven of those reads route through xero-sync.ts. An
  // ADMIN-only READ surface therefore does not narrow MANAGER's reach — it replaces the entire /sync
  // page, QuickBooks half included, with the generic error boundary, which is the opposite of what
  // round 3 said it was doing ("It keeps the whole QuickBooks branch"). See
  // tests/accounting/dashboard-read-gates.test.ts, which measures that outcome directly.
  //
  // The property is unchanged and still in two halves: MANAGER gets THROUGH the dispatcher (so the
  // loosest gate really is loose) and is refused by the Xero delegate (so the strictness really is
  // enforced somewhere). If either half stops holding, the note above the dispatchers is false again.
  currentRole = 'MANAGER'
  recorder.reset()

  // HALF ONE — through the dispatcher. `getAccountingSettingsMasked` resolves the active connector,
  // which is a plugin-state read and only happens after the dispatcher's own 'sync' gate.
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  await getAccountingSettingsMasked()
  assert.ok(
    recorder.calls.length > 0 || recorder.reaches.length > 0,
    'MANAGER must reach the connector resolution — otherwise the dispatcher refused and the '
    + 'Xero delegate was never exercised at all',
  )

  // HALF TWO — refused by the delegate. Asserted on the delegate itself rather than through a
  // dispatcher, because the write dispatchers reach the Xero branch only when a connector resolves,
  // and this file's recorder deliberately has none enabled (that is what the early-return tests
  // above are for). The frame under test is the delegate's, so the delegate is what is called.
  const { testXeroConnection } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => testXeroConnection(),
    (error: unknown) => {
      // NOT `permission === 'sync'`: that would mean the 'sync' half refused, and the ROLE check —
      // the stricter claim, and the only thing that refuses MANAGER — was never reached.
      //
      // NULL, not undefined (o3d-m3gy). The branch's own denial class typed `permission` as the
      // `Permission` union, which has no member for a ROLE denial, so a role refusal simply carried
      // no permission at all and this read `undefined`. The merged class keeps the union AND `null`,
      // and `requireRoleSession` passes `null` deliberately: "refused on the role, no permission in
      // view" is a distinct fact from "the property is missing", and only one of them can be shown to
      // an operator. Asserting `null` is asserting that the role case still has a representation.
      assert.equal((error as { permission?: string | null }).permission, null)
      assert.match(String((error as Error).message), /^Forbidden$/)
      return true
    },
  )
})

test('ADMIN passes both frames', async () => {
  currentRole = 'ADMIN'
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  const settings = await getAccountingSettingsMasked()
  assert.equal(typeof settings, 'object')
})

test('MANAGER keeps the connector READ surface, which is what the /sync page renders (o3d-m3gy)', async () => {
  // The counter-guard the scoping needs. "The credential surface is ADMIN" must not quietly become
  // "the module is ADMIN": a MANAGER that cannot read the connector's own settings cannot load /sync
  // at all, because that page fails whole on any denial. So the read is asserted to PASS, on the same
  // dispatcher whose delegate refuses the write above.
  currentRole = 'MANAGER'
  recorder.reset()
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  const settings = await getAccountingSettingsMasked()
  assert.equal(typeof settings, 'object')
  // And it is still a gate: a role without 'sync' is refused by the dispatcher's own frame.
  currentRole = 'WAREHOUSE'
  await assert.rejects(
    () => getAccountingSettingsMasked(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})
