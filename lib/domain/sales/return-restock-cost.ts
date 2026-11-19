import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSyncTxWithOutcome } from '@/lib/accounting'
import { withSavepoint } from '@/lib/db/savepoint'
import { ADOPTION_RECLASS_POSTING_SCOPE } from '@/lib/domain/accounting/posting-refusal-kinds'
import { postingIsOwed, reportPostingNotQueued, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import { WORK_SLOT_OCCUPIED_WHERE } from '@/lib/domain/accounting/ledger-standing'
import type { PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import { buildInventoryAdjustmentJournal } from '@/lib/domain/inventory/stock-adjustment-apply'
import { getAverageUnitCost, getHistoricalAverageUnitCost } from '@/lib/cost-layers'
import type { RefundReturnRow } from '@/lib/domain/sales/refund-service'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'

/**
 * Layers whose cost an operator or a receipt stated: a purchase receipt line, a manual adjustment, opening stock, or a
 * production order. A zero-cost transfer BALANCING layer (written when a dispatch snapshot could not cost the units)
 * carries none of these links, and a layer with nothing received is no evidence of a cost either: neither makes a
 * zero cost "genuinely free". The test only matters when every average is 0, so every layer it sees is at 0.
 */
const EXPLICIT_COST_LAYER_FILTER: Prisma.CostLayerWhereInput = {
  receivedQty: { gt: 0 },
  OR: [
    { poLineId: { not: null } },
    { adjustmentMovementId: { not: null } },
    { isOpeningStock: true },
    { productionOrderId: { not: null } },
  ],
}

/**
 * Takes the units of an UNPRICED returns-inbox row that a refund already restocked (or whose expectation covers them)
 * out of the restock, so the same returned unit is never valued and journalled twice.
 *
 * A refund that restocks at once books RETURN_INBOUND (referenceType SalesOrderRefund) with its own COGS reversal, and a
 * refund routed in transit keeps an expectation whose arrival is priced at the refund's cost. The parcel's inbox row then
 * arrives with nothing to price it by, and pricing it at the average would credit the same unit a second time. Cover =
 * units restocked by this order's refunds + units its expectations hold (net of write-offs), minus what earlier inbox
 * restocks and this arrival's own expectation match already used. Only the uncovered remainder is returned for valuing.
 * `coveredQty` > 0 means some units were refused: the operator marks that item Refunded only.
 */
export async function netUnpricedReturnRowsAgainstRefunds(
  tx: Prisma.TransactionClient,
  params: { inboxId: string; orderId: string; rows: readonly RefundReturnRow[] },
): Promise<{ rows: RefundReturnRow[]; coveredQty: number }> {
  const out: RefundReturnRow[] = []
  let coveredQty = 0
  const refunds = await tx.salesOrderRefund.findMany({ where: { orderId: params.orderId, deletedAt: null }, select: { id: true } })
  const refundIds = refunds.map((r) => r.id)
  for (const row of params.rows) {
    if (row.unitCostBase != null || !(row.qty > 0)) {
      out.push(row)
      continue
    }
    const productId = row.productId
    const restockedByRefunds = refundIds.length === 0 ? 0 : Number((await tx.stockMovement.aggregate({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: refundIds }, productId },
      _sum: { qty: true },
    }))._sum.qty ?? 0)
    const expectationLines = await tx.returnExpectationLine.findMany({
      where: { productId, expectation: { orderId: params.orderId } },
      select: { qty: true, qtyWrittenOff: true },
    })
    const expected = expectationLines.reduce((sum, l) => sum + Number(l.qty) - Number(l.qtyWrittenOff), 0)
    const inboxes = await tx.wmsReturnsInbox.findMany({
      where: { orderId: params.orderId, productId, id: { not: params.inboxId } },
      select: { id: true },
    })
    const priorInbox = inboxes.length === 0 ? 0 : Number((await tx.stockMovement.aggregate({
      where: { type: 'RETURN_INBOUND', referenceType: 'WmsReturnsInbox', referenceId: { in: inboxes.map((i) => i.id) }, productId },
      _sum: { qty: true },
    }))._sum.qty ?? 0)
    // This arrival's own expectation-matched rows (already priced) used up part of the expectation cover.
    const matchedNow = params.rows.filter((r) => r.productId === productId && r.unitCostBase != null).reduce((sum, r) => sum + r.qty, 0)
    const available = Math.max(0, restockedByRefunds + expected - priorInbox - matchedNow)
    const covered = Math.min(available, row.qty)
    coveredQty += covered
    const remainder = Math.round((row.qty - covered) * 1e6) / 1e6
    if (remainder > 0) out.push({ ...row, qty: remainder })
  }
  return { rows: out, coveredQty }
}

/**
 * Gives every unpriced row of a returns-inbox restock a unit cost, so the units enter stock with a cost layer.
 *
 * A row the refund's return expectation covered arrives priced (its own dispatch cost). Whatever no expectation
 * covers (an over-return, a legacy refund that already restocked, no refund at all) used to go in with no unit
 * cost: on-hand stock with no cost layer and a zero-value movement, which later sells at zero COGS. Such a row is
 * valued the way a manual stock addition is: the warehouse's current average layer cost, else the product's
 * historical average. With no cost basis anywhere the restock is refused, never booked at zero. A product whose
 * cost is legitimately zero (every layer at 0, or a NON_INVENTORY product) is restocked at 0; only a product with
 * no cost layers at all is refused.
 *
 * Whatever this prices adds inventory value, so the caller must journal it: see `queueReturnRestockValueJournal`.
 */
export async function priceUnpricedReturnRows(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  rows: readonly RefundReturnRow[],
): Promise<RefundReturnRow[]> {
  const priced: RefundReturnRow[] = []
  for (const row of rows) {
    if (row.unitCostBase != null) {
      priced.push(row)
      continue
    }
    const warehouseAverage = await getAverageUnitCost(tx, row.productId, warehouseId)
    const unitCostBase = warehouseAverage > 0 ? warehouseAverage : await getHistoricalAverageUnitCost(tx, row.productId)
    if (!(unitCostBase > 0)) {
      // Averages of 0 mean either "layers exist and are all at 0" (genuinely zero-cost: samples, free gifts) or
      // "no layers at all" (no cost basis). Only the second is refused.
      const product = await tx.product.findUnique({ where: { id: row.productId }, select: { type: true } })
      const layerCount = product?.type === 'NON_INVENTORY'
        ? 1
        : await tx.costLayer.count({ where: { productId: row.productId, ...EXPLICIT_COST_LAYER_FILTER } })
      if (layerCount === 0) {
        throw new Error(
          'This returned item cannot be restocked because no unit cost could be derived for the product (it has no cost layer from a receipt or an operator-entered cost). Receive stock for it with a unit cost first (use 0 only for genuinely zero-cost stock), then restock the return.',
        )
      }
    }
    priced.push({ ...row, unitCostBase })
  }
  return priced
}

/**
 * Journals the inventory value `priceUnpricedReturnRows` added, in the restock's own transaction, so the Inventory GL
 * ties to the cost layers. Same posting as a manual stock addition (`applyStockAdjustment`): Dr Inventory / Cr the
 * adjustment reason's account (the stock-gain / inventory-adjustment account), NOT COGS: the units priced here are ones
 * no refund reversal covers (an over-return, or a unit whose sale booked no COGS), so no COGS was ever debited for them.
 * Built by `buildInventoryAdjustmentJournal`, with the same owed-posting handling; an unmapped reason account is owed. `originalRows` are the rows BEFORE pricing; only those that arrived unpriced are valued.
 * Nothing is queued when the value is zero or no COGS / Inventory account is mapped (as a manual adjustment).
 */
export async function queueReturnRestockValueJournal(
  tx: Prisma.TransactionClient,
  params: {
    inboxId: string
    warehouse: { id: string; code: string; name: string }
    originalRows: readonly RefundReturnRow[]
    pricedRows: readonly RefundReturnRow[]
    /** The adjustment reason chosen for the restock, whose accountCode is the Cr side; null when none was chosen. */
    adjustmentReasonId?: string | null
  },
): Promise<void> {
  const byProduct = new Map<string, { qty: number; value: number }>()
  params.pricedRows.forEach((row, index) => {
    if (params.originalRows[index]?.unitCostBase != null) return
    const entry = byProduct.get(row.productId) ?? { qty: 0, value: 0 }
    entry.qty += row.qty
    entry.value += row.qty * Number(row.unitCostBase ?? 0)
    byProduct.set(row.productId, entry)
  })
  if (byProduct.size === 0) return
  const settings = await getAccountingSettings()
  const reason = params.adjustmentReasonId
    ? await tx.adjustmentReason.findUnique({ where: { id: params.adjustmentReasonId }, select: { name: true, accountCode: true } })
    : null
  const reasonAccountCode = reason?.accountCode ?? ''
  for (const [productId, { qty, value }] of byProduct) {
    if (!(value > 0)) continue
    const product = await tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } })
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: params.warehouse.code,
      warehouseName: params.warehouse.name,
      qty,
      totalValueBase: value,
      note: reason?.name ? `Returns-inbox restock: ${reason.name}` : 'Returns-inbox restock',
    })
    if (!journal) {
      // No reason account (none chosen, or it has no GL code) or no Inventory account: the value entered stock but the
      // ledger was told nothing. Owed, like any unqueued posting; a missing connector account is `not-configured`.
      if (!reasonAccountCode && settings.inventoryAccount) {
        // Nothing was enqueued: no reason account means no journal to enqueue. The owed outcome is held by name and
        // forwarded, as the manufacturing journal does for a retired chart, never built inline at the report.
        const unmappedAccountOutcome: EnqueueOutcomeLike = { queued: false, reason: 'refused', connector: settings.connector }
        await reportPostingNotQueued({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: params.inboxId,
          action: 'inventory_adjustment_journal_not_queued',
          kind: 'returns_inbox_restock_journal',
          posting: `the inventory journal for the restocked return of ${product?.sku ?? productId} at ${params.warehouse.name}`,
          committed: 'the return stock movement and its cost layer are written in IMS',
          remedy: 'Choose an adjustment reason with a GL account when restocking. Inventory in the ledger no longer matches IMS by the value of this restock; post the journal by hand (Dr Inventory / Cr the stock-gain account).',
          outcome: unmappedAccountOutcome,
          metadata: { inboxId: params.inboxId, productId, warehouseId: params.warehouse.id, adjustmentReasonId: params.adjustmentReasonId ?? null, chartConnector: settings.connector },
          inTransaction: {
            client: tx as unknown as PostingRefusalClient,
            withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
          },
        })
      }
      continue
    }
    const enqueued = await queueAccountingSyncTxWithOutcome(tx, {
      type: 'INVENTORY_ADJUSTMENT',
      referenceType: 'WmsReturnsInbox',
      referenceId: params.inboxId,
      payload: journal as unknown as Record<string, unknown>,
      chartConnector: settings.connector,
      recordRefusalAsOutstanding: true,
    })
    if (postingIsOwed(enqueued)) {
      await reportPostingNotQueued({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: params.inboxId,
        action: 'inventory_adjustment_journal_not_queued',
        kind: 'returns_inbox_restock_journal',
        posting: `the inventory journal for the restocked return of ${product?.sku ?? productId} at ${params.warehouse.name}`,
        committed: 'the return stock movement and its cost layer are written in IMS',
        remedy: 'Inventory in the ledger no longer matches IMS by the value of this restock. Post the journal by hand.',
        outcome: enqueued,
        metadata: { inboxId: params.inboxId, productId, warehouseId: params.warehouse.id, chartConnector: settings.connector },
        inTransaction: {
          client: tx as unknown as PostingRefusalClient,
          withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        },
      })
    }
  }
}

/** One returns-inbox arrival a refund adopts, and how many of its units. Recorded per refund, inbox row and quantity (`sales_order_refund_inbox_adoptions`). */
export type InboxAdoption = { inboxId: string; qty: number }

/**
 * o3d-iil0b (owner decision 2026-11-18): A REFUND ADOPTS A RETURNS-INBOX ARRIVAL THAT IS ALREADY RESTOCKED for the same order and product.
 *
 * The warehouse booked the return first (inbox status RESTOCKED, a RETURN_INBOUND movement valued and journalled Dr Inventory / Cr the
 * stock-gain reason). A refund that then restocked or routed the same units in transit would count them twice (Inventory plus Stock in
 * Transit) and its expectation would never clear. Instead the refund LINKS to the arrival: no stock movement, no expectation, no transit debit.
 *
 * WHAT IS LEFT TO ADOPT, per product: the units the order's RESTOCKED inbox rows put into stock, LESS EVERY EXISTING CLAIM ON THEM:
 *   - units the order's return expectations already received (an arrival matched to an expectation is that expectation's, not free),
 *   - units live refunds on the order already restocked themselves (the legacy restock-at-once refund's RETURN_INBOUND movements),
 *   - units earlier live refunds already adopted, counted PER INBOX ROW (`sales_order_refund_inbox_adoptions`, so a row consumed in full is never adopted again
 *     and a partly consumed row offers only what is left). A soft-deleted refund's adoptions release their units.
 * Claims that are not tied to a row are charged against the oldest rows first, so what remains is a conservative, never an optimistic, figure.
 *
 * LOCK: the order row lock, taken here (it is re-entrant) and held by the caller to commit: the refund write that records the adoption runs under the
 * same lock, and so does the inbox restock (it locks the order first), so two refunds racing for one arrival serialise and the second sees the first's claim.
 *
 * ALL-OR-NOTHING: the refund adopts only when every returned product is fully covered; a partly covered refund keeps today's behaviour (a limit, stated
 * rather than guessed at). Returns the per-row quantities to record, or null when nothing is adopted.
 */
export async function findRestockedInboxesToAdopt(
  tx: Prisma.TransactionClient,
  params: { orderId: string; lines: ReadonlyArray<{ productId?: string | null; qty: number }> },
): Promise<InboxAdoption[] | null> {
  const wanted = new Map<string, number>()
  for (const line of params.lines) {
    if (!line.productId || !(line.qty > 0)) continue
    wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.qty)
  }
  if (wanted.size === 0) return null
  await lockSalesOrder(tx, params.orderId)
  const adoptions = new Map<string, number>()
  for (const [productId, qty] of wanted) {
    const inboxes = await tx.wmsReturnsInbox.findMany({
      where: { orderId: params.orderId, productId, status: 'RESTOCKED', erasedAt: null },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (inboxes.length === 0) return null
    const inboxIds = inboxes.map((i) => i.id)
    const movementByInbox = new Map<string, number>()
    for (const g of await tx.stockMovement.groupBy({
      by: ['referenceId'],
      where: { type: 'RETURN_INBOUND', referenceType: 'WmsReturnsInbox', referenceId: { in: inboxIds }, productId },
      _sum: { qty: true },
    })) movementByInbox.set(g.referenceId ?? '', Number(g._sum.qty ?? 0))
    const adoptedByInbox = new Map<string, number>()
    for (const g of await tx.salesOrderRefundInboxAdoption.groupBy({
      by: ['inboxId'],
      where: { inboxId: { in: inboxIds }, refund: { deletedAt: null } },
      _sum: { qty: true },
    })) adoptedByInbox.set(g.inboxId, Number(g._sum.qty ?? 0))
    const free = inboxes.map((i) => ({ id: i.id, free: Math.max(0, (movementByInbox.get(i.id) ?? 0) - (adoptedByInbox.get(i.id) ?? 0)) }))

    // Claims not tied to a row: expectation receipts and units live refunds restocked themselves, charged to the oldest rows first.
    const receivedByExpectations = Number((await tx.returnExpectationLine.aggregate({
      where: { productId, expectation: { orderId: params.orderId } },
      _sum: { qtyReceived: true },
    }))._sum.qtyReceived ?? 0)
    const liveRefunds = await tx.salesOrderRefund.findMany({ where: { orderId: params.orderId, deletedAt: null }, select: { id: true } })
    const restockedByRefunds = liveRefunds.length === 0 ? 0 : Number((await tx.stockMovement.aggregate({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: liveRefunds.map((r) => r.id) }, productId },
      _sum: { qty: true },
    }))._sum.qty ?? 0)
    let claims = Math.max(0, receivedByExpectations) + Math.max(0, restockedByRefunds)
    for (const row of free) {
      const used = Math.min(row.free, claims)
      row.free -= used
      claims -= used
    }

    let need = qty
    for (const row of free) {
      if (need <= 1e-9) break
      const take = Math.min(row.free, need)
      if (take <= 1e-9) continue
      adoptions.set(row.id, Math.round(((adoptions.get(row.id) ?? 0) + take) * 1e6) / 1e6)
      need -= take
    }
    if (need > 1e-9) return null
  }
  return [...adoptions].map(([inboxId, qty]) => ({ inboxId, qty }))
}

const money2 = (n: number): number => Math.round(n * 100) / 100

/**
 * o3d-iil0b (Codex rounds 1-2): THE LEDGER SIDE OF AN ADOPTION IS AN OPERATOR TASK, NEVER AN AUTOMATIC JOURNAL.
 *
 * The warehouse's restock may have booked Dr Inventory / Cr the stock-gain reason account (`queueReturnRestockValueJournal`). An adopting refund
 * returns no stock of its own and books no COGS reversal, so the shipped cost stays expensed and the reason account holds a customer return as a gain.
 * Working out the correcting entry across mixed and partly journalled inbox rows is what went wrong twice, so IMS does NOT post one. It still adopts the
 * units (so stock is not counted twice) and raises ONE owed-posting record that names the refund, the inbox rows and the quantities and says what a
 * person should check and post by hand:
 *   Dr the restock's reason account / Cr COGS at the original shipped cost.
 * It NEVER tells anyone to post Dr Inventory: where the restock journalled, Inventory is already debited by it; where it did not, the restock's own owed
 * record carries that debit. The amounts are given only where IMS can compute them (every adopted row taken whole); a row only partly adopted, or a
 * mix of journalled and unjournalled rows, is marked ADVISORY, and where IMS cannot tell which units were journalled the record says so.
 *
 * The original cost is keyed by product (an average per unit within a product).
 */
export async function raiseAdoptionReclassTask(
  tx: Prisma.TransactionClient,
  params: {
    refundId: string
    orderId: string
    orderRef: string
    adoptions: readonly InboxAdoption[]
    /** The rows the refund returned in effect (shipped, costed): their value is the original cost being reversed. */
    rows: readonly RefundReturnRow[]
  },
): Promise<{ raised: boolean; advisory: boolean; owedCostBase: number }> {
  const none = { raised: false, advisory: false, owedCostBase: 0 }
  if (params.adoptions.length === 0) return none
  const settings = await getAccountingSettings()
  const inboxIds = params.adoptions.map((a) => a.inboxId)
  const inboxes = await tx.wmsReturnsInbox.findMany({ where: { id: { in: inboxIds } }, select: { id: true, productId: true } })
  const productOf = new Map(inboxes.map((i) => [i.id, i.productId as string | null]))
  const costByProduct = new Map<string, { qty: number; value: number }>()
  for (const r of params.rows) {
    const e = costByProduct.get(r.productId) ?? { qty: 0, value: 0 }
    e.qty += r.qty
    e.value += r.qty * Number(r.unitCostBase ?? 0)
    costByProduct.set(r.productId, e)
  }
  const movements = await tx.stockMovement.groupBy({
    by: ['referenceId'],
    where: { type: 'RETURN_INBOUND', referenceType: 'WmsReturnsInbox', referenceId: { in: inboxIds } },
    _sum: { qty: true },
  })
  const movementQty = new Map(movements.map((g) => [g.referenceId ?? '', Number(g._sum.qty ?? 0)]))
  const restockJournals = await tx.accountingSyncLog.findMany({
    // The restock journals that STAND (pending, processing or posted): the ledger module's own work-slot predicate, not a status list of mine.
    where: { type: 'INVENTORY_ADJUSTMENT', referenceType: 'WmsReturnsInbox', referenceId: { in: inboxIds }, ...WORK_SLOT_OCCUPIED_WHERE },
    select: { referenceId: true, payload: true },
  })
  const creditedByInbox = new Map<string, Map<string, number>>()
  const journalled = new Set<string>()
  for (const j of restockJournals) {
    journalled.add(j.referenceId)
    const lines = (j.payload as { lines?: Array<{ accountCode?: string; credit?: number }> } | null)?.lines ?? []
    for (const l of lines) {
      if (!l.accountCode || !(Number(l.credit) > 0) || l.accountCode === settings.inventoryAccount) continue
      const byAccount = creditedByInbox.get(j.referenceId) ?? new Map<string, number>()
      byAccount.set(l.accountCode, (byAccount.get(l.accountCode) ?? 0) + Number(l.credit))
      creditedByInbox.set(j.referenceId, byAccount)
    }
  }

  let advisory = false
  let owedCostBase = 0
  let anyJournalled = false
  let anyUnjournalled = false
  const rowNotes: string[] = []
  const rowMeta: Array<Record<string, unknown>> = []
  for (const a of params.adoptions) {
    const productId = productOf.get(a.inboxId) ?? null
    const cost = productId ? costByProduct.get(productId) : undefined
    const unitCost = cost && cost.qty > 0 ? cost.value / cost.qty : 0
    const original = money2(unitCost * a.qty)
    owedCostBase += original
    const rowQty = movementQty.get(a.inboxId) ?? 0
    const whole = rowQty > 0 && Math.abs(rowQty - a.qty) <= 1e-9
    const hasJournal = journalled.has(a.inboxId)
    if (hasJournal) anyJournalled = true; else anyUnjournalled = true
    const credited = creditedByInbox.get(a.inboxId)
    const creditedText = credited ? [...credited].map(([acc, v]) => `${acc} ${money2(v).toFixed(2)}`).join(', ') : 'none found'
    const head = `inbox row ${a.inboxId}: ${a.qty} of ${rowQty} unit(s) adopted`
    if (!hasJournal) {
      rowNotes.push(`${head}; IMS found no restock journal standing for this row; original cost to reverse ${original.toFixed(2)}`)
    } else if (whole) {
      rowNotes.push(`${head}; the restock journalled it (credited ${creditedText}); post Dr that account ${original.toFixed(2)} / Cr COGS ${original.toFixed(2)}`)
    } else {
      advisory = true
      rowNotes.push(`${head}; the restock journalled this row (credited ${creditedText}) but IMS CANNOT TELL WHICH of its units were journalled; original cost of the adopted units ${original.toFixed(2)} is an estimate`)
    }
    rowMeta.push({ inboxId: a.inboxId, qty: a.qty, rowQty, journalled: hasJournal, originalCostBase: original })
  }
  if (anyJournalled && anyUnjournalled) advisory = true
  owedCostBase = money2(owedCostBase)
  if (!(owedCostBase > 0)) return none

  const unqueuedOutcome: EnqueueOutcomeLike = {
    queued: false,
    reason: 'refused',
    connector: settings.connector,
    posting: { type: 'INVENTORY_ADJUSTMENT', referenceType: 'SalesOrderRefund', referenceId: params.refundId, scope: ADOPTION_RECLASS_POSTING_SCOPE },
  }
  await reportPostingNotQueued({
    entityType: 'SALES_ORDER',
    entityId: params.orderId,
    action: 'refund_adoption_reclass_owed',
    kind: 'refund_adoption_reclass_journal',
    posting: `the margin reclass for refund ${params.refundId} on order ${params.orderRef}, which adopted returned stock the warehouse had already restocked${advisory ? ' (ADVISORY: mixed or partly journalled rows)' : ''}`,
    committed: 'the refund and its link to the already restocked arrival are written in IMS, and the stock is counted once',
    remedy: `IMS posts nothing for this. Rows: ${rowNotes.join(' | ')}. Total original shipped cost ${owedCostBase.toFixed(2)}. Where the restock journalled, the margin needs a manual reclass: Dr the restock's reason account / Cr COGS at the original shipped cost. Never post Dr Inventory for this: the restock's own journal (or its own owed record) carries the Inventory debit.${advisory ? ' ADVISORY: the rows are mixed or only partly adopted, so check the ledger for which units were journalled before posting anything.' : ''}`,
    outcome: unqueuedOutcome,
    metadata: { refundId: params.refundId, adoptions: rowMeta, owedCostBase, advisory, chartConnector: settings.connector },
    inTransaction: {
      client: tx as unknown as PostingRefusalClient,
      withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
    },
  })
  return { raised: true, advisory, owedCostBase }
}
