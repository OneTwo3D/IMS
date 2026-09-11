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
  findIntegrationPluginExclusivityConflict,
  INTEGRATION_PLUGIN_IDS,
  type IntegrationPluginId,
  type IntegrationPluginState,
  type NonWmsIntegrationPluginId,
} from '@/lib/integration-plugin-keys'
import { isWmsConnectorId, type WmsConnectorId } from '@/lib/connectors/wms/types'

export type IntegrationPluginDescriptor = {
  id: IntegrationPluginId
  /** The switch's title — "<registered name> plugin". */
  label: string
  /** One line under the switch saying what enabling it turns on. */
  description: string
  enabled: boolean
  /**
   * Whether this build OFFERS the plugin to operators. `false` only ever reaches this list for a
   * plugin that is somehow already on — see {@link listIntegrationPluginDescriptors}.
   */
  available: boolean
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
 * WHETHER THIS BUILD OFFERS A PLUGIN TO OPERATORS — the one reader of `WmsConnectorDef.available`
 * (o3d-remove-shiphero round 12, Codex HIGH 2).
 *
 * WHAT WENT WRONG. `available` is documented on the registry definition as "false for a connector
 * that is registered but not offered to operators yet", and NOTHING consulted it. Round 8 made the
 * settings toggles registry-derived and round 6 made the /sync cards registry-derived, and both
 * derivations walked every registered id: a connector staged with `available: false` got a live
 * switch, could be enabled, and then became the connector every push, sweep and dispatch routed to.
 * A flag whose entire purpose is to keep something out of operators' hands has to be read by
 * everything that puts things in front of operators, or it is decoration.
 *
 * NON-WMS PLUGINS ARE ALWAYS AVAILABLE HERE, and that is a statement rather than an omission: the
 * four of them are enumerated in this module because there is no registry to derive them from, so
 * there is no staged-registration state for one to be in — a plugin that is not offered is simply
 * not in `NON_WMS_INTEGRATION_PLUGIN_IDS`. (The `available` flags on the shopping and accounting
 * connector registries govern connector SELECTION in the Numbering and Company screens, which is a
 * different question from whether the plugin may be switched on, and both ship `true`.)
 *
 * An id with NO registration answers `false`: a build that no longer ships a connector must not
 * offer its switch either.
 */
export function isIntegrationPluginAvailable(id: IntegrationPluginId): boolean {
  if (!isWmsConnectorId(id)) return true
  return wmsConnectorRegistry.findDef(id)?.available ?? false
}

/** Every WMS connector this build offers — what the /sync Integrations grid may open. */
export function listAvailableWmsConnectorIds(): WmsConnectorId[] {
  return wmsConnectorRegistry.list().filter((def) => def.available).map((def) => def.id)
}

/** Shown to an operator who tries to switch on something this build does not offer. */
export function unavailableIntegrationPluginConflict(id: IntegrationPluginId): string {
  return `${id} is registered but not offered by this build, so it cannot be enabled.`
}

/**
 * EVERY RULE A PLUGIN-STATE WRITE HAS TO SATISFY — one call, so neither writer can hold half of
 * them (o3d-remove-shiphero round 12, Codex HIGH 2).
 *
 * Round 10 added exclusivity and wired it into both writers; round 12 adds availability. They are
 * combined HERE rather than left as two calls a writer has to remember, because "the settings
 * action got the new rule and the wizard did not" is the shape this branch has already been bitten
 * by. Both writers evaluate this against the state their write RESULTS in, under the
 * connector-selection lock — see app/actions/settings.ts for why evaluating it beforehand made the
 * check advisory only.
 *
 * Availability is checked only on the ids being turned ON: a plugin that is somehow already enabled
 * and is not offered must still be switchable OFF, or the misconfiguration removes its own remedy.
 */
export function findIntegrationPluginWriteConflict(
  state: Partial<Record<IntegrationPluginId, boolean>>,
): string | null {
  const exclusivity = findIntegrationPluginExclusivityConflict(state)
  if (exclusivity) return exclusivity
  for (const id of INTEGRATION_PLUGIN_IDS) {
    if (state[id] && !isIntegrationPluginAvailable(id)) return unavailableIntegrationPluginConflict(id)
  }
  return null
}

/**
 * Every plugin this build OFFERS, in id order, with the copy its toggle shows and the value it
 * currently holds — plus any plugin that is NOT offered and is nonetheless switched on.
 *
 * TOTAL over `INTEGRATION_PLUGIN_IDS` by construction: the list is walked, never listed, so a
 * registered connector cannot be absent from the screen.
 *
 * THE ONE EXCLUSION, AND THE ONE EXCEPTION TO IT (round 12, Codex HIGH 2). A plugin this build does
 * not offer gets no switch — that is what `available: false` is for. But a row can say enabled
 * anyway (a restore, a direct `UPDATE setting`, a build that withdrew a connector that was already
 * on), and hiding the switch in THAT state would leave an operator with a connector they can see
 * routing their orders and no control that turns it off. So an unavailable plugin is listed exactly
 * when it is on, carrying `available: false` so the screen can offer the one move that is legal:
 * off.
 */
export function listIntegrationPluginDescriptors(
  state: IntegrationPluginState,
): IntegrationPluginDescriptor[] {
  return INTEGRATION_PLUGIN_IDS.flatMap((id): IntegrationPluginDescriptor[] => {
    const available = isIntegrationPluginAvailable(id)
    const enabled = state[id]
    if (!available && !enabled) return []
    if (isWmsConnectorId(id)) {
      // The connector's OWN registered name, so no screen spells a warehouse's name itself. An id
      // with no registration left (a build that dropped a connector) degrades to the id, which is
      // still something an operator can report.
      const label = wmsConnectorRegistry.findDef(id)?.label ?? id
      return [{
        id,
        label: `${label} plugin`,
        description: available
          ? `Enables ${label} WMS settings, webhook intake, sync UI, and ${label}-specific scheduler jobs.`
          : `${label} is enabled but this build does not offer it. Switch it off — it cannot be switched back on.`,
        enabled,
        available,
      }]
    }
    const copy = NON_WMS_PLUGIN_COPY[id]
    return [{ id, label: copy.label, description: copy.description, enabled, available }]
  })
}
