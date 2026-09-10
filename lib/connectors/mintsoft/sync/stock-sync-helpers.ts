import { Prisma } from '@/app/generated/prisma/client'
import type { WmsStockLine } from '@/lib/connectors/wms/types'
import {
  requireTransferLineResidualQty,
  type TransferLineResidualQty,
  type WmsAsnLineResidualQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'

type ThresholdConfig = {
  absoluteDelta: number | null
  percentDelta: number | null
}

export type MintsoftMissingInWmsCandidate = {
  productId: string
  sku: string
  imsQty: number
  lastExternalQty: number | null
}

export type MintsoftAlignmentCandidate = {
  asnLineMapId: string
  /**
   * ASN SCOPE (6oyu.19, Codex round-7 HIGH-2): how much room THIS `wms_asn_line_maps`
   * row itself still has — `expectedQty` less its own credit. Built only by
   * `resolveWmsAsnLineResidualQty`, so the line-wide landed figure cannot be passed
   * here: that is precisely the substitution round 6 made, and it under-allocated
   * every ASN after the first on a multi-ASN transfer line.
   */
  asnResidualQty: WmsAsnLineResidualQty
  /**
   * The transfer line this ASN row draws from, or null for a PURCHASE_ORDER_LINE
   * candidate. When non-null the planner ALSO applies that line's own residue, so
   * an already-received transfer line offers no capacity however open its ASN rows
   * look (the round-6 finding). See `transferLineResiduals` below.
   */
  transferLineId: string | null
  sortAt: Date | string
  sortId: string
}

export type MintsoftAlignmentAllocation = {
  asnLineMapId: string
  qty: number
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function parseMintsoftThresholds(value: Prisma.JsonValue | null | undefined): ThresholdConfig {
  const record = asRecord(value)
  return {
    absoluteDelta: parseNumber(record?.absoluteDelta) ?? null,
    percentDelta: parseNumber(record?.percentDelta) ?? null,
  }
}

export function sanitizeMintsoftThresholds(input: {
  absoluteDelta?: number | null
  percentDelta?: number | null
} | null | undefined): Prisma.InputJsonValue | null {
  if (!input) return null
  const absoluteDelta = input.absoluteDelta != null && Number.isFinite(input.absoluteDelta)
    ? Math.max(0, input.absoluteDelta)
    : null
  const percentDelta = input.percentDelta != null && Number.isFinite(input.percentDelta)
    ? Math.max(0, input.percentDelta)
    : null

  if (absoluteDelta == null && percentDelta == null) return null

  return {
    absoluteDelta,
    percentDelta,
  } satisfies Prisma.InputJsonObject
}

export function isMintsoftBindingDue(
  lastStockSyncAt: Date | null,
  syncFrequencyMinutes: number,
  now: Date = new Date(),
): boolean {
  if (!lastStockSyncAt) return true
  const dueAt = lastStockSyncAt.getTime() + (Math.max(1, syncFrequencyMinutes) * 60_000)
  return now.getTime() >= dueAt
}

export function consolidateMintsoftStockLines(lines: WmsStockLine[]): WmsStockLine[] {
  const bySku = new Map<string, WmsStockLine>()

  for (const line of lines) {
    const existing = bySku.get(line.sku)
    if (existing) {
      existing.quantity += line.quantity
      existing.raw = line.raw ?? existing.raw
    } else {
      bySku.set(line.sku, { ...line })
    }
  }

  return Array.from(bySku.values()).sort((left, right) => left.sku.localeCompare(right.sku))
}

export function hasMintsoftThresholdBreach(
  imsQty: number,
  wmsQty: number,
  thresholds: ThresholdConfig,
): boolean {
  const absoluteDelta = Math.abs(wmsQty - imsQty)
  const maxQty = Math.max(Math.abs(imsQty), Math.abs(wmsQty))
  const percentDelta = maxQty > 0 ? (absoluteDelta / maxQty) * 100 : 0

  if (thresholds.absoluteDelta != null && absoluteDelta >= thresholds.absoluteDelta) return true
  if (thresholds.percentDelta != null && percentDelta >= thresholds.percentDelta) return true
  return false
}

export function collectMissingInWmsCandidates(input: {
  returnedSkus: Iterable<string>
  snapshots: Array<{
    productId: string
    sku: string
    externalQty: number
  }>
  stockLevels: Array<{
    productId: string
    sku: string
    quantity: number
  }>
}): MintsoftMissingInWmsCandidate[] {
  const returnedSkus = new Set(Array.from(input.returnedSkus))
  const byProductId = new Map<string, MintsoftMissingInWmsCandidate>()

  for (const snapshot of input.snapshots) {
    if (returnedSkus.has(snapshot.sku)) continue

    byProductId.set(snapshot.productId, {
      productId: snapshot.productId,
      sku: snapshot.sku,
      imsQty: 0,
      lastExternalQty: snapshot.externalQty,
    })
  }

  for (const stockLevel of input.stockLevels) {
    if (returnedSkus.has(stockLevel.sku)) continue

    const existing = byProductId.get(stockLevel.productId)
    if (existing) {
      existing.imsQty = stockLevel.quantity
      existing.sku = stockLevel.sku
      continue
    }

    byProductId.set(stockLevel.productId, {
      productId: stockLevel.productId,
      sku: stockLevel.sku,
      imsQty: stockLevel.quantity,
      lastExternalQty: null,
    })
  }

  return Array.from(byProductId.values())
    .filter((candidate) => (
      candidate.imsQty !== 0
      || (candidate.lastExternalQty != null && candidate.lastExternalQty !== 0)
    ))
    .sort((left, right) => left.sku.localeCompare(right.sku))
}

/**
 * Spread a positive Mintsoft delta across the open ASN lines that can explain it.
 *
 * TWO CAPS, TWO SCOPES (6oyu.19, Codex rounds 6 and 7). An allocation is bounded by
 * BOTH:
 *
 *   1. its own ASN row's residue  — `expectedQty` less that row's own credit; and
 *   2. its transfer line's residue — `line.qty` less everything that has landed on
 *      the line by ANY route, shared across every open ASN row of that line and
 *      depleted as this plan allocates.
 *
 * Applying only (1) is the round-6 finding: a line received manually moves
 * `stock_transfer_lines.qtyReceived` and neither ASN column, so a fully received
 * line still looked like open capacity. Applying only (2) — round 6's fix, which
 * subtracted the line-wide landed figure from each ASN row individually — is the
 * round-7 finding: units absorbed on an earlier, now-closed ASN were charged a
 * second time against the follow-up ASN raised for the remainder, so a legitimate
 * delta was rejected with units unallocated and IMS stock left short.
 *
 * The two figures are separately branded types, so neither can be supplied where
 * the other is meant.
 */
export function planMintsoftAlignmentAllocations(input: {
  delta: number
  candidates: MintsoftAlignmentCandidate[]
  /**
   * LINE SCOPE: the residue of every transfer line any candidate draws from, keyed
   * by transfer-line id. Required (pass an empty map when every candidate is a PO
   * line); a candidate naming a transfer line that is absent from this map throws,
   * because "no entry" and "no cap" must not look alike.
   */
  transferLineResiduals: ReadonlyMap<string, TransferLineResidualQty>
}): {
  allocations: MintsoftAlignmentAllocation[]
  unallocatedQty: number
} {
  let remaining = Math.max(0, input.delta)
  if (remaining <= 0) {
    return {
      allocations: [],
      unallocatedQty: 0,
    }
  }

  const allocations: MintsoftAlignmentAllocation[] = []
  const candidates = [...input.candidates].sort((left, right) => {
    const leftTime = new Date(left.sortAt).getTime()
    const rightTime = new Date(right.sortAt).getTime()
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.sortId.localeCompare(right.sortId)
  })

  // Remaining LINE-scope capacity, depleted as this plan allocates, so several open
  // ASN rows on one transfer line share the line's residue instead of each getting
  // the whole of it.
  const lineCapacityRemaining = new Map<string, number>()

  for (const candidate of candidates) {
    if (remaining <= 0) break

    const transferLineId = candidate.transferLineId
    let availableQty = Math.max(0, candidate.asnResidualQty.qtyNumber)

    if (transferLineId != null) {
      let lineCapacity = lineCapacityRemaining.get(transferLineId)
      if (lineCapacity === undefined) {
        lineCapacity = Math.max(0, requireTransferLineResidualQty(input.transferLineResiduals, transferLineId).qtyNumber)
        lineCapacityRemaining.set(transferLineId, lineCapacity)
      }
      availableQty = Math.min(availableQty, lineCapacity)
    }

    if (availableQty <= 0) continue

    const qty = Math.min(remaining, availableQty)
    allocations.push({
      asnLineMapId: candidate.asnLineMapId,
      qty,
    })
    remaining -= qty
    if (transferLineId != null) {
      lineCapacityRemaining.set(transferLineId, (lineCapacityRemaining.get(transferLineId) ?? 0) - qty)
    }
  }

  return {
    allocations,
    unallocatedQty: remaining,
  }
}

// ---------------------------------------------------------------------------
// Align-down (6oyu.1)
// ---------------------------------------------------------------------------

export type MintsoftAlignDownPriorDiscrepancy = {
  delta: number | null
  lastSeenAt: Date | string
}

export type MintsoftAlignDownInput = {
  /** wmsQty - imsQty; align-down only considers negative deltas. */
  delta: number
  imsQty: number
  wmsQty: number
  reservedQty: number
  /** Whether the binding has an align-down adjustment reason configured. */
  reasonConfigured: boolean
  thresholds: ThresholdConfig
  /**
   * Outstanding inbound quantity for this product on OPEN ASNs: max(expected -
   * processed-receipts, 0) plus unreconciled alignment snapshot credits. A
   * positive value means IMS stock may include receipts Mintsoft has not booked
   * in yet, so the negative delta could be receipt timing, not shrinkage.
   */
  openAsnPendingQty: number
  /**
   * The OPEN QTY_MISMATCH discrepancy recorded by a PREVIOUS run, read BEFORE this
   * run upserts it. Null when this is the first run that sees the mismatch.
   */
  priorDiscrepancy: MintsoftAlignDownPriorDiscrepancy | null
  /** Start of the current sync run; the prior discrepancy must predate it. */
  runStartedAt: Date | string
}

export type MintsoftAlignDownDecision =
  | { action: 'apply'; qty: number }
  | { action: 'hold'; reason: string }

/**
 * Decide whether a NEGATIVE Mintsoft delta (IMS holds more than the WMS — the
 * shrinkage / already-shipped / oversell case) is safe to auto-correct by posting
 * a downward stock adjustment, or must stay a manual discrepancy.
 *
 * Gates, in order:
 *  1. reason configured    — align-down books a write-off; without an adjustment
 *                            reason (and its GL account) it never runs.
 *  2. thresholds configured — the discrepancy thresholds double as the auto-fix
 *                            ceiling. Unconfigured thresholds would make align-down
 *                            unbounded (a WMS API glitch returning zeros could
 *                            write off a warehouse), so both-null holds.
 *  3. within thresholds    — a breach means the delta is large enough to alert on;
 *                            large deltas stay manual.
 *  4. receipt timing       — open-ASN pending receipts can explain IMS holding
 *                            more than Mintsoft (booked-in not yet processed);
 *                            never write those off.
 *  5. persistence          — the SAME delta must have been recorded by a previous
 *                            run (dispatch webhooks/sweeps get a full cycle to
 *                            land before we treat the delta as real shrinkage).
 *  6. reservations         — never drive on-hand below reservedQty; the operator
 *                            must resolve the reserving orders first (this IS the
 *                            oversell aftermath).
 */
export function planMintsoftAlignDown(input: MintsoftAlignDownInput): MintsoftAlignDownDecision {
  if (input.delta >= 0) {
    return { action: 'hold', reason: 'Align-down only handles negative deltas.' }
  }

  if (!input.reasonConfigured) {
    return {
      action: 'hold',
      reason: 'Align To WMS auto-corrects downward deltas only when the binding has an align-down adjustment reason configured; set one in the Mintsoft binding settings.',
    }
  }

  if (input.thresholds.absoluteDelta == null && input.thresholds.percentDelta == null) {
    return {
      action: 'hold',
      reason: 'Align-down needs discrepancy thresholds configured — they cap how large a delta may be auto-corrected.',
    }
  }

  if (hasMintsoftThresholdBreach(input.imsQty, input.wmsQty, input.thresholds)) {
    return {
      action: 'hold',
      reason: 'Delta breaches the discrepancy thresholds; deltas this large stay manual.',
    }
  }

  if (input.openAsnPendingQty > 0) {
    return {
      action: 'hold',
      reason: `Open ASN lines still expect ${input.openAsnPendingQty} inbound for this product — the lower Mintsoft balance may be receipt timing, not shrinkage.`,
    }
  }

  const prior = input.priorDiscrepancy
  const priorSeenAt = prior ? new Date(prior.lastSeenAt).getTime() : null
  const runStart = new Date(input.runStartedAt).getTime()
  const priorMatchesCurrentDelta = prior?.delta != null && Math.abs(prior.delta - input.delta) < 0.0001
  if (!prior || priorSeenAt == null || priorSeenAt >= runStart || !priorMatchesCurrentDelta) {
    return {
      action: 'hold',
      reason: 'Armed: will auto-correct on the next sync run if the same delta persists (in-flight dispatches get one cycle to land).',
    }
  }

  if (input.wmsQty < input.reservedQty) {
    return {
      action: 'hold',
      reason: `Aligning down to ${input.wmsQty} would drive on-hand below the ${input.reservedQty} reserved for open orders; resolve the reserving orders first.`,
    }
  }

  return { action: 'apply', qty: input.delta }
}
