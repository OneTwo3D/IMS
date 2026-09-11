import type {
  WmsConnector,
  WmsConnectorId,
  WmsCreateReplayPolicy,
  WmsOrderPushInput,
  WmsOrderPushProvenResult,
} from './types'
import type { WmsConnectorHooks } from './connector-hooks'
import { unstable_rethrow } from 'next/navigation'
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
  & (
    /**
     * THE SECOND PAIRING THE CONTRACT CANNOT STATE ALONE (o3d-remove-shiphero round 4, Codex HIGH 1).
     *
     * `WmsConnector` makes `fetchOrderDelta` and `deltaCursorTimeZone` independently optional, so it
     * admits a connector with a bulk delta and no statement of the zone its cursor is a wall-clock
     * time in. There is no safe default for that: the sweep would have to pick somebody's zone, and
     * whichever it picked would silently shift the window — the round-2 defect (a second connector
     * inheriting Mintsoft's `Europe/London`) arriving through a different column.
     *
     * So registration requires one of two shapes:
     *
     *   - NO bulk delta, and the zone is meaningless — the sweep per-order polls; or
     *   - a bulk delta AND the zone its cursor is compared in, stated by the warehouse's own
     *     connector.
     *
     * Enforced at the registry for the same reason the verification pairing is: every production
     * connector reaches the app through `getConnector`, so a connector that cannot satisfy this
     * cannot be dispatched to at all.
     */
    | { fetchOrderDelta?: undefined }
    | {
      fetchOrderDelta: NonNullable<WmsConnector<Id>['fetchOrderDelta']>
      deltaCursorTimeZone: string
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
      // The /sync WMS panel and the onboarding connection step (o3d-remove-shiphero round 4,
      // Codex HIGH 2). Both used to be an `if (connectorId === 'mintsoft')` inside the generic
      // facade, with the connector's payload returned under a literal `mintsoft:` member.
      // NEITHER HOOK STATES `configured` (o3d-remove-shiphero round 8, Codex HIGH 1). A hook
      // supplies the PAYLOAD its own screen renders; whether the connection is set up is
      // `isConfigured()`, which every connector must implement, and the facades read it there. A
      // second source for one fact is what let the no-hook branch answer `false` on its own.
      syncDashboard: async () => {
        const m = await import('@/app/actions/mintsoft-sync')
        return { getDashboardData: async () => ({ panel: await m.getMintsoftDashboardData() }) }
      },
      onboarding: async () => {
        const m = await import('@/app/actions/mintsoft-sync')
        return { getConnectionData: async () => ({ form: await m.getMintsoftOnboardingConnectionData() }) }
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
 * Where a connector INSTANCE is read from, for generic flows holding an id that may not be one this
 * build ships. Structural for the same reason {@link WmsConnectorDefSource} is.
 */
export type WmsConnectorInstanceSource = {
  findDef(id: string): { create: () => WmsConnector<string> } | null
}

/**
 * The connector with this id, or `null` for an id this build does not ship.
 *
 * `findDef`, not `getDef`, and therefore NOT `getWmsConnector`: the callers are generic reads
 * holding an id that came out of plugin state or a link row, and an id from a connector this build
 * no longer ships must degrade rather than throw from inside a read.
 *
 * WHAT THIS EXISTS FOR (o3d-remove-shiphero round 8, Codex HIGH 1). `isConfigured()` is the one
 * MANDATORY statement a connector makes about its own connection. The two UI facades used to
 * answer `configured: false` from their own no-hook branch instead of asking it, which conflated
 * "this connector ships no panel" (a CAPABILITY) with "this connector is not set up" (its STATE) —
 * and told an operator with a live warehouse connection to go and re-enter credentials that were
 * never missing. The facades now read the state here and nowhere else.
 */
export function findWmsConnector(
  id: string,
  source: WmsConnectorInstanceSource = wmsConnectorRegistry,
): WmsConnector<string> | null {
  return source.findDef(id)?.create() ?? null
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

/**
 * WHETHER THIS CONNECTOR'S CONNECTION IS SET UP — and the ONE place `isConfigured()` may be called
 * from a read (o3d-remove-shiphero round 10, Codex HIGH 2).
 *
 * THE DEFECT THIS CLOSES. Round 8 moved `configured` onto `WmsConnector.isConfigured()`, correctly:
 * it is the one MANDATORY statement a connector makes about its own connection, and the hooks had
 * been answering it from a branch that knew only what this BUILD ships. But the move was argued as
 * behaviour-preserving by inspection and it was not. The hook-supplied value came from
 * `mintsoftHasAuthMaterial`, which CATCHES `MintsoftAuthModeError` and reads a malformed auth mode
 * as "not configured". `MintsoftConnector.isConfigured()` does not: it goes through
 * `getMintsoftApiConfiguration()`, which THROWS on a malformed stored or environment auth mode.
 *
 * The facades then awaited it unguarded, in the reads that `/onboarding` gathers with `Promise.all`
 * and `/sync` gathers with `Promise.allSettled`. So one bad `mintsoft_auth_mode` row — or one bad
 * `MINTSOFT_AUTH_MODE` env var, which never passes through the validated settings action at all —
 * took down the whole onboarding wizard and the whole /sync dashboard. Both are where an operator
 * goes to CORRECT that value. A misconfiguration became unfixable through the UI, which is strictly
 * worse than the wrong label round 8 set out to remove.
 *
 * THE RULE. `isConfigured()` answers a question, and a question that throws has not been answered.
 * A connector that cannot say whether it is configured is NOT configured: that is the money-safe
 * reading (nothing downstream treats an unanswered connection as live) and the operator-safe one
 * (the corrective form stays reachable, showing exactly the "not set up" state that sends a person
 * to fix it). The rule is enforced HERE rather than asked of each connector, because a contract
 * cannot make a method total by writing it down — and because the facades are reads, where a throw
 * has no honest destination.
 *
 * WHY THE FACADES DO NOT CALL `findWmsConnector(...).isConfigured()` THEMSELVES ANY MORE. A
 * containment they have to remember is a containment the next screen will not have. This function
 * is what they hold instead, so there is no unguarded call for a screen to make.
 *
 * `unstable_rethrow` FIRST, for the reason lib/domain/post-commit.ts states: Next signals
 * `redirect()`/`notFound()` by throwing, and reading a redirect as "not configured" would leave an
 * operator with an invalidated session on the wizard instead of at the challenge. An authorization
 * denial is deliberately NOT special-cased: `isConfigured()` is a settings read that gates nothing,
 * the facades run their own `requirePermission('sync')` before reaching this, and a connector whose
 * predicate authorizes is violating the contract in a way no caller can repair.
 *
 * `findWmsConnector`, so an id left behind by a connector this build no longer ships is
 * unconfigurable rather than a throw from inside a read.
 */
export async function isWmsConnectorConfigured(
  id: string,
  source: WmsConnectorInstanceSource = wmsConnectorRegistry,
): Promise<boolean> {
  const connector = findWmsConnector(id, source)
  if (!connector) return false
  try {
    return await connector.isConfigured()
  } catch (error) {
    unstable_rethrow(error)
    // Logged, never swallowed silently: an unanswerable predicate is a real fault an operator has
    // to fix, and `configured: false` is what the screen shows them while they do.
    console.error(`[wms] ${id}.isConfigured() threw; treating the connection as NOT configured`, error)
    return false
  }
}
