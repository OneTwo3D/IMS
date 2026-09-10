import type { WmsConnector, WmsConnectorId, WmsCreateReplayPolicy } from './types'
import { MintsoftConnector } from '@/lib/connectors/mintsoft'

/**
 * THE WMS CONNECTOR REGISTRY — and why it is a registry rather than a constant.
 *
 * Every core flow (sales, PO, transfer, stock, the sweeps, the exception inbox)
 * reaches a warehouse through {@link WmsConnectorRegistry}: it asks for a
 * connector by id and gets back something implementing the `WmsConnector`
 * contract, plus the two pieces of metadata the generic layer needs to behave
 * correctly without knowing which warehouse it is talking to — a display
 * `label` for user-facing copy, and a `createReplayPolicy` saying whether that
 * warehouse's create refuses a duplicate.
 *
 * ONLY ONE CONNECTOR SHIPS TODAY (Mintsoft; ShipHero was removed in
 * o3d-remove-shiphero — see docs/archive/shiphero-connector-removal.md). That
 * is exactly when an indirection looks like ceremony and gets inlined, so the
 * shape here is deliberate and is held in place by a test:
 *
 *   - `createWmsConnectorRegistry` is generic over the id type, so a registry
 *     can be built over ids this build does not ship. `tests/wms-second-connector-seam.test.ts`
 *     registers a fictitious `acme-wms` and drives the generic paths through it.
 *     If someone collapses this to `new MintsoftConnector()` at the call sites,
 *     that test stops compiling or stops passing — it has no other way to exist.
 *   - Dispatch is a `Map` of factories, NOT a `switch` on the id. A switch is
 *     the thing that rots: it compiles fine with one arm and quietly makes the
 *     id meaningless.
 *   - `createReplayPolicy` lives on the definition, so adding a connector fails
 *     `tsc` until somebody has written down whether its create is replay-safe.
 *     See lib/domain/wms/create-replay-policy.ts for what the answer means.
 *
 * To add a WMS connector: add its id to WMS_CONNECTOR_IDS (lib/connectors/wms/types.ts),
 * add a definition below, add an IntegrationPluginId + setting key, and add its
 * cron/webhook ingress. Core flows need no edits — that is the promise this
 * registry makes, and the second-connector test is what checks it is still true.
 */
export type WmsConnectorDef<Id extends string = WmsConnectorId> = {
  id: Id
  /** User-visible name. All generic "<WMS> ASN"/"<WMS> status" copy reads this. */
  label: string
  /** False for a connector that is registered but not offered to operators yet. */
  available: boolean
  /** Whether this warehouse's own create refuses a duplicate. Governs every automatic re-push.
   *  Required, so a new connector fails `tsc` until somebody has written it down. Pinned to the
   *  default table in lib/domain/wms/create-replay-policy.ts by a test — that module cannot import
   *  this one, because several suites replace this module with `mock.module`. */
  createReplayPolicy: WmsCreateReplayPolicy
  /** Constructs the connector. A factory, not an instance: connectors read settings on use. */
  create: () => WmsConnector<Id>
}

export type WmsConnectorRegistry<Id extends string = WmsConnectorId> = {
  /** Every registered definition, in registration order. Order is load-bearing:
   *  getActiveWmsConnectorId() falls back to the first entry. */
  list(): readonly WmsConnectorDef<Id>[]
  ids(): readonly Id[]
  has(id: string): id is Id
  /** Throws for an unregistered id — a caller holding an unknown id has a bug, not a default. */
  getDef(id: Id): WmsConnectorDef<Id>
  /** `null` rather than a throw, for callers that legitimately hold a foreign id
   *  (a link row written by a connector this build no longer ships). */
  findDef(id: string): WmsConnectorDef<Id> | null
  getConnector(id: Id): WmsConnector<Id>
}

export function createWmsConnectorRegistry<Id extends string>(
  defs: readonly WmsConnectorDef<Id>[],
): WmsConnectorRegistry<Id> {
  const byId = new Map<string, WmsConnectorDef<Id>>()
  for (const def of defs) {
    if (byId.has(def.id)) throw new Error(`Duplicate WMS connector registration: ${def.id}`)
    byId.set(def.id, def)
  }
  const ordered = [...defs]

  return {
    list: () => ordered,
    ids: () => ordered.map((def) => def.id),
    has: (id: string): id is Id => byId.has(id),
    findDef: (id: string) => byId.get(id) ?? null,
    getDef(id: Id) {
      const def = byId.get(id)
      if (!def) throw new Error(`Unknown WMS connector: ${id}`)
      return def
    },
    getConnector(id: Id): WmsConnector<Id> {
      const def = byId.get(id)
      if (!def) throw new Error(`Unknown WMS connector: ${id}`)
      return def.create()
    },
  }
}

/** The connectors this build ships. Order matches WMS_CONNECTOR_IDS. */
export const BUILT_IN_WMS_CONNECTORS: readonly WmsConnectorDef[] = [
  {
    id: 'mintsoft',
    label: 'Mintsoft',
    available: true,
    createReplayPolicy: 'remote-refuses-duplicate',
    create: () => new MintsoftConnector(),
  },
] as const

export const wmsConnectorRegistry = createWmsConnectorRegistry(BUILT_IN_WMS_CONNECTORS)

/** Back-compat view of the shipped registry. Prefer `wmsConnectorRegistry.list()`. */
export const WMS_CONNECTORS: readonly WmsConnectorDef[] = wmsConnectorRegistry.list()

export function getWmsConnectorDef(id: WmsConnectorId): WmsConnectorDef {
  return wmsConnectorRegistry.getDef(id)
}

export function getWmsConnector(id: WmsConnectorId): WmsConnector {
  return wmsConnectorRegistry.getConnector(id)
}

/**
 * The label of a connector id that may not be one this build ships — a link row written by a
 * connector that has since been removed, say. `null` rather than a throw, because this is read
 * inside display paths.
 */
export function findWmsConnectorLabel(id: string): string | null {
  return wmsConnectorRegistry.findDef(id)?.label ?? null
}
