import assert from 'node:assert/strict'
import test from 'node:test'

import type { IntegrationPluginState } from '@/lib/integration-plugins'
import { resolveOnboardingPluginSaveView } from '@/lib/domain/onboarding/plugin-save-outcome'

// ---------------------------------------------------------------------------
// o3d-osl8 round 7, finding 1 — THE CALLER'S half.
//
// The action's three outcomes are only worth distinguishing if the wizard acts on the distinction,
// and the bug lived entirely in the wizard: `if (!result.success) { restore previousPlugins }`.
// That rolled the switches back over a selection that WAS committed whenever the post-commit
// crontab reconciliation failed, and the operator was then shown the previous accounting connector
// while the database, every runtime module gate and the next server render used the new one.
//
// The decision is now a pure function so it can be enumerated rather than inferred from a
// component's try/catch — the same shape (and the same reason) as resolveConnectorOrphanBannerState.
// The rule it encodes, in one line: THE PREVIOUS SELECTION IS RESTORED ONLY WHEN THE SAVE IS KNOWN
// TO HAVE COMMITTED NOTHING.
// ---------------------------------------------------------------------------

function pluginState(over: Partial<IntegrationPluginState> = {}): IntegrationPluginState {
  return {
    woocommerce: false,
    shopify: false,
    xero: false,
    quickbooks: false,
    mintsoft: false,
    shiphero: false,
    ...over,
  } as IntegrationPluginState
}

const previous = pluginState({ woocommerce: true, xero: true })
const requested = pluginState({ woocommerce: true, quickbooks: true })

test('a REFUSAL restores the previous selection — the one outcome that committed nothing', () => {
  const view = resolveOnboardingPluginSaveView({
    attempt: { kind: 'result', result: { status: 'refused', error: 'Choose either Xero or QuickBooks, not both.' } },
    requested,
    previous,
  })

  assert.deepEqual(view.plugins, previous, 'the switches go back, because the database never moved')
  assert.equal(view.committed, false)
  assert.equal(view.error, 'Choose either Xero or QuickBooks, not both.')
  assert.equal(view.schedulerWarning, '')
})

test('a SCHEDULER FAILURE keeps the committed selection and warns about the scheduler only', () => {
  // THE FIX. Previously this returned `{ success: false }` and the caller restored `previous`, so
  // the wizard showed Xero while QuickBooks was what dispatched.
  const committed = pluginState({ woocommerce: true, quickbooks: true })
  const view = resolveOnboardingPluginSaveView({
    attempt: {
      kind: 'result',
      result: { status: 'scheduler-failed', error: 'crontab write failed: no crontab for ims', pluginState: committed },
    },
    requested,
    previous,
  })

  assert.equal(view.committed, true, 'this is a SAVE, not a rejection')
  assert.deepEqual(view.plugins, committed, 'and what is shown is the state the server read back under the lock')
  assert.notDeepEqual(view.plugins, previous, 'never the pre-toggle selection — the database has moved past it')
  assert.equal(view.error, '', 'nothing is reported as a failed save')
  assert.match(view.schedulerWarning, /selection was SAVED/, 'the warning says the selection is stored')
  assert.match(view.schedulerWarning, /crontab write failed/, 'and carries the scheduler reason')
  assert.match(view.schedulerWarning, /Settings → System → Scheduler/, 'and the recovery that actually applies')
  assert.match(view.schedulerWarning, /Scheduled jobs may still be running for the previous selection/)
})

test('the committed state wins over the requested one when they differ', () => {
  // The server reads its answer back under the selection lock, so it can legitimately differ from
  // the payload (a key this step does not offer, a concurrent partial write that landed first).
  // Showing the request instead would reintroduce a UI that disagrees with the database.
  const committed = pluginState({ woocommerce: true, quickbooks: true, mintsoft: true })
  const view = resolveOnboardingPluginSaveView({
    attempt: { kind: 'result', result: { status: 'scheduler-failed', error: 'nope', pluginState: committed } },
    requested,
    previous,
  })

  assert.equal(view.plugins.mintsoft, true, 'the database\'s answer, not the request')
})

test('a plain SAVE shows the requested selection with no warning at all', () => {
  const view = resolveOnboardingPluginSaveView({
    attempt: { kind: 'result', result: { status: 'saved' } },
    requested,
    previous,
  })

  assert.deepEqual(view, { plugins: requested, committed: true, error: '', schedulerWarning: '' })
})

test('a REJECTION does not roll back, and reports the outcome as unknown', () => {
  // The same defect as the returned case, one layer along: a rejected server action is a permission
  // gate throwing, a transaction aborting, OR a transport failure that lost the reply after the
  // write committed. Restoring `previous` asserts the first two. The component cannot tell them
  // apart, so it must assert neither.
  const view = resolveOnboardingPluginSaveView({
    attempt: { kind: 'rejected', error: new Error('Failed to fetch') },
    requested,
    previous,
  })

  assert.deepEqual(view.plugins, requested, 'the switches are NOT rolled back over an unknown outcome')
  assert.equal(view.committed, false, 'and it is not treated as a save either')
  assert.match(view.error, /NOT known whether this selection was stored/)
  assert.match(view.error, /reload this page to see the stored selection/, 'with the only action that resolves it')
  assert.match(view.error, /Failed to fetch/, 'and whatever the transport did say')
  assert.ok(
    !/was SAVED|has been saved|nothing was saved/i.test(view.error),
    'and no claim in either direction',
  )
  assert.equal(view.schedulerWarning, '')
})

test('a non-Error rejection still produces the unknown-outcome message', () => {
  const view = resolveOnboardingPluginSaveView({
    attempt: { kind: 'rejected', error: 'digest-only' },
    requested,
    previous,
  })

  assert.match(view.error, /NOT known whether this selection was stored/)
  assert.ok(!view.error.includes('digest-only'), 'an opaque production digest is not shown as a reason')
})
