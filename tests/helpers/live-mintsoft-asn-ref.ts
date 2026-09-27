import { normalizeMintsoftAsn } from '@/lib/connectors/mintsoft/api/normalizers'
import type { WmsAsnRef } from '@/lib/connectors/wms/types'
import { liveAsnBody, liveAsnItem } from '@/tests/fixtures/mintsoft-live-asn-bodies'

/**
 * A `WmsAsnRef` FOR A BOOKED-IN ASN, BUILT THE WAY PRODUCTION BUILDS ONE — from a live-shaped
 * Mintsoft `GET /api/ASN/{id}` body, through the real `normalizeMintsoftAsn`. o3d-btiw.
 *
 * WHY THIS EXISTS. Five tests used to hand a fabricated `{ …, quantity: N }` line straight to
 * `processBookedInEvent`. Each was a faithful answer to the WRONG QUESTION: the fabricated field was
 * the one the normalizer produced, not the one Mintsoft serves, so all five passed while every real
 * ASN item normalized to no quantity at all and the book-in applied nothing. A test that builds the
 * ref itself cannot notice a wire-shape defect — so these now go through the wire.
 */
export function liveMintsoftBookedInAsnRef(input: {
  externalAsnId: string
  externalLineId: string
  sourceLineId: string
  sku: string
  /** `ASNItem.QuantityExpected`. */
  expectedQty: number
  /** `ASNItem.QuantityBooked` — the quantity IMS books into stock. */
  bookedQty: number
  /** `ASNItem.QuantityReceieved` — arrived at the warehouse. Defaults to the booked quantity. */
  arrivedQty?: number
  statusName?: string
}): WmsAsnRef {
  const body = liveAsnBody({
    poReference: input.externalAsnId,
    statusName: input.statusName ?? 'BOOKEDIN',
    statusId: 4,
    items: [liveAsnItem({
      id: Number.isFinite(Number(input.externalLineId)) ? Number(input.externalLineId) : undefined,
      sourceLineId: input.sourceLineId,
      sku: input.sku,
      expected: input.expectedQty,
      booked: input.bookedQty,
      received: input.arrivedQty ?? input.bookedQty,
      complete: input.bookedQty >= input.expectedQty,
    })],
  })
  // The item's own `ID` is what the normalizer reads as `externalLineId`, and the seeded ASN line map
  // may carry a non-numeric one, so it is written verbatim after the fixture builds the item.
  ;(body.Items as Record<string, unknown>[])[0]!.ID = input.externalLineId
  const normalized = normalizeMintsoftAsn(body, { externalAsnIdFallback: input.externalAsnId })
  if (!normalized) {
    throw new Error('the live-shaped ASN body did not normalize — the fixture and the normalizer disagree')
  }
  return { ...normalized, externalAsnId: input.externalAsnId }
}

/**
 * THE SAME THING FOR AN ASN WITH SEVERAL ITEMS (o3d-8f0p6 r4).
 *
 * An ASN can cover more than one purchase order, and the book-in posts one journal per PO, so the
 * multi-PO arm needs a ref whose lines really came through `normalizeMintsoftAsn` rather than being
 * assembled by hand — the same o3d-btiw discipline as the single-line form above, and for the same
 * reason: a fabricated line cannot notice a wire-shape defect.
 */
export function liveMintsoftBookedInAsnRefMultiLine(input: {
  externalAsnId: string
  lines: Array<{
    externalLineId: string
    sourceLineId: string
    sku: string
    expectedQty: number
    bookedQty: number
    arrivedQty?: number
  }>
  statusName?: string
}): WmsAsnRef {
  const body = liveAsnBody({
    poReference: input.externalAsnId,
    statusName: input.statusName ?? 'BOOKEDIN',
    statusId: 4,
    items: input.lines.map((line) => liveAsnItem({
      id: Number.isFinite(Number(line.externalLineId)) ? Number(line.externalLineId) : undefined,
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      expected: line.expectedQty,
      booked: line.bookedQty,
      received: line.arrivedQty ?? line.bookedQty,
      complete: line.bookedQty >= line.expectedQty,
    })),
  })
  // As above: the seeded line maps carry non-numeric external ids, so each item's own `ID` — which is
  // what the normalizer reads as `externalLineId` — is written verbatim after the fixture builds it.
  const items = body.Items as Record<string, unknown>[]
  input.lines.forEach((line, index) => {
    items[index]!.ID = line.externalLineId
  })
  const normalized = normalizeMintsoftAsn(body, { externalAsnIdFallback: input.externalAsnId })
  if (!normalized) {
    throw new Error('the live-shaped ASN body did not normalize — the fixture and the normalizer disagree')
  }
  if (normalized.lines.length !== input.lines.length) {
    throw new Error(
      `the normalizer produced ${normalized.lines.length} line(s) from ${input.lines.length} item(s); `
      + 'the multi-line fixture and the normalizer disagree',
    )
  }
  return { ...normalized, externalAsnId: input.externalAsnId }
}
