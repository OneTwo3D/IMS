import type { WmsWriteClearance, WmsWriteOperation } from './types'

/**
 * THE ONE PLACE A WAREHOUSE WRITE CLEARANCE IS MINTED.
 *
 * A clearance (WmsWriteClearance, lib/connectors/wms/types.ts) is a compile-time token with no runtime content: every warehouse
 * write method takes one as its last argument, and the only way to hold one is to have been told `proceed` by a producer seam
 * (lib/connectors/wms/producer-seam.ts for the generic flows, lib/connectors/mintsoft/producer-seam.ts for the destination's own).
 * The type assertion that makes the token out of nothing is here and nowhere else, and the producer census
 * (scripts/producer-census-mintsoft.ts, MINT-5) fails on a second one and on a call of this function outside the two seams.
 */
const CLEARANCE: unknown = Object.freeze({})

export function mintWmsWriteClearance<Op extends WmsWriteOperation>(): WmsWriteClearance<Op> {
  return CLEARANCE as WmsWriteClearance<Op>
}
