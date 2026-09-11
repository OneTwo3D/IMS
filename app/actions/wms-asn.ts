'use server'

import { requirePermission } from '@/lib/auth/server'
import { getActiveWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { findWmsConnectorLabel, getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import { decorateWmsAsnState, unsupportedWmsAsnState } from '@/lib/connectors/wms/asn-types'
import type { WmsAsnActions } from '@/lib/connectors/wms/connector-hooks'
import type {
  WmsPurchaseOrderAsnState,
  WmsTransferAsnState,
  WmsCreateAsnResult,
} from '@/lib/connectors/wms/asn-types'

/**
 * Connector-agnostic ASN server-action facade. Core PO/transfer flows call these; the facade
 * resolves the ACTIVE WMS connector and dispatches to whatever ASN implementation that connector
 * registered. Adding a WMS connector means adding `hooks.asn` to its registry definition — not
 * editing this file, and not editing the PO/transfer views.
 *
 * o3d-remove-shiphero round 2 (Codex HIGH 1) — WHY THIS IS NOT AN `id === 'mintsoft'` CHECK.
 * Every action here used to dispatch only when the active connector was literally `mintsoft`, and
 * fall through otherwise. The fall-through arms are not harmless defaults: a registered connector
 * that can perfectly well create an ASN — `createAsn` is REQUIRED by `WmsConnector`, so every
 * connector can — got the "unsupported" state on the reads and the flat lie "No WMS connector is
 * enabled." on the creates. The facade was a dispatcher with one arm, which is a switch that
 * compiles fine and makes the id meaningless.
 *
 * It now routes on CAPABILITY: does the active connector declare an ASN implementation? The two
 * "no" answers are kept DISTINCT, because they call for different things from the operator —
 * nothing is enabled (enable a WMS), versus this warehouse cannot do ASNs (receive by hand). The
 * second is NAMED, so nobody is told an anonymous system is unavailable.
 *
 * o3d-512h round 3 — GUARDS, not an allowlist wildcard. These five carried no gate of their own and
 * sat behind `'wms-asn.ts:*'` in tests/security/server-action-guard-coverage.test.ts, on a reason
 * that said in as many words that the no-connector arm returns unguarded. It is the accounting-sync
 * defect verbatim: `getActiveWmsConnectorId` is a plugin-state DATABASE READ, and on the arm where
 * no WMS connector is enabled the answer comes back from this module with no delegate anywhere on
 * the path. Every principal — including SUPPLIER — could POST these to learn whether the tenant
 * runs a WMS.
 *
 * Each takes ITS OWN delegate's gate, not one gate for the file: the two reads go to
 * requireMintsoftReadAccess (= 'sync'), the PO ASN create to 'purchasing.receive' and the transfer
 * ASN create to 'stock_control.transfer'. Copying a single permission across all five would have
 * locked WAREHOUSE out of an ASN it is entitled to create. The gate is taken BEFORE the resolve, on
 * every arm, so it does not matter which arm a caller lands on.
 */

type ResolvedWmsAsn =
  | { connector: string; label: string | null; actions: WmsAsnActions }
  | { connector: string; label: string | null; actions: null }
  | { connector: null; label: null; actions: null }

/**
 * The active connector, its display label, and its ASN implementation if it declares one.
 *
 * `findWmsConnectorLabel` (not `getDef`) so a link row written by a connector this build no longer
 * ships degrades to the generic label instead of throwing inside a read.
 */
async function resolveWmsAsn(): Promise<ResolvedWmsAsn> {
  const connector = await getActiveWmsConnectorId()
  if (connector === null) return { connector: null, label: null, actions: null }
  const label = findWmsConnectorLabel(connector)
  const asn = getWmsConnectorHooks(connector).asn
  if (!asn) return { connector, label, actions: null }
  return { connector, label, actions: await asn() }
}

/** The refusal for a connector that resolved but cannot do ASNs, versus nothing resolving at all. */
function asnUnavailable(resolved: ResolvedWmsAsn): WmsCreateAsnResult {
  if (resolved.connector === null) return { success: false, error: 'No WMS connector is enabled.' }
  return {
    success: false,
    error: `${resolved.label ?? 'The active WMS connector'} does not support advance shipment notices.`,
  }
}

export async function getWmsPurchaseOrderAsnState(poId: string): Promise<WmsPurchaseOrderAsnState> {
  // mintsoft-sync.ts:getMintsoftPurchaseOrderAsnState → requireMintsoftReadAccess() → requirePermission('sync')
  await requirePermission('sync')
  const resolved = await resolveWmsAsn()
  if (!resolved.actions) return unsupportedWmsAsnState(resolved.label)
  return decorateWmsAsnState(await resolved.actions.getPurchaseOrderAsnState(poId), resolved.label)
}

export async function getWmsTransferAsnStates(
  transferIds: string[],
): Promise<Record<string, WmsTransferAsnState>> {
  // mintsoft-sync.ts:getMintsoftTransferAsnStates → requireMintsoftReadAccess() → requirePermission('sync')
  await requirePermission('sync')
  const resolved = await resolveWmsAsn()
  if (!resolved.actions) return {}
  const states = await resolved.actions.getTransferAsnStates(transferIds)
  return Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, decorateWmsAsnState(state, resolved.label)]),
  )
}

export async function createWmsPurchaseOrderAsn(
  poId: unknown,
  input: unknown,
): Promise<WmsCreateAsnResult> {
  // mintsoft-sync.ts:createMintsoftPurchaseOrderAsn → requirePermission('purchasing.receive')
  await requirePermission('purchasing.receive')
  const resolved = await resolveWmsAsn()
  if (!resolved.actions) return asnUnavailable(resolved)
  return resolved.actions.createPurchaseOrderAsn(poId, input)
}

export async function createWmsTransferAsn(
  transferId: unknown,
  input: unknown,
): Promise<WmsCreateAsnResult> {
  // mintsoft-sync.ts:createMintsoftTransferAsn → requirePermission('stock_control.transfer')
  await requirePermission('stock_control.transfer')
  const resolved = await resolveWmsAsn()
  if (!resolved.actions) return asnUnavailable(resolved)
  return resolved.actions.createTransferAsn(transferId, input)
}

/**
 * o3d-hl8l: re-check an ASN's booked-in state directly with the warehouse.
 *
 * The recovery path behind the webhook's maintenance-mode 503 (and behind the watchdog's
 * overdue-ASN alert): a callback that was refused, never sent or lost leaves no receipt-event row,
 * so nothing that replays existing rows can reach it. This reconstructs the trigger; the warehouse
 * remains the authority for the quantities.
 */
export async function recheckWmsAsnBookedIn(
  externalAsnId: unknown,
): Promise<{ success: boolean; error?: string; message?: string }> {
  // o3d-512h round 3, applied to an export that arrived after it (o3d-m3gy). This dispatcher landed on
  // `development` while `wms-asn.ts:*` still carried a blanket allowlist entry, and that entry was
  // deleted here for the reason the note in tests/security/server-action-guard-coverage.test.ts gives:
  // the no-connector arm returns WITHOUT ever reaching the delegate whose guard it claims to inherit,
  // so on exactly the path an unauthorized caller takes there was no guard at all — and reaching that
  // arm already means `getActiveWmsConnectorId` ran, i.e. the refused caller got a database read and
  // an oracle for which WMS this tenant uses.
  //
  // The gate is the DELEGATE'S OWN, not a convenient one:
  // mintsoft-sync.ts:recheckMintsoftAsnBookedIn → requirePermission('purchasing.receive').
  await requirePermission('purchasing.receive')
  const resolved = await resolveWmsAsn()
  if (!resolved.actions) return asnUnavailable(resolved)
  return resolved.actions.recheckAsnBookedIn(externalAsnId)
}
