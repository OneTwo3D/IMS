/**
 * PER-CONNECTOR WIRING THE GENERIC LAYER DISPATCHES TO BY CAPABILITY (o3d-remove-shiphero round 2).
 *
 * WHY THIS EXISTS. `WmsConnector` covers what a WAREHOUSE can do — push an order, read its status,
 * create an ASN. It does not cover the SERVER-SIDE FLOWS built around those calls: the PO/transfer
 * ASN state machine, the product/bundle sync run, the booked-in re-check queue. Those live outside
 * the connector, and until now the generic layer reached them by asking "is the active connector
 * literally `mintsoft`?" and hard-importing Mintsoft's module on the yes arm. Every other registered
 * connector therefore fell off the end of an `if` and was told, untruthfully, that no WMS connector
 * was enabled — see Codex HIGH 1 on app/actions/wms-asn.ts.
 *
 * SO THE WIRING MOVES ONTO THE DEFINITION. A connector declares the flows it can serve; the generic
 * layer routes on the PRESENCE of the declaration and never on the id. That makes the id
 * uninteresting to core flows again, which is the whole promise the registry makes, and it is what
 * `tests/wms-second-connector-seam.test.ts` drives: the fictitious `acme-wms` declares its own
 * hooks and the REAL server actions dispatch to them.
 *
 * EVERY HOOK IS OPTIONAL AND LAZY. Optional because "cannot do this" must be expressible — a
 * connector with no ASN support gets the unsupported state, NAMED, rather than an error about a
 * connector not being enabled. Lazy (a factory returning a promise) because the implementations are
 * server actions and sync modules with heavy transitive imports, and the registry is imported by
 * nearly everything.
 */
import type {
  WmsCreateAsnResult,
  WmsPurchaseOrderAsnStateCore,
  WmsTransferAsnStateCore,
} from './asn-types'
import type { WmsDeltaScopeLock } from '@/lib/domain/wms/delta-scope-lock'

/**
 * The PO/transfer ASN flows, as the generic facade (app/actions/wms-asn.ts) calls them.
 *
 * The state readers return the LABEL-FREE core: the facade decorates it with the active connector's
 * registered display label, so no connector ever spells its own name into user-facing copy.
 */
export type WmsAsnActions = {
  getPurchaseOrderAsnState(poId: string): Promise<WmsPurchaseOrderAsnStateCore>
  getTransferAsnStates(transferIds: string[]): Promise<Record<string, WmsTransferAsnStateCore>>
  createPurchaseOrderAsn(poId: unknown, input: unknown): Promise<WmsCreateAsnResult>
  createTransferAsn(transferId: unknown, input: unknown): Promise<WmsCreateAsnResult>
  /** Re-ask the warehouse whether an ASN booked in, for a callback that was refused or lost. */
  recheckAsnBookedIn(externalAsnId: unknown): Promise<{ success: boolean; error?: string; message?: string }>
}

/** What set a product/bundle sync running. Shared so the dispatcher and every connector agree. */
export type WmsSyncTrigger = 'cron' | 'product_mutation' | 'manual'

/** Product and bundle sync runs for a single product (lib/domain/wms/product-sync-dispatch.ts). */
export type WmsProductSyncActions = {
  syncProduct(productId: string, triggeredBy: WmsSyncTrigger): Promise<void>
  syncBundle(productId: string, triggeredBy: WmsSyncTrigger): Promise<void>
}

/**
 * Re-queue an ASN's booked-in reconciliation after maintenance
 * (lib/domain/wms/post-maintenance-recheck.ts).
 *
 * `unknown` is the return on purpose: the generic drain counts attempts and failures and has no use
 * for whatever bookkeeping a particular connector's queue hands back. Narrowing it here would make
 * the next connector's queue shape a compile error in the generic layer, which is the coupling this
 * whole file exists to remove.
 */
export type WmsBookedInRecheckActions = {
  recheckAsn(externalAsnId: string, options: { reason: string }): Promise<unknown>
}

/**
 * A precondition the DISPATCH SWEEP must satisfy before it touches any link, stated by the
 * connector that has one.
 *
 * Mintsoft's is its ClientId scope: unscoped, every per-order lookup throws, so a sweep that ran
 * anyway would strike and dead-letter every active link. Refusing is not an error — it is a
 * correctly disabled connector — hence the `reason`, which becomes the job's skip reason verbatim.
 */
export type WmsDispatchPrecondition = () => Promise<{ ok: true } | { ok: false; reason: string }>

/**
 * THE TWO UI READS, AND WHY THEIR PAYLOAD IS `unknown` (o3d-remove-shiphero round 4, Codex HIGH 2).
 *
 * `app/actions/wms-sync.ts` and `app/actions/wms-onboarding.ts` were the last two one-arm
 * dispatchers: each compared the active connector to a literal and fell off the end of the `if`, so
 * a second enabled registered connector got `null` dashboard data and was reported
 * `configured: false` by onboarding — a working connection, described to the operator as absent.
 *
 * They could not move onto hooks while their DTOs carried a literal `mintsoft:` member that the
 * dashboard and the wizard read BY NAME; a second named member would have been the same defect with
 * one more arm. So the DTO is keyed BY CONNECTOR and the per-connector payload is opaque here.
 *
 * `unknown`, like `WmsBookedInRecheckActions.recheckAsn`'s return, is the point rather than a
 * shortcut: the generic facade never reads inside the payload, and the only code that knows
 * what the payload IS is the connector's own panel/form — which narrows it, in the one file whose
 * job is to be connector-specific. Typing it here would make the next connector's panel shape a
 * compile error in the generic layer, which is the coupling this file exists to remove.
 */
/**
 * A HOOK STATES A PAYLOAD AND NEVER A STATE (o3d-remove-shiphero round 8, Codex HIGH 1).
 *
 * These two carried `configured` until round 8, which gave the fact two sources: the hook's, and
 * `WmsConnector.isConfigured()` — the one MANDATORY statement a connector makes about its own
 * connection. The facades' no-hook branches then wrote the second source themselves, hard-coding
 * `configured: false` for a connector that simply ships no panel. Two different questions —
 * "does this connector have a screen?" and "is this connector set up?" — were answered with one
 * value, so an operator with a live warehouse connection was told to re-enter credentials that
 * were never missing.
 *
 * Removing the field is the fix rather than correcting the branch: with nowhere to write it, the
 * facades cannot state a connection state at all except by asking the connector, and the wrong
 * answer stops being expressible.
 */
export type WmsSyncDashboard = {
  /** The payload the connector's own /sync panel renders. Opaque to everything else. */
  panel: unknown
}

export type WmsSyncDashboardActions = {
  getDashboardData(): Promise<WmsSyncDashboard>
}

/** As {@link WmsSyncDashboard}: a payload, never a statement about the connection's state. */
export type WmsOnboardingConnection = {
  /** The payload the connector's own onboarding form renders. Opaque to everything else. */
  form: unknown
}

export type WmsOnboardingActions = {
  getConnectionData(): Promise<WmsOnboardingConnection>
}

export type WmsConnectorHooks = {
  asn?: () => Promise<WmsAsnActions>
  productSync?: () => Promise<WmsProductSyncActions>
  bookedInRecheck?: () => Promise<WmsBookedInRecheckActions>
  dispatchPrecondition?: WmsDispatchPrecondition
  /** The /sync WMS panel's data. Omitted by a connector with no dashboard of its own. */
  syncDashboard?: () => Promise<WmsSyncDashboardActions>
  /** The onboarding wizard's connection step. Omitted by a connector with no setup form. */
  onboarding?: () => Promise<WmsOnboardingActions>
  /**
   * Locks the rows that define this connector's inbound-delta SCOPE and returns a token for it.
   * Omitted by a connector whose delta has no configuration-dependent scope: it then gets the
   * default lock over its OWN cursor rows (lib/domain/wms/delta-scope-lock.ts), never another
   * connector's.
   */
  deltaScopeLock?: WmsDeltaScopeLock
}
