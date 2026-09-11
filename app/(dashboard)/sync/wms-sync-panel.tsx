'use client'

import { MintsoftClient } from './mintsoft-client'
import type { MintsoftDashboardData } from '@/app/actions/mintsoft-sync'
import type { WmsSyncDashboardData } from '@/app/actions/wms-sync'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'
import { ambiguousWmsConnectorReason } from '@/lib/connectors/wms/enabled-connector'

/**
 * THE WMS PANEL REGISTRY — the /sync detail screen for whichever WMS connector is active.
 *
 * o3d-remove-shiphero round 6 (Codex HIGH 1) — WHY THIS IS A TOTAL RECORD AND NOT AN `if`.
 * Round 4 moved the two UI FACADES (app/actions/wms-sync.ts, app/actions/wms-onboarding.ts) off
 * `connectorId === 'mintsoft'` and onto capability hooks, and keyed their DTOs by connector. The
 * file that READS those DTOs was not changed: it still rendered one arm and returned `null`
 * otherwise, underneath a header that named the connector and next to an Integrations card that
 * said CONFIGURED. A second registered connector therefore got a blank configuration screen that
 * looks like a working one — worse than an error, because an operator has no reason to doubt it.
 * The seam had been carried one layer short of where production decides, for the fourth round
 * running, so the fix is structural rather than another arm:
 *
 *   - {@link WMS_PANELS} is `Record<WmsConnectorId, WmsConnectorPanel>`. It is TOTAL over the id
 *     union, so adding an id to `WMS_CONNECTOR_IDS` without writing a panel for it does not
 *     compile. Nobody can reach the runtime with a registered connector this file has not been
 *     told about;
 *   - and where a build CAN still hold an id this file does not know — a link row or a plugin
 *     state written by a connector this build no longer ships, or a mixed-version deploy — the
 *     miss renders {@link WmsPanelUnavailable}: a named, visible statement of what is missing.
 *     There is no path through this component that renders nothing.
 *
 * The DTO's per-connector payload is `unknown` on purpose (see lib/connectors/wms/connector-hooks.ts).
 * `render` is the ONE place allowed to narrow it, because this is the one file whose job is to be
 * connector-specific.
 */

export type WmsConnectorPanel = {
  /** User-visible name. Also the Integrations card's title. */
  label: string
  /** One line on the Integrations card. */
  description: string
  logo: React.ReactNode
  /** Narrows the facade's opaque payload and renders the connector's own screen. */
  render: (payload: unknown) => React.ReactNode
}

export const WMS_PANELS: Record<WmsConnectorId, WmsConnectorPanel> = {
  mintsoft: {
    label: 'Mintsoft',
    description: 'Bind Mintsoft warehouses, store credentials, and stage WMS callbacks',
    // eslint-disable-next-line @next/next/no-img-element
    logo: <img src="/images/mintsoft.svg" alt="Mintsoft" className="h-8 object-contain" />,
    render: (payload) => <MintsoftClient data={payload as MintsoftDashboardData} />,
  },
}

/**
 * The registered WMS connectors, as the Integrations grid lists them.
 *
 * Derived from the record's OWN keys rather than from `WMS_CONNECTOR_IDS`, so an entry without a
 * panel is not merely a compile error but an unconstructable value: the two lists cannot drift at
 * runtime, whatever a build or a test does to the id list.
 */
export const WMS_PANEL_ENTRIES: ReadonlyArray<{ id: WmsConnectorId } & WmsConnectorPanel> =
  (Object.entries(WMS_PANELS) as Array<[WmsConnectorId, WmsConnectorPanel]>)
    .map(([id, panel]) => ({ id, ...panel }))

/**
 * The registered WMS connectors as the Integrations grid lists them, WITH the registry's own
 * `available` flag (o3d-remove-shiphero round 12, Codex HIGH 2).
 *
 * The grid used to build these entries itself and write `available: true` into every one — a second
 * source for a fact the connector's definition already states, so a connector registered
 * `available: false` ("registered but not offered to operators yet") got a live, clickable card.
 * The offered ids are resolved from the registry on the SERVER (the registry statically imports the
 * shipped connector, and Prisma behind it, so it cannot enter a client bundle) and handed in here;
 * this is the one place that turns them into cards, so there is no second place to forget.
 */
export function listWmsIntegrationCards(
  availableWmsConnectorIds: readonly WmsConnectorId[],
): ReadonlyArray<{ id: WmsConnectorId; name: string; description: string; available: boolean }> {
  return WMS_PANEL_ENTRIES.map((entry) => ({
    id: entry.id,
    name: entry.label,
    description: entry.description,
    available: availableWmsConnectorIds.includes(entry.id),
  }))
}

function lookupWmsPanel(connectorId: string): WmsConnectorPanel | null {
  return (WMS_PANELS as Record<string, WmsConnectorPanel | undefined>)[connectorId] ?? null
}

/**
 * WHAT AN OPERATOR SEES INSTEAD OF NOTHING.
 *
 * Four distinct states, because they call for different things:
 *   - `no-panel`: this build has no screen for the connector that is enabled. Nothing here can be
 *     fixed by re-entering credentials; the build is the problem;
 *   - `no-data`: this build HAS a screen, and the connector returned nothing for it — it declares
 *     no dashboard of its own, or its read came back empty. Whether the connection itself is set
 *     up is stated separately, so "configured but nothing to show" is never mistaken for
 *     "not set up";
 *   - `not-active`: another connector is the one serving the app, and this screen can name it;
 *   - `ambiguous`: MORE THAN ONE WMS connector is enabled, so nothing is active
 *     (o3d-remove-shiphero round 12, Codex MEDIUM). This used to render as `not-active` with no
 *     `activeLabel`, which printed "another connector currently does" — a claim that some other
 *     connector is serving the app, in the one state where NONE is. The remedy is on the
 *     Integration Plugins screen and the reason names the rows that are fighting, so it is the
 *     shared `ambiguousWmsConnectorReason` rather than a sentence written again here.
 *
 * `not-active` keeps a separate `none-active` sibling for the same reason: with no connector
 * enabled at all there is no "another connector" either.
 */
type WmsPanelUnavailableReason = 'no-panel' | 'no-data' | 'not-active' | 'none-active' | 'ambiguous'

function WmsPanelUnavailable({ reason, connectorLabel, connectorId, configured, activeLabel, ambiguousConnectorIds }: {
  reason: WmsPanelUnavailableReason
  connectorLabel: string
  connectorId: string
  configured: boolean
  activeLabel?: string
  ambiguousConnectorIds?: readonly string[]
}) {
  const headline = reason === 'no-panel'
    ? `This build has no configuration screen for ${connectorLabel}.`
    : reason === 'ambiguous'
      ? 'More than one WMS connector is enabled, so none of them is serving the app.'
      : reason === 'none-active'
        ? 'No WMS connector is currently serving the app.'
        : reason === 'not-active'
          ? `${connectorLabel} is not the active WMS connector.`
          : `${connectorLabel} returned no configuration data.`

  const body = reason === 'ambiguous'
    ? ambiguousWmsConnectorReason(ambiguousConnectorIds ?? [])
    : reason === 'none-active'
      ? `Enable ${connectorLabel} on the Integration Plugins screen (Settings → Integration Plugins)`
        + ' to configure it here.'
      : reason === 'not-active'
        ? `Only one WMS connector serves the app at a time, and ${activeLabel} currently does.`
          + ` Disable that one to configure ${connectorLabel} here.`
        : configured
          ? `The ${connectorLabel} connection is set up and running — nothing here needs re-entering.`
          : `The ${connectorLabel} connection is not set up yet, and cannot be set up from this screen.`

  return (
    <div
      role="status"
      data-wms-panel-state={reason}
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="font-medium">{headline}</p>
      <p className="mt-1">
        {body}
        {' '}
        {reason === 'no-panel'
          ? `Connector id ${connectorId} is enabled but this build ships no panel for it; upgrade, or administer it where it lives.`
          : reason === 'no-data'
            ? `Connector id ${connectorId} declares no dashboard of its own.`
            : ''}
      </p>
    </div>
  )
}

type Props = {
  /** The connector whose card the operator opened. */
  connectorId: WmsConnectorId
  /**
   * The ACTIVE connector's dashboard DTO — which may belong to a DIFFERENT connector, or be
   * `null` when no WMS connector is enabled at all. The facade resolves exactly one active
   * connector; opening a second enabled connector's card used to fall through the dashboard's
   * `if` and silently re-render the Integrations grid, so the click did nothing and said nothing.
   */
  data: WmsSyncDashboardData | null
  /**
   * The enabled WMS connectors when MORE THAN ONE is enabled; empty otherwise
   * (o3d-remove-shiphero round 12, Codex MEDIUM).
   *
   * `data` is `null` in that state because the resolver refuses to pick a winner, and `null` alone
   * cannot tell "nothing is enabled" from "too much is" — so the panel said the same false thing
   * about both.
   */
  ambiguousConnectorIds?: readonly string[]
  onBack: () => void
}

export function WmsSyncPanel({ connectorId, data, ambiguousConnectorIds = [], onBack }: Props) {
  const panel = lookupWmsPanel(connectorId)
  const active = data && data.connectorId === connectorId ? data : null
  const payload = active ? (active.connectorData as Record<string, unknown>)[connectorId] : undefined
  // The panel's own name first; failing that the registry's, carried in the DTO because a client
  // component cannot read the registry; failing that the raw id, which is still an answer.
  const connectorLabel = panel?.label ?? (active ? active.connectorLabel : connectorId)
  const activeLabel = data ? (lookupWmsPanel(data.connectorId)?.label ?? data.connectorLabel) : undefined
  // WHY AMBIGUITY OUTRANKS "not active" AND "none active": all three arrive as a missing DTO, and
  // only this one has a cause the operator can act on. `> 1`, not `> 0`, because one enabled
  // connector is not an ambiguity however the caller filled the list in.
  const inactiveReason: WmsPanelUnavailableReason = ambiguousConnectorIds.length > 1
    ? 'ambiguous'
    : activeLabel === undefined ? 'none-active' : 'not-active'

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        ← Back to Integrations
      </button>
      <div className="flex items-center gap-3 mb-2">
        {panel?.logo}
        <div>
          <h2 className="text-lg font-semibold">{connectorLabel} Connector</h2>
          <p className="text-xs text-muted-foreground">Configure the WMS connection, webhook intake, and warehouse bindings.</p>
        </div>
      </div>
      {panel === null ? (
        <WmsPanelUnavailable
          reason="no-panel"
          connectorLabel={connectorLabel}
          connectorId={connectorId}
          configured={active?.configured ?? false}
        />
      ) : active === null ? (
        <WmsPanelUnavailable
          reason={inactiveReason}
          connectorLabel={connectorLabel}
          connectorId={connectorId}
          configured={false}
          activeLabel={activeLabel}
          ambiguousConnectorIds={ambiguousConnectorIds}
        />
      ) : payload === undefined ? (
        <WmsPanelUnavailable
          reason="no-data"
          connectorLabel={connectorLabel}
          connectorId={connectorId}
          configured={active.configured}
        />
      ) : (
        panel.render(payload)
      )}
    </div>
  )
}
