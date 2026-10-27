import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bundledScriptPath } from '../../lib/ops/readiness-gate-collect.ts'

test('a bundled script resolves to dist-scripts/<file> only when that file exists', () => {
  const present = (file: string) => file === '/app/dist-scripts/reconciliation-pack.mjs'
  assert.equal(bundledScriptPath('reconcile:pack', '/app', present), '/app/dist-scripts/reconciliation-pack.mjs')
  assert.equal(bundledScriptPath('read-sync:status', '/app', present), null, 'no file, so npm run is used')
  assert.equal(bundledScriptPath('reconcile:pack', '/opt/checkout', () => false), null, 'a checkout has no bundle')
})

test('only the named scripts can ever be bundled', () => {
  assert.equal(bundledScriptPath('readiness:gate', '/app', () => true), null)
  assert.equal(bundledScriptPath('constructor', '/app', () => true), null)
})
