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
 *   SIMPLE — NOT protected. A SIMPLE row owns no structure: no components, no children,
 *     no parent, no special inventory semantics. Every transformation the connector can
 *     ask for (SIMPLE→VARIABLE on the parent branch, SIMPLE→VARIANT in applyVariations)
 *     is one the connector can also COMPLETE, because it writes the children / the
 *     parentId in the same transaction. This is the ordinary "WooCommerce takes over an
 *     IMS-native catalogue" path and must keep working.
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
 * The type a row will actually carry after this sync has applied the policy: the incoming
 * type when the connector may write it, the existing one when it may not.
 *
 * Both callers need this rather than the raw WooCommerce type. The parent branch decides
 * whether it may adopt variations from it (only a VARIABLE may be a parent), and
 * applyVariations decides whether the row can legally BE a variation.
 */
export function effectiveImsProductType(existing: ProductType, incoming: ProductType): ProductType {
  return isConnectorTypeWriteSuppressed(existing, incoming) ? existing : incoming
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
 * A SKU match is evidence of identity, not proof of it. Three further things must hold
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
}): VariationAdoptionRefusal | null {
  const { row, imsParentId, rowHasChildren } = args

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
