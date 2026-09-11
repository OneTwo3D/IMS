import type {
  WmsConnector,
  WmsConnectorId,
  WmsCreateReplayPolicy,
  WmsOrderPushInput,
  WmsOrderPushProvenResult,
} from './types'
import type { WmsConnectorHooks } from './connector-hooks'
import { MintsoftConnector } from '@/lib/connectors/mintsoft'
import { isMintsoftDispatchClientScoped, mintsoftDeltaScopeToken } from '@/lib/connectors/mintsoft/settings/schema'
import { lockMintsoftDispatchSettings } from '@/lib/connectors/mintsoft/settings/dispatch-settings-lock'
import { getSettingValue } from '@/lib/settings-store'

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
/**
 * A CONNECTOR THAT MAY BE REGISTERED — the contract plus the one coupling `WmsConnector` cannot
 * state on its own (o3d-remove-shiphero round 2, Codex HIGH 4).
 *
 * `WmsConnector` makes `needsVerification` and `verifyPushedOrder` independently optional, so it
 * admits a connector that mints ids it declares UNPROVED and offers no way to prove them. There is
 * no honest state for such an order: SYNCED is a claim of ownership the connector has just
 * disclaimed, and PENDING_VERIFY is a promise nothing can keep.
 *
 * So registration requires one of two shapes, and the shape in between does not typecheck:
 *
 *   - a connector that CAN verify — `verifyPushedOrder` present — may return either kind of push
 *     result, because every doubt it raises has a resolver; or
 *   - a connector that cannot verify must push only PROVEN results
 *     (`WmsOrderPushProvenResult`, whose `needsVerification` is pinned to `false`), or not push at
 *     all.
 *
 * Enforced HERE rather than on the interface because `implements` cannot target a union — a class
 * would stop being able to say `implements WmsConnector<Id>`. Every production connector reaches
 * the app through `getConnector`, so the registry's factory is the choke point every one of them
 * passes: a connector that cannot satisfy this cannot be dispatched to at all.
 */
export type WmsRegistrableConnector<Id extends string> = WmsConnector<Id> &
  (
    | { verifyPushedOrder: NonNullable<WmsConnector<Id>['verifyPushedOrder']> }
    | {
      verifyPushedOrder?: undefined
      pushOrder?: (input: WmsOrderPushInput) => Promise<WmsOrderPushProvenResult>
    }
  )

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
  /** Constructs the connector. A factory, not an instance: connectors read settings on use.
   *  Typed {@link WmsRegistrableConnector}, so a connector that asserts a verification doubt it
   *  cannot resolve fails `tsc` at its registration rather than at a warehouse. */
  create: () => WmsRegistrableConnector<Id>
  /**
   * Server-side flows built AROUND the warehouse calls — the ASN state machine, product/bundle
   * sync, booked-in recheck, the dispatch precondition, the delta scope lock. See
   * ./connector-hooks.ts for why these are not on `WmsConnector`.
   *
   * The generic layer routes on the PRESENCE of a hook, never on the id. Omitting one means "this
   * connector cannot serve that flow", which core flows must degrade around — not "no connector is
   * enabled", which is what the id comparison this replaced said to every connector but one.
   */
  hooks?: WmsConnectorHooks
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
    // The per-connector wiring the generic layer used to reach by asking "is the active connector
    // literally `mintsoft`?". It belongs HERE, in the connector's own registration: this is the one
    // file whose job is to spell the id, so a second connector is added by writing an entry rather
    // than by editing the ASN facade, the product-sync dispatcher and the sweep.
    hooks: {
      asn: async () => {
        const m = await import('@/app/actions/mintsoft-sync')
        return {
          getPurchaseOrderAsnState: (poId) => m.getMintsoftPurchaseOrderAsnState(poId),
          getTransferAsnStates: (transferIds) => m.getMintsoftTransferAsnStates(transferIds),
          createPurchaseOrderAsn: (poId, input) => m.createMintsoftPurchaseOrderAsn(poId, input),
          createTransferAsn: (transferId, input) => m.createMintsoftTransferAsn(transferId, input),
          recheckAsnBookedIn: (externalAsnId) => m.recheckMintsoftAsnBookedIn(externalAsnId),
        }
      },
      productSync: async () => {
        const [product, bundle] = await Promise.all([
          import('@/lib/connectors/mintsoft/sync/product-sync'),
          import('@/lib/connectors/mintsoft/sync/bundle-sync'),
        ])
        return {
          syncProduct: async (productId, triggeredBy) => {
            await product.runMintsoftProductSyncForProduct(productId, triggeredBy)
          },
          syncBundle: async (productId, triggeredBy) => {
            await bundle.runBundleSyncForProduct(productId, triggeredBy)
          },
        }
      },
      bookedInRecheck: async () => {
        const m = await import('@/lib/jobs/wms/process-mintsoft-booked-in-event')
        return { recheckAsn: (externalAsnId, options) => m.enqueueMintsoftBookedInRecheckForAsn(externalAsnId, options) }
      },
      // o3d-bjc #3: unscoped, every Mintsoft per-order lookup throws, so a sweep that ran anyway
      // would strike and dead-letter every active link. A blank ClientId cleanly DISABLES dispatch
      // sync rather than half-running it.
      dispatchPrecondition: async () => {
        const clientId = await getSettingValue('mintsoft_client_id')
        if (isMintsoftDispatchClientScoped(clientId)) return { ok: true }
        return {
          ok: false,
          reason: 'Mintsoft dispatch sync is disabled until mintsoft_client_id is configured (Sync settings)'
            + ' — skipped to avoid unscoped cross-client lookups',
        }
      },
      // Mintsoft's inbound delta is scoped by the five dispatch settings (ClientId above all), so
      // moving them invalidates every cursor. Other connectors get the default lock over their own
      // cursor rows — never these.
      deltaScopeLock: async (tx) => mintsoftDeltaScopeToken(await lockMintsoftDispatchSettings(tx)),
    },
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
 * Where a connector's registered metadata is read from, for the generic flows that route on it.
 *
 * STRUCTURAL, and for the same reason `WmsCreateReplayPolicySource` is: a `WmsConnectorRegistry`
 * satisfies it, so the second-connector seam test injects a registry containing a fictitious
 * connector without any production code learning that id exists.
 */
export type WmsConnectorDefSource = {
  findDef(id: string): { label: string; hooks?: WmsConnectorHooks } | null
}

/**
 * The hooks the connector with this id declares, or `{}` for an id this build does not ship.
 *
 * `findDef`, not `getDef`: the callers are generic flows holding an id that came out of a link row
 * or a plugin-state read, and an id from a connector this build no longer ships must degrade to
 * "declares nothing" rather than throw from inside a read.
 */
export function getWmsConnectorHooks(
  id: string,
  source: WmsConnectorDefSource = wmsConnectorRegistry,
): WmsConnectorHooks {
  return source.findDef(id)?.hooks ?? {}
}

/**
 * The label of a connector id that may not be one this build ships — a link row written by a
 * connector that has since been removed, say. `null` rather than a throw, because this is read
 * inside display paths.
 */
export function findWmsConnectorLabel(
  id: string,
  source: WmsConnectorDefSource = wmsConnectorRegistry,
): string | null {
  return source.findDef(id)?.label ?? null
}
