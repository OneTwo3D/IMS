import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import type { IntegrationPluginState } from '@/lib/integration-plugin-keys'

/**
 * WHETHER THE ONBOARDING WIZARD'S INTEGRATIONS STEP MAY BE LEFT — and why it is a function rather
 * than an expression inside the step (o3d-remove-shiphero round 8, Codex HIGH 1, one layer out).
 *
 * Round 8 fixed `configured` in the two WMS UI facades: a connector with a live connection and no
 * panel of its own was being reported as not set up. The re-audit asked what READS that value, and
 * this rule is the answer that mattered most. `components/onboarding/integrations-step.tsx` seeds
 * `wmsConnected` from `WmsOnboardingConnectionData.configured` and then gates the whole step on
 * `wmsEnabled ? wmsConnected : true`. So the defect did not merely mislead: with a registered WMS
 * connector enabled and no onboarding form in this build, the wizard's Continue stayed DISABLED,
 * and the remedy the screen offered — finish setting this connector up — was one no screen could
 * perform. An unpassable wizard, from a connection that was fine.
 *
 * The expression lived inside a `useEffect` in a 700-line client component, which is why nothing
 * tested it: the render harness runs no effects, so the gate could only ever be read, not
 * exercised. As a pure function it is driven directly by the second-connector seam, with the
 * `configured` the REAL facade produced.
 *
 * WMS ENABLEMENT IS DERIVED, never a named member: any registered connector being on means a WMS
 * is in play, which is the same rule `isIntegrationModuleVisible` applies.
 */
export type IntegrationsStepConnections = {
  /** The WooCommerce store's credentials are saved. */
  woocommerce: boolean
  /** The Shopify store's credentials are saved. */
  shopify: boolean
  /** The selected accounting connector has a live connection. */
  accounting: boolean
  /** The active WMS connector's connection is set up — `WmsOnboardingConnectionData.configured`. */
  wms: boolean
}

export function isIntegrationsStepReady(
  plugins: IntegrationPluginState,
  connected: IntegrationsStepConnections,
): boolean {
  const wmsEnabled = WMS_CONNECTOR_IDS.some((id) => plugins[id])
  // At least one connector has to be chosen: an all-off step is not "ready", it is skipped.
  const anyChosen = plugins.woocommerce || plugins.shopify || plugins.xero || plugins.quickbooks || wmsEnabled
  return anyChosen
    && (plugins.woocommerce ? connected.woocommerce : true)
    && (plugins.shopify ? connected.shopify : true)
    && ((plugins.xero || plugins.quickbooks) ? connected.accounting : true)
    && (wmsEnabled ? connected.wms : true)
}
