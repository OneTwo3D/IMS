/**
 * The one genuinely connector-agnostic stock-sync primitive.
 *
 * WHAT THIS MODULE USED TO BE, AND WHY IT SHRANK (o3d-remove-shiphero). It was
 * created as a "connector-agnostic" mirror of Mintsoft's connector-local
 * lib/connectors/mintsoft/sync/stock-sync-helpers.ts so the ShipHero stock sync
 * had something generic to call — but Mintsoft was never migrated onto it, so
 * what shipped was a second COPY, not a shared module. Threshold parsing, line
 * consolidation, binding-due timing and discrepancy computation each existed
 * twice, and when ShipHero was removed every duplicate here lost its only
 * caller. They are deleted rather than kept: an unused copy of code that also
 * exists, maintained, somewhere else is not an abstraction, it is drift waiting
 * to happen. Git history has them (see docs/archive/shiphero-connector-removal.md).
 *
 * `classifyUnresolvedWmsSku` stays because Mintsoft's stock sync genuinely
 * imports it — it is the only line of that module that ever became shared.
 *
 * The real fix, if a second WMS lands, is to move Mintsoft's helpers HERE and
 * delete the connector-local copy — not to re-create a parallel one.
 */

/**
 * Classify a WMS stock line that did not resolve to an IMS product.
 *
 * Both outcomes mean "no IMS product", but they need different operator actions,
 * so they are distinct categories (6oyu.17 — MISSING_IN_IMS was previously
 * defined but never emitted, collapsing the common case into UNMAPPED_SKU):
 *  - blank/whitespace SKU → UNMAPPED_SKU. The line carries no key to look up, so
 *    it is unmappable rather than missing. Fix the WMS product record.
 *  - non-blank SKU → MISSING_IN_IMS. The WMS holds a real, identified product
 *    that IMS does not know about at all. Create/import the product in IMS.
 */
export function classifyUnresolvedWmsSku(sku: string): 'UNMAPPED_SKU' | 'MISSING_IN_IMS' {
  return sku.trim() === '' ? 'UNMAPPED_SKU' : 'MISSING_IN_IMS'
}
