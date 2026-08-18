import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

// ---------------------------------------------------------------------------
// o3d-osl8 round 8 finding 1, and round 9 finding 1 — "check the same shape everywhere", twice.
//
// Three screens persist a setting and then reconcile the OS crontab. Every one of them reported a
// post-commit failure the way it reports a rejected save: a red error, no "Saved". The setting is
// already in the database at that point, so "nothing happened" is the one reading that is certainly
// wrong — and it is the reading that invites a retry of a write that already landed.
//
// ROUND 8 fixed the SCHEDULER half of that, client-side, and declared the sweep complete.
// ROUND 9 found the same defect still live one layer down: `setSetting` committed its upsert and
// THEN awaited `logActivity` and `revalidatePath`, so either of those rejecting rejected the action
// and landed in each screen's outer catch. The round-8 doubles could not expose it, because they
// replaced `setSetting` with an infallible array push — a double with no failure mode cannot test a
// failure classification.
//
// So these doubles COMMIT AND THEN FAIL. The write is recorded (it is durable) and the action still
// reports a post-commit failure, which is exactly the state the screens kept getting wrong.
//
// The plugin screen is covered in integration-plugins-settings.test.ts (it has a committed state to
// display, so it goes through the full resolver). These two only have a warning to show.
// ---------------------------------------------------------------------------

type SettingSaveResult =
  | { status: 'saved' }
  | { status: 'refused'; error: string }
  | { status: 'post-commit-failed'; step: 'scheduler' | 'local'; error: string }

const state = {
  settingWrites: [] as Array<[string, string]>,
  cronJobWrites: [] as Array<{ settingKey: string; enabled: boolean; schedule: string }>,
  /** What the (already committed) server action reports back. */
  outcome: { status: 'saved' } as SettingSaveResult,
  /** A rejection AFTER the write is recorded — the transport-loss case, the only "unknown" one. */
  reject: null as Error | null,
}

mock.module('@/app/actions/settings', {
  namedExports: {
    savePublicAppUrl: async (value: string): Promise<SettingSaveResult> => {
      // COMMITTED FIRST, and then whatever the outcome says. That ordering is the double's whole
      // point: an infallible double cannot distinguish "not saved" from "saved, follow-up failed".
      state.settingWrites.push(['public_app_url', value])
      if (state.reject) throw state.reject
      return state.outcome
    },
  },
})

mock.module('@/app/actions/cron', {
  namedExports: {
    saveCronJobSettings: async (jobs: Array<{ settingKey: string; enabled: boolean; schedule: string }>): Promise<SettingSaveResult> => {
      state.cronJobWrites.push(...jobs)
      if (state.reject) throw state.reject
      return state.outcome
    },
  },
})

function reset() {
  state.settingWrites = []
  state.cronJobWrites = []
  state.outcome = { status: 'saved' }
  state.reject = null
}

test.beforeEach(reset)

async function mountPublicAppUrl(currentValue = 'https://ims.example.com') {
  const { PublicAppUrlSettings } = await import('@/components/settings/public-app-url-settings')
  return mountClientComponent(
    PublicAppUrlSettings as unknown as (props: { currentValue: string; source: 'settings' | 'none' }) => unknown,
    { currentValue, source: 'settings' },
  )
}

test('a scheduler failure leaves the Public App URL reported as saved', async () => {
  state.outcome = { status: 'post-commit-failed', step: 'scheduler', error: 'Cron secret is not configured.' }
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.deepEqual(state.settingWrites, [['public_app_url', 'https://ims.example.com']], 'the URL was written')
  assert.match(html, /Saved/, 'and the screen says so, because it is true')
  assert.match(html, /The Public App URL was SAVED, but the scheduler could not be updated/)
  assert.match(html, /Cron secret is not configured/, 'with the reason')
  assert.ok(!/text-destructive/.test(html), 'and nothing is rendered as a failed save')
})

test('a LOCAL post-commit failure is also a committed save, with its own sentence', async () => {
  // ROUND 9, FINDING 1 — the case the round-8 sweep could not reach. `setSetting` committed and then
  // awaited `logActivity`; a failure there rejected the action and this screen printed
  // "Failed to save app URL" over a stored URL.
  state.outcome = { status: 'post-commit-failed', step: 'local', error: 'activity log unavailable' }
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.deepEqual(state.settingWrites, [['public_app_url', 'https://ims.example.com']])
  assert.match(html, /Saved/)
  assert.match(html, /was SAVED, but a follow-up step after the save did not complete/)
  assert.match(html, /activity log unavailable/)
  assert.ok(!/Failed to save app URL/.test(html), 'never reported as a failed save')
  assert.ok(!/text-destructive/.test(html))
})

test('a REFUSED save is still a plain error, and nothing claims to be saved', async () => {
  // The split has to stay honest in the other direction. A refusal means the action rejected the
  // input before its transaction, so there is nothing to call saved.
  state.outcome = { status: 'refused', error: 'URL must start with http:// or https://' }
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /URL must start with http/)
  assert.ok(!/>Saved</.test(html))
  assert.ok(!/was SAVED, but/.test(html))
})

test('client-side validation still refuses before any round trip', async () => {
  const screen = await mountPublicAppUrl('not-a-url')

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /Enter a valid URL/)
  assert.deepEqual(state.settingWrites, [], 'nothing was written')
  assert.ok(!/>Saved</.test(html))
})

test('a REJECTED save is the only outcome still reported as an unknown failure', async () => {
  // A rejection now means the permission gate threw, the transaction aborted, or the reply was lost
  // — the genuinely unknown cases. It no longer includes "a post-commit step failed".
  state.reject = new Error('Failed to fetch')
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /Failed to fetch/)
  assert.ok(!/>Saved</.test(html))
})

async function mountCronJobs() {
  const { CronJobsSettings } = await import('@/components/settings/cron-jobs-settings')
  return mountClientComponent(
    CronJobsSettings as unknown as (props: { jobs: unknown[] }) => unknown,
    {
      jobs: [{
        slug: 'wc-order-sync',
        settingKey: 'wc_order_sync',
        module: 'woocommerce',
        moduleLabel: 'WooCommerce',
        label: 'Order sync',
        description: 'Pull orders',
        enabled: true,
        schedule: '*/15 * * * *',
      }],
    },
  )
}

test('the scheduled-jobs editor reports the same way', async () => {
  state.outcome = { status: 'post-commit-failed', step: 'scheduler', error: 'crontab write failed: no crontab for ims' }
  const screen = await mountCronJobs()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /Saved/, 'the schedule settings are stored, so the screen reports them as stored')
  assert.match(html, /Your scheduled-job settings was SAVED, but the scheduler could not be updated/)
  assert.match(html, /crontab write failed/)
})

test('the scheduled-jobs editor sends ONE atomic save, not one write per key', async () => {
  // ROUND 9, FINDING 1. It used to issue `Promise.all` over 2N independent `setSetting` calls.
  // `Promise.all` rejects on the FIRST failure while the rest keep going, so a save reported as
  // failed could leave an arbitrary subset of the editor's rows committed — and the crontab would
  // then be derived from half of one operator edit.
  const screen = await mountCronJobs()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  assert.deepEqual(
    state.cronJobWrites,
    [{ settingKey: 'wc_order_sync', enabled: true, schedule: '*/15 * * * *' }],
    'one call carrying every job, so the server can write them in one transaction',
  )
  assert.deepEqual(state.settingWrites, [], 'and no generic per-key setSetting calls at all')
})
