import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'
import type { PluginSelectionSaveResult } from '@/lib/domain/integrations/plugin-save-outcome'

// ---------------------------------------------------------------------------
// o3d-osl8 round 8, finding 2 — the SETTINGS screen still reported committed writes as failed
// saves.
//
// Round 7 split "refused" from "committed, scheduler behind" in the onboarding wizard and
// cross-ported only the WARNING to components/settings/integration-plugins-settings.tsx. The RULE
// stayed duplicated in this screen's try/catch, where it kept the shape the wizard had just been
// fixed out of: a scheduler step that THREW landed in the catch and printed a bare red error over a
// selection that was already in the database.
//
// The screen now routes every outcome through resolvePluginSelectionSaveView — the same function
// the wizard uses, with no per-screen presentation parameter — and no longer calls syncCrontab
// itself, because the reconciliation is a post-commit step of the write and belongs inside the
// action that made it.
// ---------------------------------------------------------------------------

const state = {
  /** Every payload saveIntegrationPluginState was called with. */
  saves: [] as unknown[],
  result: { status: 'saved' } as PluginSelectionSaveResult,
  rejectWith: null as unknown,
  /** Calls to syncCrontab made from the CLIENT. Must stay at zero — see the test below. */
  clientCrontabSyncs: 0,
}

mock.module('@/app/actions/settings', {
  namedExports: {
    saveIntegrationPluginState: async (payload: unknown) => {
      state.saves.push(payload)
      if (state.rejectWith) throw state.rejectWith
      return state.result
    },
  },
})

mock.module('@/app/actions/cron', {
  namedExports: {
    syncCrontab: async () => {
      state.clientCrontabSyncs += 1
      return { success: true }
    },
  },
})

/** The server-rendered selection: WooCommerce + Xero. */
const serverRendered = {
  woocommerceEnabled: true,
  shopifyEnabled: false,
  xeroEnabled: true,
  quickbooksEnabled: false,
  mintsoftEnabled: false,
}

async function mountSettings() {
  const { IntegrationPluginsSettings } = await import('@/components/settings/integration-plugins-settings')
  return mountClientComponent(
    IntegrationPluginsSettings as unknown as (props: typeof serverRendered) => unknown,
    serverRendered,
  )
}

/** Every Switch's checked state, in render order: woocommerce, shopify, xero, quickbooks, mintsoft. */
function switchStates(tree: unknown): boolean[] {
  const found: boolean[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    const element = node as { props?: Record<string, unknown> }
    if (element.props && typeof element.props.checked === 'boolean' && 'onCheckedChange' in element.props) {
      found.push(element.props.checked as boolean)
    }
    if (element.props && 'children' in element.props) walk(element.props.children)
  }
  walk(tree)
  assert.equal(found.length, 5, 'all five switches were found — an empty sweep would assert nothing')
  return found
}

/** Move a switch, as an operator would, before pressing Save. */
function toggle(tree: unknown, index: number, value: boolean): void {
  const setters: Array<(v: boolean) => void> = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    const element = node as { props?: Record<string, unknown> }
    if (element.props && typeof element.props.onCheckedChange === 'function') {
      setters.push(element.props.onCheckedChange as (v: boolean) => void)
    }
    if (element.props && 'children' in element.props) walk(element.props.children)
  }
  walk(tree)
  assert.equal(setters.length, 5, 'all five switches are operable')
  setters[index](value)
}

function reset() {
  state.saves = []
  state.result = { status: 'saved' }
  state.rejectWith = null
  state.clientCrontabSyncs = 0
}

test.beforeEach(reset)

test('a scheduler failure is shown as SAVED with a warning, never as a failed save', async () => {
  // THE DEFECT. `syncCrontab` failing after the write left this screen showing a red error and no
  // "Saved" — which reads as "nothing happened" over a selection that is stored, and invites a
  // retry of a write that already landed.
  state.result = {
    status: 'scheduler-failed',
    error: 'crontab write failed: no crontab for ims',
    pluginState: {
      woocommerce: true, shopify: false, xero: false, quickbooks: true, mintsoft: false, shiphero: false,
    } as never,
  }
  const screen = await mountSettings()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html, tree } = screen.render()
  assert.match(html, /Saved/, 'the write is reported as the save it was')
  assert.match(html, /was SAVED, but the scheduler could not be updated/, 'with the scheduler stated separately')
  assert.match(html, /Settings → System → Scheduler/, 'and the recovery that applies')
  assert.ok(!/text-destructive/.test(html), 'and nothing is rendered as a failure')
  assert.deepEqual(
    switchStates(tree),
    [true, false, false, true, false],
    'the switches show the COMMITTED state read back under the lock — QuickBooks, not the Xero the '
      + 'page was rendered with',
  )
})

test('a REFUSAL rolls the switches back and states the reason', async () => {
  // The one outcome that committed nothing, and therefore the only one a rollback describes.
  state.result = { status: 'refused', error: 'Enable either Xero or QuickBooks, not both — accounting dispatch is single-connector.' }
  const screen = await mountSettings()
  // QuickBooks ON while Xero is already on — the illegal combination the action refuses. Moving a
  // switch first is what makes the rollback observable: requested and previous must differ, or the
  // assertion below passes for a screen that never rolls back at all.
  toggle(screen.render().tree, 3, true)
  assert.deepEqual(switchStates(screen.render().tree), [true, false, true, true, false], 'the operator moved it')

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html, tree } = screen.render()
  assert.match(html, /Enable either Xero or QuickBooks/)
  assert.ok(!/>Saved</.test(html), 'nothing was saved, so nothing says it was')
  assert.ok(!/was SAVED, but the scheduler/.test(html))
  assert.deepEqual(switchStates(tree), [true, false, true, false, false], 'back to the stored selection')
})

test('a REJECTION does not roll back, and reports the outcome as unknown', async () => {
  // A rejected server action is a permission gate throwing, a transaction aborting, OR a transport
  // failure that lost the reply after the write committed. Restoring the previous switches asserts
  // the first two; this screen cannot tell them apart, so it asserts neither.
  state.rejectWith = new Error('Failed to fetch')
  const screen = await mountSettings()
  toggle(screen.render().tree, 3, true)

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html, tree } = screen.render()
  assert.deepEqual(
    switchStates(tree),
    [true, false, true, true, false],
    'the switches are NOT rolled back over an outcome nobody knows',
  )
  assert.match(html, /NOT known whether this selection was stored/)
  assert.match(html, /reload this page to see the stored selection/)
  assert.ok(!/>Saved</.test(html), 'and it is not treated as a save either')
})

test('a plain save shows Saved and warns about nothing', async () => {
  const screen = await mountSettings()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  const { html } = screen.render()
  assert.match(html, /Saved/)
  assert.ok(!/scheduler could not be updated/.test(html))
  assert.equal(state.saves.length, 1, 'one write')
})

test('the screen does NOT reconcile the crontab itself', async () => {
  // It used to: `await saveIntegrationPluginState(...)` then `await syncCrontab()`, with the screen
  // classifying the second call's outcome. That second classification is what drifted from the
  // wizard's. The reconciliation is a post-commit step of the write and now happens inside the
  // action, so there is exactly one server call to classify and one place that classifies it.
  const screen = await mountSettings()

  await screen.click(screen.render().controls.find((c) => c.label.includes('Save')))

  assert.equal(state.clientCrontabSyncs, 0, 'no client-side scheduler round-trip to misclassify')
})
