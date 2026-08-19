import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  applyPostedShipmentUnitCosts,
  applyReturnInboundStockTx,
  buildChargebackRefundLines,
  createSalesOrderRefund,
  postedShipmentUnitCostKey,
  recordRefundCogsReversalFromSync,
  resolveRefundCogsReversalBase,
  retrySalesOrderRefundAccounting,
  type RefundAccountingSyncRequest,
  type RefundServiceClient,
} from '@/lib/domain/sales/refund-service'
import type { AccountingSettings } from '@/lib/accounting'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

type Order = {
  id: string
  externalOrderNumber: string | null
  orderNumber: string | null
  status: string
  refundStatus?: string
  fxRateToBase: number
  totalBase: number
  taxBase?: number
  taxRatePercent?: number
  taxRateName?: string | null
  // o3d-w00 (Codex r3 #2): the shipping charge is a refund TARGET with its own remaining balance,
  // enforced under the order lock, so the locked read of the order carries it.
  shippingForeign?: number
  /**
   * o3d-w00 (Codex r7 #1/#2): the order's own money snapshot, in the currency it was taxed in — what
   * the posted-VAT fence checks the credit note against. `currency` fixes the minor unit the check's
   * tolerance is measured in; `taxForeign` is the order's TOTAL VAT, from which shipping's is the
   * residue; `discountAmount` + `shoppingConnectors` say whether that residue is separable.
   */
  currency?: string
  taxForeign?: number
  discountAmount?: number
  shoppingConnectors?: string[]
  revenueDeferredDate: Date | null
  unearnedRevenueAmount: number | null
  inventoryAllocatedDate: Date | null
  allocationBatchAmount: number | null
  // o3d-0qoo: the exact AccountingSyncLog.referenceId each stamp was staged into. Optional
  // here only so the many fixtures that never stage a batch stay unchanged; the un-stage
  // path must null them alongside the stamps they pair with.
  revenueDeferredBatchRef?: string | null
  inventoryAllocatedBatchRef?: string | null
  // o3d-o97 r3: what A2 recorded ABOUT the journal that carried the amount — its DB-minted sync
  // log id, the ledger it was raised on, and the account it debited. Optional so every pre-r3
  // fixture keeps the legacy amount-implies-posting inference unchanged.
  allocationBatchSyncLogId?: string | null
  allocationBatchConnector?: string | null
  allocationBatchAccountCode?: string | null
  // o3d-0i5y r12 / o3d-xlk7: the running total of pounds ALLOCATION_REVERSAL journals have already
  // credited back out of Allocated Inventory for this order — units orphaned off it, which neither
  // Group B nor a refund will ever describe. Optional, because it is null on every order until one
  // is raised.
  allocationReversalAmount?: number | null
}

type LineTaxRate = { accountingTaxType: string | null; reverseCharge: boolean | null }
type SalesLine = {
  id: string
  orderId: string
  productId: string | null
  description: string
  qty: number
  totalBase: number
  /** The line's NET total in the order's currency — what it has to refund against (Codex r3 #2). */
  totalForeign?: number
  /**
   * The VAT this line actually bore, in the order's currency (Codex r7 #1). Defaults to 0 in the
   * projection below — which is a REAL zero, not a missing read: SalesOrderLine.taxForeign is
   * non-nullable with a 0 default, so a line the fixture says nothing about is a line that bore no VAT.
   */
  taxForeign?: number
  taxRate?: LineTaxRate | null
  /**
   * o3d-kouj: the line's PINNED fulfilment recipe. The refund's component factors — how many
   * component units one refunded kit unit reverses — now come from here, and the state double
   * passes the sales-line rows through verbatim, so setting it is all a fixture has to do.
   */
  fulfillmentRequirements?: unknown
}

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted columns).
function uniqueStockMovementError() {
  return adapterUniqueViolation(['idempotencyKey'], {
    modelName: 'StockMovement',
    constraintName: 'stock_movements_idempotencyKey_key',
  })
}

function uniqueStockLevelError() {
  return adapterUniqueViolation(['productId', 'warehouseId'], {
    modelName: 'StockLevel',
    constraintName: 'stock_levels_productId_warehouseId_key',
  })
}

type Refund = {
  id: string
  orderId: string
  creditNoteNumber: string | null
  externalRefundId: number | null
  reason: string | null
  totalForeign: number
  totalBase: number
  returnWarehouseId: string | null
  chargeback?: boolean
  reversalStaged?: boolean
  accountingRetryRequired?: boolean
  accountingWarning?: string | null
  // o3d-o97 r3: the CR Allocated Inventory this refund's own reversal raised, and the refusal note
  // when it could not account for the order's A2 debit.
  allocatedReliefAmount?: number | null
  allocationBasisUnresolved?: string | null
  accountingRetrySyncs?: unknown
  totalsBasis?: string | null
  source?: string | null
}

type RefundLine = {
  id: string
  refundId: string
  salesOrderLineId?: string | null
  productId: string | null
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  totalForeign: number
  totalBase: number
  costLayerSnapshot?: unknown
  accountingTaxType?: string | null
  reverseCharge?: boolean | null
  lineKind?: string | null
}

type State = {
  orders: Order[]
  lines: SalesLine[]
  refunds: Refund[]
  refundLines: RefundLine[]
  // o3d-ee9: actionable WooCommerce refund parks, so createSalesOrderRefund's under-lock park check is testable.
  shoppingSyncLogs?: Array<{ id: string; connector: string; direction: string; entityType: string; entityId: string | null; externalId: string; status: string }>

  shipments: Array<{
    id: string
    orderId: string
    status: string
    shipmentJournalDate: Date | null
    revenueRecognizedAmount: number | null
    cogsBatchAmount: number | null
    // o3d-o97 r3: the CR Allocated Inventory Group B raised for this shipment, recorded by Group B
    // itself. Absent = journaled before the column existed, which falls back to the CogsEntry
    // derivation (and refuses when retention has swept it).
    allocatedReliefAmount?: number | null
    // o3d-o97 r4: and the journal that raised it. Absent = Group B raised no CR Allocated line at
    // all; present = resolvable to that row's STATUS, so a queued or cancelled relief is not read
    // as pounds the contra has already received.
    allocatedReliefSyncLogId?: string | null
    allocatedReliefConnector?: string | null
    allocatedReliefAccountCode?: string | null
    lines: Array<{ id: string; lineId: string; productId?: string; qty: number; costLayerSnapshot: unknown }>
  }>
  // o3d-o97 r3: `allocationBatchAmount` is the pounds A2 debited for THIS row — the posted basis a
  // partial refund reverses at, immune to the revaluation that rewrites costLayerSnapshot.
  allocations: Array<{ id: string; orderId: string; lineId: string; productId: string; warehouseId: string; qty: number; costLayerSnapshot: unknown; allocationBatchAmount?: number | null }>
  costLayers: Array<{ id: string; productId: string; poLineId: string | null; receivedQty: number; unitCostBase: number }>
  movements: Array<{
    id?: string
    productId: string
    qty: number
    referenceType: string
    referenceId: string
    toWarehouseId?: string | null
    idempotencyKey?: string | null
  }>
  cogsEntries: Array<{
    movementId: string
    costLayerId: string
    qty: number
    unitCostBase: number
    createdAt: Date
  }>
  stockLevels: Array<{ productId: string; warehouseId: string; quantity: number; reservedQty: number }>
  // scjz.20: kit product graph so loadFulfillmentProductGraph can expand KIT lines to
  // components. Keyed by productId; absent ids default to SIMPLE with no components.
  productGraph?: Record<string, {
    type: string
    productComponents: Array<{ componentId: string; qty: number; component: { sku: string; type: string; oversellAllowed: boolean } }>
  }>
  activityLogs: unknown[]
  cogsSubledgerMovements: unknown[]
  // o3d-o97 r2: the reversal journals ALREADY POSTED (or queued) against this order and its prior
  // refunds. This used to be a hardcoded `[]` in the client below — which asserted "no reversal has
  // ever posted" as a fixture invariant, so no test could observe a posted reversal being READ, and
  // the prior-reversal guards (unearned double-count, and now the Allocated Inventory contra) were
  // structurally unobservable. Backed by state now; tests that post nothing simply leave it empty.
  accountingSyncLogs?: Array<{
    id?: string
    connector: string
    type: string
    referenceType: string
    referenceId: string
    status: string
    payload: unknown
  }>
  settings: Record<string, string>
  // `rate` and `usedFor` are how a tax code is PRICED (o3d-w00 Codex r4 #2). Optional only because the
  // many fixtures that never fence an identity never read them — the double below REFUSES to answer a
  // pricing query from a row that does not carry a rate, rather than silently pricing it at 0%.
  taxRates?: Array<{ name: string; accountingTaxType: string | null; active?: boolean; rate?: number; usedFor?: string }>
  executeRawCalls: number
  nextRefundId: number
  nextRefundLineId: number
  nextCostLayerId: number
  failStockLevelUnique?: boolean
  wrapTransactionErrors?: boolean
}

function cloneTestStateValue<T>(value: T): T {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map((entry) => cloneTestStateValue(entry)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneTestStateValue(entry)]),
    ) as T
  }
  return value
}

function restoreTestState(state: State, snapshot: State) {
  for (const key of Object.keys(state) as Array<keyof State>) {
    delete state[key]
  }
  Object.assign(state, cloneTestStateValue(snapshot))
}

const accountingSettings: AccountingSettings = {
  syncEnabled: true,
  salesAccount: '4000',
  shippingAccount: '4010',
  discountAccount: '',
  cogsAccount: '5000',
  inventoryRevaluationAccount: '',
  inventoryAccount: '1200',
  allocatedInventoryAccount: '1210',
  unearnedRevenueAccount: '2100',
  transitAccount: '',
  accountsReceivableAccount: '',
  accountsPayableAccount: '',
  realisedFxGainLossAccount: '',
  unrealisedFxGainLossAccount: '',
  manufacturingOverheadAccount: '',
  paymentAccountMap: '{}',
  invoiceUrlTemplate: '',
  billUrlTemplate: '',
  reverseChargeSalesTaxType: '',
  reverseChargePurchaseTaxType: '',
}

function baseState(overrides: Partial<State> = {}): State {
  const state: State = {
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      totalBase: 100,
    }],
    refunds: [],
    refundLines: [],
    shipments: [],
    allocations: [],
    costLayers: [],
    movements: [],
    cogsEntries: [],
    stockLevels: [],
    activityLogs: [],
    cogsSubledgerMovements: [],
    accountingSyncLogs: [],
    settings: {},
    taxRates: [],
    executeRawCalls: 0,
    nextRefundId: 1,
    nextRefundLineId: 1,
    nextCostLayerId: 1,
    ...overrides,
  }
  // Default seeded existing refunds to NET basis (the post-o3d-n8p norm); a test that exercises the
  // legacy/unknown-basis block pushes a refund with totalsBasis omitted AFTER baseState().
  state.refunds = state.refunds.map((refund) => ({ totalsBasis: 'NET' as const, ...refund }))
  return state
}

function createClient(state: State): RefundServiceClient {
  // This in-memory Prisma mock is intentionally scoped to refund-service unit
  // tests. It models transaction rollback and the two shipment read shapes used
  // by refund creation: physical SHIPPED rows for restocking and journaled rows
  // for accounting reversal snapshots.
  const client = {
    $queryRaw: async () => [],
    $executeRaw: async () => {
      state.executeRawCalls += 1
      return 0
    },
    shoppingSyncLog: {
      // o3d-ee9: the under-lock park queries in createSalesOrderRefund.
      findFirst: async ({ where }: { where: { externalId?: string; entityId?: { not?: string }; status?: { in?: string[] } } }) => {
        const notOrder = where.entityId?.not
        const statuses = where.status?.in
        const match = (state.shoppingSyncLogs ?? []).find((log) =>
          log.connector === 'woocommerce' &&
          log.direction === 'FROM_CONNECTOR' &&
          log.entityType === 'SalesOrder' &&
          (where.externalId == null || log.externalId === where.externalId) &&
          // Prisma `not` excludes NULL too, so a "different order" match requires a non-null, non-`notOrder` id.
          (notOrder == null || (log.entityId != null && log.entityId !== notOrder)) &&
          (statuses == null || statuses.includes(log.status)))
        return match ? { entityId: match.entityId } : null
      },
      updateMany: async ({ where, data }: { where: { externalId?: string; entityId?: string; status?: { in?: string[] } }; data: { status?: string } }) => {
        const statuses = where.status?.in
        let count = 0
        for (const log of state.shoppingSyncLogs ?? []) {
          if (
            log.connector === 'woocommerce' && log.direction === 'FROM_CONNECTOR' && log.entityType === 'SalesOrder' &&
            (where.externalId == null || log.externalId === where.externalId) &&
            (where.entityId == null || log.entityId === where.entityId) &&
            (statuses == null || statuses.includes(log.status))
          ) {
            if (data.status != null) log.status = data.status
            count += 1
          }
        }
        return { count }
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = cloneTestStateValue(state)
      try {
        return await callback(client)
      } catch (error) {
        restoreTestState(state, snapshot)
        if (state.wrapTransactionErrors) {
          throw new Error('Wrapped transaction error', { cause: error })
        }
        throw error
      }
    },
    taxRate: {
      findFirst: async ({ where }: { where: { name?: string; active?: boolean } }) => {
        const match = (state.taxRates ?? []).find((rate) =>
          rate.name === where.name && (where.active ? rate.active !== false : true))
        return match ? { accountingTaxType: match.accountingTaxType } : null
      },
      // o3d-w00 (Codex r4 #2): what each SALES tax code is worth, re-read under the order lock so the
      // posting identity can be fenced to the one the caller converted at. A row with no `rate` is a
      // fixture that has not said what it is worth, and answering 0% for it would let the fence "pass"
      // on a number nobody chose — so it throws instead.
      findMany: async ({ where }: { where?: { usedFor?: { not?: string } } }) => (state.taxRates ?? [])
        .filter((taxRate) => where?.usedFor?.not == null || (taxRate.usedFor ?? 'BOTH') !== where.usedFor.not)
        .map((taxRate) => {
          if (taxRate.rate == null) {
            throw new Error(`tax rate fixture ${taxRate.name} has no rate, so it cannot price ${taxRate.accountingTaxType}`)
          }
          return { accountingTaxType: taxRate.accountingTaxType, rate: taxRate.rate }
        }),
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = state.settings[where.key]
        return value == null ? null : { value }
      },
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        state.settings[where.key] = state.settings[where.key] == null ? create.value : update.value
      },
    },
    orderAllocation: {
      // o3d-67y: refund-release eligibility is residual reserved qty = allocated − shipped, under the lock.
      aggregate: async ({ where }: { where: { orderId: string } }) => ({
        _sum: { qty: state.allocations.filter((row) => row.orderId === where.orderId).reduce((sum, row) => sum + row.qty, 0) },
      }),
    },
    shipmentLine: {
      aggregate: async ({ where }: { where: { shipment: { orderId: string; status: string } } }) => ({
        _sum: {
          qty: state.shipments
            .filter((s) => s.orderId === where.shipment.orderId && s.status === where.shipment.status)
            .reduce((sum, s) => sum + s.lines.reduce((lineSum, line) => lineSum + line.qty, 0), 0),
        },
      }),
    },
    integrationOutbox: {
      // o3d-67y: the durable reservation-release backstop is enqueued inside the refund tx when the order holds
      // allocations. These unit tests don't assert on the outbox, so this is a sink.
      create: async ({ data }: { data: Record<string, unknown> }) => data,
      findUnique: async () => null,
    },
    salesOrder: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) return null
        if (select.fxRateToBase) {
          return {
            ...order,
            // o3d-w00 (Codex r7): the columns the posted-VAT fence reads. Defaulted the way the schema
            // defaults them (currency GBP, taxForeign/discountAmount 0, no shopping link) so an existing
            // fixture keeps meaning what it meant — never left undefined, which would make the fence
            // read a missing column as a figure and quietly stop checking anything.
            currency: order.currency ?? 'GBP',
            taxForeign: order.taxForeign ?? 0,
            discountAmount: order.discountAmount ?? 0,
            shoppingLinks: (order.shoppingConnectors ?? []).map((connector) => ({ connector })),
            lines: state.lines
              .filter((line) => line.orderId === order.id)
              .map((line) => ({
                id: line.id,
                productId: line.productId,
                description: line.description,
                qty: line.qty,
                // Defaults to the base total, i.e. an fx-1 order — the fixtures that care set it.
                totalForeign: line.totalForeign ?? line.totalBase,
                taxForeign: line.taxForeign ?? 0,
                taxRate: line.taxRate ?? null,
              })),
            shipments: state.shipments
              .filter((row) => row.orderId === order.id && row.status === 'SHIPPED')
              .map((row) => ({ id: row.id })),
          }
        }
        if (select.allocations || select.shipments || select.refunds) {
          const shipmentSelect = select.shipments as { where?: { shipmentJournalDate?: { not?: null }; status?: string } } | undefined
          const selectedShipments = state.shipments
            .filter((row) => row.orderId === order.id)
            .filter((row) => {
              if (shipmentSelect?.where?.shipmentJournalDate) return row.shipmentJournalDate != null
              if (shipmentSelect?.where?.status) return row.status === shipmentSelect.where.status
              return true
            })
          return {
            // o3d-o97 r4: THE ORDER'S OWN SELECTED SCALARS, honoured rather than dropped. This
            // branch used to return only the relation keys, so every scalar the caller selected
            // came back UNDEFINED — a double that silently answers "not recorded" to every
            // question about the order's A2 record, which is precisely the state the production
            // code treats as a pre-migration row. Built from the select so a field added to the
            // query and forgotten here reads as null (absent) rather than as whatever the fixture
            // happens to hold.
            ...Object.fromEntries(
              Object.entries(select)
                .filter(([, value]) => value === true)
                .map(([key]) => [key, (order as unknown as Record<string, unknown>)[key] ?? null]),
            ),
            allocations: state.allocations.filter((row) => row.orderId === order.id),
            lines: state.lines.filter((row) => row.orderId === order.id),
            shipments: selectedShipments.map((shipment) => ({
              ...shipment,
              lines: shipment.lines.map((line) => ({
                ...line,
                // KIT shipment lines carry the COMPONENT productId; fall back to the
                // sales line's product for SIMPLE fixtures that don't set it (scjz.20).
                productId: line.productId ?? state.lines.find((salesLine) => salesLine.id === line.lineId)?.productId,
              })),
            })),
            refunds: state.refunds
              .filter((refund) => refund.orderId === order.id)
              .filter((refund) => {
                const refundSelect = select.refunds as { where?: { id?: { not?: string } } } | undefined
                return refundSelect?.where?.id?.not == null || refund.id !== refundSelect.where.id.not
              })
              .map((refund) => ({
                id: refund.id,
                allocatedReliefAmount: refund.allocatedReliefAmount ?? null,
                lines: state.refundLines.filter((line) => line.refundId === refund.id),
            })),
          }
        }
        return order
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Order> }) => {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) throw new Error('Order not found')
        Object.assign(order, data)
        return order
      },
    },
    salesOrderRefund: {
      // Filters on whatever keys the caller supplied. The refund service queries this three
      // ways: by {orderId, externalRefundId} (external replay), by {orderId, chargeback} and
      // by {orderId} alone (the o3d-6oyu.18 cross-path conflict guard).
      findFirst: async ({ where }: { where: { orderId?: string; externalRefundId?: number; chargeback?: boolean } }) => {
        const refund = state.refunds.find((row) => (
          (where.orderId === undefined || row.orderId === where.orderId) &&
          (where.externalRefundId === undefined || row.externalRefundId === where.externalRefundId) &&
          (where.chargeback === undefined || (row.chargeback ?? false) === where.chargeback)
        ))
        if (!refund) return null
        return {
          ...refund,
          lines: state.refundLines.filter((line) => line.refundId === refund.id),
        }
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const refund = state.refunds.find((row) => row.id === where.id)
        if (!refund) return null
        const order = state.orders.find((row) => row.id === refund.orderId)
        if (!order) return null
        return {
          ...refund,
          // o3d-w00 (Codex r8 #4): the retry re-runs the creation fence, so it reads the order's own
          // money the same way the creation transaction does — its lines and its provenance included.
          order: {
            ...order,
            shoppingLinks: (order.shoppingConnectors ?? []).map((connector) => ({ connector })),
            lines: state.lines.filter((line) => line.orderId === order.id),
          },
          lines: state.refundLines.filter((line) => line.refundId === refund.id),
        }
      },
      findMany: async ({ where, select }: { where: { orderId?: string; creditNoteNumber?: { startsWith: string } }; select: Record<string, boolean> }) => {
        if (select.creditNoteNumber) {
          return state.refunds
            .filter((refund) => where.creditNoteNumber == null || refund.creditNoteNumber?.startsWith(where.creditNoteNumber.startsWith))
            .map((refund) => ({ creditNoteNumber: refund.creditNoteNumber }))
        }
        return state.refunds
          .filter((refund) => where.orderId == null || refund.orderId === where.orderId)
          .map((refund) => ({
            totalBase: refund.totalBase,
            accountingRetryRequired: refund.accountingRetryRequired ?? false,
            totalsBasis: refund.totalsBasis ?? null,
          }))
      },
      create: async ({ data }: { data: Omit<Refund, 'id'> }) => {
        const refund = {
          id: `refund-${state.nextRefundId++}`,
          accountingRetryRequired: false,
          accountingWarning: null,
          ...data,
        }
        state.refunds.push(refund)
        return { id: refund.id }
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Refund> }) => {
        const refund = state.refunds.find((row) => row.id === where.id)
        if (!refund) throw new Error('Refund not found')
        Object.assign(refund, data)
        return refund
      },
    },
    salesOrderRefundLine: {
      findMany: async ({ where }: { where: { refund: { orderId: string } } }) => {
        const refundIds = state.refunds
          .filter((refund) => refund.orderId === where.refund.orderId)
          .map((refund) => refund.id)
        return state.refundLines
          .filter((line) => refundIds.includes(line.refundId))
          .map((line) => ({
            productId: line.productId,
            qty: line.qty,
            // o3d-w00 (Codex r3 #2): the per-target balance read. Omitting these made the cap
            // vacuous — every prior refund would look like it had credited nothing.
            salesOrderLineId: line.salesOrderLineId ?? null,
            lineKind: line.lineKind ?? null,
            totalForeign: line.totalForeign,
          }))
      },
      create: async ({ data }: { data: Omit<RefundLine, 'id'> }) => {
        const line = { id: `refund-line-${state.nextRefundLineId++}`, ...data }
        state.refundLines.push(line)
        return line
      },
      update: async ({ where, data }: { where: { id: string }; data: { costLayerSnapshot: unknown } }) => {
        const line = state.refundLines.find((row) => row.id === where.id)
        if (line) line.costLayerSnapshot = data.costLayerSnapshot
      },
    },
    accountingSyncLog: {
      // Honours the real query shape: connector (optional), type/status IN-lists, and the
      // SalesOrder-or-SalesOrderRefund reference OR. Returns only {type, payload}, as selected.
      findMany: async ({ where }: {
        where: {
          connector?: string
          type?: { in?: string[] }
          status?: { in?: string[] }
          OR?: Array<{ referenceType: string; referenceId: string | { in?: string[] } }>
        }
      }) => (state.accountingSyncLogs ?? []).filter((log) => {
        if (where.connector != null && log.connector !== where.connector) return false
        if (where.type?.in != null && !where.type.in.includes(log.type)) return false
        if (where.status?.in != null && !where.status.in.includes(log.status)) return false
        if (where.OR == null) return true
        return where.OR.some((clause) => {
          if (clause.referenceType !== log.referenceType) return false
          const ref = clause.referenceId
          return typeof ref === 'string' ? ref === log.referenceId : (ref.in ?? []).includes(log.referenceId)
        })
      }).map((log) => ({
        type: log.type,
        status: log.status,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
        payload: log.payload,
      })),
      // o3d-o97 r3: the A2 journal probed BY ITS OWN DB-MINTED ID. A missing row is not "no
      // journal" — retention deletes terminal rows — which is why the caller refuses on it.
      //
      // o3d-o97 r5: PROJECTS BY THE CALLER'S OWN `select`. This double used to return a hardcoded
      // {status, connector} whatever was asked for — the defective-double shape that silently
      // answers "not recorded" to every field a caller adds. `payload` is exactly such a field, and
      // without this the whole of r5's "prove what the journal posted" would have been tested
      // against a fixture that could not carry a journal line.
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const log = (state.accountingSyncLogs ?? []).find((row) => row.id === where.id)
        if (!log) return null
        const projected: Record<string, unknown> = {}
        for (const key of Object.keys(select ?? { status: true, connector: true })) {
          projected[key] = (log as unknown as Record<string, unknown>)[key]
        }
        return projected
      },
    },
    cogsSubledgerMovement: {
      // khdw: refund staging records the COGS reversal into the subledger ledger.
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        state.cogsSubledgerMovements.push(create)
        return create
      },
    },
    activityLog: {
      create: async ({ data }: { data: unknown }) => {
        state.activityLogs.push(data)
      },
    },
    costLayer: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => state.costLayers
        .filter((layer) => where.id.in.includes(layer.id)),
      create: async ({ data }: { data: { productId: string; warehouseId: string; receivedQty: number; remainingQty: number; unitCostBase: number; poLineId: string | null } }) => {
        const layer = { id: `return-layer-${state.nextCostLayerId++}`, productId: data.productId, poLineId: data.poLineId, receivedQty: data.receivedQty, unitCostBase: data.unitCostBase }
        state.costLayers.push(layer)
        return { id: layer.id }
      },
      findUnique: async () => ({ receivedQty: 1, sourceLines: [] }),
    },
    stockMovement: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
        const movement = state.movements.find((row) => row.idempotencyKey === where.idempotencyKey)
        if (!movement?.id) return null
        return {
          cogsEntries: state.cogsEntries
            .filter((entry) => entry.movementId === movement.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        }
      },
      findMany: async ({ where }: { where: { referenceType: string; referenceId: string; toWarehouseId?: string } }) => state.movements
        .filter((movement) => movement.referenceType === where.referenceType && movement.referenceId === where.referenceId)
        .filter((movement) => where.toWarehouseId == null || movement.toWarehouseId === where.toWarehouseId),
      createMany: async ({ data, skipDuplicates }: { data: Array<{ productId: string; qty: number; referenceType: string; referenceId: string; idempotencyKey?: string | null }>; skipDuplicates?: boolean }) => {
        let count = 0
        for (const entry of data) {
          if (skipDuplicates && entry.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === entry.idempotencyKey)) {
            continue
          }
          state.movements.push({ id: `movement-${state.movements.length + 1}`, ...entry })
          count += 1
        }
        return { count }
      },
      create: async ({ data }: { data: { productId: string; qty: number; referenceType: string; referenceId: string; toWarehouseId?: string | null; idempotencyKey?: string | null } }) => {
        if (data.idempotencyKey && state.movements.some((movement) => movement.idempotencyKey === data.idempotencyKey)) {
          throw uniqueStockMovementError()
        }
        state.movements.push({ id: `movement-${state.movements.length + 1}`, ...data })
      },
    },
    stockLevel: {
      upsert: async ({ where, create, update }: { where: { productId_warehouseId: { productId: string; warehouseId: string } }; create: { productId: string; warehouseId: string; quantity: number; reservedQty: number }; update: { quantity: { increment: number } } }) => {
        if (state.failStockLevelUnique) throw uniqueStockLevelError()
        const row = state.stockLevels.find((stock) => (
          stock.productId === where.productId_warehouseId.productId &&
          stock.warehouseId === where.productId_warehouseId.warehouseId
        ))
        if (row) {
          row.quantity += update.quantity.increment
        } else {
          state.stockLevels.push({ ...create })
        }
      },
    },
    product: {
      // Includes type + productComponents so loadFulfillmentProductGraph (scjz.20
      // kit-unit COGS conversion) can build its graph. These fixtures are all SIMPLE
      // products (1 component unit per sales-line unit); kit-unit conversion is
      // exercised end-to-end against a real DB in scripts/repro-scjz20.ts.
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id,
          sku: id.toUpperCase(),
          type: state.productGraph?.[id]?.type ?? 'SIMPLE',
          productComponents: state.productGraph?.[id]?.productComponents ?? [],
        })),
    },
  }
  return client as unknown as RefundServiceClient
}

function findReturnCostLayer(state: State) {
  const returnLayer = state.costLayers.find((layer) => layer.id.startsWith('return-layer-'))
  assert.ok(returnLayer, 'expected return cost layer to be created')
  return returnLayer
}

function findCogsReversalSync(result: Awaited<ReturnType<typeof createSalesOrderRefund>>) {
  if (!result.success) {
    assert.fail(result.error)
  }
  const sync = result.accountingSyncs.find((entry) => entry.type === 'COGS_REVERSAL')
  assert.ok(sync, 'expected COGS_REVERSAL sync')
  return sync
}

function findCogsReversalInventoryLine(result: Awaited<ReturnType<typeof createSalesOrderRefund>>) {
  const sync = findCogsReversalSync(result)
  const payload = sync.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }
  const inventoryLine = payload.lines?.find((line) => line.accountCode === accountingSettings.inventoryAccount)
  assert.ok(inventoryLine, 'expected COGS reversal inventory debit line')
  return inventoryLine
}

test('createSalesOrderRefund creates a partial refund record', async () => {
  const state = baseState()
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].status, 'SHIPPED') // lifecycle status is left untouched
  assert.equal(state.orders[0].refundStatus, 'PARTIAL')
  assert.equal(state.refunds[0].creditNoteNumber, 'CN-2026-00001')
  assert.equal(state.refundLines[0].qty, 1)
  assert.equal(state.refundLines[0].unitPriceBase, 50)
  assert.equal(state.refundLines[0].salesOrderLineId, 'line-1')
})

test('createSalesOrderRefund dual-writes refundStatus=FULL on a full refund', async () => {
  const state = baseState()
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].status, 'SHIPPED') // lifecycle status is left untouched
  assert.equal(state.orders[0].refundStatus, 'FULL')
})

test('a full NET refund of a TAXABLE order reaches refundStatus=FULL, not stuck at PARTIAL (o3d-w00)', async () => {
  // Order: gross 120, tax 20, net 100. Refund lines are stored NET, so a full refund is net 100. Against
  // the GROSS 120 it stuck at PARTIAL forever; against the NET 100 it correctly reaches FULL.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 0.2, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL', 'a full net refund of a taxable order is FULL, not stuck PARTIAL')
})

test('a new refund is stamped totalsBasis=NET and a writer-derived source (o3d-n8p)', async () => {
  const state = baseState()
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-',
  })
  assert.equal(state.refunds[0].totalsBasis, 'NET', 'stored totals are marked NET')
  assert.equal(state.refunds[0].source, 'MANUAL_UI', 'no externalRefundId / chargeback => manual')

  const woo = baseState()
  await createSalesOrderRefund(createClient(woo), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
  })
  assert.equal(woo.refunds[0].source, 'WOO_SYNC', 'externalRefundId => woo sync')
})

test('createSalesOrderRefund fails closed when the refund id is parked for a DIFFERENT order (o3d-ee9 park-first)', async () => {
  // Park-first race: order B refused this refund id and wrote a park; order A must NOT silently create its
  // refund and leave B's actionable park stranded. Under the per-refund lock the create refuses.
  const state = baseState({
    shoppingSyncLogs: [{ id: 'p1', connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'order-OTHER', externalId: '4242', status: 'FAILED' }],
  })
  await assert.rejects(
    createSalesOrderRefund(createClient(state), {
      orderId: 'order-1',
      lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
      reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
    }),
    /parked for a different order/,
  )
  assert.equal(state.refunds.length, 0, 'no refund created for the cross-order-parked id')
  assert.equal(state.shoppingSyncLogs?.[0].status, 'FAILED', "the other order's park is untouched")
})

test('createSalesOrderRefund resolves a SAME-order park atomically when the refund lands (o3d-ee9)', async () => {
  // An earlier refused delivery of this refund parked it on THIS order; once the refund is created the park
  // must be resolved in the same transaction, not left lingering as an exception.
  const state = baseState({
    shoppingSyncLogs: [{ id: 'p2', connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'order-1', externalId: '4242', status: 'FAILED' }],
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return', creditNotePrefix: 'CN-', externalRefundId: 4242,
  })
  assert.equal(result.success, true, 'the same-order refund is created')
  assert.equal(state.refunds.length, 1)
  assert.equal(state.shoppingSyncLogs?.[0].status, 'SYNCED', "this order's park was resolved atomically")
})

test('a later refund on an order with a legacy/unknown-basis refund is BLOCKED for manual reconciliation, never over-refunded (o3d-w00 #3 / o3d-n8p)', async () => {
  // A legacy refund stored 100 (basis unknown/GROSS). Summing it with new NET totals against any single
  // ceiling can either over-refund (gross ceiling grosses the new line up) or mark FULL early (net
  // ceiling). Conversion is undecidable, so createSalesOrderRefund fails closed and refuses.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 0.2, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.refunds.push({
    id: 'legacy-refund', orderId: 'order-1', creditNoteNumber: 'CN-legacy', externalRefundId: null,
    reason: 'legacy', totalForeign: 100, totalBase: 100, returnWarehouseId: null, // totalsBasis omitted => legacy/unknown
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 15 }],
    reason: 'Small extra refund', creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, false, 'blocked rather than risk an over-refund / premature FULL')
  assert.equal(result.success === false && result.quarantine, true, 'routed to manual reconciliation')
  assert.equal(state.refundLines.length, 0, 'nothing created')
})

test('a refund line SNAPSHOTS the resolved tax identity at creation (o3d-w00)', async () => {
  // The linked sales line carries its own rate; the snapshot must capture that connector tax type so the
  // credit note posts under it instead of re-predicting from the order default at post time.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 0.2, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(state.refundLines[0].accountingTaxType, 'OUTPUT2', 'the resolved tax type is snapshotted')
  assert.equal(state.refundLines[0].reverseCharge, false)
})

test('a line-linked refund with no tax code of its OWN snapshots the ORDER-DEFAULT identity (o3d-w00 Codex r3 #1)', async () => {
  // This fallback is the contract the hand-recording conversion mirrors: a line whose TaxRate carries no
  // accountingTaxType posts under the order default, so its credit is re-grossed at the DEFAULT's rate,
  // not the line's nominal one. Pinned here because it is what makes converting at the nominal rate
  // wrong — if this fallback ever changes, the exception-inbox conversion is wrong the same day.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 120, taxBase: 20, taxRatePercent: 0.2, taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.lines[0].taxRate = { accountingTaxType: null, reverseCharge: false }
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(
    state.refundLines[0].accountingTaxType, 'OUTPUT2',
    'an unmapped line posts under the ORDER DEFAULT — 20% here, whatever the line was sold at',
  )
})

test('a monetary-only refund PERSISTS lineKind=sale so a retry does not re-post it as shipping (o3d-w00 #4)', async () => {
  // A WooCommerce monetary-only refund is a null-product 'sale' line with a POSITIVE total. The retry
  // loader used to re-infer the kind from productId/sign (null product + positive total => 'shipping'),
  // sending the credit-note revenue to the shipping account on a retry. Persisting the kind fixes that.
  // The order is uniformly taxed so the monetary refund is allowed (mixed-rate orders are refused below).
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Goodwill refund', qty: 0, totalBase: 30, lineKind: 'sale' }],
    reason: 'Goodwill',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  const persisted = state.refundLines.find((line) => line.description === 'Goodwill refund')
  assert.ok(persisted, 'the monetary-only line was created')
  assert.equal(persisted?.productId, null, 'it is a null-product line (would infer as shipping)')
  assert.ok(persisted && persisted.totalBase > 0, 'with a positive total (would infer as shipping, not discount)')
  assert.equal(persisted?.lineKind, 'sale', 'the resolved kind is persisted, not left to be re-inferred on retry')
})

test('a mirrored order-discount refund line persists lineKind=discount (o3d-w00 #4)', async () => {
  // A discount line is exempt from the uniform-tax gate (it uses the order default, like the invoice).
  const state = baseState()
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Order discount', qty: 0, totalBase: 10, lineKind: 'discount' }],
    reason: 'Discount reversal',
    creditNotePrefix: 'CN-',
  })

  const persisted = state.refundLines.find((line) => line.description === 'Order discount')
  assert.equal(persisted?.lineKind, 'discount', 'a discount line persists its kind')
})

test('a monetary-only refund on a MIXED-rate order is REFUSED and quarantined (o3d-w00 #2/#5)', async () => {
  // Two order lines at different tax identities -> not uniform. A monetary-only SALE amount can't be
  // attributed, so it must be refused (fail closed) and flagged for quarantine, not posted under one rate.
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  state.lines.push({
    id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50,
    taxRate: { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: false },
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Partial monetary refund',
    externalRefundId: 9001,
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, false, 'a monetary refund on a mixed-rate order is refused')
  assert.equal(result.success === false && result.quarantine, true, 'and flagged for quarantine')
  assert.match(result.success === false ? result.error : '', /not itemised|not uniformly taxed/i)
  assert.equal(state.refundLines.length, 0, 'nothing was created')
})

test('a monetary-only refund on a reverse-charge order with NO reverse-charge code configured is REFUSED (o3d-w00 #2/#5, Codex r3 #4)', async () => {
  // No reverseChargeSalesTaxType, so resolveSalesLineTaxType performs no swap and the line stays on its
  // base code — indistinguishable from a non-reverse-charged line carrying the same code. IMS cannot say
  // which identity the money would post under, so it fails closed. The refusal now SAYS that, instead of
  // reporting a mixed-rate order the operator would go looking for a storefront breakdown of.
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, false)
  assert.equal(result.success === false && result.quarantine, true)
  assert.match(result.success === false ? result.error : '', /no reverse-charge sales tax code is configured/)
})

test('a FULLY reverse-charged order IS uniformly taxed and its monetary refund posts under the RC identity (o3d-w00 Codex r3 #4)', async () => {
  // Codex r3 #4: uniformity used to be forced false whenever ANY line was reverse-charged, so an order
  // where EVERY line is reverse-charged — one effective identity, zero seller VAT throughout, gross
  // trivially equal to net — was quarantined and the operator told its VAT could not be determined.
  // There was nothing to determine. Uniformity is now read off the effective post-swap identities.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 100, taxBase: 0, taxRatePercent: 0, taxRateName: 'RC' }],
    taxRates: [{ name: 'RC', accountingTaxType: 'ZERORATEDOUTPUT', active: true }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  state.lines.push({
    id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 0,
    // A DIFFERENT base code, so the acceptance can only come from the post-swap identity — if the test
    // passed on the raw codes it would prove nothing about the swap.
    taxRate: { accountingTaxType: 'ECOUTPUT', reverseCharge: true },
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
    accountingSettings: { ...accountingSettings, reverseChargeSalesTaxType: 'REVERSECHARGE' },
  })

  assert.equal(result.success, true, 'an all-reverse-charge order is uniformly taxed')
  const line = state.refundLines.find((refundLine) => refundLine.description === 'Monetary refund')
  assert.equal(line?.accountingTaxType, 'REVERSECHARGE', 'posted under the one reverse-charge identity')
  assert.equal(line?.reverseCharge, true, 'and the snapshot says the line is reverse-charged')
})

test('a MIXTURE of reverse-charged and VAT-bearing lines is still REFUSED (o3d-w00 Codex r3 #4)', async () => {
  // The relaxation must not reach a genuine mixture: two effective identities, and a monetary amount
  // could belong to either.
  const state = baseState({
    orders: [{ ...baseState().orders[0], taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  state.lines.push({
    id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 0,
    taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
    accountingSettings: { ...accountingSettings, reverseChargeSalesTaxType: 'REVERSECHARGE' },
  })
  assert.equal(result.success, false)
  assert.equal(result.success === false && result.quarantine, true)
  assert.match(result.success === false ? result.error : '', /not uniformly taxed/)
})

test('one order line cannot absorb money that came off another, under the refund lock (o3d-w00 Codex r3 #2)', async () => {
  // The order-wide ceiling is not enough: on a £200-net order with £100 already credited to line-1, a
  // second £100 against line-1 still fits under the total — but line-1 has nothing left, so the credit
  // would post to the wrong line's account under the wrong VAT identity. The cap is re-taken INSIDE the
  // refund transaction (after lockSalesOrder), reading the refund lines committed by the earlier refund,
  // which is what serialises two concurrent recordings against one order.
  const makeState = () => {
    const state = baseState({
      orders: [{ ...baseState().orders[0], totalBase: 240, taxBase: 40, taxRatePercent: 0.2, taxRateName: 'Standard' }],
      taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
      refunds: [{
        id: 'refund-0', orderId: 'order-1', creditNoteNumber: 'CN-0', externalRefundId: null, reason: 'first',
        totalForeign: 100, totalBase: 100, returnWarehouseId: null, totalsBasis: 'NET',
      }],
      refundLines: [{
        id: 'refund-line-0', refundId: 'refund-0', salesOrderLineId: 'line-1', productId: null,
        description: 'Widget refund', qty: 0, unitPriceForeign: 0, unitPriceBase: 0,
        totalForeign: 100, totalBase: 100, lineKind: 'sale',
      }],
    })
    state.lines[0] = {
      id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget', qty: 1,
      totalBase: 100, totalForeign: 100, taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    }
    state.lines.push({
      id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Gadget', qty: 1,
      totalBase: 100, totalForeign: 100, taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    })
    return state
  }

  const overLine1 = makeState()
  const refused = await createSalesOrderRefund(createClient(overLine1), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: null, description: 'Widget refund', qty: 0, totalForeign: 100, totalBase: 100, lineKind: 'sale' }],
    reason: 'second refund on the same line',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
  })
  assert.equal(refused.success, false)
  assert.match(refused.success === false ? refused.error : '', /Widget/)
  assert.match(refused.success === false ? refused.error : '', /more than it has left to refund/)
  assert.match(refused.success === false ? refused.error : '', /after earlier refunds/)
  assert.equal(overLine1.refunds.length, 1, 'no second credit note was created')

  // The ORDER ceiling was never the thing stopping it: the same £100 against the untouched line-2 is
  // accepted, so the refusal is per-target, not a total.
  const onLine2 = makeState()
  const allowed = await createSalesOrderRefund(createClient(onLine2), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-2', productId: null, description: 'Gadget refund', qty: 0, totalForeign: 100, totalBase: 100, lineKind: 'sale' }],
    reason: 'the other line',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
  })
  assert.equal(allowed.success, true)
})

test('the shipping charge is a capped target too, and two rows for one target are summed (o3d-w00 Codex r3 #2)', async () => {
  // Shipping has no order line, so it is keyed by lineKind. And the cap aggregates per target first:
  // two rows of £3 against a £5 charge with £4 already credited must fail together even though each
  // would pass alone.
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 126, taxBase: 21, taxRatePercent: 0.2, taxRateName: 'Standard', shippingForeign: 5 }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true }],
    refunds: [{
      id: 'refund-0', orderId: 'order-1', creditNoteNumber: 'CN-0', externalRefundId: null, reason: 'first',
      totalForeign: 4, totalBase: 4, returnWarehouseId: null, totalsBasis: 'NET',
    }],
    refundLines: [{
      id: 'refund-line-0', refundId: 'refund-0', salesOrderLineId: null, productId: null,
      description: 'Shipping refund', qty: 0, unitPriceForeign: 0, unitPriceBase: 0,
      totalForeign: 4, totalBase: 4, lineKind: 'shipping',
    }],
  })
  state.lines[0] = {
    id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget', qty: 1,
    totalBase: 100, totalForeign: 100, taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
  }

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [
      { lineId: null, productId: null, description: 'Shipping refund', qty: 0, totalForeign: 3, totalBase: 3, lineKind: 'shipping' },
      { lineId: null, productId: null, description: 'Shipping refund', qty: 0, totalForeign: 3, totalBase: 3, lineKind: 'shipping' },
    ],
    reason: 'postage',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /shipping \(6\.00 net\) is more than it has left to refund \(1\.00 net, after earlier refunds\)/)
  assert.equal(state.refunds.length, 1, 'no credit note was created')
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r4 #2): the identity the credit note posts under is FENCED to the identity the
// caller converted the operator's gross at.
//
// The hand-recording path divides a GROSS figure by the rate of the identity it expects the refund
// line to carry, and submits the NET. That resolution and this transaction's are two independent
// reads of the tax table and the accounting settings, so an admin remapping a rate, editing a rate,
// or changing the reverse-charge setting in between leaves a credit note posted under an identity
// nobody divided by — a different total from the one that was reconciled.
// ---------------------------------------------------------------------------------------------

/** A coherent taxable order: one line of 100 net at 20% under OUTPUT2, plus 5 of postage. Gross 126. */
function fencedOrderState() {
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 126, taxBase: 21, taxRatePercent: 0.2, taxRateName: 'Standard', shippingForeign: 5 }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true, rate: 0.2, usedFor: 'SALES' }],
  })
  state.lines[0] = {
    id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget', qty: 1,
    totalBase: 100, totalForeign: 100, taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
  }
  return state
}

/** 60.00 gross of widget converted at 20% => 50.00 net, and 6.00 gross of postage => 5.00 net. */
const FENCED_LINES = [
  { lineId: 'line-1', productId: null, description: 'Widget refund', qty: 0, totalForeign: 50, totalBase: 50, lineKind: 'sale' as const },
  { lineId: null, productId: null, description: 'Shipping refund', qty: 0, totalForeign: 5, totalBase: 5, lineKind: 'shipping' as const },
]
const FENCED_IDENTITIES = [
  { lineId: 'line-1', lineKind: 'sale' as const, accountingTaxType: 'OUTPUT2', reverseCharge: false, vatRate: '0.2' },
  { lineId: null, lineKind: 'shipping' as const, accountingTaxType: 'OUTPUT2', reverseCharge: false, vatRate: '0.2' },
]

test('a refund whose posting identity still matches what was converted is created (o3d-w00 Codex r4 #2)', async () => {
  const state = fencedOrderState()
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: FENCED_LINES,
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
    expectedTaxIdentities: FENCED_IDENTITIES,
  })

  assert.equal(result.success, true, 'the fence is not a blanket refusal')
  assert.equal(state.refunds.length, 1)
  assert.deepEqual(
    state.refundLines.map((refundLine) => refundLine.accountingTaxType),
    ['OUTPUT2', 'OUTPUT2'],
    'and the lines really did post under the identity that was fenced',
  )
})

test("a tax rate REMAPPED between the conversion and the posting refuses the credit note (o3d-w00 Codex r4 #2)", async () => {
  // The operator's 60.00 gross was divided by 20% because the widget's rate mapped to OUTPUT2. An
  // admin then moves that rate onto ZERORATEDOUTPUT. The credit note would post 50.00 net under a code
  // the connector grosses at 0% — a 50.00 credit note settling a 60.00 storefront refund, with the
  // park closed as reconciled.
  const state = fencedOrderState()
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: false }
  state.taxRates = [{ name: 'Zero', accountingTaxType: 'ZERORATEDOUTPUT', active: true, rate: 0, usedFor: 'SALES' }]

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: FENCED_LINES,
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
    expectedTaxIdentities: FENCED_IDENTITIES,
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /VAT identity of order line line-1 changed/)
  assert.match(result.success === false ? result.error : '', /was OUTPUT2 when the amount was converted/)
  assert.match(result.success === false ? result.error : '', /Nothing has been credited/)
  assert.equal(state.refunds.length, 0, 'no credit note, and the park stays open for a second attempt')
})

test('a tax rate RE-PRICED between the conversion and the posting refuses the credit note (o3d-w00 Codex r4 #2)', async () => {
  // The subtler half: the CODE is untouched, so an identity-only comparison would pass — but OUTPUT2
  // is now worth 5%, so the 50.00 net the operator's 60.00 gross was divided down to would re-gross to
  // 52.50. Checking the code without its price would let this straight through.
  const state = fencedOrderState()
  state.taxRates = [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: true, rate: 0.05, usedFor: 'SALES' }]

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: FENCED_LINES,
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    enforcePerTargetBalances: true,
    expectedTaxIdentities: FENCED_IDENTITIES,
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /was OUTPUT2 at 20% when the amount was converted and is OUTPUT2 at 5% now/)
  assert.equal(state.refunds.length, 0)
})

test('an identity IMS can no longer price refuses the credit note (o3d-w00 Codex r4 #2)', async () => {
  // The mapping is gone entirely, or has become ambiguous. Either way the transaction cannot confirm
  // the rate the gross was divided by, and "cannot confirm" is not "unchanged".
  const unmapped = fencedOrderState()
  unmapped.taxRates = []
  const gone = await createSalesOrderRefund(createClient(unmapped), {
    orderId: 'order-1',
    lines: FENCED_LINES,
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    expectedTaxIdentities: FENCED_IDENTITIES,
  })
  // With no active rate of that name the order default no longer resolves either, so the identity
  // itself has moved — which is the same refusal, reported at the first thing that changed.
  assert.equal(gone.success, false)
  assert.match(gone.success === false ? gone.error : '', /VAT identity of/)
  assert.equal(unmapped.refunds.length, 0)

  const ambiguous = fencedOrderState()
  ambiguous.taxRates = [
    { name: 'Standard', accountingTaxType: 'OUTPUT2', active: true, rate: 0.2, usedFor: 'SALES' },
    { name: 'EU Standard', accountingTaxType: 'OUTPUT2', active: true, rate: 0.19, usedFor: 'SALES' },
  ]
  const twoWays = await createSalesOrderRefund(createClient(ambiguous), {
    orderId: 'order-1',
    lines: FENCED_LINES,
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    expectedTaxIdentities: FENCED_IDENTITIES,
  })
  assert.equal(twoWays.success, false)
  assert.match(twoWays.success === false ? twoWays.error : '', /which IMS can no longer price/)
  assert.equal(ambiguous.refunds.length, 0)
})

test('the reverse-charge setting changing between the two reads refuses the credit note (o3d-w00 Codex r4 #2)', async () => {
  // The conversion treated the line as reverse-charged (gross IS net, 50.00 for 50.00) because the
  // swap was configured. The setting is cleared before the posting, so the line would post under its
  // VAT-bearing base code instead and the credit note would come to 60.00 against a 50.00 refund.
  const state = fencedOrderState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: true }
  state.taxRates = [
    { name: 'Standard', accountingTaxType: 'OUTPUT2', active: true, rate: 0.2, usedFor: 'SALES' },
    { name: 'EU Reverse Charge', accountingTaxType: 'REVERSECHARGE', active: true, rate: 0, usedFor: 'SALES' },
  ]

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: null, description: 'Widget refund', qty: 0, totalForeign: 50, totalBase: 50, lineKind: 'sale' }],
    reason: 'hand-recorded',
    creditNotePrefix: 'CN-',
    // No reverseChargeSalesTaxType in accountingSettings: the swap the caller relied on is gone.
    accountingSettings: { ...accountingSettings, reverseChargeSalesTaxType: '' },
    expectedTaxIdentities: [
      { lineId: 'line-1', lineKind: 'sale', accountingTaxType: 'REVERSECHARGE', reverseCharge: true, vatRate: '0' },
    ],
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /was REVERSECHARGE \(reverse-charged\) when the amount was converted and is OUTPUT2 \(reverse-charged\) now/)
  assert.equal(state.refunds.length, 0)
})

test('a monetary-only refund on a UNIFORM order posts under the single safe identity, even if the default rate is deactivated (o3d-w00 #5)', async () => {
  // The order default rate is inactive, so the old order-default lookup (active=true) resolved NULL; the
  // identity must instead come from the line relation, which still carries the type.
  const state = baseState({
    orders: [{ ...baseState().orders[0], taxRateName: 'Standard' }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', active: false }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 40, lineKind: 'sale' }],
    reason: 'Monetary refund',
    creditNotePrefix: 'CN-',
  })
  assert.equal(result.success, true, 'a uniform order allows the monetary refund even with a deactivated default')
  const line = state.refundLines.find((l) => l.description === 'Monetary refund')
  assert.equal(line?.accountingTaxType, 'OUTPUT2', 'posted under the single safe identity from the line relation')
})

test('a reverse-charge line snapshots the SWAPPED tax type (o3d-w00)', async () => {
  const state = baseState({
    orders: [{ ...baseState().orders[0], totalBase: 100, taxBase: 0, taxRatePercent: 0, taxRateName: 'RC' }],
    taxRates: [{ name: 'RC', accountingTaxType: 'ZERORATEDOUTPUT', active: true }],
    settings: { reverse_charge_sales_tax_type: 'REVERSECHARGE' },
  })
  state.lines[0].taxRate = { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true }
  await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Return',
    creditNotePrefix: 'CN-',
    accountingSettings: { ...accountingSettings, reverseChargeSalesTaxType: 'REVERSECHARGE' },
  })

  assert.equal(state.refundLines[0].accountingTaxType, 'REVERSECHARGE', 'reverse-charge swap is captured in the snapshot')
  assert.equal(state.refundLines[0].reverseCharge, true)
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 Codex r7 #1/#2/#4/#5: THE POSTED-VAT FENCE, AT THE WRITER.
//
// Every refund line is stored NET and its credit note is re-grossed by whatever the accounting tax
// code it posts under is worth. r6 checked exactly one caller (the WooCommerce sync's itemised
// SHIPPING route); these exercise the check where it now lives — inside the refund transaction, on the
// operation every entry point funnels through — and on the two targets r6 left open: the itemised SALE
// line, and the chargeback.
// ---------------------------------------------------------------------------------------------

/**
 * An order of ONE line whose own TaxRate carries no accounting code, so its credit note falls back to
 * the ORDER-DEFAULT identity — the substitution the fence exists to catch. `lineTaxForeign` is what the
 * line actually bore; £0 makes it zero-rated goods on a 20%-default order.
 */
function fallsBackToOrderDefaultState(lineTaxForeign: number) {
  const base = baseState()
  const state = baseState({
    orders: [{
      ...base.orders[0],
      totalBase: 10 + lineTaxForeign,
      taxBase: lineTaxForeign,
      taxRatePercent: lineTaxForeign > 0 ? 0.2 : 0,
      taxRateName: 'Standard',
      currency: 'GBP',
      taxForeign: lineTaxForeign,
      shippingForeign: 0,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'product-1',
      description: 'Widget',
      qty: 1,
      totalBase: 10,
      totalForeign: 10,
      taxForeign: lineTaxForeign,
      // A TaxRate row with NO accounting code: refund-service falls through to the order default for it,
      // exactly as the invoice did.
      taxRate: { accountingTaxType: null, reverseCharge: false },
    }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', rate: 0.2, active: true, usedFor: 'SALES' }],
  })
  return state
}

const ITEMISED_SALE_REFUND = {
  lineId: 'line-1',
  productId: 'product-1',
  description: 'Widget',
  qty: 1,
  totalForeign: 10,
  totalBase: 10,
  lineKind: 'sale' as const,
}

test('an ITEMISED SALE refund whose credit note would restate VAT is refused (o3d-w00 Codex r7 #1)', async () => {
  // £10.00 of zero-rated goods returned. The line's own tax rate carries no accounting code, so the
  // credit note posts under the order default (OUTPUT2, 20%) and comes to £12.00 — against a £10.00
  // storefront refund that reconciled to the penny. r6 caught this for postage and left it here.
  const state = fallsBackToOrderDefaultState(0)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    // The VAT WooCommerce STATES it returned on this line: none. Restating a stated figure needs no
    // tax-code mapping of its own, which is why the route can be checked at all.
    lines: [{ ...ITEMISED_SALE_REFUND, chargedTaxForeign: 0 }],
    reason: 'Customer return',
    externalRefundId: 8801,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.quarantine, true, 'a deliberate, non-transient refusal')
  const error = result.success === false ? result.error : ''
  assert.match(error, /returned 10\.00 of the customer's money/)
  assert.match(error, /credit note would come to 12\.00/)
  // A storefront refund is money that has ALREADY left, so the message must not read as "try again".
  assert.match(error, /do NOT issue another storefront refund/)
  assert.equal(state.refunds.length, 0, 'nothing was created')
  assert.equal(state.refundLines.length, 0)
})

test('the same line at the rate its credit will post at is recorded (o3d-w00 Codex r7 #1)', async () => {
  // The mirror image, and the one a fence that simply refused unmapped lines would have blocked: £10.00
  // of goods that DID bear the £2.00 of VAT the order default is worth. 10.00 + 2.00 against
  // 10.00 x 1.2 is 12.00 against 12.00, so there is nothing to refuse.
  const state = fallsBackToOrderDefaultState(2)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, chargedTaxForeign: 2 }],
    reason: 'Customer return',
    externalRefundId: 8802,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, true)
  assert.equal(state.refundLines[0].accountingTaxType, 'OUTPUT2')
})

test('a SMALL itemised sale refund is not refused for being small (o3d-w00 Codex r7 #1)', async () => {
  // £2.00 of goods bearing £0.40 is an entirely ordinary 20% line, but two figures rounded to the penny
  // leave its DERIVED rate uncertain by 0.3pp — past the cap a DIVIDED gross needs. Asking the writer's
  // fence to pin the rate down would quarantine it, and the remedy that quarantine names (record it by
  // hand against the same line) refuses for the identical reason: a refusal with nothing anyone can do.
  // In money there is no uncertainty worth the name, which is why the fence compares totals.
  const state = fallsBackToOrderDefaultState(0.4)
  state.orders[0].totalBase = 2.4
  state.orders[0].taxBase = 0.4
  state.orders[0].taxForeign = 0.4
  state.lines[0].totalBase = 2
  state.lines[0].totalForeign = 2
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, totalForeign: 2, totalBase: 2, chargedTaxForeign: 0.4 }],
    reason: 'Customer return',
    externalRefundId: 8803,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, true, 'a £2.00 line at 20% records')

  // And the tolerance bought nothing: the SAME small line zero-rated against the same 20% code is still
  // 2.00 against 2.40, and is still refused.
  const zeroRated = fallsBackToOrderDefaultState(0)
  zeroRated.orders[0].totalBase = 2
  zeroRated.lines[0].totalBase = 2
  zeroRated.lines[0].totalForeign = 2
  const refused = await createSalesOrderRefund(createClient(zeroRated), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, totalForeign: 2, totalBase: 2, chargedTaxForeign: 0 }],
    reason: 'Customer return',
    externalRefundId: 8804,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(refused.success, false)
  assert.match(refused.success === false ? refused.error : '', /credit note would come to 2\.40/)
})

test('an itemised sale line that matched no IMS line is checked against the STATED VAT (o3d-w00 Codex r7 #1)', async () => {
  // An unlinked sale amount posts under the order's single safe identity, and the only record of what
  // the ORDER's goods bore says 20% — so a fence reading the order aggregate would wave this through.
  // WooCommerce states that THIS refund returned £10.00 bearing nothing, and that statement is the only
  // thing that can price a line IMS never matched. It is what has to be restated, and it is refused.
  const base = baseState()
  const state = baseState({
    orders: [{
      ...base.orders[0],
      totalBase: 120, taxBase: 20, taxRatePercent: 0.2, taxRateName: 'Standard',
      currency: 'GBP', taxForeign: 20, shippingForeign: 0,
    }],
    lines: [{
      id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget',
      qty: 1, totalBase: 100, totalForeign: 100, taxForeign: 20,
      taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', rate: 0.2, active: true, usedFor: 'SALES' }],
  })
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{
      lineId: null, productId: null, description: 'Unmatched item', qty: 0,
      totalForeign: 10, totalBase: 10, lineKind: 'sale', chargedTaxForeign: 0,
    }],
    reason: 'Customer return',
    externalRefundId: 8805,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /credit note would come to 12\.00/)
})

test('with no credit note being posted the fence does not run (o3d-w00 Codex r8 #6)', async () => {
  // The fence protects a CREDIT NOTE. With none being posted nothing re-grosses the stored net lines,
  // so there is no total that could disagree — and refusing would strand every refund on a store that
  // posts no credit notes and therefore maps no accounting tax codes at all: a refusal with nothing for
  // anyone to fix. This is the gate, stated so a change to it is visible.
  const state = fallsBackToOrderDefaultState(0)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, chargedTaxForeign: 0 }],
    reason: 'Customer return',
    externalRefundId: 8806,
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
})

test('an ACTIVE connector that posts no credit notes does not arm the fence (o3d-w00 Codex r8 #6)', async () => {
  // r7 gated on the accounting PLUGIN being enabled, which is a different question from whether a
  // credit note will be posted: both connector queues no-op when the connector's sync is switched off
  // or its CREDIT_NOTE type is set to `off`. A store in that state has a live Xero plugin and no ledger
  // entry to be wrong about, so the same refund that is quarantined above must record cleanly here —
  // otherwise the fence quarantines refunds for a tax mapping the store has no reason to keep, and the
  // quarantine's remedy asks an operator to fix something that affects nothing.
  const state = fallsBackToOrderDefaultState(0)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, chargedTaxForeign: 0 }],
    reason: 'Customer return',
    externalRefundId: 8807,
    creditNotePrefix: 'CN-',
    // The plugin IS active — it still scopes the prior-reversal guard — but CREDIT_NOTE posting is off.
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: false,
  })

  assert.equal(result.success, true, 'no credit note will post, so there is no credit-note total to fence')
  assert.equal(state.refunds.length, 1)
})

/**
 * o3d-w00 (Codex r8 #1): an order of MANY small lines, each mapped to a 20% code and each charged at
 * 19% — a rate the storefront applied and the accounting code does not carry. On a £1.00 line the two
 * differ by exactly one penny, which is the per-leg tolerance to the last digit, so no leg is refusable
 * on its own however many there are.
 */
function manySmallLinesState(count: number, chargedTaxPerLine: number) {
  const base = baseState()
  const lines = Array.from({ length: count }, (unused, index) => ({
    id: `line-${index + 1}`,
    orderId: 'order-1',
    productId: `product-${index + 1}`,
    description: `Trinket ${index + 1}`,
    qty: 1,
    totalBase: 1,
    totalForeign: 1,
    taxForeign: chargedTaxPerLine,
    taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
  }))
  return baseState({
    orders: [{
      ...base.orders[0],
      totalBase: count * (1 + chargedTaxPerLine),
      taxBase: count * chargedTaxPerLine,
      taxRatePercent: 0.19,
      taxRateName: 'Standard',
      currency: 'GBP',
      taxForeign: count * chargedTaxPerLine,
      shippingForeign: 0,
    }],
    lines,
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', rate: 0.2, active: true, usedFor: 'SALES' }],
  })
}

const trinketRefund = (count: number) => Array.from({ length: count }, (unused, index) => ({
  lineId: `line-${index + 1}`,
  productId: `product-${index + 1}`,
  description: `Trinket ${index + 1}`,
  qty: 1,
  totalForeign: 1,
  totalBase: 1,
  lineKind: 'sale' as const,
}))

test('a refund whose legs each pass but whose TOTAL does not is refused (o3d-w00 Codex r8 #1)', async () => {
  // The premise first: one of these lines records cleanly, because a penny is exactly what the per-leg
  // tolerance allows and the whole point of allowing it is that a penny is what rounding looks like.
  const single = await createSalesOrderRefund(createClient(manySmallLinesState(100, 0.19)), {
    orderId: 'order-1',
    lines: trinketRefund(1),
    reason: 'Customer return',
    externalRefundId: 8901,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(single.success, true, 'no single leg is refusable — that is what makes the sum invisible')

  // Now the whole refund. 100 lines of £1.00 that returned £119.00 of the customer's money, against a
  // credit note that would come to £120.00. Every leg passed; the credit note is a pound over.
  const state = manySmallLinesState(100, 0.19)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: trinketRefund(100),
    reason: 'Customer return',
    externalRefundId: 8902,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.quarantine, true, 'deliberate and non-transient')
  const error = result.success === false ? result.error : ''
  assert.match(error, /returned 119\.00 of the customer's money across 100 parts/)
  assert.match(error, /would come to 120\.00/)
  assert.match(error, /do NOT issue another storefront refund/)
  assert.equal(state.refunds.length, 0, 'nothing was created')
})

test('a hundred legs that merely round awkwardly are still recorded (o3d-w00 Codex r8 #1)', async () => {
  // The refusal above must not be "many lines". £1.00 bearing £0.20 is a plain 20% line; a hundred of
  // them agree with the code they post under exactly, and a hundred more that round the other way
  // (£1.00 of VAT on £4.99, a real 20% line WooCommerce quantised up from £0.998) stay inside the
  // rounding they actually carry. A fence that refused these would refuse ordinary imported orders.
  const exact = await createSalesOrderRefund(createClient(manySmallLinesState(100, 0.2)), {
    orderId: 'order-1',
    lines: trinketRefund(100),
    reason: 'Customer return',
    externalRefundId: 8903,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(exact.success, true)

  const rounded = manySmallLinesState(100, 1)
  for (const salesLine of rounded.lines) {
    salesLine.totalBase = 4.99
    salesLine.totalForeign = 4.99
  }
  rounded.orders[0].totalBase = 599
  const roundedResult = await createSalesOrderRefund(createClient(rounded), {
    orderId: 'order-1',
    lines: trinketRefund(100).map((refundLine) => ({ ...refundLine, totalForeign: 4.99, totalBase: 4.99 })),
    reason: 'Customer return',
    externalRefundId: 8904,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(roundedResult.success, true, '4.99 x 1.2 = 5.988, and WooCommerce sent 5.99')
})

/**
 * A chargeback fixture: £100.00 of goods bearing £20.00 under their OWN code, and £10.00 of postage
 * bearing £2.00 under the ORDER DEFAULT — the identity the invoice posted shipping under. Shipping's
 * VAT is stored in no column of its own, so it is the £2.00 the order records over and above its lines.
 */
function chargebackState(orderDefaultRate: number, overrides: Partial<Order> = {}) {
  const base = baseState()
  return baseState({
    orders: [{
      ...base.orders[0],
      totalBase: 132, taxBase: 22, taxRatePercent: 0.2, taxRateName: 'Standard',
      currency: 'GBP', taxForeign: 22, shippingForeign: 10,
      ...overrides,
    }],
    lines: [{
      id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget',
      qty: 2, totalBase: 100, totalForeign: 100, taxForeign: 20,
      taxRate: { accountingTaxType: 'OUTPUTGOODS', reverseCharge: false },
    }],
    taxRates: [
      { name: 'Standard', accountingTaxType: 'OUTPUT2', rate: orderDefaultRate, active: true, usedFor: 'SALES' },
      { name: 'Goods', accountingTaxType: 'OUTPUTGOODS', rate: 0.2, active: true, usedFor: 'SALES' },
    ],
  })
}

// o3d-w00 (Codex r8 #5): the lines PRODUCTION emits, not a hand-written approximation of them.
// raiseChargebackForReversedOrder builds its refund through buildChargebackRefundLines, so a fixture
// that omits a leg the builder emits tests a shape that never reaches the writer — which is how the
// r7 "discount makes the shipping leg inseparable" test came to assert on a chargeback carrying no
// discount line at all.
const chargebackLines = (discountBase?: number) => buildChargebackRefundLines({
  lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Widget', qty: 2, totalBase: 100 }],
  shipping: { totalBase: 10 },
  discount: discountBase != null ? { totalBase: discountBase } : undefined,
})
const CHARGEBACK_LINES = chargebackLines()

test('a chargeback posted at the rates the invoice used is raised (o3d-w00 Codex r7 #2)', async () => {
  const state = chargebackState(0.2)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: CHARGEBACK_LINES,
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    chargeback: true,
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, true, 'an unchanged tax configuration reverses symmetrically')
  assert.equal(state.refundLines.find((line) => line.lineKind === 'shipping')?.accountingTaxType, 'OUTPUT2')
})

test('a chargeback raised after the order-default RATE was edited is refused (o3d-w00 Codex r7 #2)', async () => {
  // The symmetry argument for leaving the chargeback unchecked was that the invoice posts shipping under
  // the order default and the reversal unwinds it under the same default, so whatever that code is worth
  // the two cancel. They cancel only while the tax configuration is UNCHANGED. Here an admin has edited
  // the rate mapped to OUTPUT2 from 20% to 5% since the sale — the mutability this branch has already
  // established (Codex r4 #1) — so the credit note would unwind £10.50 of postage against the £12.00 the
  // invoice charged, and the whole reversal is refused rather than posted at the new rate.
  const state = chargebackState(0.05)
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: CHARGEBACK_LINES,
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    chargeback: true,
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, false)
  const error = result.success === false ? result.error : ''
  assert.match(error, /The refunded shipping returned 12\.00 of the customer's money/)
  assert.match(error, /credit note would come to 10\.50/)
  // Not a storefront refund, so it must NOT claim money has already left the business.
  assert.doesNotMatch(error, /storefront/)
  assert.equal(state.refunds.length, 0, 'no chargeback row, so the poller holds paidAt and re-attempts')
  // The goods leg was untouched by the edit and is not what refused it — the shipping leg is, and the
  // remedy named is the SHIPPING one (the order's default rate), not "map this line's tax rate".
  assert.match(error, /refunded shipping/)
  assert.match(error, /Shipping posts under the ORDER's default VAT identity/)
})

test("a discounted chargeback's shipping and discount legs are checked TOGETHER (o3d-w00 Codex r8 #5)", async () => {
  // r7 left both legs unchecked on this order and stated the gap as a decision: shipping's residue is
  // `shipping VAT − discount VAT` when createSalesOrder wrote the totals, and neither figure can be
  // read out of the mixture. True of either leg ALONE — and the automatic chargeback does not raise
  // either alone. buildChargebackRefundLines emits BOTH, both under the order default, so their
  // combined net is exactly the amount that residue is the VAT of, and the pair is checkable.
  //
  // £10.00 of postage at 20% (£2.00) less a £4.00 order discount at 20% (£0.80) leaves the £1.20 the
  // order records over and above its lines. The reversal posts 10.00 − 4.00 = 6.00 net under the order
  // default; at 20% that unwinds 7.20, which is what the invoice charged for the pair.
  const discounted = (orderDefaultRate: number, overrides: Partial<Order> = {}) => chargebackState(orderDefaultRate, {
    discountAmount: 4,
    // £20.00 of line VAT plus the £1.20 residue.
    taxForeign: 21.2,
    taxBase: 21.2,
    ...overrides,
  })

  const unchanged = await createSalesOrderRefund(createClient(discounted(0.2)), {
    orderId: 'order-1',
    lines: chargebackLines(4),
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    chargeback: true,
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(unchanged.success, true, 'an unchanged tax configuration reverses symmetrically')

  // The same admin edit r7 established the chargeback is NOT immune to (OUTPUT2 20% → 5%). The pair
  // would unwind 6.00 x 1.05 = 6.30 against the 7.20 the invoice charged, and is refused.
  const edited = await createSalesOrderRefund(createClient(discounted(0.05)), {
    orderId: 'order-1',
    lines: chargebackLines(4),
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    chargeback: true,
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(edited.success, false)
  const error = edited.success === false ? edited.error : ''
  assert.match(error, /reversed shipping and order discount together/)
  assert.match(error, /returned 7\.20 of the customer's money/)
  assert.match(error, /credit note would come to 6\.30/)
})

test("a discounted chargeback's legs are NOT combined when the discount's VAT was never in the total (o3d-w00 Codex r8 #5)", async () => {
  // The combination is only sound for a writer that nets the order discount's VAT off the same total.
  // The WooCommerce importer does not — it sums the components, and Woo allocates coupon money INTO the
  // line totals (Codex r6 #3) — so there the residue is shipping's VAT ALONE, the shipping leg is
  // checked on its own, and the discount leg's VAT was never in the order's total to be checked
  // against. Same numbers, different provenance, different (and still correct) answer.
  const wooState = chargebackState(0.05, { discountAmount: 4, shoppingConnectors: ['woocommerce'] })
  const wooResult = await createSalesOrderRefund(createClient(wooState), {
    orderId: 'order-1',
    lines: chargebackLines(4),
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    chargeback: true,
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(wooResult.success, false)
  const error = wooResult.success === false ? wooResult.error : ''
  // The SHIPPING leg alone: £10.00 of postage bearing the £2.00 residue, against 10.00 x 1.05.
  assert.match(error, /The refunded shipping returned 12\.00 of the customer's money/)
  assert.match(error, /credit note would come to 10\.50/)
})

test('a public caller cannot state the VAT the fence checks against (o3d-w00 Codex r7 #1/#4)', async () => {
  // chargedTaxForeign REPLACES the order's own snapshot, so a forged value would wave a divergent credit
  // note straight through. createRefund (app/actions/sales.ts) strips it from a non-internal caller —
  // this is the writer half: the fence must act on it when it IS supplied, which is what makes stripping
  // it upstream load-bearing rather than decorative.
  const state = fallsBackToOrderDefaultState(0)
  const forged = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    // "This £10.00 bore £2.00" — false, the line's own snapshot says it bore nothing.
    lines: [{ ...ITEMISED_SALE_REFUND, chargedTaxForeign: 2 }],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(forged.success, true, 'a stated figure is believed — which is why only internal callers may state one')

  const honest = await createSalesOrderRefund(createClient(fallsBackToOrderDefaultState(0)), {
    orderId: 'order-1',
    lines: [ITEMISED_SALE_REFUND],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(honest.success, false, "and without one the line's OWN money is what it is checked against")
  assert.match(honest.success === false ? honest.error : '', /credit note would come to 12\.00/)
})

test('createSalesOrderRefund converts refund totals from base to foreign currency', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 2,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.refunds[0].totalForeign, 100)
  assert.equal(state.refundLines[0].totalForeign, 100)
  assert.equal(state.refundLines[0].unitPriceForeign, 100)
})

test('createSalesOrderRefund rejects stock returns before shipment', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot return refunded stock before the order has shipped',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.movements.length, 0)
})

test('createSalesOrderRefund rejects stock returns for packed shipments', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PACKING',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'PACKED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot return refunded stock before the order has shipped',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.movements.length, 0)
})

test('createSalesOrderRefund records accounting warnings without fallback stock returns', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.match(result.success ? result.accountingWarning ?? '' : '', /accounting reversal staging failed/)
  assert.match(result.success ? result.accountingWarning ?? '' : '', /Cannot reverse COGS/)
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0].accountingRetryRequired, true)
  assert.match(state.refunds[0].accountingWarning ?? '', /Cannot reverse COGS/)
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
})

test('createSalesOrderRefund rejects refund quantities beyond remaining order quantity', async () => {
  const state = baseState({
    refunds: [{
      id: 'prior-refund',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: null,
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: null,
    }],
    refundLines: [{
      id: 'prior-refund-line',
      refundId: 'prior-refund',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 25,
      unitPriceBase: 25,
      totalForeign: 50,
      totalBase: 50,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 25 }],
    reason: 'Duplicate',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Refund qty 1 for product product-1 exceeds remaining refundable qty 0.00',
  })
})

test('createSalesOrderRefund rejects manual kit component refunds', async () => {
  const state = baseState({
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      description: 'Kit 1',
      qty: 1,
      totalBase: 100,
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'component-1', description: 'Component 1', qty: 1, totalBase: 50 }],
    reason: 'Wrong item',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.error.includes('kit component'), true)
})

test('createSalesOrderRefund stages COGS reversal and returns shipped stock from snapshots', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].qty, 1)
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.movements[0].idempotencyKey, 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns')
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
})

test('createSalesOrderRefund chargeback mode suppresses COGS reversal AND restock (scjz.70)', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Payment reversed (chargeback)',
    // A warehouse is supplied to prove the chargeback suppresses restock regardless.
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, true)
  // No COGS reversal — cost is kept as a loss.
  assert.equal(
    result.success && result.accountingSyncs.some((s) => s.type === 'COGS_REVERSAL'),
    false,
  )
  // No inventory restock — the customer keeps the goods.
  assert.equal(result.success && result.returnedRows.length, 0)
  assert.equal(state.movements.length, 0)
  // The refund is recorded as a chargeback that staged NO reversal (fully shipped →
  // credit-note-only), so the accounting evidence checks exempt it durably (scjz.71).
  assert.equal(state.refunds[0]?.chargeback, true)
  assert.equal(state.refunds[0]?.reversalStaged, false)
})

// ---------------------------------------------------------------------------
// o3d-6oyu.18 — concurrent double-reversal guard.
//
// A Xero payment removal and a WooCommerce refund can land inside one poll cycle.
// Both credit-note paths pre-check "has this order already been reversed?" OUTSIDE
// the refund transaction, so neither sees the other's uncommitted row and both post
// a credit note. The authoritative guard is re-taken inside the refund transaction,
// under pg_advisory_xact_lock + the sales_orders row lock, where the loser blocks
// until the winner COMMITS and then reads its row.
//
// These two tests pin the DECISION (both orderings) against the same in-memory
// client the rest of this suite uses. They cannot prove the LOCKING — the mock's
// $transaction is not concurrent and its statements never block. That half needs a
// real Postgres and lives in tests/concurrency/refund-chargeback-race.concurrent.test.ts.
// ---------------------------------------------------------------------------

function reversalRaceState(): State {
  return baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: 'WC-1001',
      orderNumber: null,
      status: 'SHIPPED',
      fxRateToBase: 1,
      // Gross (VAT-inclusive) order total. The chargeback's NET lines (£100) plus a small
      // WC refund still fit under it, which is precisely why the refund-total cap does not
      // catch this race and an explicit conflict guard is needed.
      totalBase: 120,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }] }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })
}

test('o3d-6oyu.18: WC refund commits first → the poller chargeback is refused as prior-refund, not double-credited', async () => {
  const state = reversalRaceState()
  // The WooCommerce refund webhook won the race: its row is COMMITTED by the time the
  // chargeback transaction takes the order lock, even though it was invisible to
  // raiseChargebackForReversedOrder's pre-check.
  state.refunds.push({
    id: 'refund-wc',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.conflict, 'prior-refund')
  assert.match(result.success === false ? result.error : '', /CN-0001/)
  // The decisive assertion: exactly ONE credit note exists for the order.
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0]?.id, 'refund-wc')
})

test('o3d-6oyu.18: chargeback commits first → the WC refund is refused as prior-chargeback, not double-credited', async () => {
  const state = reversalRaceState()
  // The payment poller won the race: its chargeback already unwound the WHOLE remaining
  // order, so the Woo-side refund arriving after must not add a second credit note.
  state.refunds.push({
    id: 'refund-chargeback',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0009',
    externalRefundId: null,
    reason: 'Payment reversed (chargeback)',
    totalForeign: 100,
    totalBase: 100,
    returnWarehouseId: null,
    chargeback: true,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7001,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, false)
  assert.equal(result.success === false && result.conflict, 'prior-chargeback')
  assert.match(result.success === false ? result.error : '', /CN-0009/)
  assert.equal(state.refunds.length, 1)
  assert.equal(state.refunds[0]?.id, 'refund-chargeback')
})

test('o3d-6oyu.18: an ordinary partial refund on an order with prior NON-chargeback refunds is untouched', async () => {
  // The guard must not turn legitimate stacked partial refunds into conflicts — only a
  // prior CHARGEBACK blocks an ordinary refund.
  //
  // totalsBasis MUST be set here (o3d-w00/o3d-n8p): a NULL-basis prior refund is legacy/unknown
  // and now fails closed on its own, which would make this test pass for the wrong reason — it
  // would be asserting the basis guard rather than the chargeback guard it is named for.
  const state = reversalRaceState()
  state.refunds.push({
    id: 'refund-wc-1',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
    totalsBasis: 'NET',
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7002,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.refunds.length, 2)
})

test('createSalesOrderRefund reverses kit COGS in component units, not kit units', async () => {
  // scjz.20: refund qty is in KIT units but cost-layer snapshots are in COMPONENT
  // units. A 1:2 kit refunded for 3 kits must reverse 3 * 2 = 6 component units of
  // basis (£60), not 3 (£30). Refund only the fully-shipped portion to isolate the
  // shipment-cost conversion.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 150,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 150,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 60,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      description: 'Kit',
      qty: 3,
      totalBase: 150,
    }],
    productGraph: {
      'kit-1': {
        type: 'KIT',
        productComponents: [{
          componentId: 'comp-1',
          qty: 2,
          component: { sku: 'COMP-1', type: 'SIMPLE', oversellAllowed: false },
        }],
      },
    },
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 150,
      cogsBatchAmount: 60,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        productId: 'comp-1',
        qty: 6,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 6, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', poLineId: 'po-line-1', receivedQty: 6, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'kit-1', description: 'Kit', qty: 3, totalBase: 150 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  // 3 kits * 2 components = 6 component units of basis at £10 = £60 reversed.
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '6.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  // Returned stock is restocked in component units against the component product.
  assert.equal(state.movements[0].productId, 'comp-1')
  assert.equal(state.movements[0].qty, 6)
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
})

test('createSalesOrderRefund replays external refunds without duplicate stock side effects', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })
  const input = {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'WooCommerce refund replay',
    returnWarehouseId: 'warehouse-returns',
    externalRefundId: 12345,
    creditNotePrefix: 'CN-',
    accountingSettings,
  }

  const first = await createSalesOrderRefund(createClient(state), input)
  assert.equal(first.success, true)
  const movementCount = state.movements.length
  const costLayerCount = state.costLayers.length
  const refundCount = state.refunds.length
  const refundLineCount = state.refundLines.length
  const stockQty = state.stockLevels[0]?.quantity

  const second = await createSalesOrderRefund(createClient(state), input)

  assert.equal(second.success, true)
  assert.equal(second.success && first.success && second.createdRefund.id, first.success && first.createdRefund.id)
  assert.deepEqual(second.success && second.accountingSyncs, [])
  assert.deepEqual(second.success && second.returnedRows, [])
  assert.equal(state.movements.length, movementCount)
  assert.equal(state.costLayers.length, costLayerCount)
  assert.equal(state.refunds.length, refundCount)
  assert.equal(state.refundLines.length, refundLineCount)
  assert.equal(state.stockLevels[0]?.quantity, stockQty)
})

test('replaying a monetary-only external refund reconstructs lineKind=sale from the snapshot, not shipping (o3d-w00 #4)', async () => {
  // A duplicate WooCommerce delivery hits the external-refund replay query, which used to re-infer the
  // kind from salesOrderLineId (null => shipping) — re-posting a monetary 'sale' as shipping. It must now
  // reconstruct from the PERSISTED lineKind instead.
  const state = baseState()
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false } // uniform: monetary refund allowed
  const input = {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Goodwill refund', qty: 0, totalBase: 30, lineKind: 'sale' as const }],
    reason: 'Goodwill',
    externalRefundId: 55555,
    creditNotePrefix: 'CN-',
    accountingSettings,
  }
  const first = await createSalesOrderRefund(createClient(state), input)
  assert.equal(first.success, true)

  const replay = await createSalesOrderRefund(createClient(state), input)
  assert.equal(replay.success, true)
  const line = replay.success ? replay.createdRefundLines.find((l) => l.description === 'Goodwill refund') : undefined
  assert.ok(line, 'the monetary-only line is present in the replay')
  assert.equal(line?.productId, null, 'null-product line (the shape that inferred as shipping)')
  assert.equal(line?.lineKind, 'sale', 'the replay uses the persisted kind, not the shipping inference')
})

test('createSalesOrderRefund reconstructs legacy shipment snapshots from COGS entries', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: null,
      }],
    }],
    movements: [{
      id: 'dispatch-movement-1',
      productId: 'product-1',
      qty: 2,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
    cogsEntries: [{
      movementId: 'dispatch-movement-1',
      costLayerId: 'layer-1',
      qty: 2,
      unitCostBase: 10,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(result.success && result.accountingWarning, undefined)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
  const refundMovement = state.movements.find((movement) => movement.referenceType === 'SalesOrderRefund')
  assert.ok(refundMovement, 'expected refund return movement')
  assert.equal(refundMovement.qty, 1)
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
})

// 6oyu.5: after a post-dispatch landed-cost revaluation, updateSnapshotsForCost-
// LayerChange rewrites the shipment snapshot AND cogsBatchAmount to the CURRENT
// layer cost (£12), so the snapshot can NOT be the posted basis (scjz.19). The
// immutable CogsEntry dispatch rows (£10) are. The refund must reverse £10 (posted)
// and re-enter the returned stock at £10 — the +£2 revaluation delta stays in COGS.
test('createSalesOrderRefund reverses originally-posted COGS after an UPWARD landed-cost revaluation (6oyu.5)', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      // Revaluation mutated the snapshot AND cogsBatchAmount to the current £12.
      cogsBatchAmount: 24,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 12 }],
      }],
    }],
    // Immutable dispatch COGS: posted at £10/unit.
    movements: [{
      id: 'dispatch-movement-1',
      productId: 'product-1',
      qty: 2,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
    cogsEntries: [{
      movementId: 'dispatch-movement-1',
      costLayerId: 'layer-1',
      qty: 2,
      unitCostBase: 10,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 12 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after revaluation',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '10.000000',
    'return layer should re-enter at the originally-posted cost, not the revalued layer cost',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
  const sync = findCogsReversalSync(result)
  assert.equal((sync.payload as { _cogsReversalBase?: number })._cogsReversalBase, 10)
})

test('createSalesOrderRefund reverses originally-posted COGS after a DOWNWARD landed-cost revaluation (6oyu.5)', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 16,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 8 }],
      }],
    }],
    movements: [{
      id: 'dispatch-movement-1',
      productId: 'product-1',
      qty: 2,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
    cogsEntries: [{
      movementId: 'dispatch-movement-1',
      costLayerId: 'layer-1',
      qty: 2,
      unitCostBase: 10,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 8 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after supplier credit',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(
    findReturnCostLayer(state).unitCostBase,
    '10.000000',
    'return layer should re-enter at the originally-posted cost after a downward revaluation',
  )
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
})

test('createSalesOrderRefund draws posted COGS proportionally on a PARTIAL refund after revaluation (6oyu.5)', async () => {
  // Shipped 2 units across two FIFO layers with DIFFERENT posted costs (£10, £20),
  // both revalued up to £15 after dispatch. A 1-unit partial refund must reverse
  // the FIFO-oldest layer's POSTED £10 (proportional draw), not the current £15.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 30,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 30,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [
          { costLayerId: 'layer-1', qty: 1, unitCostBase: 15 },
          { costLayerId: 'layer-2', qty: 1, unitCostBase: 15 },
        ],
      }],
    }],
    movements: [{
      id: 'dispatch-movement-1',
      productId: 'product-1',
      qty: 2,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
    }],
    cogsEntries: [
      { movementId: 'dispatch-movement-1', costLayerId: 'layer-1', qty: 1, unitCostBase: 10, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { movementId: 'dispatch-movement-1', costLayerId: 'layer-2', qty: 1, unitCostBase: 20, createdAt: new Date('2026-01-02T00:00:01.000Z') },
    ],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 1, unitCostBase: 15 },
      { id: 'layer-2', productId: 'product-1', poLineId: 'po-line-2', receivedQty: 1, unitCostBase: 15 },
    ],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Partial return after revaluation',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(findReturnCostLayer(state).unitCostBase, '10.000000')
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
})

test('applyPostedShipmentUnitCosts overrides shipment entries with the posted basis, keeps others (6oyu.5)', () => {
  const posted = new Map<string, number>([
    [postedShipmentUnitCostKey('shipment-line-1', 'layer-1'), 10],
  ])
  const entries = [
    // Shipment entry with a posted basis → overridden to £10.
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 12, shipmentLineId: 'shipment-line-1', source: 'shipment' as const },
    // Shipment entry with NO posted basis (legacy) → keeps its carrying cost.
    { costLayerId: 'layer-9', qty: 1, unitCostBase: 7, shipmentLineId: 'shipment-line-1', source: 'shipment' as const },
    // Allocation entry (no shipmentLineId) → untouched.
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 5, orderAllocationId: 'alloc-1', source: 'allocation' as const },
  ]
  assert.deepEqual(applyPostedShipmentUnitCosts(entries, posted), [
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 10, shipmentLineId: 'shipment-line-1', source: 'shipment' },
    { costLayerId: 'layer-9', qty: 1, unitCostBase: 7, shipmentLineId: 'shipment-line-1', source: 'shipment' },
    { costLayerId: 'layer-1', qty: 1, unitCostBase: 5, orderAllocationId: 'alloc-1', source: 'allocation' },
  ])
})

test('createSalesOrderRefund falls back to shipment snapshot cost when cost layer no longer exists', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Customer return after layer cleanup',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(findCogsReversalInventoryLine(result).debit, 10)
})

test('createSalesOrderRefund clears accounting deferral dates for full refunds', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      revenueDeferredBatchRef: 'A1-2026-01-01-deadbeef',
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-cafef00d',
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      // o3d-o97 r3: what Group B recorded it credited Allocated Inventory, in the same UPDATE as
      // the journal stamp. Without it the order's A2 debit cannot be accounted for and the
      // un-stage below is deliberately withheld.
      allocatedReliefAmount: 20,
      // o3d-o97 r4: and the journal that raised that credit, SYNCED below — a recorded amount
      // naming no journal is refused now, because it does not say the credit was ever raised.
      allocatedReliefSyncLogId: 'gb-log-1',
      allocatedReliefConnector: 'xero',
      allocatedReliefAccountCode: '1210',
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })
  state.accountingSyncLogs?.push({
    id: 'gb-log-1',
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-01-02-cafebabe',
    status: 'SYNCED',
    // o3d-o97 r5: the CR Allocated Inventory line the journal actually carried. SYNCED says the row
    // settled, never what it credited, so the shipment's recorded £20 is now checked against the
    // journal's own lines — an empty journal here would be a record contradicted by its own journal.
    payload: { lines: [{ accountCode: '1210', credit: 20 }] },
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(state.orders[0].revenueDeferredDate, null)
  assert.equal(state.orders[0].inventoryAllocatedDate, null)
  // o3d-0qoo: each batch ref must be nulled in the SAME update as the stamp it pairs with.
  // A surviving ref with a cleared stamp still matches the delete guard's referenceId lookup,
  // so the order would be blocked forever on a batch it is no longer part of.
  assert.equal(state.orders[0].revenueDeferredBatchRef, null, 'A1 batch ref must be cleared with revenueDeferredDate')
  assert.equal(state.orders[0].inventoryAllocatedBatchRef, null, 'A2 batch ref must be cleared with inventoryAllocatedDate')
  assert.deepEqual(state.refunds[0].accountingRetrySyncs, result.success ? result.accountingSyncs : [])
})

test('createSalesOrderRefund reverses the FULL deferral on a full refund of a shipped-but-unjournaled order (qn8a)', async () => {
  // qn8a: a deferred order ships, but Group B has NOT yet journaled its revenue
  // recognition (shipmentJournalDate: null, revenueRecognizedAmount: 0), then a
  // FULL refund is issued. A concern was raised that the unearnedReversal cap
  // (unshippedQtyRevenue + nonQtyRevenue) would drop the shipped portion's
  // deferral, stranding it in the unearned account once the order flips to
  // REFUNDED (which Group B then excludes forever).
  //
  // It does NOT strand: the refund's shipment query filters to journaled
  // shipments only (refund-service.ts shipments where shipmentJournalDate not
  // null), so an unjournaled-but-shipped qty is classified as UNSHIPPED in the
  // revenue split and lands inside the cap. The full remaining deferral is
  // reversed; the credit-note ACCRECCREDIT document reverses Sales↔AR, netting
  // to Dr Unearned / Cr AR — a correct full unwind. This test locks that so the
  // journaled-only filter cannot silently regress.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      // Unjournaled: Group B has not run for this shipment yet.
      shipmentJournalDate: null,
      revenueRecognizedAmount: 0,
      cogsBatchAmount: 0,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    allocations: [{
      id: 'alloc-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  const unearnedSync = result.success && result.accountingSyncs.find((s) => s.type === 'UNEARNED_REV_REVERSAL')
  assert.ok(unearnedSync, 'expected an UNEARNED_REV_REVERSAL sync')
  const debitLine = (unearnedSync.payload as { lines?: Array<{ accountCode?: string; debit?: number }> })
    .lines?.find((l) => l.accountCode === accountingSettings.unearnedRevenueAccount && l.debit)
  // The entire £100 deferral is reversed out of the unearned account — nothing stranded.
  assert.equal(debitLine?.debit, 100)
})

// ---------------------------------------------------------------------------
// o3d-o97 — the A2 allocated contra a full refund un-stages.
//
// A full refund nulls inventoryAllocatedDate, and BOTH daily-batch windows filter
// `refundStatus: { not: 'FULL' }`, so after it neither Group A2 nor Group B will ever
// touch this order again. Whatever of A2's DR Allocated Inventory is still unrelieved at
// that moment is stranded permanently unless this refund reverses it.
//
// These assert the FIGURE on the Allocated Inventory credit line, not merely that a
// reversal exists: the defect these cover is a reversal that posts the wrong (too small)
// amount, which a presence check cannot see.
// ---------------------------------------------------------------------------

/** The Allocated Inventory credit on the refund's UNEARNED_REV_REVERSAL journal, or null. */
function findAllocatedInventoryCredit(
  result: Awaited<ReturnType<typeof createSalesOrderRefund>>,
): number | null {
  if (!result.success) return null
  const sync = result.accountingSyncs.find((entry) => entry.type === 'UNEARNED_REV_REVERSAL')
  if (!sync) return null
  const lines = (sync.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }).lines ?? []
  const credit = lines.find((line) => line.accountCode === accountingSettings.allocatedInventoryAccount && line.credit != null)
  return credit?.credit ?? null
}

/** The matching Inventory debit, so the reversal is checked as a balanced pair. */
function findInventoryReversalDebit(
  result: Awaited<ReturnType<typeof createSalesOrderRefund>>,
): number | null {
  if (!result.success) return null
  const sync = result.accountingSyncs.find((entry) => entry.type === 'UNEARNED_REV_REVERSAL')
  if (!sync) return null
  const lines = (sync.payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> }).lines ?? []
  const debit = lines.find((line) => line.accountCode === accountingSettings.inventoryAccount && line.debit != null)
  return debit?.debit ?? null
}

/** An A2-staged, fully-allocated, unshipped order worth £20 of allocated cost. */
function a2StagedAllocatedState(): State {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      // A2 posted DR Allocated Inventory £20 / CR Inventory £20 for this order.
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-deadbeef',
      allocationBatchAmount: 20,
    }],
    allocations: [{
      id: 'alloc-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      // o3d-o97 r4: the pounds A2 debited for THIS row, which A2 writes in the same transaction as
      // the order's stamp. A row without it has no posted basis, and a refund of its units now
      // reverses ZERO rather than being valued at whatever the layer is worth today.
      allocationBatchAmount: 20,
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })
  // Uniform tax identity, so the monetary-only shape below is allowed rather than parked (o3d-w00).
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  return state
}

test('a MONETARY-ONLY full refund reverses the whole A2 allocated contra it un-stages (o3d-o97)', async () => {
  // The WooCommerce monetary-only shape: no productId, no qty, £100 of value. It reaches
  // REFUNDED through isFullRefundAmount, so it clears inventoryAllocatedDate — but it consumes
  // NO allocation cost, so before o3d-o97 the refund posted no allocation reversal at all and
  // A2's £20 debit sat in Allocated Inventory forever.
  const state = a2StagedAllocatedState()

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL', 'the refund is full by AMOUNT, which is what un-stages A2')
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'and A2 is un-staged, so nothing will relieve it later')
  assert.equal(
    findAllocatedInventoryCredit(result),
    20,
    'the whole £20 A2 debit is credited back out of Allocated Inventory',
  )
  assert.equal(findInventoryReversalDebit(result), 20, 'and debited back to Inventory — a balanced pair')
})

test('a full-by-amount refund whose LINES cover only part of the allocation still reverses all £20 (o3d-o97)', async () => {
  // Full by amount (£100 of a £100 order) but the line covers 1 of the 2 allocated units. The
  // line-driven reversal is £10; the other £10 is the residue nothing else can ever relieve,
  // because refundStatus=FULL removes the order from both daily-batch windows.
  const state = a2StagedAllocatedState()

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 100 }],
    reason: 'Full value, partial quantity',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(
    findAllocatedInventoryCredit(result),
    20,
    'both the £10 the line consumed and the £10 residue are reversed — not £10',
  )
})

test('a full refund whose lines cover EVERY allocated unit reverses £20 once, not twice (o3d-o97)', async () => {
  // The ordinary shape. The residue is empty because the refund lines consumed the whole pin,
  // so adding it must not double the reversal.
  const state = a2StagedAllocatedState()

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 20, 'exactly the A2 amount, reversed once')
})

// ---------------------------------------------------------------------------
// o3d-xlk7 — AN ALLOCATION_REVERSAL IS THE THIRD THING THAT RELIEVES THE A2 CONTRA.
//
// o3d-batch-shiporder raises ALLOCATION_REVERSAL journals for units ORPHANED off an order (a
// re-allocation that drops a scope, the deallocation teardown, the manual editor, the
// over-allocation rebalancer). Those units will never ship and were never refunded, so NEITHER of
// o3d-o97's two relief sources — Group B's per-shipment `allocatedReliefAmount` and each prior
// refund's `allocatedReliefAmount` — will ever describe them.
//
// So before this fix the open balance still contained pounds that had already been credited, and
// the residue on a full refund credited them A SECOND TIME. These assert the FIGURE, because the
// defect is a reversal of the wrong (too large) amount and a presence check cannot see it.
// ---------------------------------------------------------------------------

/**
 * The £20 order after one of its two units was orphaned and reversed for £10:
 *   * one allocation row left, one unit, £10 of posted basis;
 *   * `allocationBatchAmount` still 20 — that is what A2 POSTED, and o3d-o97 keeps it deliberately
 *     (`resolveStagedAllocationDebit` reads a recorded zero as proof no debit stands, so netting a
 *     reversal into it would let a fully-reversed order clear its stamp and be posted again);
 *   * `allocationReversalAmount` 10 — the durable record of what the reversal credited back.
 */
function a2StagedWithOrphanReversalState(): State {
  const state = a2StagedAllocatedState()
  state.orders[0].allocationReversalAmount = 10
  state.allocations = [{
    id: 'alloc-1',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 1,
    costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 1, unitCostBase: 10 }],
    allocationBatchAmount: 10,
  }]
  return state
}

/** The SYNCED reversal journal itself: CR Allocated Inventory £10 / DR Inventory £10. */
function seedPostedAllocationReversal(state: State, status = 'SYNCED'): void {
  state.accountingSyncLogs = [{
    id: 'alloc-reversal-1',
    connector: 'xero',
    type: 'ALLOCATION_REVERSAL',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    status,
    payload: {
      lines: [
        { accountCode: accountingSettings.inventoryAccount, debit: 10 },
        { accountCode: accountingSettings.allocatedInventoryAccount, credit: 10 },
      ],
    },
  }]
}

test('a full refund does NOT re-credit units an ALLOCATION_REVERSAL already credited (o3d-xlk7)', async () => {
  // THE DOUBLE-CREDIT, end to end. A2 debited Allocated Inventory £20 for two units. One unit was
  // later orphaned off the order and an ALLOCATION_REVERSAL credited £10 of it back — so £10 is
  // open. A monetary-only full refund then closes both daily-batch windows for ever.
  //
  //   before  the open balance was `allocationBatchAmount` (£20) less relief from Group B (none)
  //           and prior refunds (none) = £20, and the residue credited the whole £20. Allocated
  //           Inventory received £10 + £20 = £30 against a £20 debit, and the SAME UNIT was
  //           credited twice.
  //   now     the reversal is proved from its own journal lines (net CR £10) and netted, so the
  //           open balance is £10 and exactly £10 is credited. £10 + £10 = the £20 debited.
  const state = a2StagedWithOrphanReversalState()
  seedPostedAllocationReversal(state)

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL', 'full by amount, which is what un-stages A2')
  assert.equal(
    findAllocatedInventoryCredit(result),
    10,
    'only the £10 still open — NOT the £20 A2 posted, £10 of which the reversal already credited',
  )
  assert.equal(findInventoryReversalDebit(result), 10, 'and the matching Inventory debit is £10, not £20')
})

test('an ALLOCATION_REVERSAL journal retention has swept is still counted, and says it was assumed (o3d-xlk7)', async () => {
  // The reason the relief is RECORDED on the order and not read off the journal alone.
  // `retention_sync_logs_months` hard-deletes an AccountingSyncLog row once terminal and past the
  // cutoff, and an orphaning can precede its order's refund by many months. With the row gone the
  // proved relief is zero — and reading that as "nothing was ever reversed" is the double-credit
  // again, later and quieter. The recorded £10 is counted instead (the reading that moves the least
  // money: it can only UNDER-reverse, which leaves a visible standing debit), and the refund row
  // says the figure rests on a record rather than on a journal.
  const state = a2StagedWithOrphanReversalState()
  state.accountingSyncLogs = []

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 10, 'the recorded reversal is still netted off')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /reversal relief was counted from its own record because the journal\(s\) that raised it can no longer be read/,
    'and the assumption reaches the refund row, so retention cannot turn it into a resolution',
  )
})

test('an ALLOCATION_REVERSAL that has not settled makes the refund REFUSE rather than guess (o3d-xlk7)', async () => {
  // A queued or abandoned reversal is pounds that may or may not have left the account, and this
  // repository has established both halves: a FAILED row does not prove nothing posted (o3d-ju8t),
  // and CANCELLED is an abandonment written by a sweep or an operator who cannot see whether the
  // remote call landed (o3d-o97 r5). Counting it under-reverses; ignoring it over-credits. Neither
  // guess is available, so nothing is credited and the refund says which journal.
  const state = a2StagedWithOrphanReversalState()
  seedPostedAllocationReversal(state, 'PENDING')

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'nothing is credited to an account whose balance is unknown')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /Allocated Inventory reversal journal\(s\) recorded PENDING, not SYNCED/,
  )
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'and the A2 stamp survives so the order stays reportable')
})

test('a full refund on an order A2 never staged posts NO allocation reversal (o3d-o97)', async () => {
  // The allocation rows carry pinned layers, but no A2 journal was ever posted for them (no
  // inventoryAllocatedDate), so Allocated Inventory holds nothing for this order. Crediting it
  // would move a balance the daily batch never made.
  const state = a2StagedAllocatedState()
  state.orders[0].inventoryAllocatedDate = null
  state.orders[0].inventoryAllocatedBatchRef = null
  state.orders[0].allocationBatchAmount = null

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'no Allocated Inventory credit line at all')
})

test('a PARTIAL refund leaves the A2 stamp and reverses only what its lines consumed (o3d-o97)', async () => {
  // The order stays A2-staged and stays inside both daily-batch windows, so the unconsumed pin is
  // NOT stranded — Group B will still relieve it when the units ship. Reversing it here would
  // credit Allocated Inventory twice for the same units.
  const state = a2StagedAllocatedState()

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 40 }],
    reason: 'Partial return',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(state.orders[0].inventoryAllocatedDate?.toISOString(), '2026-01-01T00:00:00.000Z', 'still staged')
  assert.equal(findAllocatedInventoryCredit(result), 10, 'only the one refunded unit — the residue stays with Group B')
})

test('an ALLOCATION-ONLY reversal journal is labelled for what it contains (o3d-o97)', async () => {
  // Allocate 3, ship and journal 2. Group B recognised the whole £100 deferral, so
  // remainingUnearned is 0 and this journal has NO unearned line — but one allocated unit's
  // £10 contra is still open, and the full refund is the last chance to reverse it. Before
  // o3d-o97 this journal did not exist at all; the label must not claim an unearned reversal
  // that is not in it.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-deadbeef',
      allocationBatchAmount: 30,
    }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 3, totalBase: 100 }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      // Group B recognised the entire deferral for this order.
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      // o3d-o97 r3: and recorded the £20 it credited Allocated Inventory.
      // o3d-o97 r4: naming the journal that raised it, SYNCED below.
      allocatedReliefAmount: 20,
      allocatedReliefSyncLogId: 'gb-log-1',
      allocatedReliefConnector: 'xero',
      allocatedReliefAccountCode: '1210',
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        // Carries orderAllocationId, so it relieves 2 of the 3 pinned units.
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10, orderAllocationId: 'alloc-1', source: 'shipment' }],
      }],
    }],
    allocations: [{
      id: 'alloc-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 3,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 10 }],
      // o3d-o97 r4: the posted basis A2 wrote for the row — £30 over 3 units.
      allocationBatchAmount: 30,
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 3, unitCostBase: 10 }],
  })
  state.accountingSyncLogs?.push({
    id: 'gb-log-1',
    connector: 'xero',
    type: 'DAILY_BATCH_GROUP_B',
    referenceType: 'DailyBatch',
    referenceId: 'B-2026-01-02-cafebabe',
    status: 'SYNCED',
    // o3d-o97 r5: the CR Allocated Inventory line this batch journal actually carried, which is
    // what proves the shipment's recorded 20 pounds of relief rather than the row's status.
    payload: { lines: [{ accountCode: '1210', credit: 20 }] },
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  const sync = result.success && result.accountingSyncs.find((entry) => entry.type === 'UNEARNED_REV_REVERSAL')
  assert.ok(sync, 'the allocation residue still produces a reversal journal')
  const payload = sync.payload as { reference?: string; narration?: string; lines?: Array<{ accountCode?: string; debit?: number }> }
  assert.equal(findAllocatedInventoryCredit(result), 10, 'the one unshipped allocated unit')
  assert.equal(
    payload.lines?.some((line) => line.accountCode === accountingSettings.unearnedRevenueAccount),
    false,
    'nothing is left in the unearned account to reverse',
  )
  assert.equal(payload.reference, 'Allocation reversal: SO-1')
  assert.equal(payload.narration, 'Allocation reversal — refund on order SO-1')
})

// ---------------------------------------------------------------------------
// o3d-o97 r2 — the residue is arithmetic on RECORDS, not a value re-derived from
// current state.
//
// Every test below asserts the FIGURE on the Allocated Inventory credit of the journal
// the REAL refund path produces. A plan-level or presence-level check cannot see any of
// these defects: in each one a reversal is posted either way, for the wrong number of
// pounds.
// ---------------------------------------------------------------------------

/** An A2-staged, unshipped order of 4 units whose A2 posting was £40 (4 × £10). */
function a2StagedFourUnitState(): State {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-deadbeef',
      // A2 posted DR Allocated Inventory £40 for this order, and recorded it here in the
      // same UPDATE as the stamp above.
      allocationBatchAmount: 40,
    }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 4, totalBase: 100 }],
    allocations: [{
      id: 'alloc-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      qty: 4,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 4, unitCostBase: 10 }],
      // o3d-o97 r4: and the row's share of that debit, £40 over 4 units, which A2 writes in the
      // same transaction. A row without it is one the rebalancer re-pinned after A2 stamped the
      // order, and its units now reverse ZERO instead of being valued at the current layer cost —
      // see the clamp test, which deletes this deliberately.
      allocationBatchAmount: 40,
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 4, unitCostBase: 10 }],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  return state
}

/** A prior refund of 1 unit that CLAIMED £10 of allocated cost in its cost-layer snapshot. */
function seedPriorAllocationRefund(state: State) {
  state.refunds.push({
    id: 'refund-prior',
    orderId: 'order-1',
    creditNoteNumber: 'CN-000001',
    externalRefundId: null,
    reason: 'Earlier partial refund',
    totalForeign: 25,
    totalBase: 25,
    returnWarehouseId: null,
    totalsBasis: 'NET',
    accountingRetryRequired: false,
  })
  state.refundLines.push({
    id: 'refund-prior-line-1',
    refundId: 'refund-prior',
    salesOrderLineId: 'line-1',
    productId: 'product-1',
    description: 'Product 1',
    qty: 1,
    unitPriceForeign: 25,
    unitPriceBase: 25,
    totalForeign: 25,
    totalBase: 25,
    costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 1, unitCostBase: 10, orderAllocationId: 'alloc-1', source: 'allocation' }],
  })
}

test('a full refund does not treat a prior refund SNAPSHOT as a posted reversal (o3d-o97 r2, r5)', async () => {
  // The prior refund wrote its cost-layer snapshot — that write is unconditional and happens
  // before any journal decision — so reading the snapshot as relief credited £30 and left £10 of a
  // real debit stranded for ever, because refundStatus=FULL removes the order from both windows.
  //
  // o3d-o97 r5 — AND THE OTHER HALF OF THE ANSWER MOVED. r2 through r4 read the prior reversal's
  // CANCELLED status as proof it never posted and reversed the whole £40. CANCELLED does not prove
  // that: it is written by the cross-connector orphan sweep, by an order cancellation and by
  // operators, and a claimed row is retired without anyone knowing whether the remote call had
  // already landed (the processors post BEFORE persisting SYNCED). If those £10 DID reach the
  // ledger, reversing £40 credits Allocated Inventory £10 it never held.
  //
  // So neither £40 nor £30: the refund reverses NOTHING and records why, on a row that outlives
  // every stamp on the order.
  const state = a2StagedFourUnitState()
  seedPriorAllocationRefund(state)
  state.accountingSyncLogs = [{
    connector: 'xero',
    type: 'UNEARNED_REV_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-prior',
    status: 'CANCELLED',
    payload: { lines: [{ accountCode: '1200', debit: 10 }, { accountCode: '1210', credit: 10 }] },
  }]

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 75, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(
    findAllocatedInventoryCredit(result),
    null,
    'not £30 (the snapshot is not a posting) and not £40 either (CANCELLED is not proof of one)',
  )
  assert.equal(findInventoryReversalDebit(result), null)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the A2 stamp survives so the order stays reportable')
  assert.match(
    String(state.refunds.find((refund) => refund.id !== 'refund-prior')!.allocationBasisUnresolved),
    /is CANCELLED, not SYNCED/,
  )
})

test('a full refund DOES net a prior refund reversal that actually posted (o3d-o97 r2)', async () => {
  // The mirror of the test above, and the one the hardcoded `accountingSyncLog.findMany: () => []`
  // double made impossible to write: same snapshot, same units, but this time the prior refund's
  // journal is live, so £10 of the £40 is already out of Allocated Inventory and only £30 is owed.
  const state = a2StagedFourUnitState()
  seedPriorAllocationRefund(state)
  state.accountingSyncLogs = [{
    connector: 'xero',
    type: 'UNEARNED_REV_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-prior',
    status: 'SYNCED',
    payload: { lines: [{ accountCode: '1200', debit: 10 }, { accountCode: '1210', credit: 10 }] },
  }]

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 75, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 30, 'the £40 posted less the £10 already reversed')
})

test('a partial refund then a full one credit the A2 debit exactly once, end to end (o3d-o97 r2)', async () => {
  // Both refunds go through the real service. The first one's journal is queued into the sync log
  // between them, exactly as queueRefundAccountingActions does in production, so the second refund
  // reads it as the record of what was posted rather than re-deriving it.
  const state = a2StagedFourUnitState()
  const client = createClient(state)

  const partial = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 25 }],
    reason: 'One unit back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })
  assert.equal(partial.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(partial), 10, 'the one unit its line consumed')

  // Queue what the first refund staged, as the accounting-sync queue does — and POST it, as the
  // outbox does. o3d-o97 r4: SYNCED, not PENDING. A queued reversal is not relief; leaving it
  // PENDING is the case the test immediately below this one pins, where the second refund refuses
  // rather than netting pounds that have not moved.
  for (const sync of partial.success ? partial.accountingSyncs : []) {
    state.accountingSyncLogs?.push({
      connector: 'xero',
      type: sync.type,
      referenceType: sync.referenceType,
      referenceId: sync.referenceId,
      status: 'SYNCED',
      payload: sync.payload,
    })
  }

  const full = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 75, lineKind: 'sale' }],
    reason: 'Goodwill remainder',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(full.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(full), 30, 'the remainder of the £40, not the whole £40 again')
  assert.equal(
    (findAllocatedInventoryCredit(partial) ?? 0) + (findAllocatedInventoryCredit(full) ?? 0),
    40,
    'the two refunds together credit Allocated Inventory exactly what A2 debited it',
  )
})

test('the residue is the RECORDED A2 debit, not the pins revalued since it posted (o3d-o97 r2)', async () => {
  // A2 debited Allocated Inventory £30 for three units at £10. A landed-cost correction then
  // rewrote layer-1 to £4 and, with it, the allocation snapshot pinned to it
  // (updateSnapshotsForCostLayerChange) — while posting to COGS/Inventory and never to Allocated
  // Inventory. Re-deriving the residue from those pins credited £12 against a £30 debit and left
  // £18 stranded; had the layer been corrected upwards it would have moved pounds that were never
  // in the account at all.
  const state = a2StagedFourUnitState()
  state.orders[0].allocationBatchAmount = 30
  state.lines[0].qty = 3
  state.allocations[0].qty = 3
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 4 }]
  state.costLayers[0].unitCostBase = 4

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 30, 'what A2 posted, not what the layers cost now')
})

test("Group B's relief is the dispatch COGS it POSTED, not the revalued shipment cost (o3d-o97 r2)", async () => {
  // A2 posted £30 for three allocated units. Two of them dispatched and Group B credited Allocated
  // Inventory the £20 it debited to COGS. A later landed-cost correction dropped layer-1 to £4,
  // rewriting the shipment snapshot, Shipment.cogsBatchAmount AND the allocation pin in place — but
  // a revaluation posts to COGS/Inventory, never to Allocated Inventory, so £10 is still owed there.
  //
  // Re-deriving from the pins credited £4 (one unit at today's cost). Valuing Group B's relief from
  // the mutable snapshot/cogsBatchAmount instead of the immutable dispatch CogsEntry rows would
  // credit £22 (£30 − £8) — over-reversing by £12.
  const state = a2StagedFourUnitState()
  state.orders[0].status = 'SHIPPED'
  state.orders[0].allocationBatchAmount = 30
  state.lines[0].qty = 3
  state.allocations[0].qty = 3
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 4 }]
  state.costLayers[0].unitCostBase = 4
  state.shipments = [{
    id: 'shipment-1',
    orderId: 'order-1',
    status: 'SHIPPED',
    shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
    revenueRecognizedAmount: 100,
    // Revaluation rewrote both of these to the current £4/unit.
    cogsBatchAmount: 8,
    lines: [{
      id: 'shipment-line-1',
      lineId: 'line-1',
      productId: 'product-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 4, orderAllocationId: 'alloc-1', source: 'shipment' }],
    }],
  }]
  // The immutable record of what dispatch actually posted: £10/unit.
  state.movements.push({
    id: 'dispatch-movement-1',
    productId: 'product-1',
    qty: 2,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    idempotencyKey: 'SALE_DISPATCH:shipmentLine:shipment-line-1',
  })
  state.cogsEntries.push({
    movementId: 'dispatch-movement-1',
    costLayerId: 'layer-1',
    qty: 2,
    unitCostBase: 10,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 10, '£30 posted less the £20 Group B actually credited')
})

test('an A2 STAMP with no recorded amount reverses nothing AND KEEPS THE REMEDY (o3d-o97 r3)', async () => {
  // The stamp says the order went through the A2 window; it does not say what A2 posted, and on a
  // row staged before allocationBatchAmount existed there is nothing that does. Guessing the figure
  // from the pins credited £20 to Allocated Inventory on no evidence — and a reversal posted wrongly
  // is as bad as the original.
  //
  // r2 refused here and named the remedy as `sales_order_inventory_allocation_missing_amount`,
  // which reports every STAMPED order with no allocation amount — and then nulled
  // inventoryAllocatedDate three statements later, so the invariant's `hasA2` went false and the
  // order was never reported again. THE REFUSAL DESTROYED ITS OWN REMEDY. The stamp now survives a
  // refusal, and the reason is recorded on the refund row, which outlives every stamp on the order.
  const state = a2StagedAllocatedState()
  state.orders[0].allocationBatchAmount = null

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'no Allocated Inventory credit line at all')
  // The A1 half is still un-staged: its deferral reversal is amount-driven and did run.
  assert.equal(state.orders[0].revenueDeferredDate, null, 'the A1 stamp still goes')
  // The A2 half is NOT, because nothing accounted for its debit.
  assert.notEqual(
    state.orders[0].inventoryAllocatedDate,
    null,
    'the A2 stamp survives the refusal, so sales_order_inventory_allocation_missing_amount keeps reporting the order',
  )
  assert.equal(state.orders[0].inventoryAllocatedBatchRef, 'A2-2026-01-01-deadbeef', 'and its batch ref stays paired with it')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /A2 stamp with no recorded allocation amount/,
    'and the refund itself records why it reversed nothing',
  )
})

test('an order A2 valued at ZERO reverses nothing, stamp and pins notwithstanding (o3d-o97 r2)', async () => {
  // A2 stamps every order in its window, including ones it values at nothing — for which no journal
  // line naming this order exists at all. The pins here were written after that stamp, so reading
  // the stamp as evidence credited £20 to an account that was never debited for this order.
  const state = a2StagedAllocatedState()
  state.orders[0].allocationBatchAmount = 0

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 100, lineKind: 'sale' }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'nothing was posted, so nothing is reversed')
})

test('createSalesOrderRefund fallback stock return excludes the current refund from prior returns', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-main',
      qty: 2,
      costLayerSnapshot: [],
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 2, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 100 }],
    reason: 'Full return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].qty, 2)
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.movements[0].idempotencyKey, 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns')
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('createSalesOrderRefund rejects restocking a refund line with no shipped source stock', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50 },
    ],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-2',
      productId: 'product-2',
      warehouseId: 'warehouse-main',
      qty: 1,
      costLayerSnapshot: [],
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [{ id: 'shipment-line-1', lineId: 'line-1', qty: 1, costLayerSnapshot: [] }],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-2', productId: 'product-2', description: 'Product 2', qty: 1, totalBase: 50 }],
    reason: 'Refund unshipped allocation',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot restock product product-2 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.refundLines.length, 0)
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
})

test('createSalesOrderRefund unwraps transaction-wrapped return source errors', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 100 }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [],
    }],
    wrapTransactionErrors: true,
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 100 }],
    reason: 'Refund unshipped line',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.deepEqual(result, {
    success: false,
    error: 'Cannot restock product product-1 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  })
  assert.equal(state.refunds.length, 0)
  assert.equal(state.refundLines.length, 0)
})

test('createSalesOrderRefund keeps same-product refund lines as distinct inbound movements', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: null,
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    }],
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1 A', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-1', description: 'Product 1 B', qty: 1, totalBase: 50 },
    ],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: null,
      revenueRecognizedAmount: null,
      cogsBatchAmount: null,
      lines: [
        { id: 'shipment-line-1', lineId: 'line-1', qty: 1, costLayerSnapshot: [] },
        { id: 'shipment-line-2', lineId: 'line-2', qty: 1, costLayerSnapshot: [] },
      ],
    }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [
      { lineId: 'line-1', productId: 'product-1', description: 'Product 1 A', qty: 1, totalBase: 50 },
      { lineId: 'line-2', productId: 'product-1', description: 'Product 1 B', qty: 1, totalBase: 50 },
    ],
    reason: 'Return both same-SKU lines',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
  })

  assert.equal(result.success, true)
  assert.deepEqual(
    state.movements.map((movement) => movement.idempotencyKey),
    [
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      'RETURN_INBOUND:refund:refund-1:line:refund-line-2:warehouse:warehouse-returns',
    ],
  )
  assert.equal(state.stockLevels[0].quantity, 2)
})

test('applyReturnInboundStockTx scopes refund movement idempotency to the return warehouse', async () => {
  const state = baseState()

  await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-a',
    rows: [{ productId: 'product-1', qty: 1, refundLineId: 'refund-line-1' }],
    note: 'Refund return',
  })
  await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-b',
    rows: [{ productId: 'product-1', qty: 1, refundLineId: 'refund-line-1' }],
    note: 'Refund return',
  })

  assert.deepEqual(
    state.movements.map((movement) => movement.idempotencyKey),
    [
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-a',
      'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-b',
    ],
  )
  assert.deepEqual(state.stockLevels.map((stockLevel) => ({
    productId: stockLevel.productId,
    warehouseId: stockLevel.warehouseId,
    quantity: stockLevel.quantity,
  })), [
    { productId: 'product-1', warehouseId: 'warehouse-a', quantity: 1 },
    { productId: 'product-1', warehouseId: 'warehouse-b', quantity: 1 },
  ])
})

test('applyReturnInboundStockTx does not create return cost layers on movement idempotency conflict', async () => {
  const state = baseState({
    movements: [{
      productId: 'product-1',
      qty: 1,
      referenceType: 'SalesOrderRefund',
      referenceId: 'other-refund',
      idempotencyKey: 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      toWarehouseId: 'warehouse-returns',
    }],
  })

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
      unitCostBase: 10,
      poLineId: 'po-line-1',
      sourceCostLayerId: 'source-layer-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
  assert.equal(state.activityLogs.length, 1)
  assert.deepEqual(state.activityLogs[0], {
    entityType: 'SALES_ORDER',
    entityId: 'refund-1',
    action: 'refund_return_deduped',
    tag: 'sales',
    level: 'INFO',
    description: 'Skipped duplicate refund return for product product-1',
    metadata: {
      idempotencyKey: 'RETURN_INBOUND:refund:refund-1:line:refund-line-1:warehouse:warehouse-returns',
      productId: 'product-1',
      refundLineId: 'refund-line-1',
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
    },
  })
})

test('applyReturnInboundStockTx bubbles stock-level unique conflicts after movement creation', async () => {
  const state = baseState({ failStockLevelUnique: true })

  await assert.rejects(
    () => applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
      referenceType: 'SalesOrderRefund',
      referenceId: 'refund-1',
      warehouseId: 'warehouse-returns',
      rows: [{
        productId: 'product-1',
        qty: 1,
        refundLineId: 'refund-line-1',
        unitCostBase: 10,
        poLineId: 'po-line-1',
      }],
      note: 'Refund return',
    }),
    /Unique constraint failed/,
  )

  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
  assert.equal(state.activityLogs.length, 0)
})

test('applyReturnInboundStockTx creates movement stock and cost layers on non-conflicting rows', async () => {
  const state = baseState()

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
      unitCostBase: 10,
      poLineId: 'po-line-1',
      sourceCostLayerId: 'source-layer-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.costLayers.length, 1)
  assert.equal(state.costLayers[0].unitCostBase, '10.000000')
})

test('applyReturnInboundStockTx allows return rows without cost layer inputs', async () => {
  const state = baseState()

  const result = await applyReturnInboundStockTx(createClient(state) as Prisma.TransactionClient, {
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    warehouseId: 'warehouse-returns',
    rows: [{
      productId: 'product-1',
      qty: 1,
      refundLineId: 'refund-line-1',
    }],
    note: 'Refund return',
  })

  assert.deepEqual(result, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.costLayers.length, 0)
})


// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r8 #4): THE ACCOUNTING RETRY IS A ROUTE INTO A CREDIT NOTE OF ITS OWN.
//
// Every other entry point funnels through createSalesOrderRefund and is fenced inside the transaction
// that resolves the identity. This one re-queues (or re-stages) a credit note for a refund that
// already exists, using the identity snapshotted on each line at creation — which fixes WHICH code
// posts and nothing at all about what that code is WORTH. An admin editing the rate mapped to it
// between the failure and the retry turns a valid £12.00 credit into a £10.50 one, and the retry
// reports success.
// ---------------------------------------------------------------------------------------------

/**
 * A refund of the whole of a £10.00 line that bore £2.00 of VAT, snapshotted at creation under
 * OUTPUT2. `outputRate` is what an admin has since made that code worth.
 */
function retryFenceState(outputRate: number, persistedSyncs?: unknown) {
  const base = baseState()
  return baseState({
    orders: [{
      ...base.orders[0],
      status: 'REFUNDED',
      refundStatus: 'FULL',
      totalBase: 12,
      taxBase: 2,
      taxRateName: 'Standard',
      currency: 'GBP',
      taxForeign: 2,
      shippingForeign: 0,
      revenueDeferredDate: new Date('2026-01-01'),
      unearnedRevenueAmount: 12,
    }],
    lines: [{
      id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Widget',
      qty: 1, totalBase: 10, totalForeign: 10, taxForeign: 2,
      taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    }],
    refunds: [{
      id: 'refund-1', orderId: 'order-1', creditNoteNumber: 'CN-2026-00001', externalRefundId: null,
      reason: 'Customer return', totalForeign: 10, totalBase: 10, returnWarehouseId: null,
      accountingRetryRequired: true, accountingWarning: 'Previous accounting queueing failed',
      accountingRetrySyncs: persistedSyncs ?? null,
    }],
    refundLines: [{
      id: 'refund-line-1', refundId: 'refund-1', salesOrderLineId: 'line-1', productId: 'product-1',
      description: 'Widget', qty: 1, unitPriceForeign: 10, unitPriceBase: 10,
      totalForeign: 10, totalBase: 10,
      // The identity resolved AT CREATION, when OUTPUT2 was worth the 20% the line was sold at.
      accountingTaxType: 'OUTPUT2', reverseCharge: false, lineKind: 'sale',
    }],
    taxRates: [{ name: 'Standard', accountingTaxType: 'OUTPUT2', rate: outputRate, active: true, usedFor: 'SALES' }],
  })
}

const CREDIT_NOTE_SYNC = [{
  type: 'CREDIT_NOTE' as const,
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-1',
  idempotencyKey: 'sales-order-refund:refund-1:credit-note',
  payload: { lineAmountsIncludeTax: false, lines: [{ unitAmount: 10, taxType: 'OUTPUT2' }] },
}]

test('an accounting retry re-prices the snapshotted identity and refuses a moved rate (o3d-w00 Codex r8 #4)', async () => {
  // Unchanged configuration: the retry re-stages exactly as before.
  const unchanged = await retrySalesOrderRefundAccounting(createClient(retryFenceState(0.2)), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(unchanged.success, true)

  // OUTPUT2 edited to 5% since the refund was created. The snapshot still says OUTPUT2, so nothing
  // about the refund has moved — but the credit note it re-stages would now come to £10.50 against the
  // £12.00 the customer's money says this line is worth.
  const state = retryFenceState(0.05)
  const moved = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(moved.success, false)
  const error = moved.success === false ? moved.error : ''
  assert.match(error, /This refund is recorded, but its credit note has NOT been raised/)
  assert.match(error, /returned 12\.00 of the customer's money/)
  assert.match(error, /credit note would come to 10\.50/)
  assert.match(error, /stays on the accounting retry list/)
  assert.equal(state.refunds[0].accountingRetryRequired, true, 'and stays visible for an operator')
})

test('an accounting retry that REPLAYS a persisted credit note is fenced too (o3d-w00 Codex r8 #4)', async () => {
  // The shortcut path: the credit note was already staged and is simply re-queued. It carries the same
  // stale identity, so it needs the same re-pricing — replaying a payload is not evidence that the
  // payload is still right.
  const replayed = await retrySalesOrderRefundAccounting(createClient(retryFenceState(0.05, CREDIT_NOTE_SYNC)), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(replayed.success, false)
  assert.match(replayed.success === false ? replayed.error : '', /credit note would come to 10\.50/)

  // A retry that re-queues no credit note carries no tax identity to be wrong about, and is not held up.
  const cogsOnly = [{
    type: 'COGS_REVERSAL' as const,
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
    payload: { date: '2026-01-03', reference: 'COGS reversal: SO-1', lines: [] },
  }]
  const unaffected = await retrySalesOrderRefundAccounting(createClient(retryFenceState(0.05, cogsOnly)), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(unaffected.success, true)
})

test('an accounting retry refuses a snapshotted code IMS can no longer price (o3d-w00 Codex r8 #4)', async () => {
  // The code was mapped when the refund was created and is not mapped now. An unmapped code is not a 0%
  // one — it is a code IMS cannot say the value of — and that is as true on the retry as at creation.
  const state = retryFenceState(0.2)
  state.taxRates = [{ name: 'Standard', accountingTaxType: 'SOMETHINGELSE', rate: 0.2, active: true, usedFor: 'SALES' }]
  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /which no IMS tax rate is mapped to/)
})

test('an accounting retry with no credit note being posted is not fenced (o3d-w00 Codex r8 #4/#6)', async () => {
  // Same gate as creation: with no credit note going to the ledger there is no total to be wrong about.
  const result = await retrySalesOrderRefundAccounting(createClient(retryFenceState(0.05)), {
    refundId: 'refund-1',
    accountingSettings,
  })
  assert.equal(result.success, true)
})

/**
 * o3d-w00 (Codex r9 #2): the SAME chargeback as the r8 #5 writer tests, already recorded, with only
 * its credit note outstanding.
 *
 * The persisted refund lines are derived from `buildChargebackRefundLines` rather than written out by
 * hand, for the reason r8 #5 recorded: a hand-written chargeback fixture drops the discount leg the
 * builder actually emits, and then tests a shape that never reaches either fence. The stored
 * `accountingTaxType` is what the writer snapshotted — the goods under their own code, shipping and
 * the mirrored discount under the ORDER DEFAULT, which is the identity the invoice posted them under.
 */
function retryChargebackState(orderDefaultRate: number, overrides: Record<string, unknown> = {}) {
  const state = chargebackState(orderDefaultRate, {
    status: 'REFUNDED',
    refundStatus: 'FULL',
    discountAmount: 4,
    // £20.00 of line VAT plus the £1.20 the order records over and above its lines (£2.00 of shipping
    // VAT less £0.80 on the order discount) — the figure the combined leg is checked against.
    taxForeign: 21.2,
    taxBase: 21.2,
    revenueDeferredDate: new Date('2026-01-01'),
    unearnedRevenueAmount: 106,
    ...overrides,
  } as Parameters<typeof chargebackState>[1])
  state.refunds = [{
    id: 'refund-1', orderId: 'order-1', creditNoteNumber: 'CN-2026-00001', externalRefundId: null,
    reason: 'Payment reversed (chargeback)', totalForeign: 106, totalBase: 106, returnWarehouseId: null,
    chargeback: true,
    accountingRetryRequired: true, accountingWarning: 'Previous accounting queueing failed',
    accountingRetrySyncs: null,
  }]
  state.refundLines = chargebackLines(4).map((refundLine, index) => ({
    id: `refund-line-${index + 1}`,
    refundId: 'refund-1',
    salesOrderLineId: refundLine.lineId ?? null,
    productId: refundLine.productId ?? null,
    description: refundLine.description,
    qty: refundLine.qty,
    unitPriceForeign: refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : 0,
    unitPriceBase: refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : 0,
    totalForeign: refundLine.totalBase,
    totalBase: refundLine.totalBase,
    lineKind: refundLine.lineKind,
    // Shipping and the mirrored discount posted under the ORDER default; the goods under their own.
    accountingTaxType: refundLine.lineKind === 'sale' ? 'OUTPUTGOODS' : 'OUTPUT2',
    reverseCharge: false,
  }))
  return state
}

test("an accounting retry checks the chargeback's shipping and discount legs TOGETHER (o3d-w00 Codex r9 #2)", async () => {
  // r8 added the combined leg at the WRITER (#5) and fenced the retry (#4) — separately, so the route
  // that posts a credit note WITHOUT creating a refund never asked the one question neither leg can be
  // asked alone. The credit note is per-refund and attached to POSTING, not to creation, so a rate
  // edit between the failure and the retry has to be caught on this route too.
  //
  // Sanity first: the shipping leg CANNOT carry this on its own here. Its VAT is the order total's
  // residue over its lines, which on a createSalesOrder order carrying a discount is
  // `shipping VAT − discount VAT` — two figures IMS cannot separate — so the per-leg check declines to
  // derive anything and passes. Only the pair is checkable.
  const unchanged = await retrySalesOrderRefundAccounting(createClient(retryChargebackState(0.2)), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(unchanged.success, true, 'an unchanged tax configuration re-stages symmetrically')

  // OUTPUT2 edited 20% → 5% since the chargeback was recorded. The pair posts 10.00 − 4.00 = 6.00 net
  // under it, which now unwinds 6.30 against the 7.20 the invoice charged for the same pair.
  const state = retryChargebackState(0.05)
  const moved = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(moved.success, false)
  const error = moved.success === false ? moved.error : ''
  assert.match(error, /This refund is recorded, but its credit note has NOT been raised/)
  assert.match(error, /reversed shipping and order discount together/)
  assert.match(error, /returned 7\.20 of the customer's money/)
  assert.match(error, /credit note would come to 6\.30/)
  assert.equal(state.refunds[0].accountingRetryRequired, true, 'and stays visible for an operator')

  // Same scoping as the writer's, and for the same reason: where the order total is the plain SUM of
  // its components (a WooCommerce import) the discount's VAT was never in it, the residue is
  // shipping's VAT alone, and the shipping leg is checked on its own instead.
  const woo = await retrySalesOrderRefundAccounting(
    createClient(retryChargebackState(0.05, { shoppingConnectors: ['woocommerce'], taxForeign: 22, taxBase: 22 })),
    { refundId: 'refund-1', accountingSettings, creditNotePostingEnabled: true },
  )
  assert.equal(woo.success, false)
  const wooError = woo.success === false ? woo.error : ''
  assert.match(wooError, /The refunded shipping returned 12\.00 of the customer's money/)
  assert.doesNotMatch(wooError, /together/)

  // And an ordinary (non-chargeback) refund is not combined at all: it credits some arbitrary part of
  // shipping and of the discount, so their combined net is not the amount that residue is the VAT of.
  const ordinary = retryChargebackState(0.05)
  ordinary.refunds[0].chargeback = false
  const ordinaryResult = await retrySalesOrderRefundAccounting(createClient(ordinary), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(ordinaryResult.success, true, 'nothing checkable, so nothing refused')
})

test('a line credits nothing only when BOTH its columns are nothing (o3d-w00 Codex r9 #3)', async () => {
  // r8 #2 stopped the fence pricing the tax code of a line nobody is crediting, so a quarantine's
  // remedy could carry a park's returned UNITS through on a fully-discounted line. It tested ONE of
  // the two money columns a refund line carries, and they are written independently.
  //
  // ZERO BASE, MONEY IN FOREIGN. The line credits the customer in the order's currency, so its
  // identity has to be priced like any other. (This direction already held — netForeignOf reads the
  // foreign column first — and is kept as the regression guard for it.)
  const foreignOnly = fallsBackToOrderDefaultState(2)
  foreignOnly.taxRates = []
  const foreignOnlyResult = await createSalesOrderRefund(createClient(foreignOnly), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, qty: 1, totalForeign: 10, totalBase: 0 }],
    reason: 'Customer return',
    externalRefundId: 8907,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(foreignOnlyResult.success, false, 'a foreign-currency credit is a credit')
  assert.match(
    foreignOnlyResult.success === false ? foreignOnlyResult.error : '',
    /Widget has no accounting tax code/,
    'and it is refused BECAUSE its identity could not be priced, not for some unrelated reason',
  )

  // ZERO FOREIGN, MONEY IN BASE. The mirror image, and the one that was open: the foreign column is
  // `Decimal @default(0)`, so a caller that states only base money — or a legacy row — reaches the
  // fence with a real amount and a zero foreign figure, and was skipped as crediting nothing.
  const baseOnly = fallsBackToOrderDefaultState(2)
  baseOnly.taxRates = []
  const baseOnlyResult = await createSalesOrderRefund(createClient(baseOnly), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, qty: 1, totalForeign: 0, totalBase: 10 }],
    reason: 'Customer return',
    externalRefundId: 8908,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(baseOnlyResult.success, false, 'a base-currency credit is a credit too')
  assert.match(
    baseOnlyResult.success === false ? baseOnlyResult.error : '',
    /Widget has no accounting tax code/,
    'the same refusal, for the same reason — the skip must not read one column and call it the line',
  )

  // And a line that really does credit nothing is still waved through, so r8 #2's remedy still works.
  const nothing = fallsBackToOrderDefaultState(2)
  nothing.taxRates = []
  const nothingResult = await createSalesOrderRefund(createClient(nothing), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, qty: 1, totalForeign: 0, totalBase: 0 }],
    reason: 'Returned, credited on an earlier refund',
    externalRefundId: 8909,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(nothingResult.success, true, 'the units come back; no credit-note total exists to be wrong about')
})

test('the accounting retry reads BOTH money columns before skipping a line (o3d-w00 Codex r9 #3)', async () => {
  // The same asymmetry on the posting route that never creates anything. SalesOrderRefundLine
  // .totalForeign defaults to 0, so a legacy row carries its whole credit in totalBase — and the retry
  // re-stages that credit note while skipping the line entirely, unpriced, whatever the tax table now
  // says about the code it posts under.
  const state = retryFenceState(0.05)
  state.refundLines[0] = { ...state.refundLines[0], totalForeign: 0, totalBase: 10 }
  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(result.success, false)
  assert.match(result.success === false ? result.error : '', /credit note would come to 10\.50/)

  // A row with nothing in EITHER column credits nothing and is still left alone.
  const empty = retryFenceState(0.05)
  empty.refundLines[0] = { ...empty.refundLines[0], totalForeign: 0, totalBase: 0 }
  const emptyResult = await retrySalesOrderRefundAccounting(createClient(empty), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })
  assert.equal(emptyResult.success, true)
})


test('an accounting retry reads the PERSISTED line kind, not productId (o3d-w00 #4)', async () => {
  // The retry built its replay lines with `line.productId ? 'sale' : 'shipping'` — the historical
  // inference reconstructReplayLine was written to replace, still open on this path. A monetary-only
  // refund line (no product, positive amount) is a SALE line, and reconstructing it as shipping posts
  // the revenue reversal to the shipping account on retry but not on the first attempt. Visible here
  // through the fence, which prices a sale line against the order's GOODS and a shipping line against
  // the shipping residue, and names the target it refused.
  const state = retryFenceState(0.05)
  state.orders[0].shippingForeign = 10
  state.orders[0].taxForeign = 4
  state.refundLines[0] = {
    ...state.refundLines[0],
    salesOrderLineId: null,
    productId: null,
    description: 'Goodwill refund',
    qty: 0,
    lineKind: 'sale',
  }
  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, false)
  const error = result.success === false ? result.error : ''
  assert.match(error, /Goodwill refund returned/, 'reconstructed as the SALE line it was created as')
  assert.doesNotMatch(error, /The refunded shipping/)
})

test('a refund line that credits NOTHING is not fenced on its tax code (o3d-w00 Codex r8 #2)', async () => {
  // The hand-recording path now carries a quarantined park's returned UNITS through on lines the
  // operator credited no money against, so the writer sees qty > 0 with a zero amount. Zero cannot be
  // re-grossed into a wrong total, and pricing its identity would refuse the whole refund over a tax
  // code no money is posting under — turning the fix for the silent write-off into a new dead end.
  const state = fallsBackToOrderDefaultState(2)
  // The order default no longer resolves at all, so any line priced through it is refused.
  state.taxRates = []
  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND, qty: 1, totalForeign: 0, totalBase: 0 }],
    reason: 'Returned, credited on an earlier refund',
    externalRefundId: 8905,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })

  assert.equal(result.success, true, 'the units come back; no credit-note total exists to be wrong about')

  // The same line carrying money IS refused, so the skip is scoped to "credits nothing", not to the line.
  const withMoney = await createSalesOrderRefund(createClient(fallsBackToOrderDefaultState(2)), {
    orderId: 'order-1',
    lines: [{ ...ITEMISED_SALE_REFUND }],
    reason: 'Customer return',
    externalRefundId: 8906,
    creditNotePrefix: 'CN-',
    activeAccountingConnector: 'xero',
    creditNotePostingEnabled: true,
  })
  assert.equal(withMoney.success, true, 'control: the same line prices fine when its code resolves')
})

test('retrySalesOrderRefundAccounting replays persisted syncs after full refund clears deferral dates', async () => {
  const persistedSyncs = [{
    type: 'COGS_REVERSAL' as const,
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-1',
    idempotencyKey: 'sales-order-refund:refund-1:cogs-reversal',
    payload: {
      date: '2026-01-03',
      reference: 'COGS reversal: SO-1',
      lines: [
        { accountCode: '1200', description: 'COGS reversal: SO-1', debit: 20 },
        { accountCode: '5000', description: 'COGS reversal: SO-1', credit: 20 },
      ],
    },
  }]
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: null,
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: null,
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Full return',
      totalForeign: 100,
      totalBase: 100,
      returnWarehouseId: null,
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting queueing failed',
      accountingRetrySyncs: persistedSyncs,
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 100,
      totalBase: 100,
    }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(result.success ? result.accountingSyncs : [], persistedSyncs)
  assert.equal(state.movements.length, 0)
})

test('applyReturnInboundStockTx returns existing movement rows without duplicating stock', async () => {
  const state = baseState({
    movements: [{
      productId: 'product-1',
      qty: 1,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      toWarehouseId: 'warehouse-returns',
    }],
  })

  const rows = await applyReturnInboundStockTx(createClient(state) as Parameters<typeof applyReturnInboundStockTx>[0], {
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    warehouseId: 'warehouse-returns',
    rows: [{ productId: 'product-1', qty: 1, unitCostBase: 10 }],
    note: 'Refund return',
  })

  assert.deepEqual(rows, [{ productId: 'product-1', sku: 'PRODUCT-1', qty: 1 }])
  assert.equal(state.movements.length, 1)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.costLayers.length, 0)
})

test('retrySalesOrderRefundAccounting stages accounting and return stock for an existing refund', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(result.success && result.accountingSyncs[0].type, 'COGS_REVERSAL')
  assert.equal(
    result.success && result.accountingSyncs[0].idempotencyKey,
    'sales-order-refund:refund-1:cogs-reversal',
  )
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '1.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }])
  assert.equal(state.movements[0].productId, 'product-1')
  assert.equal(state.movements[0].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[0].referenceId, 'refund-1')
  assert.equal(state.stockLevels[0].quantity, 1)
  assert.equal(state.executeRawCalls, 1)
})

test('retrySalesOrderRefundAccounting does not restock allocation-only refund rows', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 100,
      totalBase: 100,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'refund-line-1',
      refundId: 'refund-1',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 2,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 100,
      totalBase: 100,
    }],
    allocations: [{
      id: 'allocation-1',
      orderId: 'order-1',
      lineId: 'line-1',
      productId: 'product-1',
      warehouseId: 'warehouse-main',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.equal(result.success, false)
  assert.equal(
    result.success ? '' : result.error,
    'Refund was created, but accounting reversal staging failed: Cannot restock product product-1 for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.',
  )
  assert.equal(state.movements.length, 0)
  assert.equal(state.stockLevels.length, 0)
  assert.equal(state.refunds[0].accountingRetryRequired, true)
})

test('retrySalesOrderRefundAccounting requires a pending accounting failure', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    refunds: [{
      id: 'refund-1',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: false,
      accountingWarning: null,
    }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-1',
    accountingSettings,
  })

  assert.deepEqual(result, {
    success: false,
    error: 'No failed refund accounting action is pending for this refund',
  })
})

test('retrySalesOrderRefundAccounting uses persisted sales line identity and refund-scoped stock returns', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'PARTIALLY_REFUNDED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    lines: [
      { id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
      { id: 'line-2', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 },
    ],
    refunds: [{
      id: 'prior-refund',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00001',
      externalRefundId: null,
      reason: 'Earlier return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: false,
      accountingWarning: null,
    }, {
      id: 'refund-2',
      orderId: 'order-1',
      creditNoteNumber: 'CN-2026-00002',
      externalRefundId: null,
      reason: 'Customer return',
      totalForeign: 50,
      totalBase: 50,
      returnWarehouseId: 'warehouse-returns',
      accountingRetryRequired: true,
      accountingWarning: 'Previous accounting staging failed',
    }],
    refundLines: [{
      id: 'prior-refund-line',
      refundId: 'prior-refund',
      salesOrderLineId: 'line-1',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
      costLayerSnapshot: [{
        costLayerId: 'layer-1',
        qty: 1,
        unitCostBase: 10,
        shipmentLineId: 'shipment-line-1',
        source: 'shipment',
      }],
    }, {
      id: 'refund-line-2',
      refundId: 'refund-2',
      salesOrderLineId: 'line-2',
      productId: 'product-1',
      description: 'Product 1',
      qty: 1,
      unitPriceForeign: 50,
      unitPriceBase: 50,
      totalForeign: 50,
      totalBase: 50,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 25,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 1,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 1, unitCostBase: 10 }],
      }, {
        id: 'shipment-line-2',
        lineId: 'line-2',
        qty: 1,
        costLayerSnapshot: [{ costLayerId: 'layer-2', qty: 1, unitCostBase: 15 }],
      }],
    }],
    costLayers: [
      { id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 1, unitCostBase: 10 },
      { id: 'layer-2', productId: 'product-1', poLineId: 'po-line-2', receivedQty: 1, unitCostBase: 15 },
    ],
    movements: [{ productId: 'product-1', qty: 1, referenceType: 'SalesOrderRefund', referenceId: 'prior-refund' }],
  })

  const result = await retrySalesOrderRefundAccounting(createClient(state), {
    refundId: 'refund-2',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[1].costLayerSnapshot, [{
    costLayerId: 'layer-2',
    qty: '1.000000',
    unitCostBase: '15.000000',
    shipmentLineId: 'shipment-line-2',
    source: 'shipment',
  }])
  assert.equal(state.movements.length, 2)
  assert.equal(state.movements[1].referenceType, 'SalesOrderRefund')
  assert.equal(state.movements[1].referenceId, 'refund-2')
})

// scjz.70 / .42a: full-order chargeback refund-line selection (pure).
test('buildChargebackRefundLines: full order with no prior refunds keeps qty + value exact', () => {
  const lines = buildChargebackRefundLines({
    lines: [
      { lineId: 'l1', productId: 'p1', description: 'Widget', qty: 3, totalBase: 30 },
      { lineId: 'l2', productId: 'p2', description: 'Gadget', qty: 1, totalBase: 12.5 },
    ],
  })
  assert.deepEqual(
    lines.map((l) => ({ lineId: l.lineId, qty: l.qty, totalBase: l.totalBase, lineKind: l.lineKind })),
    [
      { lineId: 'l1', qty: 3, totalBase: 30, lineKind: 'sale' },
      { lineId: 'l2', qty: 1, totalBase: 12.5, lineKind: 'sale' },
    ],
  )
})

test('buildChargebackRefundLines: preserves 4dp totals (no cent-rounding) — Codex P2', () => {
  // Decimal(18,4) totals must survive intact; rounding to 2dp would understate.
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Frac', qty: 1, totalBase: 12.3456 }],
  })
  assert.equal(lines[0]!.totalBase, 12.3456)
})

test('buildChargebackRefundLines: includes remaining shipping as a shipping-kind line — Codex P2', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 10 }],
    shipping: { totalBase: 5.5, priorRefundedBase: 1.5 },
  })
  const ship = lines.find((l) => l.lineKind === 'shipping')
  assert.ok(ship)
  assert.equal(ship.productId, null)
  assert.equal(ship.qty, 0)
  assert.equal(ship.totalBase, 4) // 5.5 − 1.5 remaining
})

test('buildChargebackRefundLines: order discount mirrored as a negative discount line, goods at full value — scjz.71', () => {
  // Goods 100 + shipping 10, a £10 order discount: the invoice posted full goods +
  // a separate −10 discount line, so the chargeback mirrors it (no goods scaling).
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 100 }],
    shipping: { totalBase: 10 },
    discount: { totalBase: 10 },
  })
  const sale = lines.find((l) => l.lineKind === 'sale')!
  const ship = lines.find((l) => l.lineKind === 'shipping')!
  const disc = lines.find((l) => l.lineKind === 'discount')!
  assert.equal(sale.totalBase, 100) // goods at FULL value — not scaled
  assert.equal(ship.totalBase, 10)
  assert.equal(disc.totalBase, -10) // negative discount line, mirrors the invoice
  assert.equal(disc.productId, null)
  assert.equal(disc.qty, 0)
  // Net reversed = goods + shipping − discount = the order's net total.
  assert.equal(sale.totalBase + ship.totalBase + disc.totalBase, 100)
})

test('buildChargebackRefundLines: no discount line emitted when no order discount — scjz.71', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 2, totalBase: 50 }],
    shipping: { totalBase: 5 },
  })
  assert.equal(lines.find((l) => l.lineKind === 'sale')!.totalBase, 50)
  assert.equal(lines.find((l) => l.lineKind === 'shipping')!.totalBase, 5)
  assert.equal(lines.some((l) => l.lineKind === 'discount'), false)
})

test('buildChargebackRefundLines: fully-refunded shipping is dropped', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 10 }],
    shipping: { totalBase: 5, priorRefundedBase: 5 },
  })
  assert.equal(lines.some((l) => l.lineKind === 'shipping'), false)
})

test('buildChargebackRefundLines: prior refunds reduce remaining qty AND remaining value', () => {
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 4, totalBase: 100 }],
    priorRefundedQtyByLineId: { l1: 1 },
    priorRefundedBaseByLineId: { l1: 25 },
  })
  assert.deepEqual(
    lines.map((l) => ({ qty: l.qty, totalBase: l.totalBase })),
    [{ qty: 3, totalBase: 75 }],
  )
})

test('buildChargebackRefundLines: non-proportional prior refund (price-only) reduces value not qty — Codex P2', () => {
  // A £10 price-only adjustment with no quantity: remaining qty unchanged, value − 10.
  const lines = buildChargebackRefundLines({
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Widget', qty: 4, totalBase: 100 }],
    priorRefundedBaseByLineId: { l1: 10 },
  })
  assert.deepEqual(
    lines.map((l) => ({ qty: l.qty, totalBase: l.totalBase })),
    [{ qty: 4, totalBase: 90 }],
  )
})

test('buildChargebackRefundLines: fully-refunded (qty + value) and zero lines are dropped', () => {
  const lines = buildChargebackRefundLines({
    lines: [
      { lineId: 'l1', productId: 'p1', description: 'Done', qty: 2, totalBase: 20 },
      { lineId: 'l2', productId: 'p2', description: 'Zero', qty: 0, totalBase: 0 },
      { lineId: 'l3', productId: 'p3', description: 'Keep', qty: 1, totalBase: 10 },
    ],
    priorRefundedQtyByLineId: { l1: 2 },
    priorRefundedBaseByLineId: { l1: 20 },
  })
  assert.deepEqual(lines.map((l) => l.lineId), ['l3'])
})

// ---------------------------------------------------------------------------
// bcz9.4: COGS-reversal subledger recording at queue time
// ---------------------------------------------------------------------------

test('resolveRefundCogsReversalBase prefers the 6dp structured base over 2dp credit lines', () => {
  const base = resolveRefundCogsReversalBase({
    date: '2026-01-02',
    _cogsReversalBase: 10.123456,
    lines: [
      { accountCode: '630', debit: 10.12 },
      { accountCode: '500', credit: 10.12 },
    ],
  })
  assert.equal(base, 10.123456)
})

test('resolveRefundCogsReversalBase falls back to summed credit lines without a structured base', () => {
  const base = resolveRefundCogsReversalBase({
    date: '2026-01-02',
    lines: [
      { accountCode: '630', debit: 7.5 },
      { accountCode: '500', credit: 7.5 },
    ],
  })
  assert.equal(base, 7.5)
})

test('resolveRefundCogsReversalBase returns null when no positive base is present', () => {
  assert.equal(resolveRefundCogsReversalBase({ date: '2026-01-02', lines: [{ credit: 0 }] }), null)
  assert.equal(resolveRefundCogsReversalBase({ date: '2026-01-02' }), null)
  assert.equal(resolveRefundCogsReversalBase(null), null)
})

function cogsLedgerProbe(): { rows: Array<Record<string, unknown>>; client: RefundServiceClient } {
  const rows: Array<Record<string, unknown>> = []
  const client = {
    cogsSubledgerMovement: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        rows.push(create)
        return create
      },
    },
  } as unknown as RefundServiceClient
  return { rows, client }
}

const cogsReversalSync: RefundAccountingSyncRequest = {
  type: 'COGS_REVERSAL',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-9',
  idempotencyKey: 'sales-order-refund:refund-9:cogs-reversal',
  payload: {
    date: '2026-01-02',
    reference: 'COGS reversal',
    _cogsReversalBase: 10.123456,
    lines: [
      { accountCode: '630', description: 'COGS reversal', debit: 10.12 },
      { accountCode: '500', description: 'COGS reversal', credit: 10.12 },
    ],
  },
}

test('recordRefundCogsReversalFromSync writes the negative 6dp row when the reversal will post', async () => {
  const { rows, client } = cogsLedgerProbe()
  await recordRefundCogsReversalFromSync(client, cogsReversalSync, true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceType, 'REFUND_REVERSAL')
  assert.equal(rows[0].sourceRef, 'refund-9')
  assert.equal(rows[0].idempotencyKey, 'sales-order-refund:refund-9:cogs-reversal')
  assert.equal(Number(rows[0].baseDelta), -10.123456)
})

test('recordRefundCogsReversalFromSync is a no-op when the reversal will not post', async () => {
  const { rows, client } = cogsLedgerProbe()
  await recordRefundCogsReversalFromSync(client, cogsReversalSync, false)
  assert.equal(rows.length, 0)
})

test('recordRefundCogsReversalFromSync ignores non-COGS_REVERSAL syncs', async () => {
  const { rows, client } = cogsLedgerProbe()
  const unearned: RefundAccountingSyncRequest = { ...cogsReversalSync, type: 'UNEARNED_REV_REVERSAL' }
  await recordRefundCogsReversalFromSync(client, unearned, true)
  assert.equal(rows.length, 0)
})

// ---------------------------------------------------------------------------
// o3d-mrwu — a refund/chargeback row is born OWING its accounting.
//
// The refund transaction COMMITS before stageRefundAccountingReversals runs. While
// accountingRetryRequired defaulted to false, a crash in that window left a committed
// row with no queued reversal and nothing marking it unfinished — so the concurrency
// guard read it as a completed reversal and refused the other source, while the poller
// read the false flag as completion and advanced. Both acknowledged; no reversal
// recoverable. The flag now starts true and is cleared ONLY by successful staging.
// ---------------------------------------------------------------------------

test('a refund that owes accounting is created with accountingRetryRequired set (o3d-mrwu)', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  // Capture the flag as it stood when the row was FIRST written, i.e. at the moment the
  // transaction would have committed — before staging gets a chance to clear it.
  let flagAtCreate: unknown
  const client = createClient(state)
  const realCreate = client.salesOrderRefund.create.bind(client.salesOrderRefund)
  client.salesOrderRefund.create = (async (args: { data: Record<string, unknown> }) => {
    flagAtCreate = args.data.accountingRetryRequired
    return realCreate(args as never)
  }) as unknown as typeof client.salesOrderRefund.create

  const result = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  })

  assert.equal(result.success, true)
  assert.equal(
    flagAtCreate,
    true,
    'the row must commit already marked as owing accounting — a crash before staging must be visible',
  )
  assert.equal(
    state.refunds[0]?.accountingRetryRequired,
    false,
    'and staging succeeding is what clears it',
  )
})

test('a crash between commit and staging leaves the reversal recoverable, not silently complete (o3d-mrwu)', async () => {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 20,
    }],
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 100,
      cogsBatchAmount: 20,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 2, unitCostBase: 10 }],
  })

  // Simulate the crash: the refund transaction commits, then the process dies before the
  // post-commit update that records the staged syncs. The row is left exactly as committed.
  const client = createClient(state)
  client.salesOrderRefund.update = (async () => {
    throw new Error('process died before staging was recorded')
  }) as unknown as typeof client.salesOrderRefund.update

  await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 50 }],
    reason: 'Payment reversed (chargeback)',
    creditNotePrefix: 'CN-',
    accountingSettings,
    chargeback: true,
  }).catch(() => { /* the crash itself is not what this test asserts */ })

  assert.equal(state.refunds.length, 1, 'the refund row committed')
  assert.equal(
    state.refunds[0]?.accountingRetryRequired,
    true,
    'it must still be marked as owing accounting — this is what makes the reversal recoverable, '
      + 'and what stops the guard and the poller both reading it as complete',
  )
})

test('o3d-w00/o3d-n8p: a second refund on an order with a LEGACY-basis refund fails closed and quarantines', async () => {
  // The operationally consequential half of the basis marker, pinned explicitly because it
  // changes what happens to real money on real orders.
  //
  // Every refund written before the totals_basis migration has a NULL basis, and a NULL row's
  // stored total may be GROSS. Summing it with a new NET total is not sound: a legacy £60 gross
  // plus a new £60 net passes a 60+60=120 ceiling on a £120 order, yet the new line grosses up to
  // £72 — £132 of credit against £120 of goods. Converting a legacy mixed-rate gross refund back
  // to net is undecidable, so there is no safe automatic reconciliation.
  //
  // Hence: refuse and park for a human. This means an order carrying a pre-migration refund will
  // NOT take a second automated refund — it quarantines instead. That is deliberate, and it is
  // the behaviour someone working the exceptions inbox has to be ready for.
  const state = reversalRaceState()
  state.refunds.push({
    id: 'refund-legacy',
    orderId: 'order-1',
    creditNoteNumber: 'CN-0001',
    externalRefundId: 7001,
    reason: 'WooCommerce refund',
    totalForeign: 10,
    totalBase: 10,
    returnWarehouseId: null,
    chargeback: false,
    // No totalsBasis — exactly what every pre-migration row looks like.
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'WooCommerce refund',
    externalRefundId: 7002,
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, false, 'a legacy-basis order does not take a second automated refund')
  assert.equal(result.success === false && result.quarantine, true, 'and it is parked, not merely failed')
  assert.match(result.success === false ? result.error : '', /legacy\/unknown amount basis/)
  assert.equal(state.refunds.length, 1, 'no second refund was written')
})

// ---------------------------------------------------------------------------
// o3d-kouj — THE COMPONENT FACTORS A REFUND REVERSES COME FROM THE LINE'S PIN.
//
// This is the money end of the snapshot. A refund is expressed in KIT units; the basis it relieves
// was recorded in COMPONENT units — by dispatch onto the shipment line, and by Group A2 onto the
// allocation row — in the units of the recipe the order was ALLOCATED from. Re-deriving the factors
// from the current graph makes the reversal reverse the wrong quantity of the right layers: too
// little and COGS never reconciles against inventory, too much and the take fails closed on
// "only M available across recorded shipments" and strands the refund in retry.
// ---------------------------------------------------------------------------

test('o3d-kouj: a kit re-composed AFTER dispatch still reverses the component units that actually shipped', async () => {
  // 3 kits shipped when 1 kit = 2 x comp-1, so 6 component units left and the shipment snapshot
  // holds 6. The catalogue has since been re-composed to 1 x comp-1. Reading the CURRENT graph
  // would reverse 3 units (£30) against 6 units of posted COGS (£60) — a permanent £30 hole
  // between the ledger and the goods.
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'SHIPPED',
      fxRateToBase: 1,
      totalBase: 150,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 150,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      allocationBatchAmount: 60,
    }],
    lines: [{
      id: 'line-1',
      orderId: 'order-1',
      productId: 'kit-1',
      description: 'Kit',
      qty: 3,
      totalBase: 150,
      fulfillmentRequirements: {
        version: 1,
        productId: 'kit-1',
        graphVersion: 4,
        capturedAt: '2026-01-01T00:00:00.000Z',
        requirements: [{ productId: 'comp-1', factor: '2' }],
      },
    }],
    productGraph: {
      'kit-1': {
        type: 'KIT',
        // THE EDIT: the live recipe now needs ONE component per kit.
        productComponents: [{
          componentId: 'comp-1',
          qty: 1,
          component: { sku: 'COMP-1', type: 'SIMPLE', oversellAllowed: false },
        }],
      },
    },
    shipments: [{
      id: 'shipment-1',
      orderId: 'order-1',
      status: 'SHIPPED',
      shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
      revenueRecognizedAmount: 150,
      cogsBatchAmount: 60,
      lines: [{
        id: 'shipment-line-1',
        lineId: 'line-1',
        productId: 'comp-1',
        qty: 6,
        costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 6, unitCostBase: 10 }],
      }],
    }],
    costLayers: [{ id: 'layer-1', productId: 'comp-1', poLineId: 'po-line-1', receivedQty: 6, unitCostBase: 10 }],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'kit-1', description: 'Kit', qty: 3, totalBase: 150 }],
    reason: 'Customer return',
    returnWarehouseId: 'warehouse-returns',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.deepEqual(state.refundLines[0].costLayerSnapshot, [{
    costLayerId: 'layer-1',
    qty: '6.000000',
    unitCostBase: '10.000000',
    shipmentLineId: 'shipment-line-1',
    source: 'shipment',
  }], '3 kits x the PINNED factor of 2 = the 6 component units that were dispatched')
  assert.equal(state.movements[0].productId, 'comp-1')
  assert.equal(state.movements[0].qty, 6, 'and the same 6 units are restocked, not 3')
})

// ---------------------------------------------------------------------------
// o3d-o97 r3 — the records the postings write have to SURVIVE the sweep whose job is
// deleting old rows, PROVE they posted, name WHICH LEDGER, and BOUND what may be
// reversed. Every test below drives the real refund path and asserts the FIGURE on the
// Allocated Inventory credit, or the specific refusal — never bare success.
// ---------------------------------------------------------------------------

/**
 * A2 recorded the journal it raised: its DB-minted sync log id, the ledger, the account.
 *
 * o3d-o97 r5: and the journal ROW carries the DR Allocated Inventory line it actually raised. It
 * used to be seeded with `lines: []` — a journal that debits nothing anywhere — which is fine while
 * only the STATUS is read and becomes a fixture that cannot express the thing under test the moment
 * the lines are. `journalDebit` is the WINDOW's total (this order's recorded share is one member of
 * a whole day's batch), so it defaults well clear of any single order in these fixtures; the tests
 * that care set it deliberately. `journalLines: []` seeds the empty-journal case on purpose.
 */
function withRecordedA2Journal(
  state: State,
  overrides: {
    syncLogId?: string
    connector?: string
    accountCode?: string
    status?: string
    journalDebit?: number
    journalLines?: Array<{ accountCode?: string; debit?: number; credit?: number }>
    journalPayload?: unknown
  } = {},
) {
  const syncLogId = overrides.syncLogId ?? 'a2-log-1'
  state.orders[0].allocationBatchSyncLogId = syncLogId
  state.orders[0].allocationBatchConnector = overrides.connector ?? 'xero'
  state.orders[0].allocationBatchAccountCode = overrides.accountCode ?? accountingSettings.allocatedInventoryAccount
  if (overrides.status !== undefined) {
    const lines = overrides.journalLines ?? [{
      accountCode: overrides.accountCode ?? accountingSettings.allocatedInventoryAccount,
      debit: overrides.journalDebit ?? 500,
    }]
    state.accountingSyncLogs?.push({
      id: syncLogId,
      connector: overrides.connector ?? 'xero',
      type: 'DAILY_BATCH_INVENTORY_ALLOC',
      referenceType: 'DailyBatch',
      referenceId: 'A2-2026-01-01-deadbeef',
      status: overrides.status,
      payload: 'journalPayload' in overrides ? overrides.journalPayload : { lines },
    })
  }
}

/**
 * o3d-o97 r4: Group B recorded not just WHAT it credited Allocated Inventory for a shipment but
 * WHICH JOURNAL raised it, on which ledger, against which account — and the id resolves to that
 * row's status. Without this a recorded relief names no journal and the refund refuses, which is
 * the whole point: `shipmentJournalDate` says the shipment passed through the Group B window, not
 * that the window credited Allocated Inventory anything, nor that its journal reached a ledger.
 */
function withRecordedGroupBRelief(
  state: State,
  options: {
    amount: number
    status?: string | null
    shipmentIndex?: number
    syncLogId?: string
    connector?: string
    accountCode?: string
    /**
     * o3d-o97 r5: the CR Allocated Inventory the journal's own lines carry — the WINDOW's total,
     * of which this shipment's `amount` is one share. Defaults to the shipment's own figure, which
     * is the smallest batch that can contain it; the tests that probe the bound set it explicitly.
     */
    journalCredit?: number
    journalPayload?: unknown
  },
) {
  const shipment = state.shipments[options.shipmentIndex ?? 0]
  const syncLogId = options.syncLogId ?? 'gb-log-1'
  shipment.allocatedReliefAmount = options.amount
  shipment.allocatedReliefSyncLogId = syncLogId
  shipment.allocatedReliefConnector = options.connector ?? 'xero'
  shipment.allocatedReliefAccountCode = options.accountCode ?? accountingSettings.allocatedInventoryAccount
  if (options.status) {
    state.accountingSyncLogs?.push({
      id: syncLogId,
      connector: options.connector ?? 'xero',
      type: 'DAILY_BATCH_GROUP_B',
      referenceType: 'DailyBatch',
      referenceId: 'B-2026-01-02-cafebabe',
      status: options.status,
      payload: 'journalPayload' in options ? options.journalPayload : {
        lines: [{
          accountCode: options.accountCode ?? accountingSettings.allocatedInventoryAccount,
          credit: options.journalCredit ?? options.amount,
        }],
      },
    })
  }
}

/**
 * The WooCommerce monetary-only shape (no productId, no qty) that carries the whole remaining
 * order value — so `isFullRefundAmount` makes it FULL and the un-stage path is actually reached.
 * Every caller below asserts refundStatus === 'FULL' as well, because a total that quietly falls
 * short would make the whole assertion vacuous.
 */
function monetaryFullRefund(totalBase = 100) {
  return {
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase, lineKind: 'sale' as const }],
    reason: 'Goodwill full refund',
    creditNotePrefix: 'CN-',
  }
}

test('the A2 amount is not evidence its journal POSTED — a CANCELLED A2 batch reverses nothing (o3d-o97 r3)', async () => {
  // A2 wrote £40 and the stamp in ONE UPDATE, which r2 read as proof a journal exists. It is not:
  // the batch log is created PENDING inside that transaction and the remote call is a LATER one.
  // Here it ended CANCELLED — the ordinary fate of a cross-connector orphan — so Allocated
  // Inventory was never debited a penny for this order.
  //
  // Reversing off the amount alone credited £40 to that account and debited £40 to Inventory,
  // overstating inventory by £40 against no matching entry anywhere. Now: nothing, the A2 stamp
  // survives so the standing invariants keep reporting it, and the refund says why.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'CANCELLED' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'no credit at all — the debit it would reverse was never raised')
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the A2 stamp survives the refusal')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /is CANCELLED, not SYNCED/)
})

test('a SYNCED A2 batch on the recorded ledger and account reverses the whole £40 (o3d-o97 r3)', async () => {
  // The mirror of the test above, and the proof the new gate is a gate rather than a refusal: same
  // fixture, same £40, but the journal reached the ledger it says it reached.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 40, 'the whole posted debit')
  assert.equal(findInventoryReversalDebit(result), 40)
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'and the debit being accounted for is what allows the un-stage')
  assert.equal(state.refunds[0].allocationBasisUnresolved, null)
  assert.equal(state.refunds[0].allocatedReliefAmount, 40, 'recorded on the refund, so a later pass need not re-derive it')
})

test('a PENDING A2 batch is queued, not posted, so nothing is reversed yet (o3d-o97 r3)', async () => {
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'PENDING' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'the pounds have not moved, so there are none to move back')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /is PENDING, not SYNCED/)
})

test('the A2 record names WHICH LEDGER it was raised against, and a reversal will not cross ledgers (o3d-o97 r3)', async () => {
  // A2 debited Allocated Inventory in the ledger that was active then. The org has since switched
  // connectors, so this reversal would be raised in a DIFFERENT ledger — one that holds no debit
  // for this order. Crediting there moves £40 that ledger never held AND leaves the original
  // £40 debit standing, so the same mistake is made twice in opposite books.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    accountingSettings,
    activeAccountingConnector: 'quickbooks',
    ...monetaryFullRefund(),
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /A2 debited Allocated Inventory on xero/)
})

test('the A2 record names WHICH ACCOUNT it debited, and a re-mapped account is not credited (o3d-o97 r3)', async () => {
  // Allocated Inventory was account 1215 when A2 posted; the settings name 1210 today. The
  // reversal would credit 1210 — never debited for this order — while 1215 keeps the £40.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED', accountCode: '1215' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /A2 debited account 1215/)
})

/** The A2-staged four-unit order, with one journaled shipment that relieved 2 of the 4 units. */
function a2StagedWithJournaledShipment(): State {
  const state = a2StagedFourUnitState()
  state.orders[0].status = 'SHIPPED'
  state.shipments.push({
    id: 'shipment-1',
    orderId: 'order-1',
    status: 'SHIPPED',
    shipmentJournalDate: new Date('2026-01-02T00:00:00.000Z'),
    revenueRecognizedAmount: 50,
    cogsBatchAmount: 20,
    lines: [{
      id: 'shipment-line-1',
      lineId: 'line-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 10, orderAllocationId: 'alloc-1', source: 'shipment' }],
    }],
  })
  return state
}

test("Group B's recorded relief survives stock-movement retention AND a revaluation (o3d-o97 r3)", async () => {
  // r2 valued Group B's relief from the CogsEntry dispatch rows, calling them immutable. They are
  // — right up until `retention_stock_movements_months` HARD-DELETES the StockMovement and its
  // CogsEntry children (data-retention.ts). Here they are gone AND layer-1 has since been revalued
  // from £10 to £4, which rewrote the shipment line's snapshot in place.
  //
  // With no CogsEntry rows to override it, the derivation valued the surviving snapshot at the new
  // £4: relief 2 × £4 = £8, residue £30 − £8 = £22 — £2 more than the account can give back, and
  // the wrong side of the £10 that IS owed. Group B's own record says £20, so the residue is £10.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.orders[0].allocationBatchAmount = 30
  state.allocations[0].allocationBatchAmount = 30
  state.allocations[0].qty = 3
  state.lines[0].qty = 3
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 4 }]
  // o3d-o97 r4: Group B's record, and the SYNCED journal that raised it.
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED' })
  state.shipments[0].lines[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 4, orderAllocationId: 'alloc-1', source: 'shipment' }]
  state.costLayers[0].unitCostBase = 4
  // Retention has swept the dispatch movement and its CogsEntry rows: state.movements is empty.

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 10, '£30 posted less the £20 Group B RECORDED it credited')
  assert.equal(state.refunds[0].allocationBasisUnresolved, null)
})

test('a journaled shipment whose dispatch cost rows were swept and never recorded its relief REFUSES (o3d-o97 r3)', async () => {
  // The same shipment with no recorded relief and no CogsEntry rows behind it. The only valuation
  // left is the CURRENT layer cost — the exact revaluation 6oyu.5 forbids — so the residue is not
  // computed at all rather than computed from a basis that expired.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.orders[0].allocationBatchAmount = 30
  state.lines[0].qty = 3

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'no figure is invented from an expired basis')
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the stamp survives so the order stays reportable')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /swept by stock-movement retention/)
})

test("a prior refund's RECORDED relief survives sync-log retention (o3d-o97 r3)", async () => {
  // r2 read a prior refund's relief off its UNEARNED_REV_REVERSAL sync log. That row is
  // HARD-DELETED by `retention_sync_logs_months` once it terminalises — and with the row gone the
  // relief read ZERO, so the residue reversed the WHOLE £40 again, double-crediting the £10 the
  // earlier refund had already taken out. The refund row records what it credited, and refund rows
  // are not swept.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  seedPriorAllocationRefund(state)
  state.refunds.find((refund) => refund.id === 'refund-prior')!.allocatedReliefAmount = 10
  // No accountingSyncLogs entry for refund-prior at all: retention has taken it.

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund(75) })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 30, '£40 posted less the £10 the earlier refund RECORDED it credited')
  // o3d-o97 r6: and it SAYS the £10 was counted from the record, because retention deletes CANCELLED
  // rows as well as SYNCED ones — so this absence is equally consistent with a relief that never
  // reached the ledger, and counting it silently is what retires yesterday's refusal.
  assert.match(
    String(state.refunds.find((refund) => refund.id !== 'refund-prior')!.allocationBasisUnresolved),
    /£10\.00 of Allocated Inventory relief was counted against this order's A2 debit WITHOUT the journal/,
  )
})

test('a prior refund that claimed allocated units with no surviving record REFUSES (o3d-o97 r3)', async () => {
  // The same prior refund with neither a recorded relief nor a sync row of any status. Reading
  // that silence as "it relieved nothing" is what credits the same £10 twice; reading it as
  // "it relieved everything" strands a debit. Neither is known, so nothing is reversed.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  seedPriorAllocationRefund(state)

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund(75) })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.match(String(state.refunds.find((refund) => refund.id !== 'refund-prior')!.allocationBasisUnresolved), /no longer on record/)
})

test('a PARTIAL refund reverses the basis A2 POSTED, not the layers revalued since (o3d-o97 r3)', async () => {
  // A2 debited £40 for 4 units at £10 and pinned £40 on the allocation row itself. A landed-cost
  // correction then rewrote layer-1 to £18 and, with it, the row's costLayerSnapshot
  // (updateSnapshotsForCostLayerChange) — while posting to COGS/Inventory and NEVER to Allocated
  // Inventory. Three of the four units are then refunded.
  //
  // Valuing the reversal at the current pin credited 3 × £18 = £54 against an account holding £40:
  // £14 of it was never there, and the residue is floored at zero so a full refund would not have
  // clawed it back either. The posted basis is £40/4 = £10 a unit, so £30.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.allocations[0].allocationBatchAmount = 40
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 4, unitCostBase: 18 }]
  state.costLayers[0].unitCostBase = 18

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 3, totalBase: 40 }],
    reason: 'Three units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 30, '3 units at the £10 A2 debited them at, not the £18 they are worth today')
  assert.equal(findInventoryReversalDebit(result), 30)
})

test('a PARTIAL refund on a basis-less allocation row reverses the APPORTIONED A2 debit, not the revalued layer (o3d-o97 r4)', async () => {
  // THE LEGACY FALLBACK, WHICH r3 LEFT REACHABLE. The rebalancer re-pinned this order's allocation
  // AFTER A2 stamped it, so the ROW carries no posted amount of its own — which is also the state
  // of every allocation row in the database on the day the per-row column ships. r3 valued its
  // units at the CURRENT layer cost, the exact revaluation this round exists to stop, and relied on
  // the open-balance CAP to bound the damage. The cap only bites when the line total EXCEEDS the
  // balance, so it bounded nothing a partial under that ceiling did.
  //
  // A2 debited £40 for four units at £10; a landed-cost correction rewrote the layer to £18.
  // THREE units back: r3 valued them 3 x £18 = £54 and clamped to £40 — £10 more than the £30 those
  // units were debited at, and the fourth unit is left £0 of balance instead of its £10. Now the
  // units are priced from A2's own recorded £40 spread over the four units it covers: £30.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.allocations[0].allocationBatchAmount = null
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 4, unitCostBase: 18 }]
  state.costLayers[0].unitCostBase = 18

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 3, totalBase: 40 }],
    reason: 'Three units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(
    findAllocatedInventoryCredit(result),
    30,
    'the £40 A2 recorded, apportioned over the four units it covers — not £54, and not the £40 r3 clamped to',
  )
  assert.equal(findInventoryReversalDebit(result), 30)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the order stays staged and stays in both batch windows')
})

test('a basis-less partial UNDER the cap is no longer priced from the layer either (o3d-o97 r4)', async () => {
  // The half of the same defect the cap never reached. TWO units back, at r3's £18, is £36 — under
  // the £40 open balance, so nothing capped it at all: £36 credited and £36 debited to Inventory
  // for units A2 debited £20 for. £16 of inventory conjured from a price A2 never posted, and the
  // remaining two units, worth £20, left with £4 of balance.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.allocations[0].allocationBatchAmount = null
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 4, unitCostBase: 18 }]
  state.costLayers[0].unitCostBase = 18
  const client = createClient(state)

  const partial = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 25 }],
    reason: 'Two units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })
  assert.equal(partial.success, true)
  assert.equal(findAllocatedInventoryCredit(partial), 20, 'r3 sent £36 here, uncapped, against a £20 posted basis')

  // And the balance closes exactly: the full refund's residue takes the remaining £20, never £40.
  const full = await createSalesOrderRefund(client, {
    orderId: 'order-1',
    lines: [{ lineId: null, productId: null, description: 'Monetary refund', qty: 0, totalBase: 75, lineKind: 'sale' }],
    reason: 'Goodwill remainder',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(full.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(full), 20, 'the remainder of the recorded £40')
  assert.equal(
    (findAllocatedInventoryCredit(partial) ?? 0) + (findAllocatedInventoryCredit(full) ?? 0),
    40,
    'the two refunds together credit Allocated Inventory exactly what A2 debited it',
  )
})

test("Group B's recorded relief is not relief until its journal POSTS — a queued one refuses (o3d-o97 r4)", async () => {
  // r3 gave Group B a durable relief column and then read it exactly the way it had just stopped
  // reading the A2 amount: recorded, therefore relieved. The figure is written for every shipment
  // the batch stamps, in the transaction that CREATES the journal PENDING — the remote call is a
  // later one.
  //
  // Relief is SUBTRACTED from the debit, so counting a journal that has not posted shrinks the open
  // balance and the refund credits less than the account holds. A2 debited £40 and Group B recorded
  // £20 of relief: r3 reversed £40 − £20 = £20, and if that Group B journal never posts, £20 of a
  // real debit is stranded — permanently, because a FULL refund closes both batch windows for ever.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'PENDING' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'not £20 — the open balance is not knowable while that credit is queued')
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the A2 stamp survives the refusal, so the order stays reportable')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /for shipment shipment-1 is PENDING, not SYNCED/)
})

test("a refusal WITHHOLDS the line reversal instead of un-capping it (o3d-o97 r4)", async () => {
  // r3's refusal had a hole in it that only opens when the refund has LINES. `openAllocatedContra`
  // is computed only when the basis resolved, and it is also the CAP — so a refusal left the cap
  // null and the line-driven reversal went out UNBOUNDED. The refusal did not withhold pounds; it
  // removed the ceiling on them.
  //
  // Here Group B's £20 credit is still queued, so how much of the £40 debit is open is unknown. The
  // refund's own lines claim £20 of allocated basis: r3 sent all £20 with nothing to bound it, on
  // the very pass that recorded "this refund could not account for the debit".
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'PENDING' })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 4, totalBase: 100 }],
    reason: 'All four units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'nothing is credited to an account whose open balance is unknown')
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'and the A2 stamp survives so the order stays reportable')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /is PENDING, not SYNCED/)
})

test("a CANCELLED Group B journal is NOT evidence of no relief — it refuses (o3d-o97 r5)", async () => {
  // r4 made CANCELLED the one terminal status that counted as PROOF: relief of zero, so the whole
  // £40 came out. It is not proof. A row is marked CANCELLED by the cross-connector orphan sweep,
  // by `cancelPendingSalesInvoiceSyncForOrder`, and by an operator from the accounting-sync screen —
  // and a claimed row is retired without anyone being able to see whether the remote call had
  // already landed, because the processors POST BEFORE persisting SYNCED. It is the same class of
  // fact as FAILED (o3d-ju8t), which this branch already refuses to read as "nothing posted".
  //
  // Worked: A2 debited £40 and Group B recorded £20 of relief under a journal now CANCELLED.
  //   r3  subtracted the £20 and reversed £20 — and if the Group B journal never posted, £20 of a
  //       real debit stands for ever, both windows having closed on the full refund.
  //   r4  read CANCELLED as a proved zero and reversed £40 — and if those £20 DID land, Allocated
  //       Inventory is credited £20 it never held, in the opposite direction and just as silent.
  //   r5  neither. Nothing is credited, the A2 stamp survives so the standing invariant keeps
  //       reporting the order, and the refusal names the journal and its status.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'CANCELLED' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'neither r3\'s £20 nor r4\'s £40 — the open balance is not established')
  assert.equal(findInventoryReversalDebit(result), null)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the A2 stamp survives the refusal')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /for shipment shipment-1 is CANCELLED, not SYNCED/)
})

test("a SYNCED Group B journal on the recorded ledger nets its £20 exactly once (o3d-o97 r4)", async () => {
  // The gate is a gate, not a refusal: same fixture, same £20, but the credit reached the ledger.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 20, '£40 debited less the £20 Group B actually credited')
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'and the accounted-for debit allows the un-stage')
})

test("Group B's relief raised in ANOTHER LEDGER is not netted against this reversal (o3d-o97 r4)", async () => {
  // The third of r3's own three reasons, applied to relief. The £20 was credited to Allocated
  // Inventory on xero; this reversal would be raised on quickbooks. Netting them treats a credit in
  // one set of books as if it had happened in another.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED', connector: 'quickbooks' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED', connector: 'xero' })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    accountingSettings,
    activeAccountingConnector: 'quickbooks',
    ...monetaryFullRefund(),
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /credited Allocated Inventory on xero/)
})

test("a recorded relief of more than half a penny that names NO journal is refused (o3d-o97 r4)", async () => {
  // Group B stamps the journal id whenever its journal carried a CR Allocated line, so a recorded
  // £20 with no id cannot have come from that writer at all. It is not evidence of a credit, and it
  // certainly is not evidence of one in the account this reversal would touch.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.shipments[0].allocatedReliefAmount = 20

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /names no journal/)
})

test("a sub-penny relief with no journal is a relief of ZERO, not a refusal (o3d-o97 r4)", async () => {
  // The one shape that legitimately records an amount and no id: the window's ROUNDED COGS total
  // was zero, so no CR Allocated line was raised and this shipment's share is necessarily
  // sub-penny. Zero relief is right to within half a penny, and refusing over £0.004 would strand
  // the whole £40.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.shipments[0].allocatedReliefAmount = 0.004

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 40, 'nothing was credited to Allocated Inventory, so all £40 is open')
  assert.equal(state.refunds[0].allocationBasisUnresolved, null)
})

test("a prior refund's QUEUED reversal is not relief either (o3d-o97 r4)", async () => {
  // The same rule one row along. The earlier refund RECORDED that it would credit £10, and its
  // journal is still sitting PENDING in the outbox. r3 counted it — its own comment argued a queued
  // reversal is work that completes — and reversed £40 − £10 = £30. If that reversal is then
  // cancelled, £10 of the debit is stranded with both batch windows already closed.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  seedPriorAllocationRefund(state)
  state.refunds.find((refund) => refund.id === 'refund-prior')!.allocatedReliefAmount = 10
  state.accountingSyncLogs?.push({
    id: 'prior-reversal-1',
    connector: 'xero',
    type: 'UNEARNED_REV_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-prior',
    status: 'PENDING',
    payload: { lines: [{ accountCode: '1210', credit: 10 }] },
  })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund(75) })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'not £30 — how much is open is not knowable while that credit is queued')
  assert.match(String(state.refunds.find((refund) => refund.id !== 'refund-prior')!.allocationBasisUnresolved), /is PENDING, not SYNCED/)
})

test('an order whose rows PARTLY recorded their basis apportions only the unrecorded remainder (o3d-o97 r4)', async () => {
  // Two rows: one A2 recorded £20 for its 3 units, one the rebalancer created afterwards with 1
  // unit and no record. The order's recorded debit is £40, so the unrecorded row's single unit is
  // worth the £20 REMAINDER — not a quarter of £40, and certainly not the £18 the layer says. The
  // figures are chosen so the layer answer (£20 + £18 = £38) is UNDER the £40 open balance: the cap
  // cannot mask the difference, which is exactly how r3's fallback escaped notice.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.allocations[0].qty = 3
  state.allocations[0].allocationBatchAmount = 20
  state.allocations[0].costLayerSnapshot = [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 18 }]
  state.allocations.push({
    id: 'alloc-2',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 1,
    costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 1, unitCostBase: 18 }],
  })
  state.costLayers[0].unitCostBase = 18

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 4, totalBase: 40 }],
    reason: 'All four units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(
    findAllocatedInventoryCredit(result),
    40,
    '£20 from the row that recorded it plus the £20 remainder for the row that did not — never £20 + £18',
  )
})

// ---------------------------------------------------------------------------
// o3d-o97 r5 — A STATUS IS NOT A POSTING, ON EITHER SIDE OF THE CONTRA. Round 4 made every
// figure name the journal that was to carry it and then read the ANSWER off that journal's
// `status`. SYNCED says the ROW SETTLED, not what it credited; CANCELLED says the row was
// ABANDONED, not that nothing landed. What a journal did is in its own lines.
// ---------------------------------------------------------------------------

test("a SETTLED Group B journal whose lines credit Allocated Inventory NOTHING is refused (o3d-o97 r5)", async () => {
  // The exact shape r4 could not see. The shipment records £20 of relief and names a journal that
  // is SYNCED — r4 stopped there and netted the £20, reversing £40 − £20 = £20. But the journal it
  // names credits that account nothing at all: the account codes are read from settings at posting
  // time, so a re-mapped Allocated Inventory account (or a revenue-only window) produces exactly
  // this. Either the record or the journal is wrong, and reading the record subtracts £20 of relief
  // the ledger never received — permanently, because a full refund closes both windows.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED', journalPayload: { lines: [{ accountCode: '4000', credit: 20 }] } })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'not r4\'s £20, and not £40 either')
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the A2 stamp survives the refusal')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /the journal it names credits nothing to 1210/)
})

test("a shipment recording MORE relief than its journal credited in total is refused (o3d-o97 r5)", async () => {
  // The other way the record and the journal can disagree, and the one that needs the batch shape
  // to see. `Shipment.allocatedReliefAmount` is ONE SHIPMENT'S SHARE of a whole day's Group B
  // journal, so it can never exceed that journal's own CR to Allocated Inventory. Here the shipment
  // claims £20 against a journal that credited £6 in total for every shipment in the window.
  // r4 netted the whole £20 off the £40 debit and reversed £20, so £14 of a real debit is stranded.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED', journalCredit: 6 })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'not the £20 r4 subtracted from the £40')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /more than the £6\.00 its journal credited to 1210 in total/)
})

test("a Group B journal ROW raised on another ledger is refused even when the stamp says otherwise (o3d-o97 r5)", async () => {
  // r4 checked the connector RECORDED BESIDE THE AMOUNT — written by the same statement as the
  // amount, so only as right as that writer was. The journal row carries the ledger it was actually
  // raised into, and that is the ledger's own record of the fact. Here they disagree: the shipment
  // says xero, the row says the £20 was raised on quickbooks, and this reversal goes to xero.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED' })
  state.accountingSyncLogs!.find((log) => log.id === 'gb-log-1')!.connector = 'quickbooks'

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    accountingSettings,
    activeAccountingConnector: 'xero',
    ...monetaryFullRefund(),
  })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'not the £20 the stamp claimed for this ledger')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /was raised on quickbooks, but this reversal would be raised on xero/)
})

test("a prior refund's relief is the pounds its journal CREDITED, not the pounds its column claims (o3d-o97 r5)", async () => {
  // r4 took the VERDICT from the row and the AMOUNT from the column — which is the same
  // "SYNCED means it credited what I say it credited" inference in a smaller place. This journal is
  // raised for ONE refund, so its CR to Allocated Inventory IS what that refund relieved: £4, not
  // the £10 the column records. r4 subtracted £10 and reversed £30, crediting £6 of Allocated
  // Inventory that had never been debited back out of it. The proven answer leaves £36 open.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  seedPriorAllocationRefund(state)
  state.refunds.find((refund) => refund.id === 'refund-prior')!.allocatedReliefAmount = 10
  state.accountingSyncLogs?.push({
    id: 'prior-reversal-1',
    connector: 'xero',
    type: 'UNEARNED_REV_REVERSAL',
    referenceType: 'SalesOrderRefund',
    referenceId: 'refund-prior',
    status: 'SYNCED',
    payload: { lines: [{ accountCode: '1200', debit: 4 }, { accountCode: '1210', credit: 4 }] },
  })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund(75) })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 36, '£40 debited less the £4 the journal actually credited — not the £10 recorded')
  assert.equal(findInventoryReversalDebit(result), 36)
})

test("a SETTLED A2 journal whose lines debit Allocated Inventory NOTHING is refused (o3d-o97 r5)", async () => {
  // The same rule on the debit side. The order records a £40 share of journal a2-log-1, which is
  // SYNCED — and whose lines debit that account nothing whatever. Reversing off the record alone
  // credits Allocated Inventory £40 it was never debited, which is precisely the harm r3 opened
  // this line of work over; r3 and r4 both stopped at the status.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED', journalLines: [{ accountCode: '4000', debit: 40 }] })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the stamp survives so the order stays reportable')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /its lines debit nothing to Allocated Inventory \(1210\)/)
})

test("an order claiming a bigger share than its A2 batch journal debited is refused (o3d-o97 r5)", async () => {
  // A share cannot exceed the batch it came from. The order records £40 of a day's A2 journal that
  // debited Allocated Inventory £25 in total for every order in that window.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED', journalDebit: 25 })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), null, 'not the £40 the order records')
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /records a £40\.00 share of an A2 journal that debited Allocated Inventory only £25\.00/)
})

test("a settled journal whose payload was COMPACTED off it still resolves to the recorded figure (o3d-o97 r5)", async () => {
  // ILLEGIBLE is not the same as UNPROVED, and must not become a refusal. `backReferenceEvidence
  // CompactedAt` compaction drops `payload` from a row it otherwise keeps, so a settled journal can
  // be present with nothing readable on it — the same position as a row retention deleted outright,
  // which this branch already resolves to the recorded amount. Refusing here would strand the whole
  // £40 on every order old enough to have been compacted.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED', journalPayload: null })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED', journalPayload: null })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 20, 'the recorded £40 less the recorded £20, exactly as when the rows are gone')
  // o3d-o97 r6: the POUNDS are unchanged — illegible is still resolved to the recorded figure — but
  // the refund now says the £20 of relief was counted WITHOUT its journal being readable. Silence
  // here is what lets retention turn an unproved relief into a resolved posting.
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /£20\.00 of Allocated Inventory relief was counted against this order's A2 debit WITHOUT the journal/,
  )
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /compacted off the row/)
})

// ---------------------------------------------------------------------------
// o3d-o97 r5 — AN ORDER-WIDE APPORTIONMENT IS NOT A PER-PRODUCT COST. r4 valued basis-less
// allocation rows by spreading the order's recorded A2 debit over their units and defended it
// as "bounded by the recorded debit and closed exactly by the residue". Both of those are
// FULL-refund facts: the cap only bites above the open balance, and the residue only runs on a
// full refund.
// ---------------------------------------------------------------------------

/**
 * £40 of A2 debit over two products whose real shares are £30 and £10, on rows the rebalancer
 * re-created after A2 stamped the order — so only the ORDER's £40 survives and the apportioned rate
 * (£10 a unit) is neither product's own.
 */
function a2StagedTwoProductBasislessState(): State {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-deadbeef',
      allocationBatchAmount: 40,
    }],
    lines: [
      { id: 'line-x', orderId: 'order-1', productId: 'product-x', description: 'Expensive X', qty: 2, totalBase: 60 },
      { id: 'line-y', orderId: 'order-1', productId: 'product-y', description: 'Cheap Y', qty: 2, totalBase: 40 },
    ],
    allocations: [
      {
        id: 'alloc-x',
        orderId: 'order-1',
        lineId: 'line-x',
        productId: 'product-x',
        warehouseId: 'warehouse-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-x', qty: 2, unitCostBase: 15 }],
        // No allocationBatchAmount on either row: both were re-pinned after A2 stamped the order.
      },
      {
        id: 'alloc-y',
        orderId: 'order-1',
        lineId: 'line-y',
        productId: 'product-y',
        warehouseId: 'warehouse-1',
        qty: 2,
        costLayerSnapshot: [{ costLayerId: 'layer-y', qty: 2, unitCostBase: 5 }],
      },
    ],
    costLayers: [
      { id: 'layer-x', productId: 'product-x', poLineId: 'po-line-x', receivedQty: 2, unitCostBase: 15 },
      { id: 'layer-y', productId: 'product-y', poLineId: 'po-line-y', receivedQty: 2, unitCostBase: 5 },
    ],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  state.lines[1].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  return state
}

test('a PARTIAL refund whose apportionment pool spans two products refuses instead of blending (o3d-o97 r5)', async () => {
  // THE FINDING, worked. A2 debited £40: 2 units of X at £15 (£30) and 2 units of Y at £5 (£10).
  // Neither row records its share, so r4 spreads the £40 over the 4 units at £10 each.
  //
  // Refund the two CHEAP units: r4 credits Allocated Inventory 2 × £10 = £20 and debits Inventory
  // £20, for units A2 debited £10 for — £10 of inventory conjured from a rate no product ever had,
  // and X's real £30 share is left with £20 of balance. The cap never bites (£20 is under the £40
  // open balance) and the residue never runs (this is a partial), so nothing corrects either.
  const state = a2StagedTwoProductBasislessState()
  withRecordedA2Journal(state, { status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-y', productId: 'product-y', description: 'Cheap Y', qty: 2, totalBase: 40 }],
    reason: 'Both cheap units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'not r4\'s £20 for units worth £10')
  assert.equal(findInventoryReversalDebit(result), null)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the order stays staged and inside both batch windows')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /reverses 2 of the 4 such unit\(s\) spread across 2 separately-valued allocation rows \(2 product\(s\)\)/,
  )
  // The refusal an operator can SEE — r4 recorded a refusal only on a FULL refund, so this one
  // would have withheld £20 of credit and written nothing on the row the invariant report reads.
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /valued £20\.00 of allocated basis and NONE of it was credited/)
  assert.equal(state.refunds[0].allocatedReliefAmount, 0, 'and it records that it relieved nothing, so a later refund may take it all')
})

test('the same two-product order on a FULL refund still closes to exactly the recorded £40 (o3d-o97 r5)', async () => {
  // The proof the refusal above is a gate rather than a blanket ban on apportionment. Both LINES
  // are refunded here, so every one of the four units really is valued at the £10 blended rate and
  // the per-line split is as wrong as it was on the partial — but on a FULL refund the cap and the
  // residue between them close the order to precisely the open balance whatever that split was, so
  // the blend cannot move the TOTAL by a penny. Refusing here would strand the whole £40, because a
  // full refund closes both batch windows for ever.
  const state = a2StagedTwoProductBasislessState()
  withRecordedA2Journal(state, { status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [
      { lineId: 'line-x', productId: 'product-x', description: 'Expensive X', qty: 2, totalBase: 60 },
      { lineId: 'line-y', productId: 'product-y', description: 'Cheap Y', qty: 2, totalBase: 40 },
    ],
    reason: 'Everything back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 40, 'the whole recorded debit — 4 units at the £10 blend, capped and closed to £40')
  assert.equal(findInventoryReversalDebit(result), 40)
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'and the accounted-for debit allows the un-stage')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /valued by apportioning the order's recorded debit/,
    'the apportionment IS what valued these units, and the refund says so — a residue-only full refund would not reach it at all',
  )
})

test('a SINGLE-product apportionment pool still values a partial refund (o3d-o97 r5)', async () => {
  // The other edge of the same gate. One product, so the apportioned rate IS that product's own
  // average across the pool and k units of it are exactly k/n of its debit — nothing is fabricated
  // and there is nothing to refuse over. £40 over 4 units, two units back, £20.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  state.allocations[0].allocationBatchAmount = null
  state.allocations.push({
    id: 'alloc-2',
    orderId: 'order-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 0,
    costLayerSnapshot: [],
  })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 2, totalBase: 25 }],
    reason: 'Two units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 20, 'two of the four units the £40 covers')
})

// ---------------------------------------------------------------------------
// o3d-o97 r6 — WHAT AN ACCOUNT MOVED IS THE NET, NEVER ONE SIDE'S GROSS.
//
// r5 proved a figure out of the journal's own lines instead of its status, and then measured those
// lines one side at a time: the sum of DEBITS on the account for the A2 posting, the sum of CREDITS
// for the relief. A journal can touch one account on BOTH sides — these are whole-day batches built
// line by line, the reconciliation sweeps add their own rounding lines, and two settings roles
// mapped to one code put both halves of a pair on that code — and every reader of these figures is
// asking what the account MOVED.
// ---------------------------------------------------------------------------

test('an A2 journal that debits AND credits Allocated Inventory is bounded by the NET, not the gross debit (o3d-o97 r6)', async () => {
  // A2's journal debits Allocated Inventory £100 and credits it £80 in the same journal, so the
  // account moved £20. This order records a £40 share of that batch.
  //   gross: £40 <= £100, so the share "fits its batch", the basis resolves, and the full refund
  //     credits Allocated Inventory £40 out of a journal that put £20 into it.
  //   net:   £40 > £20, so it cannot have come from this journal — refused, nothing credited, and
  //     the £20 stays open and reported.
  const state = a2StagedFourUnitState()
  withRecordedA2Journal(state, {
    status: 'SYNCED',
    journalLines: [
      { accountCode: accountingSettings.allocatedInventoryAccount, debit: 100 },
      { accountCode: accountingSettings.allocatedInventoryAccount, credit: 80 },
    ],
  })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'gross-side reading credits £40 here')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /records a £40\.00 share of an A2 journal that debited Allocated Inventory only £20\.00 in total/,
  )
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the stamp survives so the invariant keeps reporting it')
})

test("a Group B journal that debits Allocated Inventory back is bounded by its NET credit (o3d-o97 r6)", async () => {
  // The relief side of the same defect. The batch credits Allocated Inventory £25 and debits it £10
  // — it relieved £15 — while the shipment records a £20 share of it.
  //   gross: £20 <= £25, so £20 of relief is netted off the £40 debit and the refund credits £20.
  //   net:   £20 > £15, so the record and the journal disagree — refused.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, {
    amount: 20,
    status: 'SYNCED',
    journalPayload: {
      lines: [
        { accountCode: accountingSettings.allocatedInventoryAccount, credit: 25 },
        { accountCode: accountingSettings.allocatedInventoryAccount, debit: 10 },
      ],
    },
  })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, 'gross-side reading credits £20 here')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /records £20\.00 of Allocated Inventory relief, more than the £15\.00 its journal credited/,
  )
})

// ---------------------------------------------------------------------------
// o3d-o97 r6 — RETENTION MUST NOT BE ABLE TO MANUFACTURE A RESOLUTION.
//
// A relief record whose journal was CANCELLED refuses while the row survives (r5). Retention then
// DELETES that row — CANCELLED is terminal — and from that moment the same record resolves to
// "posted" at the recorded amount. The pounds are the least-destructive reading and stay as they
// are; what must not stay is the SILENCE, which retires the refusal that stood yesterday, stops the
// standing invariant reporting the order, and makes the under-reversal permanent on a full refund.
// ---------------------------------------------------------------------------

test("a shipment's relief counted after retention deleted its journal is REPORTED, not silently resolved (o3d-o97 r6)", async () => {
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  // Recorded £20 of relief naming a journal row that no longer exists — which is exactly the state
  // a CANCELLED (never-posted) Group B journal reaches once it is past the retention cutoff.
  withRecordedGroupBRelief(state, { amount: 20, status: null })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 20, 'the pounds are unchanged: £40 recorded less the £20 recorded relief')
  const note = String(state.refunds[0].allocationBasisUnresolved)
  assert.match(note, /£20\.00 of Allocated Inventory relief was counted against this order's A2 debit WITHOUT the journal/)
  assert.match(note, /shipment shipment-1/, 'and it names WHICH record, so an operator knows what to go and settle')
  assert.match(note, /no longer on record \(retention\)/)
  assert.match(note, /the open balance may be overstated as relieved by up to that much/)
})

test('a proved relief writes no such note — the report is about UNREADABLE evidence only (o3d-o97 r6)', async () => {
  // The guard against the note becoming noise on every refund: the same £20, proved out of a
  // settled journal's own lines, resolves silently exactly as before.
  const state = a2StagedWithJournaledShipment()
  withRecordedA2Journal(state, { status: 'SYNCED' })
  withRecordedGroupBRelief(state, { amount: 20, status: 'SYNCED' })

  const result = await createSalesOrderRefund(createClient(state), { orderId: 'order-1', accountingSettings, ...monetaryFullRefund() })

  assert.equal(result.success, true)
  assert.equal(findAllocatedInventoryCredit(result), 20)
  assert.equal(state.refunds[0].allocationBasisUnresolved, null)
})

// ---------------------------------------------------------------------------
// o3d-o97 r6 — A PRODUCT IS NOT A RATE. r5 kept the blend for a single-product pool because "the
// rate IS that product's own average across the pool". That holds only if every unit of the pool
// was debited at the same rate, and A2 values an allocation ROW, not a product: two rows of the
// same product pinned to different layers were valued separately and at different rates.
// ---------------------------------------------------------------------------

/**
 * £40 of A2 debit over ONE product held in TWO allocation rows whose real shares are £15 (3 units
 * off a £5 layer) and £25 (1 unit off a £25 layer). The rebalancer re-created both rows after A2
 * stamped the order, so neither records its own share and only the order's £40 survives — and the
 * blended rate is £10 a unit, which is neither row's.
 *
 * The line total is £40 of a £100 order, so refunding every unit is still a PARTIAL refund and the
 * full refund's residue never runs.
 */
function a2StagedOneProductTwoBasislessRows(): State {
  const state = baseState({
    orders: [{
      id: 'order-1',
      externalOrderNumber: null,
      orderNumber: 'SO-1',
      status: 'ALLOCATED',
      fxRateToBase: 1,
      totalBase: 100,
      revenueDeferredDate: new Date('2026-01-01T00:00:00.000Z'),
      unearnedRevenueAmount: 100,
      inventoryAllocatedDate: new Date('2026-01-01T00:00:00.000Z'),
      inventoryAllocatedBatchRef: 'A2-2026-01-01-deadbeef',
      allocationBatchAmount: 40,
    }],
    lines: [{ id: 'line-1', orderId: 'order-1', productId: 'product-1', description: 'Product 1', qty: 4, totalBase: 40 }],
    allocations: [
      {
        id: 'alloc-cheap',
        orderId: 'order-1',
        lineId: 'line-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        qty: 3,
        costLayerSnapshot: [{ costLayerId: 'layer-cheap', qty: 3, unitCostBase: 5 }],
      },
      {
        id: 'alloc-expensive',
        orderId: 'order-1',
        lineId: 'line-1',
        productId: 'product-1',
        warehouseId: 'warehouse-1',
        qty: 1,
        costLayerSnapshot: [{ costLayerId: 'layer-expensive', qty: 1, unitCostBase: 25 }],
      },
    ],
    costLayers: [
      { id: 'layer-cheap', productId: 'product-1', poLineId: 'po-line-1', receivedQty: 3, unitCostBase: 5 },
      { id: 'layer-expensive', productId: 'product-1', poLineId: 'po-line-2', receivedQty: 1, unitCostBase: 25 },
    ],
  })
  state.lines[0].taxRate = { accountingTaxType: 'OUTPUT2', reverseCharge: false }
  return state
}

test('a PARTIAL refund apportioning across TWO rows of ONE product refuses instead of blending (o3d-o97 r6)', async () => {
  // THE FINDING, worked. A2 debited £40: 3 units at £5 (£15) and 1 unit at £25. Neither row records
  // its share, so r5 sees one product, calls the £10 blended rate "that product's own average" and
  // lets a partial use it. One unit back is then £10 credited to Allocated Inventory for a unit A2
  // debited at either £5 or £25 — never £10 — and the cap does not bite (£10 is under the £40 open
  // balance) and the residue does not run (this is a partial), so nothing corrects it.
  const state = a2StagedOneProductTwoBasislessRows()
  withRecordedA2Journal(state, { status: 'SYNCED', journalDebit: 40 })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 }],
    reason: 'One unit back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), null, "not r5's £10 for a unit A2 never debited £10 for")
  assert.equal(findInventoryReversalDebit(result), null)
  assert.equal(state.refunds[0].allocatedReliefAmount, 0, 'it relieved nothing, so a later refund may take it all')
  assert.match(
    String(state.refunds[0].allocationBasisUnresolved),
    /reverses 1 of the 4 such unit\(s\) spread across 2 separately-valued allocation rows \(1 product\(s\)\)/,
    'the pool is one PRODUCT and two ROWS, and it is the rows that make the rate a fiction',
  )
  assert.match(String(state.refunds[0].allocationBasisUnresolved), /remaining A2 debit of £40\.00/)
  assert.notEqual(state.orders[0].inventoryAllocatedDate, null, 'the order stays staged and inside both batch windows')
})

test('a PARTIAL refund that empties the WHOLE pool still credits it — the total is exact (o3d-o97 r6)', async () => {
  // The other edge, and the reason the gate is not "two rows, always refuse". The residual IS the
  // pool's debit by construction, so taking every unit of every unrecorded row credits exactly £40
  // whatever the per-row split was — the split cancels in the sum. Still a PARTIAL refund (£40 of a
  // £100 order), so the full refund's residue is not what is saving it here.
  const state = a2StagedOneProductTwoBasislessRows()
  withRecordedA2Journal(state, { status: 'SYNCED', journalDebit: 40 })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [{ lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 4, totalBase: 40 }],
    reason: 'All four units back',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.notEqual(state.orders[0].refundStatus, 'FULL')
  assert.equal(findAllocatedInventoryCredit(result), 40, 'exactly the recorded debit, from the four units that share it')
  assert.equal(findInventoryReversalDebit(result), 40)
})

test('the SAME inexact apportionment on a FULL refund is not refused — cap and residue close it (o3d-o97 r6)', async () => {
  // The gate has to be a gate, not a ban: this refund prices ONE of the pool's four units at the
  // same fictional £10 blend the test above refuses over — k=1, n=4, two separately-valued rows —
  // and it is allowed, because a FULL refund's cap and residue close the order to precisely the
  // open balance whatever the per-line split was. £10 from the line, £30 from the residue, £40 in
  // total: exactly the recorded debit. Refusing here would strand the whole £40 for ever, since a
  // full refund closes both daily-batch windows permanently.
  const state = a2StagedOneProductTwoBasislessRows()
  withRecordedA2Journal(state, { status: 'SYNCED', journalDebit: 40 })

  const result = await createSalesOrderRefund(createClient(state), {
    orderId: 'order-1',
    lines: [
      { lineId: 'line-1', productId: 'product-1', description: 'Product 1', qty: 1, totalBase: 10 },
      { lineId: null, productId: null, description: 'Monetary remainder', qty: 0, totalBase: 90, lineKind: 'sale' as const },
    ],
    reason: 'One unit back and the rest in cash',
    creditNotePrefix: 'CN-',
    accountingSettings,
  })

  assert.equal(result.success, true)
  assert.equal(state.orders[0].refundStatus, 'FULL', 'a total that quietly fell short would make this vacuous')
  assert.equal(findAllocatedInventoryCredit(result), 40, 'the £10 blended line plus the £30 residue — exactly the recorded debit')
  assert.equal(findInventoryReversalDebit(result), 40)
  assert.equal(state.orders[0].inventoryAllocatedDate, null, 'the accounted-for debit allows the un-stage')
})
