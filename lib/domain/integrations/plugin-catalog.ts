/**
 * WHAT THE PLUGIN TOGGLES SAY, FOR EVERY REGISTERED PLUGIN (o3d-m0ad, o3d-remove-shiphero round 8).
 *
 * WHY THIS EXISTS. `components/settings/integration-plugins-settings.tsx` used to declare five
 * `useState` hooks, five `<Switch>` blocks and five hand-written copy strings — one per plugin, the
 * WMS one spelling the shipped connector's id. So a SECOND registered WMS connector had no toggle
 * screen at all, and the two `as IntegrationPluginState` casts the component used to assemble its
 * selection suppressed the very "member missing" errors that would have said so. That is the half
 * of o3d-m0ad the persistence fix does not reach: a connector that the action can now store is
 * still unreachable if no screen can ask for it.
 *
 * SO THE LIST IS DERIVED. The non-WMS plugins are enumerated — there is no registry to derive them
 * from, and the record below is TOTAL over their id union, so adding one is a `tsc` error here
 * until somebody writes what it does. The WMS plugins are read from the WMS connector registry,
 * label and all, so registering a connector gives it a toggle without editing this file or the
 * component.
 *
 * SERVER-SIDE. The WMS registry statically imports the shipped connector (and Prisma behind it), so
 * this cannot be imported from a client component. The Settings page is a server component and
 * passes the descriptors down, which is also what keeps the connector id out of the client bundle.
 */
import { wmsConnectorRegistry } from '@/lib/connectors/wms/registry'
import {
  INTEGRATION_PLUGIN_IDS,
  type IntegrationPluginId,
  type IntegrationPluginState,
  type NonWmsIntegrationPluginId,
} from '@/lib/integration-plugin-keys'
import { isWmsConnectorId } from '@/lib/connectors/wms/types'

export type IntegrationPluginDescriptor = {
  id: IntegrationPluginId
  /** The switch's title — "<registered name> plugin". */
  label: string
  /** One line under the switch saying what enabling it turns on. */
  description: string
  enabled: boolean
}

const NON_WMS_PLUGIN_COPY: Record<NonWmsIntegrationPluginId, { label: string; description: string }> = {
  woocommerce: {
    label: 'WooCommerce plugin',
    description: 'Enables the shopping connector, webhooks, sync UI, and WooCommerce-specific scheduler jobs.',
  },
  shopify: {
    label: 'Shopify plugin',
    description: 'Reserves the shopping connector slot, settings, and sync/dashboard wiring for Shopify.',
  },
  xero: {
    label: 'Xero plugin',
    description: 'Enables the accounting connector, callback flow, sync UI, and accounting scheduler jobs backed by Xero.',
  },
  quickbooks: {
    label: 'QuickBooks plugin',
    description: 'Reserves the accounting connector slot, settings, and sync/dashboard wiring for QuickBooks.',
  },
}

/**
 * Every registered plugin, in id order, with the copy its toggle shows and the value it currently
 * holds.
 *
 * TOTAL over `INTEGRATION_PLUGIN_IDS` by construction: the list is walked, never listed, so a
 * registered connector cannot be absent from the screen.
 */
export function listIntegrationPluginDescriptors(
  state: IntegrationPluginState,
): IntegrationPluginDescriptor[] {
  return INTEGRATION_PLUGIN_IDS.map((id) => {
    if (isWmsConnectorId(id)) {
      // The connector's OWN registered name, so no screen spells a warehouse's name itself. An id
      // with no registration left (a build that dropped a connector) degrades to the id, which is
      // still something an operator can report.
      const label = wmsConnectorRegistry.findDef(id)?.label ?? id
      return {
        id,
        label: `${label} plugin`,
        description: `Enables ${label} WMS settings, webhook intake, sync UI, and ${label}-specific scheduler jobs.`,
        enabled: state[id],
      }
    }
    const copy = NON_WMS_PLUGIN_COPY[id]
    return { id, label: copy.label, description: copy.description, enabled: state[id] }
  })
}
