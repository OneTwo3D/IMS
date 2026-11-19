import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-nlvy / o3d-6qub: the onboarding Integrations gate has ONE decider, isIntegrationsStepReady, called by the wizard shell from props
 * and the connection overrides; the step holds no useState copy of wmsConnection.configured and reports no readiness up (the shell
 * preferred that child-reported value, which is null on the first render and on SSR, over its own copy).
 * The render harness runs no effects, so the wiring is pinned at source: the shape the two beads describe cannot come back unseen.
 * Named mutations (shown red): shell copy of the rule restored; useState(wmsConnection.configured) restored.
 */
const shell = readFileSync('app/(dashboard)/onboarding/onboarding-client.tsx', 'utf8')
const step = readFileSync('components/onboarding/integrations-step.tsx', 'utf8')

test('the shell decides the integrations gate with isIntegrationsStepReady and has no copy of the rule', () => {
  assert.match(shell, /isIntegrationsStepReady\(plugins, \{ woocommerce: wcConnected, accounting: accountingConnected, wms: wmsConnected \}\)/)
  assert.doesNotMatch(shell, /integrationsReadyOverride|anyIntegrationsEnabled/)
  assert.doesNotMatch(shell, /plugins\.woocommerce && !wcConnected|wmsEnabled && !wmsConnected|accountingEnabled && !accountingConnected/)
})

test('the step keeps no state copy of wmsConnection.configured and reports no readiness up', () => {
  assert.doesNotMatch(step, /useState\(wmsConnection\.configured\)|setWmsConnected/)
  assert.doesNotMatch(step, /onReadyChange|isIntegrationsStepReady/)
  assert.match(step, /onConnectionStateChange\(\{ wms: true \}\)/)
})
