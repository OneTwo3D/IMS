/**
 * WHAT TO DO WITH AN UNSELLABLE UNIT THAT IS AT THE 3PL (switch return_condition_check_enabled). Pure, no imports, so the restock dialog can
 * show the same words the server refuses with.
 *
 * Quarantine is kept in IMS only, so a unit held at the 3PL is never quarantined: it is restocked as Sellable into the bound warehouse (which
 * also clears a refund's return in transit) and written off. WHO books the write-off depends on the binding's stock mode:
 *  - ALIGNED (stock sync mode ALIGN_TO_WMS, the warehouse system is the stock master): the 3PL writes the unit off in the warehouse system and
 *    the next stock sync aligns IMS down, booking the write-off under the binding's align-down reason. An IMS stock adjustment as well would
 *    write the unit off TWICE.
 *  - IMS_MASTER (NOTIFICATION_ONLY or DISABLED, IMS is the stock master): nothing aligns IMS, so the write-off is an IMS stock adjustment, and
 *    the 3PL must really write the unit off in the warehouse system too (not merely hold it), or the two disagree.
 *  - UNKNOWN (no binding found for the warehouse): both routes are given, keyed on the binding's mode.
 * Either way the units leave at FIFO cost (the warehouse's oldest open layers), not necessarily at the returned unit's own layer.
 */

export type WmsStockMode = 'ALIGNED' | 'IMS_MASTER' | 'UNKNOWN'

export function wmsStockModeFromSyncMode(stockSyncMode: string | null | undefined): WmsStockMode {
  if (stockSyncMode === 'ALIGN_TO_WMS') return 'ALIGNED'
  if (stockSyncMode === 'NOTIFICATION_ONLY' || stockSyncMode === 'DISABLED') return 'IMS_MASTER'
  return 'UNKNOWN'
}

const ALIGNED_ADVICE =
  'This warehouse is aligned to the warehouse system, so have the 3PL write the unit off there: the next stock sync aligns IMS down and books the write-off under the binding\'s align-down reason (map that reason to your write-off account). Do not also make a stock adjustment in IMS: that would write the unit off twice.'

const IMS_MASTER_ADVICE =
  'IMS is the stock master for this warehouse, so nothing books the write-off for you: have the 3PL write the unit off in the warehouse system (a real write-off, so it no longer counts it), and write it off in IMS with a stock adjustment in that warehouse (a reason mapped to your write-off account).'

const UNKNOWN_ADVICE =
  'How it is written off depends on the warehouse\'s binding: if its stock is aligned to the warehouse system, the 3PL writes it off there and the next stock sync books it in IMS under the align-down reason (do not also adjust in IMS); otherwise the 3PL writes it off there and you write it off in IMS with a stock adjustment (a reason mapped to your write-off account).'

const FIFO_NOTE = 'The write-off is valued at FIFO (the warehouse\'s oldest open layers), not at the returned unit\'s own layer.'

/** The write-off half of the advice for one stock mode. */
export function wmsUnsellableWriteOffAdvice(mode: WmsStockMode): string {
  const advice = mode === 'ALIGNED' ? ALIGNED_ADVICE : mode === 'IMS_MASTER' ? IMS_MASTER_ADVICE : UNKNOWN_ADVICE
  return `${advice} ${FIFO_NOTE}`
}

/** The returns-inbox refusal for an UNSELLABLE unit held at the 3PL. */
export function wmsUnsellableReturnRefusal(mode: WmsStockMode): string {
  return `This return is at the 3PL warehouse, and quarantine is kept in IMS only: the warehouse system would still count the unit, and stock alignment would book it into the bound warehouse a second time. Restock it as Sellable into the bound warehouse instead (that also clears a return in transit). ${wmsUnsellableWriteOffAdvice(mode)} Nothing was recorded.`
}

/** The refund-dialog refusal for an UNSELLABLE return of units that shipped from a WMS-bound warehouse. */
export function wmsUnsellableRefundRefusal(mode: WmsStockMode): string {
  return `These units shipped from a 3PL warehouse (bound to the warehouse system), so they go back to the 3PL, and quarantine is kept in IMS only: the warehouse system would count them again and stock alignment would book them into the bound warehouse a second time. Record the refund as Sellable into that warehouse (or with no stock return). ${wmsUnsellableWriteOffAdvice(mode)} Nothing was recorded.`
}
