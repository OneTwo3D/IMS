/**
 * What a connector is allowed to do to the STRUCTURE of an existing IMS product (o3d-y89x).
 *
 * One rule, applied in three places:
 *
 *   **A connector may never silently destroy IMS-owned structure.**
 *
 * WooCommerce models exactly two shapes — `simple` and `variable` — and IMS models six.
 * So a WooCommerce type is an ABSENCE of information about everything IMS additionally
 * knows (composition, parentage, whether stock is tracked at all), never an assertion
 * that the product has none. Writing it unconditionally onto an existing row therefore
 * cannot be right: the write is a downgrade decided by a system that was never told.
 *
 * Kept in its own module, free of `db` and of Prisma runtime imports, so the policy is a
 * pure function the tests can pin directly rather than infer from a sync's side effects.
 */

import { canTypeHaveVariableParent } from '@/lib/products/type-transforms'
import type { ProductType } from '@/app/generated/prisma/client'

/**
 * The ONLY existing IMS type a connector may transform a row out of.
 *
 * Stated as an allow-list on purpose: a ProductType added later is protected by default,
 * which is the safe direction. The per-type reasoning, all of it decided against
 * `validateProductStructureChange` (lib/products/type-transforms.ts) — the rule the
 * product editor and the CSV import already enforce:
 *
 *   SIMPLE — NOT protected, but NOT unconditionally transformable either. A SIMPLE row owns
 *     no structure OF ITS OWN: no components, no children, no parent, no special inventory
 *     semantics. Every transformation the connector can ask for (SIMPLE→VARIABLE on the
 *     parent branch, SIMPLE→VARIANT in applyVariations) is one the connector can also
 *     COMPLETE, because it writes the children / the parentId in the same transaction. This
 *     is the ordinary "WooCommerce takes over an IMS-native catalogue" path and must keep
 *     working.
 *
 *     What "owns no structure" does NOT mean is "is not in use". A live SIMPLE row can carry
 *     stock, reservations and open sales/purchase/production/transfer documents, and
 *     `validateProductStructureChange` blocks a type OR parent change on any of them. That
 *     second gate is not expressible as an allow-list — it is a question about the ROW, not
 *     about its type — so the connector asks it separately, using the editor's own
 *     `getProductTransformBlockers` rather than a second copy of the rules that would drift.
 *     See `decideConnectorParentWrite` and `refuseVariationAdoption` below.
 *
 *   KIT, BOM — protected. Composition is IMS-owned and WooCommerce cannot express it.
 *     Flattening to SIMPLE left the ProductComponent rows in place (a SIMPLE product WITH
 *     components — the state o3d-w998 stops the CSV import from creating) and retroactively
 *     stopped every in-flight order expanding into components.
 *
 *   VARIABLE — protected. A VARIABLE row is a PARENT: other rows carry its id in their
 *     `parentId`, and `validateProductStructureChange` requires a parent to be VARIABLE.
 *     Flattening it to SIMPLE leaves those children pointing at a non-variable parent and
 *     leaves its ProductOption rows behind — the same invalid-state class as the KIT bug,
 *     with a different column. The editor refuses this transformation OUTRIGHT ("Variable
 *     parents cannot be converted through the standard editor"), unconditionally, and so
 *     does this: a "does it have children right now?" test would be a TOCTOU the connector
 *     cannot make sound, because it takes no structural lock on the child rows.
 *
 *   VARIANT — protected. A VARIANT is by definition attached to a VARIABLE parent
 *     (`validateProductStructureChange` rejects a VARIANT with no parentId). The parent
 *     branch of the sync writes `type` but NEVER writes or clears `parentId`, so
 *     VARIANT→SIMPLE minted a SIMPLE row that still carried a parentId — a shape the editor
 *     refuses to save (o3d-8s89). The other direction is no better: VARIANT→VARIABLE would
 *     make a child into a parent, a two-level chain IMS has no concept of. Preserving the
 *     type keeps `type` and `parentId` coherent with each other without the connector
 *     having to decide a detach it has no information about.
 *
 *   NON_INVENTORY — protected. It means "not stock-tracked" — a service, a fee, a shipping
 *     line. Converting it to SIMPLE silently gives it inventory semantics: stock levels,
 *     allocation, COGS. WooCommerce's `simple` says nothing whatsoever about whether IMS
 *     tracks stock for it. The editor refuses this transformation outright too.
 */
const CONNECTOR_TRANSFORMABLE_TYPES: ReadonlySet<ProductType> = new Set<ProductType>(['SIMPLE'])

/** True when a connector may not decide this existing row's type. */
export function isConnectorProtectedProductType(type: ProductType): boolean {
  return !CONNECTOR_TRANSFORMABLE_TYPES.has(type)
}

/**
 * Would writing `incoming` onto a row currently typed `existing` be suppressed?
 *
 * Note the `existing !== incoming` half. It is not an optimisation: without it EVERY
 * re-sync of EVERY protected row would report a suppressed write — a VARIANT being
 * re-synced as VARIANT, a VARIABLE parent as VARIABLE — and the operator-facing warning
 * would drown in the case where nothing is being changed at all.
 */
export function isConnectorTypeWriteSuppressed(existing: ProductType, incoming: ProductType): boolean {
  return existing !== incoming && isConnectorProtectedProductType(existing)
}

/**
 * The type a row will actually carry after this sync has applied the TYPE policy: the incoming
 * type when the connector may write it, the existing one when it may not.
 *
 * Both callers need this rather than the raw WooCommerce type. The parent branch decides
 * whether it may adopt variations from it (only a VARIABLE may be a parent), and
 * applyVariations decides whether the row can legally BE a variation.
 *
 * NOTE this answers the allow-list question ONLY. On the parent branch use
 * `decideConnectorParentWrite`, which also folds in the two facts an allow-list cannot see:
 * whether the row is itself somebody's child, and whether it is live.
 */
export function effectiveImsProductType(existing: ProductType, incoming: ProductType): ProductType {
  return isConnectorTypeWriteSuppressed(existing, incoming) ? existing : incoming
}

// ---------------------------------------------------------------------------
// The parent branch, as ONE decision (o3d-y89x r2)
// ---------------------------------------------------------------------------

/**
 * Why an IMS row may not act as the variable parent WooCommerce says it is.
 *
 * `detail` is the reason clause and `remedy` the operator's next step; the sync composes both
 * into the conflict line, so the two halves stay next to the rule that produced them.
 */
export type WcVariableParentRefusal = {
  reason: 'type_cannot_be_a_variable_parent' | 'row_is_a_child' | 'transform_blocked'
  detail: string
  remedy: string
}

/**
 * Everything the parent branch may or may not write, decided TOGETHER.
 *
 * The r1 fix guarded one column. It suppressed the `type` write on a protected row and then
 * let the surrounding code run: the update still cleared `salesPriceBase`/`salePriceBase`
 * because the INCOMING type was variable, and `applyProductOptions` still wrote variable-only
 * ProductOption rows onto the row it had just refused to make a parent. A KIT therefore kept
 * its components, lost its IMS price and gained options the UI only shows for VARIABLE
 * products — a partially-applied state every retry re-applied.
 *
 * The lesson is the same one the type fix taught: guard the DECISION, not one column. So
 * every write that is only correct if the row really is what WooCommerce says it is reads a
 * field of this object instead of re-deriving the answer from `wcProduct.type`.
 */
export type ConnectorParentWriteDecision = {
  /** The type the row carries after this transaction. */
  effectiveType: ProductType
  /** True when the incoming `type` must be omitted from the UPDATE entirely. */
  suppressTypeWrite: boolean
  /**
   * True when this write would transform the row (a type change the allow-list permits), so
   * the caller must ask the editor's live-row question and decide again with the answer.
   * Deliberately false in the steady state, so a re-sync costs no extra queries.
   */
  needsTransformBlockerCheck: boolean
  /**
   * True when the row may receive children and variable-only ProductOption rows. False is
   * why `parentRoleRefusal` is set.
   */
  canBeVariableParent: boolean
  /**
   * True when the row's OWN price columns may follow WooCommerce's shape this sync.
   *
   * Those columns mean opposite things on the two shapes — a variable parent shows min–max
   * from its variants and carries none of its own, a standalone product carries exactly these
   * — so writing EITHER arm requires IMS and WooCommerce to agree about which shape this row
   * has. When they disagree the row keeps what it has, because both arms are wrong in that
   * state: erasing an IMS kit's price because WooCommerce calls the pairing variable, and
   * stamping a simple product's price onto a variable parent because WooCommerce calls it
   * simple, are the same mistake in opposite directions.
   */
  appliesWooPriceShape: boolean
  /** Non-null exactly when `canBeVariableParent` is false. */
  parentRoleRefusal: WcVariableParentRefusal | null
}

export type ConnectorParentRow = {
  id: string
  sku: string
  type: ProductType
  parentId?: string | null
}

/**
 * Decide the whole parent write.
 *
 * Called once with no blocker summary to learn whether a transform is even on the table, then
 * — only when `needsTransformBlockerCheck` says so — again with the editor's summary in hand.
 * Keeping it a pure function of its inputs is what lets the sync do that without a second copy
 * of the rules, and what keeps the steady state free of extra queries.
 *
 * The three suppression rules, and why each exists:
 *
 *   1. THE ALLOW-LIST. `isConnectorTypeWriteSuppressed`. WooCommerce knows two shapes and IMS
 *      six, so a WooCommerce type is an absence of information, never an assertion.
 *   2. A CHILD MAY NOT BECOME A PARENT. A row with a non-null `parentId` is somebody's
 *      variation; attaching children to it builds a two-level hierarchy IMS has no concept of.
 *      This rule is NOT conditional on the type changing. A row that is ALREADY VARIABLE and
 *      already carries a parentId is an invalid shape that predates this sync (the pre-fix
 *      parent branch could mint exactly that, by writing VARIABLE over a VARIANT without
 *      clearing its parentId), and `existing !== incoming` let it through — so the sync
 *      PRESERVED the invalid chain and then EXTENDED it by adopting children into it, while
 *      reporting a clean run. "Nothing is changing, so nothing to guard" and "the type is
 *      unchanged but the write would still deepen an invalid structure" are different
 *      statements; only the first may be quiet.
 *   3. LIVE ROWS. The editor refuses any type/parent change on a product with stock,
 *      reservations or open documents. The connector performs the same transformations, so it
 *      asks the same question — via the editor's own `getProductTransformBlockers`.
 *
 * What the connector deliberately does NOT copy from `validateProductStructureChange` is its
 * outright refusal of anything involving VARIABLE ("Variable parents cannot be converted
 * through the standard editor"). That rule exists because an OPERATOR cannot complete the
 * transformation — the editor has no way to create the variation rows — whereas this sync
 * writes the parent, its children and their parentIds in one transaction. The half the editor
 * refuses for a reason that applies here too (VARIABLE→anything, which strands existing
 * children) is refused here as well, by the allow-list.
 */
export function decideConnectorParentWrite(args: {
  /** The existing IMS row, or null on the create branch. */
  row: ConnectorParentRow | null
  /** The type mapped from the WooCommerce payload. */
  incoming: ProductType
  /** The editor's blocker summary for this row, or null when it is clean / not yet asked. */
  transformBlockerSummary?: string | null
}): ConnectorParentWriteDecision {
  const { row, incoming } = args
  const transformBlockerSummary = args.transformBlockerSummary ?? null

  // A brand-new row has no structure to protect, no parent and nothing live pointing at it.
  // The create branch stays unguarded on purpose: guarding it would leave new products
  // typeless.
  if (!row) {
    return {
      effectiveType: incoming,
      suppressTypeWrite: false,
      needsTransformBlockerCheck: false,
      canBeVariableParent: incoming === 'VARIABLE',
      appliesWooPriceShape: true,
      parentRoleRefusal: incoming === 'VARIABLE'
        ? null
        : {
          reason: 'type_cannot_be_a_variable_parent',
          detail: `a new ${incoming} product cannot be a variable parent.`,
          remedy: 'Point the WooCommerce product at a different SKU.',
        },
    }
  }

  const rowIsAChild = row.parentId != null
  const typeWouldChange = row.type !== incoming
  const refusedByAllowList = isConnectorTypeWriteSuppressed(row.type, incoming)
  const wouldMakeAChildAParent = rowIsAChild && incoming === 'VARIABLE'

  // Only worth asking the live-row question when a transform is genuinely on the table: the
  // allow-list and the child rule have already decided every case they cover.
  const needsTransformBlockerCheck = typeWouldChange && !refusedByAllowList && !wouldMakeAChildAParent
  const blockedByLiveRows = needsTransformBlockerCheck && transformBlockerSummary != null

  const suppressTypeWrite = typeWouldChange
    && (refusedByAllowList || wouldMakeAChildAParent || blockedByLiveRows)
  const effectiveType = suppressTypeWrite ? row.type : incoming

  // Precedence is by specificity. "It is somebody's child" is a fact about THIS row and
  // outranks anything derived from its type — including the case where the row is already
  // (invalidly) typed VARIABLE.
  let parentRoleRefusal: WcVariableParentRefusal | null = null
  if (rowIsAChild) {
    parentRoleRefusal = {
      reason: 'row_is_a_child',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is itself a child of IMS product ${row.parentId}, `
        + 'so it cannot also be a variable parent.',
      remedy: 'Detach the IMS product from its parent, or point the WooCommerce product at a different SKU.',
    }
  } else if (blockedByLiveRows) {
    parentRoleRefusal = {
      reason: 'transform_blocked',
      detail: `IMS product ${row.id} (SKU "${row.sku}") cannot be converted from ${row.type} to a variable parent `
        + `while it has ${transformBlockerSummary}.`,
      remedy: 'Clear or complete those first, or point the WooCommerce product at a different SKU.',
    }
  } else if (effectiveType !== 'VARIABLE') {
    parentRoleRefusal = {
      reason: 'type_cannot_be_a_variable_parent',
      detail: `IMS product ${row.id} is ${effectiveType}, which cannot be a variable parent.`,
      remedy: 'Convert the IMS product to a variable parent, or point the WooCommerce product at a different SKU.',
    }
  }

  const canBeVariableParent = parentRoleRefusal === null

  return {
    effectiveType,
    suppressTypeWrite,
    needsTransformBlockerCheck,
    canBeVariableParent,
    // Agreement, both directions: WooCommerce says variable AND the row really becomes that
    // parent, or WooCommerce says simple AND the row really is a standalone product.
    appliesWooPriceShape: incoming === 'VARIABLE' ? canBeVariableParent : effectiveType !== 'VARIABLE',
    parentRoleRefusal,
  }
}

// ---------------------------------------------------------------------------
// Variation row matching (o3d-h2cz)
// ---------------------------------------------------------------------------

export type VariationAdoptionRefusal =
  /** The row already belongs to a DIFFERENT IMS variable parent. */
  | { reason: 'different_ims_parent'; detail: string }
  /** The row is itself a parent — other IMS rows carry its id in their parentId. */
  | { reason: 'row_is_a_parent'; detail: string }
  /** After the type policy, the row's type may not sit under a variable parent. */
  | { reason: 'type_cannot_be_a_variation'; detail: string }
  /** The row is LIVE, and the editor blocks a type/parent change on a live row. */
  | { reason: 'transform_blocked'; detail: string }

/**
 * Would adopting this row as a variation actually TRANSFORM it — a type change, a parent
 * change, or both?
 *
 * The editor gates on exactly that pair (`typeChanged || parentChanged`), so this is the
 * question that decides whether the connector owes the live-row check. It is deliberately
 * false for the steady state — a VARIANT already under this parent, re-synced — so a
 * re-import of a 200-variation product costs no blocker queries at all, and true for a
 * KIT/BOM whose type is preserved but whose `parentId` this sync would still set, because a
 * reparent is a structural change even when the type write is dropped.
 */
export function connectorVariationAdoptionChangesStructure(args: {
  row: { type: ProductType; parentId?: string | null }
  imsParentId: string
}): boolean {
  const { row, imsParentId } = args
  const typeWouldChange = effectiveImsProductType(row.type, 'VARIANT') !== row.type
  const parentWouldChange = (row.parentId ?? null) !== imsParentId
  return typeWouldChange || parentWouldChange
}

/**
 * May this WooCommerce variation adopt the IMS row its SKU matched?
 *
 * `applyVariations` resolves rows by BARE SKU and then writes `type`, `parentId` and
 * `externalProductId` onto whatever comes back. `assertWcRowNotClaimedByAnotherWcObject`
 * only asks whether ANOTHER WooCommerce object already owns the row, and deliberately
 * returns early for an unmapped one — that is the initial-import takeover path and it has
 * to keep working. So an IMS-native row that happens to share a SKU with a WooCommerce
 * variation was silently reparented and remapped, and the o3d-y89x type guard did not stop
 * it: it suppressed the `type` write and let `parentId` through.
 *
 * A SKU match is evidence of identity, not proof of it. Four further things must hold
 * before the row is treated as the one this variation owns.
 *
 * Returns the refusal, or null when the row may be adopted. Refusing is not the same as
 * failing: the caller SKIPS this one variation, keeps syncing the rest, and records a
 * structural conflict — one bad row must not cost 200 healthy siblings their update, and
 * the operator gets told which SKU it was.
 */
export function refuseVariationAdoption(args: {
  row: { id: string; sku: string; type: ProductType; parentId?: string | null }
  /** The IMS product this WooCommerce parent resolved to. */
  imsParentId: string
  /** True when other IMS rows carry `row.id` in their parentId. */
  rowHasChildren: boolean
  /**
   * The editor's blocker summary for this row, or null when it is clean / not yet asked.
   *
   * The caller asks only when `connectorVariationAdoptionChangesStructure` says the adoption
   * would transform the row, and only after the three structural checks below have passed —
   * so a refusal that can be decided from the rows already in hand never costs a query.
   */
  transformBlockerSummary?: string | null
}): VariationAdoptionRefusal | null {
  const { row, imsParentId, rowHasChildren } = args
  const transformBlockerSummary = args.transformBlockerSummary ?? null

  // 1. PARENT COMPATIBILITY. A row already under a different variable parent is another
  //    product's variation. Adopting it silently moves it between parents — the previous
  //    parent keeps offering a variation that no longer belongs to it — and the editor
  //    treats a reparent as a structural change it blocks outright when the row has stock,
  //    reservations or open documents. The connector checks none of that, so it may not
  //    perform the move at all.
  if (row.parentId != null && row.parentId !== imsParentId) {
    return {
      reason: 'different_ims_parent',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is already a child of IMS product ${row.parentId}; `
        + `refusing to reparent it onto ${imsParentId}.`,
    }
  }

  // 2. THE ROW IS ITSELF A PARENT. Making it a variation would leave ITS children pointing
  //    at a row that is now a child — a two-level chain IMS has no concept of. Checked by
  //    child rows rather than by type, because the corrupt shapes this is guarding against
  //    (a SIMPLE row with children) are exactly the ones whose type does not say so.
  if (rowHasChildren) {
    return {
      reason: 'row_is_a_parent',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is itself the parent of other IMS products; `
        + 'refusing to turn a parent into a variation.',
    }
  }

  // 3. TYPE COMPATIBILITY, decided on the type the row will actually END UP with. A SIMPLE
  //    row is adoptable precisely BECAUSE the connector may rewrite it to VARIANT; a KIT or
  //    BOM is adoptable because a composition product under a variable parent is a
  //    first-class IMS shape (a "bundle variant") and the type write is suppressed rather
  //    than refused. VARIABLE and NON_INVENTORY keep their protected types and neither may
  //    sit under a parent, so there is no write that leaves the row valid.
  const effectiveType = effectiveImsProductType(row.type, 'VARIANT')
  if (!canTypeHaveVariableParent(effectiveType)) {
    return {
      reason: 'type_cannot_be_a_variation',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is ${row.type}, which cannot sit under a variable parent; `
        + 'refusing to adopt it as a WooCommerce variation.',
    }
  }

  // 4. THE ROW IS LIVE. Adoption sets `parentId` and (for a SIMPLE row) `type`, which is
  //    exactly the pair `validateProductStructureChange` refuses to change while the product
  //    has stock, reservations or open sales/purchase/production/transfer documents. "SIMPLE
  //    owns no structure" is a statement about the row's SHAPE and says nothing about whether
  //    it is in use, so the allow-list cannot answer this and the editor's own query does.
  //    Last, because the three checks above are answered from rows already in hand.
  if (transformBlockerSummary != null) {
    return {
      reason: 'transform_blocked',
      detail: `IMS product ${row.id} (SKU "${row.sku}") cannot be converted into a variation of `
        + `${imsParentId} while it has ${transformBlockerSummary}; the product editor refuses the same change.`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * A WooCommerce object this sync could NOT apply to IMS because doing so would have
 * destroyed IMS-owned structure.
 *
 * The distinction that decides whether something becomes one of these, rather than just a
 * warning: **did WooCommerce data go unapplied?** A suppressed `type` write with nothing
 * left over — an IMS KIT whose WooCommerce twin is `simple` — is the NORMAL, correct
 * pairing for a bundle and is only warned about. A WooCommerce variation that now exists in
 * WooCommerce and nowhere in IMS is a divergence no later sync repairs on its own, and it
 * has downstream consequences: order import resolves lines by SKU, so an absent variation
 * imports as a line with no product and no inventory allocation.
 */
export type WcProductStructureConflict = {
  kind: 'variations_not_imported' | 'variation_row_refused'
  /** The SKU the operator has to look at — the parent's, or the refused variation's. */
  sku: string
  imsProductId: string
  imsType: ProductType
  /** The WooCommerce product or variation id involved. */
  wcObjectId: string
  detail: string
}

/** One operator-facing line per conflict; the sync's error string and the inbox row share it. */
export function summarizeWcProductStructureConflicts(conflicts: readonly WcProductStructureConflict[]): string {
  return conflicts.map((conflict) => conflict.detail).join(' ')
}
