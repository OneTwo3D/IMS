import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

// ---------------------------------------------------------------------------
// o3d-osl8 round 8, finding 1 — "check the same shape everywhere".
//
// Four screens persist a setting and then reconcile the OS crontab. Every one of them reported a
// post-commit scheduler failure the way it reports a rejected save: a red error, no "Saved". The
// setting is already in the database at that point, so "nothing happened" is the one reading that
// is certainly wrong — and it is the reading that invites a retry of a write that already landed.
//
// The plugin screen is covered in integration-plugins-settings.test.ts (it has a committed-state to
// display, so it goes through the full resolver). These two only have a warning to show, and they
// share resolveSchedulerFollowUp so the classification and the sentence have one definition.
// ---------------------------------------------------------------------------

const state = {
  settingWrites: [] as Array<[string, string]>,
  cron: { success: true } as { success: boolean; error?: string },
  cronThrows: null as Error | null,
}

mock.module('@/app/actions/settings', {
  namedExports: {
    setSetting: async (key: string, value: string) => { state.settingWrites.push([key, value]) },
  },
})

mock.module('@/app/actions/cron', {
  namedExports: {
    syncCrontab: async () => {
      if (state.cronThrows) throw state.cronThrows
      return state.cron
    },
  },
})

function reset() {
  state.settingWrites = []
  state.cron = { success: true }
  state.cronThrows = null
}

test.beforeEach(reset)

async function mountPublicAppUrl() {
  const { PublicAppUrlSettings } = await import('@/components/settings/public-app-url-settings')
  return mountClientComponent(
    PublicAppUrlSettings as unknown as (props: { currentValue: string; source: 'settings' | 'none' }) => unknown,
    { currentValue: 'https://ims.example.com', source: 'settings' },
  )
}

test('a RETURNED scheduler failure leaves the Public App URL reported as saved', async () => {
  state.cron = { success: false, error: 'Cron secret is not configured.' }
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.deepEqual(state.settingWrites, [['public_app_url', 'https://ims.example.com']], 'the URL was written')
  assert.match(html, /Saved/, 'and the screen says so, because it is true')
  assert.match(html, /The Public App URL was SAVED, but the scheduler could not be updated/)
  assert.match(html, /Cron secret is not configured/, 'with the reason')
  assert.ok(!/text-destructive/.test(html), 'and nothing is rendered as a failed save')
})

test('a THROWN scheduler failure is the same outcome on that screen', async () => {
  // This one used to fall through to the component's outer catch, which printed
  // "Failed to save app URL" — a claim about the save, over a write that had committed.
  state.cronThrows = new Error('Forbidden: missing permission settings.company')
  const screen = await mountPublicAppUrl()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.deepEqual(state.settingWrites, [['public_app_url', 'https://ims.example.com']])
  assert.match(html, /Saved/)
  assert.match(html, /was SAVED, but the scheduler could not be updated/)
  assert.ok(!/Failed to save app URL/.test(html), 'never reported as a failed save')
})

test('a validation failure BEFORE the write is still a plain error', async () => {
  // The split has to stay honest in the other direction: nothing was committed here, so there is
  // nothing to call saved.
  const { PublicAppUrlSettings } = await import('@/components/settings/public-app-url-settings')
  const screen = mountClientComponent(
    PublicAppUrlSettings as unknown as (props: { currentValue: string; source: 'settings' | 'none' }) => unknown,
    { currentValue: 'not-a-url', source: 'settings' },
  )

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /Enter a valid URL/)
  assert.deepEqual(state.settingWrites, [], 'nothing was written')
  assert.ok(!/>Saved</.test(html))
  assert.ok(!/scheduler could not be updated/.test(html))
})

test('the scheduled-jobs editor reports the same way', async () => {
  const { CronJobsSettings } = await import('@/components/settings/cron-jobs-settings')
  state.cronThrows = new Error('crontab write failed: no crontab for ims')
  const screen = mountClientComponent(
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

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.deepEqual(
    state.settingWrites,
    [['cron_wc_order_sync_enabled', 'true'], ['cron_wc_order_sync_schedule', '*/15 * * * *']],
    'the schedule settings are stored',
  )
  assert.match(html, /Saved/, 'so the screen reports them as stored')
  assert.match(html, /Your scheduled-job settings was SAVED, but the scheduler could not be updated/)
  assert.match(html, /crontab write failed/)
})
