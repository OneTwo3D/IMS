import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

// Nothing enabled — the state this resolver exists to get right.
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => ({
      woocommerce: false, shopify: false, xero: false, quickbooks: false, mintsoft: false, shiphero: false,
    }),
  },
})

/**
 * o3d-bjc.12: anything that asks "is a sweep maintaining this?" must resolve the
 * connector the way runWmsDispatchSweep does — enabled, with NO legacy fallback.
 * getActiveWmsConnectorId() falls back to the first registered connector so
 * historical single-connector deployments keep routing somewhere; used here that
 * would offer to bulk-quarantine links on a connector no sweep is running.
 */

test('[o3d-bjc.12] the enabled-connector resolver has no fallback', async () => {
  // BEHAVIOURAL, not a source scan (o3d-0gzr). The previous version asserted the
  // text `?? null` appeared and `WMS_CONNECTOR_IDS[0]` did not — which a
  // resolver that delegated to the fallback helper and then appended `?? null`
  // would have passed while doing precisely the wrong thing. Drive it with
  // nothing enabled and check what actually comes back.
  const { getEnabledWmsConnectorId, getActiveWmsConnectorId } = await import('../lib/connectors/wms/active-connector.ts')
  assert.equal(await getEnabledWmsConnectorId(), null, 'nothing enabled must resolve to NOTHING, not to a default')
  // The contrast that matters: the ordinary helper DOES fall back, which is
  // exactly why the drift paths must not use it.
  assert.notEqual(await getActiveWmsConnectorId(), null, 'the legacy helper still falls back, by design')
})

test('[o3d-bjc.12] the drift paths never reach for the fallback resolver', () => {
  const src = readFileSync('app/actions/sync-exceptions.ts', 'utf8')
  assert.ok(!/getActiveWmsConnectorId/.test(src),
    'the fallback resolver would show — and allow isolating — a connector no sweep maintains')
  // Deliberately NOT a count of call sites. The old assertion pinned the exact
  // number, so hardening the isolate path with one extra check under the lock
  // broke it — a test that fails for being MORE careful is measuring the wrong
  // thing (o3d-0gzr).
})

test('[o3d-0gzr] isolate settles enablement inside the write, not before it', () => {
  const src = readFileSync('app/actions/sync-exceptions.ts', 'utf8')
  const tx = src.slice(src.indexOf('isolated = await db.$transaction'), src.indexOf('} catch (error) {', src.indexOf('isolated = await db.$transaction')))
  // The sweep lock does not serialize a plugin being switched off, so the
  // enablement check has to live in the same transaction as the quarantine.
  assert.match(tx, /INTEGRATION_PLUGIN_SETTING_KEYS/, 'enablement must be re-read inside the transaction')
  assert.match(tx, /DriftIsolationAborted/, 'and a disabled connector must ABORT the write, not just report')
  // The CAS retraction must be able to fail the whole thing.
  assert.match(tx, /retracted\.count !== 1/, 'a zero-row retraction must roll the quarantine back')
})
