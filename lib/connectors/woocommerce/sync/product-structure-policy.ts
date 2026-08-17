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
 *     Note the direction that makes r4's child query compatible with this (see rule 3 in
 *     `decideConnectorParentWrite`). The allow-list refuses VARIABLE unconditionally and asks
 *     nothing; the child query is only ever used to refuse MORE — a row it reports as having
 *     children is refused, and a row it reports as clean falls back on every other rule. A
 *     TOCTOU that can only add refusals never permits something it should have refused, which
 *     is the only direction that would be unsound here.
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
  reason:
    | 'type_cannot_be_a_variable_parent'
    | 'row_is_a_child'
    /** Other IMS rows carry this row's id in their `parentId`, but its type does not admit it. */
    | 'row_is_an_invalid_parent'
    | 'transform_blocked'
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
   * True when the write this decision describes ACTUALLY moves `type` — the allow-list
   * permitted the transform and no blocker was found (o3d-y89x r3).
   *
   * Distinct from `needsTransformBlockerCheck`, which stays true after a blocker is found (the
   * check WAS owed; it was answered "blocked"). This one goes false, and that is what makes it
   * the right flag to hang the conditional write on: the write reasserts "still transformable"
   * only while it is still asking to transform.
   */
  writeTransformsRow: boolean
  /**
   * True when the row may receive children and variable-only ProductOption rows. False is
   * why `parentRoleRefusal` is set.
   */
  canBeVariableParent: boolean
  /**
   * DO IMS AND WOOCOMMERCE AGREE ABOUT THIS ROW'S SHAPE? The branch's one structural
   * predicate — stated here, derived in exactly one place, and read by everything that
   * depends on the answer (o3d-y89x r3).
   *
   * WooCommerce models two shapes and IMS six, so there is exactly ONE structural fact
   * WooCommerce is competent to state about an existing row: **is it a variable parent?**
   * `variable` asserts "this row has children, here they are, and it carries no price of its
   * own"; `simple` asserts "this row has no variations, and here is its price". Everything
   * else IMS knows — KIT-ness, BOM-ness, whether stock is tracked at all — WooCommerce has no
   * opinion about, because `simple` is an ABSENCE of information, never a denial.
   *
   * So the whole question is whether that one boolean matches, on both halves of what "being a
   * variable parent" means here:
   *
   *   - WooCommerce says VARIABLE: the row must actually be able to hold the children this
   *     payload carries — `canBeVariableParent`, which folds in the type, the row-is-a-child
   *     rule, the physical parent-by-children rule below and the live-row gate.
   *   - WooCommerce says SIMPLE: the row must actually NOT be a parent. That is TWO facts, not
   *     one: its type must not be VARIABLE, AND no other IMS row may carry its id as a
   *     `parentId`. A row that stays VARIABLE keeps child rows and ProductOption rows that IMS
   *     owns and this connector may not delete, and its own price columns are meaningless (a
   *     parent shows min–max from its variants), so WooCommerce's simple price cannot be
   *     applied either.
   *
   * TYPE IS NOT ENOUGH, IN EITHER DIRECTION (Codex r4 finding 1). Nothing in the database
   * enforces that only a VARIABLE row may have children — `Product.parentId` is a plain
   * self-relation with no type constraint — and the pre-o3d-y89x connector could mint exactly
   * the offending shape, by flattening a VARIABLE row to SIMPLE without deleting its children.
   * Deciding the simple arm from `effectiveType` alone therefore reported AGREEMENT for such a
   * legacy row: WooCommerce's simple price was applied, its children were left attached, the
   * sync was recorded SYNCED and the cursor advanced — the same stale-structure failure the
   * VARIABLE case was fixed for, reached through physical state instead of the type column.
   * So the rule asks the PHYSICAL question (`rowIsAParent`) as well as the type one, and the
   * variable arm asks it too: a row whose type denies the children it demonstrably has is one
   * this connector may neither flatten nor build on, in either direction. See
   * `row_is_an_invalid_parent` in {@link decideConnectorParentWrite}.
   *
   * WHAT AGREEMENT BUYS, AND WHAT DISAGREEMENT COSTS. Both consumers of this flag follow from
   * the same sentence — *this sync applied the shape WooCommerce asserted*:
   *
   *   - PRICING. The row's own price columns may follow WooCommerce only on agreement.
   *     Erasing an IMS kit's price because WooCommerce calls the pairing variable, and
   *     stamping a simple product's price onto a variable parent because WooCommerce calls it
   *     simple, are the same mistake in opposite directions.
   *   - CONFLICTS. Disagreement means WooCommerce data went UNAPPLIED, which is the definition
   *     of a structure conflict (see {@link WcProductStructureConflict}) — quarantined, failed,
   *     cursor pinned. Agreement means it did not, and must stay silent.
   *
   * THE CASE THAT MAKES THE SECOND CONSUMER NECESSARY (Codex r3 finding 1). An IMS KIT paired
   * with a WooCommerce `simple` product AGREES: neither side claims a parent, the kit's
   * composition is IMS-only knowledge WooCommerce never contradicted, nothing went unapplied.
   * That is the ordinary bundle pairing and it must stay quiet. An IMS VARIABLE row paired
   * with a WooCommerce `simple` product DISAGREES by the identical rule — and used to be
   * recorded as a clean SYNCED sync with its type unwritten, its price unwritten and its IMS
   * variants left standing, because the conflict branch only ran when the INCOMING payload was
   * variable. Reading the conflict off this flag instead of off the incoming type is what makes
   * the two cases decided by one rule rather than by two separate `if`s that disagreed.
   */
  wooShapeAgrees: boolean
  /** Non-null exactly when `canBeVariableParent` is false. */
  parentRoleRefusal: WcVariableParentRefusal | null
}

/**
 * The shape-agreement rule, in one place (see {@link ConnectorParentWriteDecision.wooShapeAgrees}).
 *
 * Kept as a named function rather than inlined twice because the create branch and the update
 * branch both need it, and two copies of a boolean this load-bearing is how the two `if`s that
 * disagreed came about in the first place.
 */
function wooAndImsAgreeOnShape(args: {
  incoming: ProductType
  effectiveType: ProductType
  /** PHYSICAL, not typed: other IMS rows carry this row's id in their `parentId`. */
  rowIsAParent: boolean
  canBeVariableParent: boolean
}): boolean {
  return args.incoming === 'VARIABLE'
    ? args.canBeVariableParent
    : args.effectiveType !== 'VARIABLE' && !args.rowIsAParent
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
 *   3. A ROW WHOSE TYPE DENIES ITS OWN CHILDREN IS NOT ACTED ON AT ALL (Codex r4 finding 1).
 *      The mirror of rule 2, and the same class of pre-existing corruption seen from the other
 *      end: `caller.rowHasChildren` is true while the type is not VARIABLE. Only a VARIABLE row
 *      may be a parent (`validateProductStructureChange` refuses any other), and no database
 *      constraint enforces it, so this shape is reachable — the pre-o3d-y89x connector minted
 *      it by flattening a VARIABLE row to SIMPLE and leaving the children behind. Both things
 *      the connector could do with it are wrong: treating it as the standalone product
 *      WooCommerce called `simple` flattens what is left of an IMS parent (applying a simple
 *      price to a row that still has variants, and calling the sync clean), and promoting it to
 *      VARIABLE because WooCommerce called it `variable` silently adopts child rows this
 *      payload never mentioned into a WooCommerce-owned parent. So the connector does neither:
 *      it refuses the parent role, suppresses the type write, and reports the conflict for an
 *      operator to repair in the editor. Answered from a CHILD-ROW QUERY, never from the type,
 *      because the type is precisely the field that is lying.
 *   4. LIVE ROWS. The editor refuses any type/parent change on a product with stock,
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
  /**
   * True when other IMS rows carry `row.id` in their `parentId` — the PHYSICAL parent question,
   * which no field of `row` can answer (a row's children are different rows).
   *
   * Required rather than optional on purpose: defaulting it to false would make the caller that
   * forgot to ask indistinguishable from the row that genuinely has no children, which is the
   * exact confusion Codex r4 finding 1 is about. Its one source is
   * `findImsProductIdsWithChildren` in product-sync.ts, shared with `refuseVariationAdoption`
   * so the two rules cannot drift apart.
   */
  rowHasChildren: boolean
  /** The editor's blocker summary for this row, or null when it is clean / not yet asked. */
  transformBlockerSummary?: string | null
}): ConnectorParentWriteDecision {
  const { row, incoming, rowHasChildren } = args
  const transformBlockerSummary = args.transformBlockerSummary ?? null

  // A brand-new row has no structure to protect, no parent and nothing live pointing at it.
  // The create branch stays unguarded on purpose: guarding it would leave new products
  // typeless.
  if (!row) {
    const canBeVariableParent = incoming === 'VARIABLE'
    return {
      effectiveType: incoming,
      suppressTypeWrite: false,
      needsTransformBlockerCheck: false,
      writeTransformsRow: false,
      canBeVariableParent,
      // A created row is whatever WooCommerce says it is, so the rule below always answers
      // true here. Computed rather than hardcoded so there is exactly one definition of
      // agreement, and so a future create-branch guard cannot make this silently stale.
      // `rowIsAParent: false` is a fact, not a default: the row does not exist yet, so no other
      // row can be carrying its id.
      wooShapeAgrees: wooAndImsAgreeOnShape({
        incoming,
        effectiveType: incoming,
        rowIsAParent: false,
        canBeVariableParent,
      }),
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
  // Rule 3: the row demonstrably HAS children while its type says it cannot. Read off the
  // CURRENT type, not `effectiveType` — the question is whether the row as it stands is already
  // an invalid parent, and `effectiveType` would answer it with the outcome of the very
  // transform being decided.
  const rowIsAnInvalidParent = rowHasChildren && row.type !== 'VARIABLE'
  const typeWouldChange = row.type !== incoming
  const refusedByAllowList = isConnectorTypeWriteSuppressed(row.type, incoming)
  const wouldMakeAChildAParent = rowIsAChild && incoming === 'VARIABLE'
  // Promoting an already-invalid parent to VARIABLE would silently adopt the child rows it
  // should not have into a WooCommerce-owned parent, so the type write is suppressed for the
  // same reason a child may not become a parent: the connector was never told about those rows.
  const wouldPromoteAnInvalidParent = rowIsAnInvalidParent && incoming === 'VARIABLE'

  // Only worth asking the live-row question when a transform is genuinely on the table: the
  // allow-list, the child rule and the invalid-parent rule have already decided every case they
  // cover, and each of them refuses without needing to know whether the row is live.
  const needsTransformBlockerCheck = typeWouldChange
    && !refusedByAllowList && !wouldMakeAChildAParent && !wouldPromoteAnInvalidParent
  const blockedByLiveRows = needsTransformBlockerCheck && transformBlockerSummary != null

  const suppressTypeWrite = typeWouldChange
    && (refusedByAllowList || wouldMakeAChildAParent || wouldPromoteAnInvalidParent || blockedByLiveRows)
  const effectiveType = suppressTypeWrite ? row.type : incoming

  // Precedence is by specificity. "It is somebody's child" and "it is somebody's parent" are
  // facts about THIS row and outrank anything derived from its type — including the case where
  // the row is already (invalidly) typed VARIABLE.
  let parentRoleRefusal: WcVariableParentRefusal | null = null
  if (rowIsAChild) {
    parentRoleRefusal = {
      reason: 'row_is_a_child',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is itself a child of IMS product ${row.parentId}, `
        + 'so it cannot also be a variable parent.',
      remedy: 'Detach the IMS product from its parent, or point the WooCommerce product at a different SKU.',
    }
  } else if (rowIsAnInvalidParent) {
    parentRoleRefusal = {
      reason: 'row_is_an_invalid_parent',
      detail: `IMS product ${row.id} (SKU "${row.sku}") is ${row.type}, but other IMS products already carry `
        + 'its id as their parent — a shape only a VARIABLE product may have, so the row is already invalid '
        + 'and a connector may neither flatten it nor build on it.',
      remedy: 'Repair the IMS product in the product editor — detach or remove its child rows, or make it a '
        + 'variable parent — then re-run the sync.',
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
    // The write really does move `type`: the allow-list permitted it AND no blocker was found.
    // This is what the conditional write below has to re-assert at the instant it writes, and
    // it is false again the moment a blocker turns up (`blockedByLiveRows` sets
    // `suppressTypeWrite`), so a retry after a late refusal no longer asks for the transform.
    writeTransformsRow: needsTransformBlockerCheck && !suppressTypeWrite,
    canBeVariableParent,
    wooShapeAgrees: wooAndImsAgreeOnShape({
      incoming,
      effectiveType,
      rowIsAParent: rowHasChildren,
      canBeVariableParent,
    }),
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
 *
 * On the PARENT branch that question has exactly one answer, and it is
 * {@link ConnectorParentWriteDecision.wooShapeAgrees}: disagreement about whether the row is a
 * variable parent is the only way parent-level WooCommerce data goes unapplied, and it covers
 * both directions — the payload's variations with nowhere to go, and the payload's own type and
 * price with nothing they can be written onto.
 */
export type WcProductStructureConflict = {
  kind: 'variations_not_imported' | 'parent_shape_not_applied' | 'variation_row_refused'
  /** The SKU the operator has to look at — the parent's, or the refused variation's. */
  sku: string
  imsProductId: string
  imsType: ProductType
  /** The WooCommerce product or variation id involved. */
  wcObjectId: string
  detail: string
}

/**
 * The operator-facing line for the OTHER direction of shape disagreement (o3d-y89x r3):
 * WooCommerce says `simple`, the IMS row is (and stays) a parent.
 *
 * The remedy has to name something that actually clears it. Two things do, and the reason
 * neither is "let the connector fix it" is the branch's whole policy: the connector cannot
 * flatten the row, because the children and ProductOption rows it would strand are IMS-owned
 * and WooCommerce never asked for them to be deleted — `simple` says nothing about them.
 *
 * Two shapes reach here and they need different words (Codex r4 finding 1). The row may be a
 * parent BY TYPE — a healthy VARIABLE product whose WooCommerce twin has been made simple — or
 * a parent BY CHILD ROWS while typed something that may not have them, which is a row that was
 * already invalid before this sync ran. Calling the second one "a variable parent" would tell
 * the operator to go and remove variants from a product the UI does not show variants for.
 */
export function describeParentShapeNotApplied(args: {
  wcProductId: string
  sku: string
  imsProductId: string
  imsType: ProductType
  /**
   * Set when the row ALSO could not act as a parent (already somebody's child, already an
   * invalid parent, or live).
   */
  parentRoleRefusal: WcVariableParentRefusal | null
}): string {
  if (args.parentRoleRefusal?.reason === 'row_is_an_invalid_parent') {
    return `WooCommerce product ${args.wcProductId} ("${args.sku}") is simple, but `
      + `${args.parentRoleRefusal.detail} Its WooCommerce type and price were NOT applied — a row with `
      + 'child rows is not the standalone product WooCommerce describes, and pricing it as one would '
      + `bury the corruption instead of surfacing it. ${args.parentRoleRefusal.remedy}`
  }
  const extra = args.parentRoleRefusal ? ` Additionally, ${args.parentRoleRefusal.detail}` : ''
  return `WooCommerce product ${args.wcProductId} ("${args.sku}") is simple, but IMS product `
    + `${args.imsProductId} is ${args.imsType} — a variable parent whose child rows and options IMS `
    + 'owns, and which a connector may not delete. Its WooCommerce type and price were NOT applied '
    + `and its IMS variants remain, so the two systems still disagree.${extra} `
    + 'To resolve: convert the IMS product in the product editor (detaching or removing its variants '
    + 'first), or make the WooCommerce product variable again.'
}

/** One operator-facing line per conflict; the sync's error string and the inbox row share it. */
export function summarizeWcProductStructureConflicts(conflicts: readonly WcProductStructureConflict[]): string {
  return conflicts.map((conflict) => conflict.detail).join(' ')
}
