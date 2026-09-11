import { WMS_CONNECTOR_IDS, type WmsConnectorId } from './types'

/**
 * WHICH WMS CONNECTOR IS ACTIVE — asked once, answered honestly, and never guessed
 * (o3d-remove-shiphero round 10, Codex HIGH 1).
 *
 * WHAT THIS REPLACES. Sixteen production sites each wrote `WMS_CONNECTOR_IDS.find((id) => state[id])`
 * inline. That is a DERIVED answer that silently picks a winner: with two connectors enabled it
 * returns the first one in registration order and says nothing, so an operator who enabled a second
 * WMS — which round 8's registry-derived toggles made possible, and which no writer refused — saw a
 * successful save and then watched every push, every sweep and every dispatch keep going to
 * Mintsoft. Sixteen copies of a rule is also how this branch has been bitten six times by a rule
 * fixed in one reader and left in another.
 *
 * TWO HALVES, AND BOTH ARE NEEDED.
 *   1. The bad state is now UNWRITABLE: `findIntegrationPluginExclusivityConflict`
 *      (lib/integration-plugin-keys.ts) puts the WMS ids in a derived exclusivity group, and both
 *      plugin-state writers evaluate it under the connector-selection lock against the state their
 *      write RESULTS in. Two enabled WMS connectors cannot be committed by this app.
 *   2. A reader must still not GUESS. "Cannot be written by this app" is not "cannot exist": a
 *      database restore, a direct `UPDATE setting`, or a row written before this rule can all
 *      produce it. So the resolution is a three-way answer and `ambiguous` is a state of its own —
 *      it is not folded into `none`, and it never resolves to a connector.
 *
 * WHY AMBIGUOUS ROUTES NOWHERE. Every consumer of this answer either talks to a warehouse (order
 * push, dispatch reconciliation, status polling, ASN creation) or tells an operator which warehouse
 * is in charge. Picking one of two is how an order gets created in the wrong warehouse and picked
 * there; picking one for display is how an operator is told the switch they flipped took effect
 * when it did not. Refusing is the only answer that is wrong in a direction somebody notices.
 */
export type WmsConnectorResolution =
  /** No WMS connector is enabled. */
  | { readonly kind: 'none' }
  /** Exactly one is, and it is the one everything routes to. */
  | { readonly kind: 'one'; readonly id: WmsConnectorId }
  /**
   * More than one is. Unwritable through this app since round 10, and still reachable by a restore
   * or a direct row edit — which is exactly why it is a value rather than an assumption.
   */
  | { readonly kind: 'ambiguous'; readonly ids: readonly WmsConnectorId[] }

/** What a sweep or a facade says when it declines to act. One sentence per kind, in one place. */
export const NO_WMS_CONNECTOR_ENABLED = 'No WMS connector enabled'

/**
 * Named so it reads as a configuration fault rather than an outage: the remedy is on the Integration
 * Plugins screen, and the message says which rows are fighting.
 */
export function ambiguousWmsConnectorReason(ids: readonly string[]): string {
  return `More than one WMS connector is enabled (${ids.join(', ')}) — WMS routing is single-connector,`
    + ' so nothing is dispatched until exactly one is on (Settings → Integration Plugins)'
}

/**
 * The skip/refusal reason for a resolution that is not exactly one connector.
 *
 * `noneReason` exists so a caller that already published its own "no connector" wording keeps it
 * byte-for-byte. Round 10 adds a reason for a state that had none; it is not the round to re-word
 * the messages that were already right, and a skip string a test or an operator recognises is worth
 * more than uniformity.
 */
export function wmsResolutionSkipReason(
  resolution: Exclude<WmsConnectorResolution, { kind: 'one' }>,
  noneReason: string = NO_WMS_CONNECTOR_ENABLED,
): string {
  return resolution.kind === 'none' ? noneReason : ambiguousWmsConnectorReason(resolution.ids)
}

/**
 * Resolve the enabled WMS connector from an already-read plugin state.
 *
 * PURE, and takes the state rather than reading it, because most callers already hold a plugin-state
 * read they took for another reason — the inline `find` this replaces was written that way for
 * exactly that, and a helper that read the state again would have been declined at every one of
 * them. This module imports nothing but the id list, so it stays out of the Prisma graph.
 */
export function resolveEnabledWmsConnector(
  state: Partial<Record<string, boolean>>,
): WmsConnectorResolution {
  const enabled = enabledWmsConnectorIds(state)
  if (enabled.length === 0) return { kind: 'none' }
  if (enabled.length === 1) return { kind: 'one', id: enabled[0] }
  return { kind: 'ambiguous', ids: enabled }
}

/**
 * EVERY enabled WMS connector — for the one consumer that must not narrow.
 *
 * `app/actions/stock-counts.ts` screens a warehouse's WMS bindings to decide whether a stock count
 * is blocked or needs an acknowledgement. That is not routing: with a contradictory enabled set the
 * conservative answer is to honour every enabled connector's binding, because dropping one would
 * silently un-block a count the WMS is about to overwrite. Callers that ROUTE must not use this.
 */
export function enabledWmsConnectorIds(
  state: Partial<Record<string, boolean>>,
): WmsConnectorId[] {
  return WMS_CONNECTOR_IDS.filter((id) => state[id])
}

/**
 * The enabled WMS connector, or `null` when there is not exactly one.
 *
 * For the callers whose whole behaviour on "no connector" and on "cannot tell" is identical —
 * showing no WMS chip, rendering no panel, skipping a screening pass. A caller that REPORTS its
 * reason must use {@link resolveEnabledWmsConnector} instead, so an ambiguity is not described to
 * an operator as "no WMS connector is enabled" while two switches are visibly on.
 */
export function enabledWmsConnectorId(
  state: Partial<Record<string, boolean>>,
): WmsConnectorId | null {
  const resolution = resolveEnabledWmsConnector(state)
  return resolution.kind === 'one' ? resolution.id : null
}
