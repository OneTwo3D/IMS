/**
 * The WMS returned a record we cannot act on — not a transport failure, and not a
 * fault of the local order.
 *
 * The motivating case (o3d-6j8) is a record that reads as DISPATCHED while omitting
 * the fulfilment fields the dispatch write consumes. Applying it would mark the IMS
 * order SHIPPED with no tracking, and SHIPPED leaves the dispatch poll set, so the
 * real tracking number could never land afterwards.
 *
 * Why a distinct type rather than a plain Error: the generic dispatch sweep must map
 * this to UNRESOLVED (hold the delta watermark, mark the job PARTIAL) and NOT to a
 * per-link reconciliation error. A plain Error takes a failure strike, so systemic
 * connector-level schema drift would dead-letter every active link in turn, exclude
 * them all from the candidate queries, flood the exception inbox with one
 * notification per order, and require individual replay even after the WMS recovers —
 * fulfilment would stop tenant-wide. The condition is connector drift, not order
 * damage, so links must stay eligible for automatic recovery.
 *
 * Deliberately connector-AGNOSTIC and declared at the generic WMS boundary: any
 * connector can raise it and the sweep stays free of connector-specific knowledge.
 */
export class WmsUnresolvableRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WmsUnresolvableRecordError'
  }
}

/** True when this error means "the WMS record cannot be acted on", not "the call failed". */
export function isWmsUnresolvableRecordError(error: unknown): error is WmsUnresolvableRecordError {
  return error instanceof WmsUnresolvableRecordError
}
