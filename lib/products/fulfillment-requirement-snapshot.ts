import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  requirementsMapToDecimalRows,
  scaleFulfillmentRequirements,
  type DecimalFulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'

/**
 * THE IMMUTABLE PER-LINE FULFILMENT-REQUIREMENT SNAPSHOT (o3d-kouj).
 *
 * WHAT THE DEFECT IS. Everything IMS knows about "what does this sales line require" is derived, on
 * every read, by expanding the CURRENT component graph. Fourteen modules do it. So a component-graph
 * edit does not change the future — it retroactively changes the past and the in-flight present. A
 * kit re-composed after an order shipped is REPORTED against the new recipe; a kit re-composed while
 * an order is picked makes the picked set read as disproportionate, or (worse, and this is the money
 * bug) makes a UNIFORM rescale read as a perfectly proportional half-kit that every check passes.
 *
 * The bounded mitigations that shipped before this — the component-graph edit guard (o3d-4kfh r4/r5)
 * and the graph-version CAS (o3d-57b0/o3d-4kfh r6) — both work by REFUSING. The guard refuses the
 * catalogue edit; the CAS refuses the shipment. Refusal is the only tool available while the current
 * graph is the authority, and it is why r4's version of the guard froze a KIT permanently the first
 * time an order shipped it.
 *
 * WHAT THIS STORES, AND WHY THAT SHAPE. One row per {@link Prisma.SalesOrderLine}: the FLAT leaf
 * requirement set for ONE unit of the line's product, exactly as
 * `expandFulfillmentRequirementsDecimal(productId, 1, graph)` produced it at capture time. Flat, not
 * a copy of the graph, because a flat per-unit factor set is what every one of the fourteen readers
 * actually asks for — they call `expandFulfillmentRequirementsDecimal(line.productId, 1, graph)` and
 * then either scale it or feed it to `calculateDecimalFulfillmentCoverage`. Persisting the graph
 * instead would mean re-implementing the walk against a persisted structure, i.e. a second expander,
 * which is the thing `loadFulfillmentProductGraph`'s docstring already refuses on the SQL side.
 *
 * FACTORS ARE STORED VERBATIM, INCLUDING NON-POSITIVE ONES. `expandFulfillmentRequirementsDecimal`
 * emits a leaf requirement of zero (or less) when a component's `qty` is non-positive — the guard at
 * the top of `visit` only stops the RECURSION, and `addRequirement` is reached unconditionally for a
 * non-KIT component. Such a factor makes `calculateDecimalFulfillmentCoverage` return 0 forever, and
 * that is a known, separately-filed defect. This snapshot must reproduce the expansion it replaces,
 * not quietly repair it: inventing a semantic here would mean a snapshot-backed line and a
 * live-graph line answer the same question differently, which is precisely the "partial rollout is
 * worse than none" failure o3d-kouj warns about.
 *
 * FACTORS ARE STORED AS EXACT DECIMAL STRINGS, at whatever scale the multiplication produced. This
 * is NOT a violation of "quantise the computed side, never the stored side" (o3d-i4qd): a factor is
 * not a persisted `numeric(12,4)` quantity, it is the multiplicand. Rounding it here would move the
 * rounding one step EARLIER than the one place it belongs — after the whole multiplication, on the
 * computed quantity — and would make a snapshot-backed expansion disagree with a live one.
 */
export const FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION = 1

export type SerializedFulfillmentRequirement = {
  productId: string
  factor: string
}

export type SerializedFulfillmentRequirementSnapshot = {
  version: number
  productId: string
  graphVersion: number
  capturedAt: string
  requirements: SerializedFulfillmentRequirement[]
}

export type FulfillmentRequirementSnapshot = {
  version: number
  productId: string
  graphVersion: number
  capturedAt: string | null
  requirements: DecimalFulfillmentRequirement[]
}

/**
 * Thrown when a line carries a fulfilment-requirement snapshot that cannot be read.
 *
 * FAIL CLOSED, NEVER FALL BACK. The tempting alternative — treat an unreadable snapshot as absent
 * and expand the live graph — is the exact defect class this session was told to watch for (a
 * snapshot whose parser silently dropped what it could not read). A line that HAS a snapshot is a
 * line the rest of the system believes is protected from graph drift; answering it from the current
 * graph anyway would give a wrong number under a claim of correctness, and would do it silently.
 * Refusing is loud, and the remedy is the same one every other refusal on this path names:
 * re-allocate the order, which re-captures the snapshot.
 */
export class FulfillmentRequirementSnapshotError extends Error {
  readonly lineId: string | null

  constructor(reason: string, lineId: string | null) {
    super(
      `The stored fulfilment-requirement snapshot${lineId ? ` on sales line ${lineId}` : ''} could not `
      + `be read: ${reason}. That snapshot is what the order's allocation, picking and cost reversal `
      + 'are judged against, so it cannot be substituted with the current component graph — the '
      + 'current graph may no longer be the recipe this order was allocated from. Re-allocate the '
      + 'order to rebuild the snapshot from the current graph, then retry.',
    )
    this.name = 'FulfillmentRequirementSnapshotError'
    this.lineId = lineId
  }
}

/** The minimum a caller must select for a line to be resolvable through the snapshot. */
export type SnapshotResolvableLine = {
  id?: string
  productId: string | null
  fulfillmentRequirements?: unknown
}

/**
 * Capture ONE unit's leaf requirements for a product, from a graph the caller has already loaded.
 *
 * The graph MUST be the one whose expansion the caller is about to act on — `loadFulfillmentProductGraph`
 * guarantees whole-load version atomicity, and `graphVersion` is taken from the node in the SAME map,
 * so the recorded version certifies the recipe that was actually expanded rather than whatever the
 * `products` table says a statement later. A product missing from the graph expands to itself and
 * records version 0, matching every other consumer's treatment of a missing node.
 */
export function captureFulfillmentRequirementSnapshot(
  productId: string,
  graph: Map<string, FulfillmentGraphNode>,
  capturedAt: Date = new Date(),
): SerializedFulfillmentRequirementSnapshot {
  const requirements = requirementsMapToDecimalRows(
    expandFulfillmentRequirementsDecimal(productId, 1, graph),
  )
  return {
    version: FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION,
    productId,
    graphVersion: graph.get(productId)?.fulfillmentGraphVersion ?? 0,
    capturedAt: capturedAt.toISOString(),
    // `toFixed()` and not `toString()`: decimal.js switches to exponential notation below 1e-7, and a
    // deeply nested kit can produce a factor that small. Both round-trip, but only one is legible in
    // a jsonb column an operator may have to read during an incident.
    requirements: requirements.map((requirement) => ({
      productId: requirement.productId,
      factor: requirement.factor.toFixed(),
    })),
  }
}

/**
 * Read a stored snapshot. Returns null ONLY for a genuinely absent one (the pre-snapshot state, and
 * the state of every line that has never been allocated); throws for anything present and unreadable.
 *
 * An EMPTY requirement list counts as unreadable rather than as "requires nothing". A live expansion
 * of a positive quantity always yields at least one requirement — a product missing from the graph
 * expands to itself — so an empty list can only be corruption, and reading it as zero requirements
 * would make every coverage check on the line answer 0 (permanently outstanding) or vacuously pass,
 * depending on the reader. That divergence between readers is the failure mode o3d-kouj exists to
 * prevent.
 */
export function parseFulfillmentRequirementSnapshot(
  value: unknown,
  lineId: string | null = null,
): FulfillmentRequirementSnapshot | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new FulfillmentRequirementSnapshotError('payload is not an object', lineId)
  }

  const row = value as Record<string, unknown>
  if (row.version !== FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION) {
    throw new FulfillmentRequirementSnapshotError(
      `unsupported snapshot version ${JSON.stringify(row.version)} (this build reads `
      + `${FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION})`,
      lineId,
    )
  }
  if (typeof row.productId !== 'string' || row.productId.length === 0) {
    throw new FulfillmentRequirementSnapshotError('missing the product it was captured for', lineId)
  }
  if (!Array.isArray(row.requirements) || row.requirements.length === 0) {
    throw new FulfillmentRequirementSnapshotError('it records no requirements at all', lineId)
  }

  const requirements: DecimalFulfillmentRequirement[] = []
  for (const entry of row.requirements) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FulfillmentRequirementSnapshotError('a requirement entry is not an object', lineId)
    }
    const requirement = entry as Record<string, unknown>
    if (typeof requirement.productId !== 'string' || requirement.productId.length === 0) {
      throw new FulfillmentRequirementSnapshotError('a requirement entry has no product', lineId)
    }
    // `toDecimal` is deliberately NOT asked to judge this. It maps null, undefined and the empty
    // string to ZERO — which is a legitimate factor here (see the module docstring on non-positive
    // factors), so letting it coerce would turn a MISSING field into a valid-looking requirement of
    // zero and silently make the line permanently uncoverable.
    const rawFactor = requirement.factor
    if (
      !(typeof rawFactor === 'number' || (typeof rawFactor === 'string' && rawFactor.trim() !== ''))
    ) {
      throw new FulfillmentRequirementSnapshotError(
        `requirement for product ${requirement.productId} has no usable factor `
        + `(${JSON.stringify(rawFactor)})`,
        lineId,
      )
    }
    let factor: Prisma.Decimal
    try {
      factor = toDecimal(rawFactor as DecimalInput)
    } catch {
      throw new FulfillmentRequirementSnapshotError(
        `requirement for product ${requirement.productId} has an unparseable factor `
        + `${JSON.stringify(rawFactor)}`,
        lineId,
      )
    }
    // A non-positive factor is NOT rejected — see the module docstring. It is what the live
    // expansion produces for a non-positive component qty, and the snapshot's job is to reproduce
    // the expansion, not to correct it.
    requirements.push({ productId: requirement.productId, factor })
  }

  return {
    version: FULFILLMENT_REQUIREMENT_SNAPSHOT_VERSION,
    productId: row.productId,
    graphVersion: typeof row.graphVersion === 'number' ? row.graphVersion : 0,
    capturedAt: typeof row.capturedAt === 'string' ? row.capturedAt : null,
    requirements,
  }
}

/**
 * Does this line carry a usable snapshot — i.e. is the CURRENT component graph no longer the
 * authority for it?
 *
 * This is the predicate the graph-version CAS is now conditioned on. Throws for the same unreadable
 * payloads {@link parseFulfillmentRequirementSnapshot} throws for, so no caller can answer "not
 * snapshot-backed" by failing to read a snapshot that is there.
 */
export function hasFulfillmentRequirementSnapshot(line: SnapshotResolvableLine): boolean {
  const snapshot = parseFulfillmentRequirementSnapshot(line.fulfillmentRequirements, line.id ?? null)
  if (!snapshot) return false
  return snapshot.productId === line.productId
}

/**
 * THE ONE SEAM every reader goes through: what does one unit of this line require?
 *
 * Snapshot if the line has one, current graph if it does not. There is deliberately no third
 * behaviour and no per-caller override — o3d-kouj's stated reason for the deferral was that a
 * partial rollout is WORSE than none, because snapshot-aware and live-graph readers would disagree
 * about the same order. One function, one rule, and the rule degrades to exactly the pre-snapshot
 * behaviour for a line that has never been allocated.
 *
 * A snapshot captured for a DIFFERENT product than the line now references is not evidence about
 * this line, so it is not used — the line's current product is expanded instead, which is what the
 * line had before any snapshot existed. Warned rather than silently ignored, because a sales line
 * changing product while carrying a pinned recipe is not something any IMS write path is supposed
 * to do.
 */
export function lineFulfillmentRequirements(
  line: SnapshotResolvableLine,
  graph: Map<string, FulfillmentGraphNode>,
): DecimalFulfillmentRequirement[] {
  const snapshot = parseFulfillmentRequirementSnapshot(line.fulfillmentRequirements, line.id ?? null)
  if (snapshot && line.productId && snapshot.productId !== line.productId) {
    console.warn(
      `[fulfillment-requirement-snapshot] sales line ${line.id ?? '(unknown)'} carries a snapshot for `
      + `product ${snapshot.productId} but now references ${line.productId} — expanding the current `
      + 'graph instead, because the pinned recipe is not about this line.',
    )
  }
  if (snapshot && snapshot.productId === line.productId) return snapshot.requirements
  if (!line.productId) return []
  return requirementsMapToDecimalRows(expandFulfillmentRequirementsDecimal(line.productId, 1, graph))
}

/**
 * The same seam, scaled: what does `qty` of this line require, in leaf units?
 *
 * The multiplication is ONE step from the per-unit factor, never a re-walk with the quantity pushed
 * down the tree, and nothing is quantised here — quantisation belongs to whichever caller persists
 * the result, once, after the whole multiplication (o3d-i4qd).
 */
export function lineFulfillmentRequirementQuantities(
  line: SnapshotResolvableLine,
  qty: DecimalInput,
  graph: Map<string, FulfillmentGraphNode>,
): Map<string, Prisma.Decimal> {
  const snapshot = parseFulfillmentRequirementSnapshot(line.fulfillmentRequirements, line.id ?? null)
  if (!snapshot || snapshot.productId !== line.productId) {
    if (!line.productId) return new Map<string, Prisma.Decimal>()
    return expandFulfillmentRequirementsDecimal(line.productId, qty, graph)
  }

  return scaleFulfillmentRequirements(snapshot.requirements, qty)
}

/** Every leaf product any of these lines can require, snapshot-aware. Mirrors `listFulfillmentLeafProductIds`. */
export function lineFulfillmentLeafProductIds(
  lines: SnapshotResolvableLine[],
  graph: Map<string, FulfillmentGraphNode>,
): string[] {
  const ids = new Set<string>()
  for (const line of lines) {
    for (const requirement of lineFulfillmentRequirements(line, graph)) ids.add(requirement.productId)
  }
  return [...ids]
}

/**
 * WHEN A LINE'S SNAPSHOT MAY BE (RE)WRITTEN — the whole of the immutability rule, in one pure
 * function so it cannot drift between the two writers.
 *
 * A line's snapshot is captured from the current graph whenever the line holds NOTHING in flight,
 * and is untouchable from the moment it holds an allocation row or a committed (non-PENDING)
 * shipment line. That gives four properties worth stating outright:
 *
 *  - IMMUTABLE FOR THE WHOLE OF A LINE'S IN-FLIGHT LIFE. Between the allocation that pins it and the
 *    dispatch that consumes it, no component edit can change what the line requires. That is the
 *    property the coverage, proportionality, dispatch-cap and cost-reversal checks need, and the
 *    only one they need.
 *  - FROZEN FOREVER ONCE SHIPPED. Dispatch decrements `reservedQty` but RETAINS the `OrderAllocation`
 *    rows, so a shipped line permanently holds allocations and can never be re-captured. Completed
 *    history therefore keeps reporting against the recipe it actually shipped under, which is the
 *    residual o3d-4kfh r5 left open when it stopped freezing the catalogue.
 *  - RE-CAPTURABLE EXACTLY WHERE THAT IS SAFE. A line that has been deallocated, or has never been
 *    allocated, holds no commitment against the old recipe, so adopting the new one costs nothing.
 *    This is what keeps "re-allocate the order" a real remedy instead of a phrase in an error
 *    message.
 *  - NEVER PARTIALLY PINNED. Capture is per line and the predicate is per line, so two lines of one
 *    order can legitimately carry snapshots taken at different graph versions — which is correct:
 *    they were committed at different times, against different recipes, and nothing compares
 *    requirements ACROSS lines.
 */
export function selectCapturableLineIds(input: {
  lineIds: Iterable<string>
  lineIdsHoldingAllocations: Iterable<string>
  lineIdsHoldingCommittedShipments: Iterable<string>
}): string[] {
  const blocked = new Set<string>([
    ...input.lineIdsHoldingAllocations,
    ...input.lineIdsHoldingCommittedShipments,
  ])
  return [...new Set(input.lineIds)].filter((lineId) => !blocked.has(lineId))
}
