/**
 * o3d-2gv2g LOW-6: the activity action of a receipt HELD because the order's invoice is being deleted (`DOCUMENT_DELETE_PENDING`). Not a decided
 * refusal (`invoice_payment_not_registered`): the inline callers read it as on record (nothing more to do for them now), but the scheduled receipt
 * sweep does not, so it registers the receipt once the delete has cleared. Its own module so the writer and the readers share one spelling.
 */
export const INVOICE_PAYMENT_HELD_DOCUMENT_DELETE_ACTION = 'invoice_payment_held_document_delete'
