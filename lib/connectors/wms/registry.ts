import type {
  WmsConnector,
  WmsConnectorId,
  WmsCreateReplayPolicy,
  WmsOrderPushInput,
  WmsOrderPushProvenResult,
} from './types'
import { WMS_CONNECTOR_IDS } from './types'
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
 * To add a WMS connector: add its id to WMS_CONNECTOR_IDS (lib/connectors/wms/types.ts) and a
 * definition under that id in BUILT_IN_WMS_CONNECTOR_REGISTRATIONS below — neither half compiles
 * without the other — then add a panel and its cron/webhook ingress. The IntegrationPluginId, the
 * setting key and the toggle are derived. Core flows need no edits: that is the promise this
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

/**
 * A CONNECTOR MUST BE THE CONNECTOR THAT WAS ASKED FOR (o3d-remove-shiphero round 14, Codex HIGH 1).
 *
 * {@link WmsConnectorRegistrations} makes a mismatched factory uncompilable, and that is where this
 * is meant to be caught. This is the backstop for the callers the compiler never sees: a JavaScript registration,
 * a `mock.module` that widens the id list, a mixed-version deploy, a registry built through the
 * structural `WmsConnectorInstanceSource`. It runs at CONSTRUCTION — the single moment every
 * dispatch in the app passes through — rather than at load, because a factory body is opaque until
 * it is invoked.
 *
 * IT THROWS, and loudly. The failure it prevents is silent: an operation routed to a warehouse
 * nobody asked for, whose result is then recorded under the id that was asked for. There is no
 * degraded behaviour that is better than refusing — a connector that is not the one requested
 * cannot serve the request, and `isWmsConnectorConfigured` already turns a throw from this layer
 * into "not configured", which is the honest answer for a build that cannot route the id.
 */
function assertWmsConnectorIdentity<C extends { id: string }>(requestedId: string, connector: C): C {
  if (connector.id !== requestedId) {
    throw new Error(
      `WMS connector registration for "${requestedId}" built a connector whose id is`
      + ` "${String(connector.id)}" — a registration's factory must return that connector, never`
      + ' another warehouse\'s',
    )
  }
  return connector
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
      return assertWmsConnectorIdentity(id, def.create())
    },
  }
}

/**
 * A DEFINITION WITHOUT ITS ID — the id comes from the key it is registered under.
 *
 * Dropping `id` from the value is not tidiness: it is what makes "the definition's id disagrees
 * with the id it is registered as" unrepresentable rather than merely wrong. Nobody writes the id
 * twice, so nobody can write it twice differently.
 */
export type WmsConnectorRegistration<Id extends string = WmsConnectorId> = Omit<WmsConnectorDef<Id>, 'id'>

/**
 * THE REGISTRATION RECORD — every entry constrained to ITS OWN KEY, which is a MAPPED TYPE and not
 * a `Record` over the union (o3d-remove-shiphero round 14, Codex HIGH 1).
 *
 * WHAT WENT WRONG. Round 12 made the record TOTAL over `WmsConnectorId`, which is what makes a
 * registered id with no definition uncompilable, and that half was right. But it spelled the
 * totality `Record<Id, WmsConnectorRegistration<Id>>`, and `Record` hands EVERY entry the WHOLE id
 * union. With two ids the `acme-wms` entry's `create` was
 * `() => WmsRegistrableConnector<'mintsoft' | 'acme-wms'>`, so a factory returning the MINTSOFT
 * connector typechecked under Acme's key — and `getConnector('acme-wms')` handed it straight back.
 * Production would have resolved Acme and sent every operation to Mintsoft: the order push, the
 * ASNs, the stock reads, the dispatch poll, all against the wrong warehouse, recorded under Acme's
 * link rows, cursors and audit trail. A key that does not constrain the thing it names is not a
 * registry, it is a table of coincidences.
 *
 * SO EACH ENTRY IS KEYED TO ITSELF. `[K in Id]` binds `K` per member, so entry `K` may hold only
 * `WmsConnectorRegistration<K>`; `WmsConnector`'s `readonly id: Id` then carries that same literal
 * into the factory's RETURN TYPE. A registration whose factory returns a connector for a different
 * id does not compile.
 *
 * WHY THE TYPE HAS TO BE THE PRIMARY ANSWER. Factories are NOT invoked until request time, so no
 * load-time walk can look inside one: the round-12 load-time guard can see that an id has an entry
 * and can never see whose connector that entry builds. The only place a mismatch is visible before
 * a warehouse call is the compiler. `assertWmsConnectorIdentity` is the backstop for the callers
 * `tsc` never sees — a JavaScript registration, a `mock.module` that widens the id list, a
 * mixed-version deploy — and it fires when the connector is CONSTRUCTED, which every dispatch
 * passes through.
 */
export type WmsConnectorRegistrations<Id extends string> = {
  readonly [K in Id]: WmsConnectorRegistration<K>
}

/**
 * THE ONE DERIVATION: a registry is the canonical id list crossed with one definition per id
 * (o3d-remove-shiphero round 12, Codex HIGH 1).
 *
 * WHAT WENT WRONG. `BUILT_IN_WMS_CONNECTORS` was a hand-written array typed
 * `readonly WmsConnectorDef[]`. Rounds 6 and 8 made the PANELS and the plugin TOGGLES total over
 * `WMS_CONNECTOR_IDS` — so a registered id with no screen does not compile — and never applied the
 * same rule to the DEFINITIONS, which is the one list that actually has to be complete. Adding an
 * id, a panel and a form while omitting the definition typechecked: the settings screen then
 * offered the connector, the writer persisted it, the resolver selected it, and every route that
 * reached `getWmsConnector` threw `Unknown WMS connector` at REQUEST time — in the order push, the
 * dispatch sweep, the ASN actions. A registration that is half-done is worse than one that is
 * missing, because the operator is told it worked.
 *
 * SO THE LIST AND THE DEFINITIONS ARE NO LONGER TWO LISTS. `ids` is walked and each id is looked up
 * in a record that is TOTAL over those ids, which gives both halves:
 *
 *   - COMPILE TIME: {@link WmsConnectorRegistrations} is total over `ids`, so an id in the list with
 *     no definition is a `tsc` error at the record, and a definition for an id that is not in the
 *     list is an excess-property error. Neither list can grow without the other. It is also keyed
 *     PER ENTRY (round 14, Codex HIGH 1), so an entry cannot hold another connector's factory;
 *   - LOAD TIME: the lookup is still checked, because a build can reach the runtime with the two
 *     disagreeing anyway — a `mock.module` that widens the id list, a JavaScript caller, a
 *     mixed-version deploy. It throws HERE, at module evaluation, naming the id. A build that
 *     cannot route a registered connector must fail where a deploy sees it, not on the first order
 *     that happens to need the warehouse.
 *
 * Order is `ids` order, which is what `getActiveWmsConnectorId`'s legacy fallback depends on — one
 * list decides it rather than an array literal that has to be kept "matching" by hand.
 */
export function createRegisteredWmsConnectorRegistry<Id extends string>(
  ids: readonly Id[],
  registrations: WmsConnectorRegistrations<Id>,
): WmsConnectorRegistry<Id> {
  return createWmsConnectorRegistry(ids.map((id): WmsConnectorDef<Id> => {
    const registration = registrations[id]
    if (!registration) {
      throw new Error(
        `WMS connector "${id}" is a registered id with no definition —`
        + ' every id in WMS_CONNECTOR_IDS must have an entry in the registration record',
      )
    }
    // `id` LAST (o3d-remove-shiphero round 14, Codex HIGH 1). Spread first and the key wins; spread
    // last — as this read `{ id, ...registration }` until round 14 — and a registration carrying an
    // `id` of its own OVERWRITES the key it was filed under. `WmsConnectorRegistration` omits `id`,
    // so `tsc` refuses to write one; a JavaScript caller, a `JSON.parse`d registration or a test
    // fixture is under no such constraint, and the value it smuggled in would have become the
    // definition's id everywhere downstream — including the identity check meant to catch exactly
    // this. The key is authoritative because it is applied last, not because nobody wrote the field.
    return { ...registration, id }
  }))
}

/**
 * The connectors this build ships, keyed by id.
 *
 * TOTAL over `WMS_CONNECTOR_IDS` (see {@link createRegisteredWmsConnectorRegistry}): registering an
 * id without writing its definition here does not compile. And each entry is typed to ITS OWN KEY
 * ({@link WmsConnectorRegistrations}), so `create` under a key must return the connector for THAT
 * id — a factory returning another warehouse's connector does not compile either.
 */
export const BUILT_IN_WMS_CONNECTOR_REGISTRATIONS: WmsConnectorRegistrations<WmsConnectorId> = {
  mintsoft: {
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
}

export const wmsConnectorRegistry = createRegisteredWmsConnectorRegistry(
  WMS_CONNECTOR_IDS,
  BUILT_IN_WMS_CONNECTOR_REGISTRATIONS,
)

/** The connectors this build ships, in `WMS_CONNECTOR_IDS` order — the registry's own list. */
export const BUILT_IN_WMS_CONNECTORS: readonly WmsConnectorDef[] = wmsConnectorRegistry.list()

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
  const def = source.findDef(id)
  if (!def) return null
  // The identity check again, and NOT because `getConnector` already does it — this function does
  // not go through `getConnector` (round 14, Codex HIGH 1). `WmsConnectorInstanceSource` is
  // STRUCTURAL, so it carries no `id` for the compiler to constrain, and this is the path
  // `isWmsConnectorConfigured` takes: the /sync panel and the onboarding wizard would otherwise read
  // "is it set up?" off whichever connector the factory happened to build.
  return assertWmsConnectorIdentity(id, def.create())
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
 *
 * RESOLUTION IS INSIDE THE TRY, not just the predicate (o3d-remove-shiphero round 14, Codex HIGH 1).
 * `findWmsConnector` can now throw on its own account — a registration whose factory builds another
 * warehouse's connector is refused there — and the round-10 rule covers that throw for exactly the
 * same reason it covers the predicate's: these are the reads `/onboarding` gathers with
 * `Promise.all` and `/sync` gathers with the other twenty-one, so a rejection here is not "the WMS
 * panel is missing", it is the whole wizard and the whole dashboard. A build that cannot resolve the
 * connector cannot say the connection is set up either, and `false` is the answer that leaves the
 * screens up. The DISPATCH path is unchanged and still throws: `getWmsConnector` has an honest
 * destination for a fault, and routing an order to a warehouse nobody asked for does not.
 */
export async function isWmsConnectorConfigured(
  id: string,
  source: WmsConnectorInstanceSource = wmsConnectorRegistry,
): Promise<boolean> {
  try {
    const connector = findWmsConnector(id, source)
    if (!connector) return false
    return await connector.isConfigured()
  } catch (error) {
    unstable_rethrow(error)
    // Logged, never swallowed silently: an unanswerable predicate — or a connector that cannot be
    // resolved at all — is a real fault somebody has to fix, and `configured: false` is what the
    // screen shows while they do.
    console.error(`[wms] could not answer whether ${id} is configured; treating it as NOT configured`, error)
    return false
  }
}
