/**
 * The invoicing state vocabulary, import-free so a client component (the sales order list filter, the order page badge) can use it
 * without pulling the derivation, which reads the database. The derivation lives in invoicing-state.ts.
 */
export const INVOICING_STATES = ['NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED'] as const
export type InvoicingState = (typeof INVOICING_STATES)[number]

export const INVOICING_STATE_LABELS: Record<InvoicingState, string> = {
  NOT_INVOICED: 'Not invoiced',
  PARTIALLY_INVOICED: 'Partially invoiced',
  FULLY_INVOICED: 'Fully invoiced',
}

/** Badge colours, in the same family as the order status chips. */
export const INVOICING_STATE_CLASS: Record<InvoicingState, string> = {
  NOT_INVOICED: 'bg-slate-100 text-slate-700 border-slate-200',
  PARTIALLY_INVOICED: 'bg-amber-100 text-amber-800 border-amber-200',
  FULLY_INVOICED: 'bg-emerald-100 text-emerald-800 border-emerald-200',
}
