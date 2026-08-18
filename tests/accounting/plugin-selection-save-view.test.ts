import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { IntegrationPluginState } from '@/lib/integration-plugins'
import {
  completePluginSelectionSave,
  resolvePluginSelectionSaveView,
} from '@/lib/domain/integrations/plugin-save-outcome'
import { schedulerBehindWarning, SCHEDULER_RECOVERY } from '@/lib/domain/integrations/scheduler-followup'
import { resolveSettingSaveView } from '@/lib/domain/settings/setting-save-outcome'

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
//
// ROUND 8 moved it out of lib/domain/onboarding, because the Settings screen kept a PARALLEL copy
// of the same rule (finding 2) and that copy still called a committed write a failed save. One
// implementation, two call sites, no presentation parameter — the screens differ only in which
// switches they apply the answer to.
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
  const view = resolvePluginSelectionSaveView({
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
  const view = resolvePluginSelectionSaveView({
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
  const view = resolvePluginSelectionSaveView({
    attempt: { kind: 'result', result: { status: 'scheduler-failed', error: 'nope', pluginState: committed } },
    requested,
    previous,
  })

  assert.equal(view.plugins.mintsoft, true, 'the database\'s answer, not the request')
})

test('a plain SAVE shows the requested selection with no warning at all', () => {
  const view = resolvePluginSelectionSaveView({
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
  const view = resolvePluginSelectionSaveView({
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
  const view = resolvePluginSelectionSaveView({
    attempt: { kind: 'rejected', error: 'digest-only' },
    requested,
    previous,
  })

  assert.match(view.error, /NOT known whether this selection was stored/)
  assert.ok(!view.error.includes('digest-only'), 'an opaque production digest is not shown as a reason')
})

// ---------------------------------------------------------------------------
// Round 8, finding 1 — the POST-COMMIT GUARD, on its own.
//
// The resolver above only ever sees an outcome someone else classified. The defect was in the
// classifier: it handled a scheduler step that RETURNED a failure and let one that THREW escape the
// union entirely, where a caller reads it as "the outcome is unknown". Both writers now share this
// guard, so the two shapes cannot be treated differently again.
// ---------------------------------------------------------------------------

const committedState = pluginState({ woocommerce: true, quickbooks: true })

test('a post-commit step that RETURNS a failure is scheduler-failed, carrying the committed state', async () => {
  const result = await completePluginSelectionSave({
    committed: committedState,
    postCommit: async () => ({ success: false, error: 'crontab write failed: no crontab for ims' }),
  })

  assert.deepEqual(result, {
    status: 'scheduler-failed',
    error: 'crontab write failed: no crontab for ims',
    pluginState: committedState,
  })
})

test('a post-commit step that THROWS produces the IDENTICAL outcome', async () => {
  // THE ASSERTION THAT FAILS WITHOUT THE FIX. With the try/catch removed this rejects, which is how
  // the action behaved before: a committed selection reported to the caller as an unknown outcome.
  const result = await completePluginSelectionSave({
    committed: committedState,
    postCommit: async () => { throw new Error('crontab: EACCES') },
  })

  assert.equal(result.status, 'scheduler-failed')
  assert.ok(result.status === 'scheduler-failed')
  assert.match(result.error, /EACCES/, 'the thrown reason is carried through, exactly like a returned one')
  assert.deepEqual(result.pluginState, committedState, 'and so is the committed state')
})

test('a non-Error throw still lands as scheduler-failed rather than escaping', async () => {
  // A server action rejection in production is an opaque digest, not an Error. Falling through on
  // anything that is not an Error would put the whole defect back for exactly the shape that
  // reaches a browser.
  const result = await completePluginSelectionSave({
    committed: committedState,
    postCommit: async () => { throw 'digest-only' },
    fallbackError: 'Failed to apply scheduler changes',
  })

  assert.equal(result.status, 'scheduler-failed')
  assert.ok(result.status === 'scheduler-failed')
  assert.equal(result.error, 'Failed to apply scheduler changes')
  assert.deepEqual(result.pluginState, committedState)
})

test('a post-commit step that succeeds is a plain save, with nothing extra attached', async () => {
  const result = await completePluginSelectionSave({
    committed: committedState,
    postCommit: async () => ({ success: true }),
  })

  assert.deepEqual(result, { status: 'saved' })
})

test('the guard\'s outcome feeds the resolver, so a THROWN failure keeps the switches too', async () => {
  // End to end over the two pure pieces: what the action returns for a thrown scheduler failure is
  // what the screens must render, and it must not be a rollback.
  const view = resolvePluginSelectionSaveView({
    attempt: {
      kind: 'result',
      result: await completePluginSelectionSave({
        committed: committedState,
        postCommit: async () => { throw new Error('crontab: EACCES') },
      }),
    },
    requested,
    previous,
  })

  assert.equal(view.committed, true)
  assert.deepEqual(view.plugins, committedState)
  assert.equal(view.error, '', 'nothing is presented as a failed save')
  assert.match(view.schedulerWarning, /was SAVED, but the scheduler could not be updated/)
})

// ---------------------------------------------------------------------------
// The same shape at the three OTHER screens that reconcile the crontab after a committed write
// (the onboarding company step, the Public App URL setting, the scheduled-jobs editor). They save
// something other than the plugin selection, so they cannot use the resolver above — but the
// classifying rule and the sentence are shared rather than re-typed.
//
// ROUND 9, FINDING 4 — those three used to classify CLIENT-SIDE, via `resolveSchedulerFollowUp`,
// which ran `syncCrontab` from the browser and caught everything it threw. Two problems: the catch
// swallowed Next's `NEXT_REDIRECT` (raised by `syncCrontab`'s own re-entered permission gate), and
// running the reconciliation as a second round trip meant the commit and its post-commit step could
// never be one guarded unit. They now call a server action that commits and then runs every
// post-commit step inside `runPostCommit`, and render `resolveSettingSaveView` over its result.
// ---------------------------------------------------------------------------

test('a settings save with no post-commit failure warns about nothing', () => {
  assert.deepEqual(
    resolveSettingSaveView({ result: { status: 'saved' }, what: 'The Public App URL' }),
    { committed: true, error: '', warning: '' },
  )
})

test('a post-commit SCHEDULER failure is a warning over a committed save, never an error', () => {
  const view = resolveSettingSaveView({
    result: { status: 'post-commit-failed', step: 'scheduler', error: 'crontab write failed' },
    what: 'The Public App URL',
  })

  assert.equal(view.committed, true, 'the value IS stored — that is the whole point')
  assert.equal(view.error, '', 'and nothing is presented as a failed save')
  assert.match(view.warning, /^The Public App URL was SAVED, but the scheduler could not be updated/)
  assert.match(view.warning, /Settings → System → Scheduler/, 'with the recovery that applies')
  assert.ok(!/failed to save|could not be saved/i.test(view.warning))
})

test('a post-commit LOCAL failure gets its own sentence rather than blaming the scheduler', () => {
  // The sentence has to stay TRUE. `setSettings`’ post-commit tail is the activity-log row and the
  // cache revalidation; telling an operator to go and sync the crontab because THAT failed would be
  // a second, smaller lie in the place built to stop the first one.
  const view = resolveSettingSaveView({
    result: { status: 'post-commit-failed', step: 'local', error: 'activity log unavailable' },
    what: 'Your delivery tracking settings',
  })

  assert.equal(view.committed, true)
  assert.equal(view.error, '')
  assert.match(view.warning, /was SAVED, but a follow-up step after the save did not complete/)
  assert.match(view.warning, /activity log unavailable/)
  assert.ok(!/Scheduler/.test(view.warning), 'it does not send them to a page that cannot help')
})

test('a REFUSED settings save is the only one that reports a failure', () => {
  // Refused means the action rejected the input BEFORE its transaction, so nothing was written.
  // It is the only outcome where "your value was not saved" is true.
  const view = resolveSettingSaveView({
    result: { status: 'refused', error: 'URL must start with http:// or https://' },
    what: 'The Public App URL',
  })
  assert.deepEqual(view, { committed: false, error: 'URL must start with http:// or https://', warning: '' })
})

test('the warning sentence has ONE definition', () => {
  // Both users of it — the plugin resolver and the settings resolver — go through this function,
  // so the wording cannot drift into per-screen variants that each say something slightly different
  // about what is and is not saved.
  assert.equal(
    schedulerBehindWarning('X', 'why'),
    resolvePluginSelectionSaveView({
      attempt: { kind: 'result', result: { status: 'scheduler-failed', error: 'why', pluginState: committedState } },
      requested,
      previous,
    }).schedulerWarning.replace('Your integration plugin selection', 'X'),
  )
})

test('the recovery names a control that actually exists on that page', () => {
  // ROUND 9. Rounds 7 and 8 told the operator to "use Sync crontab there". No such button exists —
  // the scheduler tab renders CronJobsSettings, whose only control is Save & Apply, and that page's
  // own drift warnings say "Save the scheduler settings". A warning that sends someone looking for
  // a control nobody built is the same defect the warning was written to fix: a message the reader
  // cannot act on. It survived two rounds because every assertion matched on
  // "Settings → System → Scheduler" and stopped there.
  const schedulerTab = readFileSync(join(process.cwd(), 'components/settings/cron-jobs-settings.tsx'), 'utf8')
  const controls = [...schedulerTab.matchAll(/<Button[\s\S]{0,200}?>([\s\S]*?)<\/Button>/g)]
    .map((m) => m[1].replace(/\{[\s\S]*?\}/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  assert.deepEqual(controls, ['Save & Apply'], 'the scheduler tab offers exactly one control')
  assert.ok(
    SCHEDULER_RECOVERY.includes('Save & Apply'),
    `the recovery must name it; it says: ${SCHEDULER_RECOVERY}`,
  )
  assert.ok(!/Sync crontab/i.test(SCHEDULER_RECOVERY), 'and must not name a button that does not exist')
})
