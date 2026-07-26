import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-bjc.12: anything that asks "is a sweep maintaining this?" must resolve the
 * connector the way runWmsDispatchSweep does — enabled, with NO legacy fallback.
 * getActiveWmsConnectorId() falls back to the first registered connector so
 * historical single-connector deployments keep routing somewhere; used here that
 * would offer to bulk-quarantine links on a connector no sweep is running.
 */

test('[o3d-bjc.12] the enabled-connector resolver has no fallback', () => {
  const src = readFileSync('lib/connectors/wms/active-connector.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function getEnabledWmsConnectorId'))
  assert.match(fn, /\?\? null/, 'must return null when nothing is enabled')
  assert.ok(!/WMS_CONNECTOR_IDS\[0\]/.test(fn), 'must NOT fall back to the first registered connector')
})

test('[o3d-bjc.12] the drift inbox and both actions use it, not the fallback resolver', () => {
  const src = readFileSync('app/actions/sync-exceptions.ts', 'utf8')
  assert.ok(!/getActiveWmsConnectorId/.test(src),
    'the fallback resolver would show — and allow isolating — a connector no sweep maintains')
  // Both loaders and both mutations.
  assert.equal((src.match(/getEnabledWmsConnectorId\(\)/g) ?? []).length, 4)
})
