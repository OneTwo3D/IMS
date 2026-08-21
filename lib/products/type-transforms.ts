import { ProductType, type Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

const OPEN_SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const
const OPEN_PURCHASE_ORDER_STATUSES = ['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const
const OPEN_PRODUCTION_ORDER_STATUSES = ['DRAFT', 'IN_PROGRESS'] as const
const OPEN_TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT'] as const

const CHILD_CAPABLE_TYPES = new Set<ProductType>([ProductType.VARIANT, ProductType.KIT, ProductType.BOM])
const COMPONENT_TYPES = new Set<ProductType>([ProductType.KIT, ProductType.BOM])
const TRANSFORMABLE_TYPES = new Set<ProductType>([ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM])

/**
 * Everything a structure validation reads: the product row itself AND the five tables that
 * say whether the row is live (o3d-y89x r2).
 *
 * It has to name all six. `getProductTransformBlockers` used to read the module-level `db`
 * regardless of what the caller passed, so the editor's INSIDE-the-transaction re-validation
 * (o3d-42hw) checked the row under `tx` and the blockers on a different connection — i.e.
 * outside the locks it had just taken, against a snapshot that could already have moved.
 * Threading the client through is what makes `client: tx` mean what it says.
 */
export type ProductStructureClient = Pick<
  typeof db,
  'product' | 'stockLevel' | 'salesOrderLine' | 'purchaseOrderLine' | 'productionOrder' | 'stockTransferLine'
>

type ProductStructureInput = {
  productId?: string
  type: ProductType
  parentId?: string | null
  /**
   * Client to validate against. Defaults to the module-level `db`, which is what the
   * pre-transaction fast path uses. The editor re-validates INSIDE its write transaction
   * (o3d-42hw) and must pass `tx`, or it would re-read the same pre-lock state and prove
   * nothing — a WooCommerce import committing in between would still be overwritten with
   * structure decided against a state that no longer exists.
   */
  client?: ProductStructureClient
}

type CurrentProductShape = {
  id: string
  sku: string
  type: ProductType
  parentId: string | null
}

export type ProductStructureValidationResult =
  | {
      ok: true
      current: CurrentProductShape | null
      normalizedParentId: string | null
      clearComponents: boolean
      clearExternalMapping: boolean
    }
  | {
      ok: false
      fieldErrors: Record<string, string[]>
      message: string
    }

export type ProductTransformBlockers = {
  stockQty: number
  reservedQty: number
  openSalesOrderLines: number
  openPurchaseOrderLines: number
  openProductionOrders: number
  openTransferLines: number
}

export function isVariantChildProduct(input: { parentId?: string | null }): boolean {
  return Boolean(input.parentId)
}

export function canTypeHaveVariableParent(type: ProductType): boolean {
  return CHILD_CAPABLE_TYPES.has(type)
}

export function isComponentProductType(type: ProductType): boolean {
  return COMPONENT_TYPES.has(type)
}

/** True when any blocker is present. The one place "is this row live?" is decided. */
export function hasProductTransformBlockers(blockers: ProductTransformBlockers): boolean {
  return blockers.stockQty > 0
    || blockers.reservedQty > 0
    || blockers.openSalesOrderLines > 0
    || blockers.openPurchaseOrderLines > 0
    || blockers.openProductionOrders > 0
    || blockers.openTransferLines > 0
}

export function summarizeTransformBlockers(blockers: ProductTransformBlockers): string {
  const parts: string[] = []
  if (blockers.stockQty > 0) parts.push(`stock on hand (${blockers.stockQty.toFixed(2)})`)
  if (blockers.reservedQty > 0) parts.push(`reserved stock (${blockers.reservedQty.toFixed(2)})`)
  if (blockers.openSalesOrderLines > 0) parts.push(`${blockers.openSalesOrderLines} open sales order line${blockers.openSalesOrderLines === 1 ? '' : 's'}`)
  if (blockers.openPurchaseOrderLines > 0) parts.push(`${blockers.openPurchaseOrderLines} open purchase order line${blockers.openPurchaseOrderLines === 1 ? '' : 's'}`)
  if (blockers.openProductionOrders > 0) parts.push(`${blockers.openProductionOrders} open manufacturing order${blockers.openProductionOrders === 1 ? '' : 's'}`)
  if (blockers.openTransferLines > 0) parts.push(`${blockers.openTransferLines} open stock transfer line${blockers.openTransferLines === 1 ? '' : 's'}`)
  return parts.join(', ')
}

/**
 * THE SAME BLOCKER QUESTION, AS A PREDICATE ON THE PRODUCT ROW — so a caller can require the
 * answer to still hold AT THE INSTANT IT WRITES, not merely at the moment it asked
 * (o3d-y89x r3, Codex finding 2).
 *
 * `getProductTransformBlockers` is a SELECT. Under READ COMMITTED its answer is a statement of
 * the past by the time the caller's UPDATE runs, and nothing serializes the gap: the per-SKU
 * advisory locks (`lib/products/sku-write-lock.ts`) are cooperative and are taken only by the
 * `Product.sku` writers — the editor, the CSV import, the WooCommerce sync. The writers that
 * CREATE blockers (stock receipts, allocation, sales/purchase/production/transfer documents)
 * take none of them, so one of them can commit between the check and the write.
 *
 * WHAT ANDING THIS INTO THAT UPDATE'S OWN `WHERE` BUYS — AND WHAT IT DOES NOT (corrected in
 * o3d-y89x r4, Codex finding 2; the r3 wording overclaimed). It MOVES THE BOUNDARY, from the
 * caller's SELECT snapshot to the UPDATE statement's own: a blocker committed before that
 * statement makes the update match zero rows, and the caller fails closed instead of
 * transforming a row the editor would refuse. That is a real, fail-closed improvement and it is
 * all it is. It does NOT make the transform race-free:
 *
 *   - Under READ COMMITTED a blocker transaction that is still uncommitted when this statement
 *     takes its snapshot, and commits before the caller's transaction does, is invisible here —
 *     and this transform is invisible to it. That is write skew, and no `WHERE` can see it.
 *   - Raising THIS transaction to SERIALIZABLE would not close it either. Postgres' SSI
 *     guarantees hold only among transactions that are ALL serializable, and every blocker
 *     writer (stock receipts, allocation, sales/purchase/production/transfer documents) runs
 *     READ COMMITTED. "Use SERIALIZABLE with retry" is therefore a change to all of them, not a
 *     change available to one caller.
 *   - A lock the blocker writers also took would close it. THERE IS NO SUCH LOCK: the per-SKU
 *     advisory locks (lib/products/sku-write-lock.ts) are cooperative and taken only by the
 *     `Product.sku` writers, and no blocker writer takes any lock a structural writer contends
 *     on. Callers must say that plainly rather than describe this predicate as a closure.
 *
 * A caller that needs the window narrowed further can re-assert the FULL blocker question (this
 * predicate's four arms plus the transfer arm below) immediately before it commits. That bounds
 * the exposure at the width of the re-assertion itself instead of the rest of the transaction —
 * TWO statements if it is asked set-wise (`findProductsWithTransformBlockers`), 5N if it is asked
 * row by row. It does not remove the write-skew residual either way. The WooCommerce connector
 * asks it set-wise — see `assertTransformedRowsStillTransformable` in the product sync.
 *
 * EXACTLY EQUIVALENT TO THE COUNTING VERSION, for the four arms it covers:
 *
 *   - the three document arms are per-row existence questions in both forms;
 *   - the STOCK arm is an aggregate (`sum(quantity) > 0`) in `getProductTransformBlockers` and a
 *     per-row existence test here. Those agree because `quantity` and `reservedQty` are
 *     DB-enforced non-negative (`stock_levels_quantity_nonnegative`,
 *     `stock_levels_reserved_nonnegative`, both VALIDATED) — with no negative rows possible,
 *     `sum > 0` and `EXISTS(row > 0)` are the same predicate. If either constraint is ever
 *     dropped, this equivalence goes with it and the two forms will disagree.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: open STOCK TRANSFER lines. `StockTransferLine.productId`
 * carries no foreign key to Product on purpose ("no FK to Product to allow orphaned lines in
 * audit"), so there is no relation to filter through and no way to state it as a predicate on
 * this row at all — a correlated raw `NOT EXISTS` could express it, but only by giving up
 * Prisma's typed `updateMany` for a hand-built dynamic `UPDATE`. That arm is therefore answered
 * by a statement of its own, and answered ONE STATEMENT EARLIER than the other four AT BOTH
 * BOUNDARIES — never as part of the same snapshot:
 *
 *   - at the WRITE, `getProductTransformBlockers` reads it before the UPDATE that carries this
 *     predicate;
 *   - at a PRE-COMMIT RE-ASSERTION, `findProductsWithTransformBlockers` reads it first and the
 *     product predicate second, deliberately (the four arms the writes carried get the narrower
 *     of the two windows).
 *
 * So the transfer arm always has the WIDER window of the two, and a transfer line committing
 * between the two statements is seen by neither the transfer read nor the product predicate.
 * That is on top of the write-skew residual above, not instead of it. Callers must say so
 * rather than claim the whole question is closed.
 *
 * THE DECISION (o3d-0fok, 2026-08): THE RESIDUAL IS ACCEPTED, PERMANENTLY. It is not an
 * unfinished item and no future change should quietly try to "fix" it here. The two closures
 * were both weighed and both rejected:
 *
 *   - A PRODUCT-SCOPED LOCK THAT EVERY BLOCKER WRITER TAKES. The blocker writers are stock
 *     receipts, allocation, and the sales/purchase/production/transfer document writers — the
 *     hottest paths in the system. They would each take a new lock, which then has to be
 *     ordered against the sales-order lock and COMPONENT_GRAPH_WRITE_LOCK_KEY. Adding a
 *     deadlock surface across every inventory write to protect an occasional administrative
 *     edit trades a rare, visible, repairable fault for a common one.
 *   - SERIALIZABLE ISOLATION. Postgres SSI holds only among transactions that are ALL
 *     serializable, so raising this one alone buys nothing; raising all of them is the same
 *     list of hot paths plus serialization-failure retry loops in each.
 *
 * WHAT MAKES THE RESIDUAL TOLERABLE, stated so the judgement can be re-examined rather than
 * merely inherited:
 *
 *   - the window is the width of ONE statement (the predicate ANDed into the UPDATE) plus the
 *     pre-commit re-assertion, not the width of the transaction;
 *   - the uncontended case — which is all of them in practice, since these edits are made by a
 *     human in an editor, not by a sweep — is refused outright;
 *   - the failure mode is a product whose type or parent changed under a document that
 *     references it. That is visible in the document and repairable by transforming the
 *     product back or voiding the document. It is not a silent quantity or money error, and
 *     nothing downstream computes a wrong number from it.
 *
 * WHAT IS NOT DONE, and is the honest next step if this ever bites in practice: nothing
 * DETECTS the residual after the fact. The scheduled inventory-invariant census
 * (lib/domain/inventory/invariants.ts) has no check for "a product whose type is inconsistent
 * with the documents that reference it". Adding one would make the accepted residual
 * observable without touching a single write path, and is the cheap half of this problem.
 */
export const PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE: Prisma.ProductWhereInput = {
  stockLevels: { none: { OR: [{ quantity: { gt: 0 } }, { reservedQty: { gt: 0 } }] } },
  salesOrderLines: { none: { order: { status: { in: [...OPEN_SALES_ORDER_STATUSES] } } } },
  poLines: { none: { po: { status: { in: [...OPEN_PURCHASE_ORDER_STATUSES] } } } },
  // The two arms of the production-order check, from this product's side: it is the OUTPUT of
  // an open order, or it is a COMPONENT of a product that is.
  productionOrdersAsOutput: { none: { status: { in: [...OPEN_PRODUCTION_ORDER_STATUSES] } } },
  usedAsComponentIn: {
    none: {
      product: {
        productionOrdersAsOutput: { some: { status: { in: [...OPEN_PRODUCTION_ORDER_STATUSES] } } },
      },
    },
  },
}

/**
 * The rows that make a product LIVE: stock, reservations, open sales/purchase/production/
 * transfer documents. Transforming a product's type or parent while any of these exist is
 * what the editor refuses (`Cannot change product type while this product has ...`).
 *
 * Exported (o3d-y89x r2) so the WooCommerce connector runs the SAME checks rather than a
 * second copy that drifts: the connector transforms SIMPLE rows too (SIMPLE→VARIABLE on the
 * parent branch, SIMPLE→VARIANT when adopting a variation) and was doing so without asking
 * any of these questions.
 *
 * `client` must be the transaction that holds the row locks; see ProductStructureClient.
 */
export async function getProductTransformBlockers(
  productId: string,
  client: ProductStructureClient = db,
): Promise<ProductTransformBlockers> {
  const [
    stockAggregate,
    openSalesOrderLines,
    openPurchaseOrderLines,
    openProductionOrders,
    openTransferLines,
  ] = await Promise.all([
    client.stockLevel.aggregate({
      where: { productId },
      _sum: { quantity: true, reservedQty: true },
    }),
    client.salesOrderLine.count({
      where: {
        productId,
        order: {
          status: { in: [...OPEN_SALES_ORDER_STATUSES] },
        },
      },
    }),
    client.purchaseOrderLine.count({
      where: {
        productId,
        po: {
          status: { in: [...OPEN_PURCHASE_ORDER_STATUSES] },
        },
      },
    }),
    client.productionOrder.count({
      where: {
        status: { in: [...OPEN_PRODUCTION_ORDER_STATUSES] },
        OR: [
          { outputProductId: productId },
          { outputProduct: { productComponents: { some: { componentId: productId } } } },
        ],
      },
    }),
    client.stockTransferLine.count({
      where: {
        productId,
        transfer: {
          status: { in: [...OPEN_TRANSFER_STATUSES] },
        },
      },
    }),
  ])

  return {
    stockQty: Number(stockAggregate._sum.quantity ?? 0),
    reservedQty: Number(stockAggregate._sum.reservedQty ?? 0),
    openSalesOrderLines,
    openPurchaseOrderLines,
    openProductionOrders,
    openTransferLines,
  }
}

/**
 * THE SAME QUESTION OVER A SET OF ROWS, IN A FIXED NUMBER OF STATEMENTS (o3d-y89x r5, Codex
 * finding 1).
 *
 * `getProductTransformBlockers` answers for ONE product in five statements. A caller
 * re-asserting the question over N rows by calling it N times issues 5N statements — and the
 * row it checks FIRST then stays exposed across the remaining 5(N-1), so the window grows with
 * the row count. That is exactly what a pre-commit re-assertion exists to bound, so asking it
 * row by row is self-defeating at any interesting N.
 *
 * This answers the whole set in TWO statements, whatever N is:
 *
 *   1. the transfer arm — `StockTransferLine.productId` carries no FK to Product, so no
 *      predicate on the product row can express it (see the fragment above). Grouped by product,
 *      so it returns at most one row per candidate rather than one per line.
 *   2. the four arms `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE` CAN express, as a filter on the
 *      product rows themselves. This is the identical exported fragment the conditional UPDATEs
 *      carry, so the re-assertion cannot drift from the predicate it re-asserts. Any candidate
 *      id the statement does not return has at least one of those four blockers.
 *
 * WHAT THAT GUARANTEES, EXACTLY AND NO MORE. Two statements means TWO snapshots, not one:
 *
 *   - a blocker committing between the two is seen by the second and not by the first, so the
 *     transfer arm is answered as of one statement earlier than the other four;
 *   - a blocker committing after BOTH and before the caller's COMMIT is seen by neither. That is
 *     the write-skew residual documented on the fragment above, unchanged and not closable by
 *     any single caller;
 *   - it is a SELECT pair, not a lock. Nothing here prevents a blocker from arriving.
 *
 * What it removes is only the GROWTH: the window is two statements wide for one transformed row
 * and two statements wide for two hundred. Callers may say that and may not say more.
 *
 * A candidate id that no longer exists comes back as blocked, because arm 2 cannot return a row
 * that is not there. That is the fail-closed direction and in practice unreachable for this
 * caller: it re-asserts over rows it has already UPDATE-ed in the same transaction, whose row
 * locks it still holds.
 *
 * It returns WHICH rows are blocked, never WHY. The "why" is one row's operator-facing summary,
 * and callers get it from `getProductTransformBlockers` for the rows this flags — on a path that
 * is already failing, where an extra statement costs nothing and widens no window.
 */
export async function findProductsWithTransformBlockers(
  productIds: readonly string[],
  client: Pick<ProductStructureClient, 'product' | 'stockTransferLine'> = db,
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Set()

  const openTransferLines = await client.stockTransferLine.groupBy({
    by: ['productId'],
    where: {
      productId: { in: ids },
      transfer: { status: { in: [...OPEN_TRANSFER_STATUSES] } },
    },
  })
  const blocked = new Set<string>(openTransferLines.map((row) => row.productId))

  // Read LAST on purpose: these four arms are the ones the writes themselves carried, so
  // re-reading them as the final statement gives them the narrowest of the two windows. (On the
  // write path the split runs the other way round — the transfer arm is read one statement
  // EARLIER than the predicate — for the same reason: there, the predicate rides in the write.)
  const stillTransformable = await client.product.findMany({
    where: { id: { in: ids }, ...PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE },
    select: { id: true },
  })
  const clean = new Set(stillTransformable.map((row) => row.id))
  for (const id of ids) {
    if (!clean.has(id)) blocked.add(id)
  }

  return blocked
}

export async function validateProductStructureChange(
  input: ProductStructureInput,
): Promise<ProductStructureValidationResult> {
  const client = input.client ?? db
  const normalizedParentId = input.parentId?.trim() ? input.parentId.trim() : null

  const current = input.productId
    ? await client.product.findUnique({
        where: { id: input.productId },
        select: { id: true, sku: true, type: true, parentId: true },
      })
    : null

  if (input.productId && !current) {
    return {
      ok: false,
      fieldErrors: { type: ['Product not found'] },
      message: 'Product not found',
    }
  }

  if (normalizedParentId && normalizedParentId === input.productId) {
    return {
      ok: false,
      fieldErrors: { parentId: ['A product cannot be its own parent'] },
      message: 'A product cannot be its own parent',
    }
  }

  if (normalizedParentId && !canTypeHaveVariableParent(input.type)) {
    return {
      ok: false,
      fieldErrors: {
        type: ['Only simple variants, bundle variants, and BOM variants can sit under a variable parent'],
      },
      message: 'Only variant, bundle, and BOM products can sit under a variable parent',
    }
  }

  if (input.type === ProductType.VARIANT && !normalizedParentId) {
    return {
      ok: false,
      fieldErrors: { parentId: ['Simple variants must stay attached to a variable parent'] },
      message: 'Simple variants must stay attached to a variable parent',
    }
  }

  if (normalizedParentId) {
    const parent = await client.product.findUnique({
      where: { id: normalizedParentId },
      select: { id: true, type: true },
    })
    if (!parent || parent.type !== ProductType.VARIABLE) {
      return {
        ok: false,
        fieldErrors: { parentId: ['Parent product must be an existing variable product'] },
        message: 'Parent product must be an existing variable product',
      }
    }
  }

  if (current) {
    const typeChanged = current.type !== input.type
    const parentChanged = (current.parentId ?? null) !== normalizedParentId

    if ((typeChanged || parentChanged) && (!TRANSFORMABLE_TYPES.has(current.type) || !TRANSFORMABLE_TYPES.has(input.type))) {
      return {
        ok: false,
        fieldErrors: {
          type: ['This product type cannot be transformed through the standard editor'],
        },
        message: 'This product type cannot be transformed through the standard editor',
      }
    }

    if ((typeChanged || parentChanged) && (current.type === ProductType.VARIABLE || input.type === ProductType.VARIABLE)) {
      return {
        ok: false,
        fieldErrors: {
          type: ['Variable parents cannot be converted through the standard editor'],
        },
        message: 'Variable parents cannot be converted through the standard editor',
      }
    }

    if ((typeChanged || parentChanged) && (current.type === ProductType.NON_INVENTORY || input.type === ProductType.NON_INVENTORY)) {
      return {
        ok: false,
        fieldErrors: {
          type: ['Non-inventory products cannot be converted through the standard editor'],
        },
        message: 'Non-inventory products cannot be converted through the standard editor',
      }
    }

    if (typeChanged || parentChanged) {
      // `client`, not the ambient `db`: inside the editor's write transaction this must read
      // the state the locks are holding, not a parallel connection's snapshot (o3d-y89x r2).
      const blockers = await getProductTransformBlockers(current.id, client)

      if (hasProductTransformBlockers(blockers)) {
        const summary = summarizeTransformBlockers(blockers)
        return {
          ok: false,
          fieldErrors: {
            type: [`Cannot change product type while this product has ${summary}`],
          },
          message: `Cannot change product type while this product has ${summary}`,
        }
      }
    }

    return {
      ok: true,
      current,
      normalizedParentId,
      clearComponents: isComponentProductType(current.type) && !isComponentProductType(input.type),
      clearExternalMapping: typeChanged || parentChanged,
    }
  }

  return {
    ok: true,
    current: null,
    normalizedParentId,
    clearComponents: false,
    clearExternalMapping: false,
  }
}
