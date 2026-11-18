import type { Prisma } from '@/app/generated/prisma/client'

/**
 * WHICH `wms_asn_maps` ROWS STILL EXPECT UNITS — stated once, for every reader of "incoming stock".
 *
 * `BOOKED_IN` DOES NOT IMPLY A RECEIPT. The Mintsoft sync writes `BOOKED_IN` from the WAREHOUSE's status
 * (`app/actions/mintsoft-sync.ts`, where the ASN is finalized after a create and after a duplicate
 * recovery) with `closedAt: null` and the receipt not yet applied; only the booked-in service sets
 * `closedAt`, atomically with the receipt it applies. So an ASN is out of the incoming-stock arm only when
 * it is `BOOKED_IN` AND `closedAt` is set. `BOOKED_IN` with `closedAt` null means "the warehouse says it is
 * booked in, IMS has not accounted for the receipt": its expected quantity is neither on hand nor
 * accounted, and dropping it makes the units vanish from incoming for as long as that lasts.
 *
 * Quantities already credited (`qtyAccountedViaSnapshot` / `qtyAccountedViaReceipt`) are subtracted by the
 * readers, so including such a row never double counts a receipt that has been applied.
 *
 * The next writer of `BOOKED_IN` must keep `closedAt` null until the receipt is applied, or this reading
 * stops being true.
 */
export const OPEN_WMS_ASN_STATUSES = ['OPEN', 'PARTIALLY_BOOKED_IN'] as const

/** Prisma filter on a `wms_asn_maps` row (`asn` relation) for "still expects units". */
export function wmsAsnAwaitingUnitsWhere(): Prisma.WmsAsnMapWhereInput {
  return {
    OR: [
      { status: { in: [...OPEN_WMS_ASN_STATUSES] } },
      { status: 'BOOKED_IN', closedAt: null },
    ],
  }
}

/** The same rule over a loaded row. `closedAt` wins for BOOKED_IN only (a closed-short ASN keeps its status). */
export function isWmsAsnAwaitingUnits(asn: { status: string; closedAt?: Date | null }): boolean {
  if (asn.status === 'BOOKED_IN') return asn.closedAt == null
  return (OPEN_WMS_ASN_STATUSES as readonly string[]).includes(asn.status)
}
