import type { AllocateSalesOrderResult } from './allocation-service'

/**
 * o3d-2k5r r3 — the activity-log row an allocation attempt earns, as a pure decision.
 *
 * Extracted from `autoAllocateOrder` because it now has a SECOND caller: the repack recovery
 * runs `allocateSalesOrder` inside its own transaction (so the reopen, the netting and the
 * refund-backstop resolution commit together), which means it cannot go through
 * `autoAllocateOrder` and would otherwise have had to restate this classification by hand. Two
 * hand-written copies of "which of these five outcomes was it" drift, and the one that drifts is
 * the one nobody reads until an operator is standing in front of an order asking what happened.
 *
 * Returns null when the allocation transaction never ran (`logAttempt` unset) — there is no
 * attempt to record, and writing one would put a rolled-back or refused run on the timeline as
 * though stock had moved.
 */
export type AllocationActivityEntry = {
  action: 'allocated' | 'backorder_recorded' | 'allocation_failed'
  level: 'INFO' | 'WARNING'
  description: string
  metadata: Record<string, unknown>
}

export function describeAllocationAttempt(
  result: AllocateSalesOrderResult,
): AllocationActivityEntry | null {
  if (!result.logAttempt || !result.orderRef) return null

  const hasUnallocatedDemand = result.unallocatedQty > 0
  const action: AllocationActivityEntry['action'] = !result.success
    ? 'allocation_failed'
    : result.allocationCount > 0
    ? 'allocated'
    : hasUnallocatedDemand
      ? 'backorder_recorded'
      : 'allocation_failed'
  const level: AllocationActivityEntry['level'] = result.success ? 'INFO' : 'WARNING'
  const description = !result.success
    ? result.allocationCount > 0
      ? `Partially allocated stock for order ${result.orderRef} — ${result.allocationCount} allocation(s), but some lines are not oversell-eligible`
      : `No stock available to allocate for order ${result.orderRef}`
    : result.allocationCount > 0
    ? hasUnallocatedDemand
      ? `Auto-allocated stock for order ${result.orderRef} — ${result.allocationCount} allocation(s), ${result.unallocatedQty} unit(s) left unallocated`
      : `Auto-allocated stock for order ${result.orderRef} — ${result.allocationCount} allocation(s)`
    : hasUnallocatedDemand
      ? `Recorded ${result.unallocatedQty} unit(s) as backorder demand for order ${result.orderRef}`
      : `No stock available to allocate for order ${result.orderRef}`

  return {
    action,
    level,
    description,
    metadata: {
      orderNumber: result.orderRef,
      isShoppingOrder: result.isShoppingOrder,
      shipFromWarehouseId: result.shipFromWarehouseId,
      allocations: result.allocationCount,
      unallocatedQty: result.unallocatedQty,
      backorderLineCount: result.backorderLineCount,
      unallocatedLines: result.unallocatedLines,
    },
  }
}
