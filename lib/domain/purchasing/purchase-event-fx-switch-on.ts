import { xeroProducerSeamVerdict } from '@/lib/domain/accounting/xero-producer-seam'

/**
 * PER-EVENT FX: TURNING THE SWITCH ON IS REFUSED WHILE IMS IS NOT THE WRITER OF SUPPLIER BILLS IN XERO.
 *
 * Under the switch a foreign bill is valued at the prepayment (or bill-date) rate and split into a stock line on Stock in Transit and a price-variance
 * line, and the exchange-rate journal assumes the bill reached Xero that way. While the producer-side hold SHADOWS a PURCHASE_INVOICE (phase P1: Qoblex
 * writes bills natively), IMS's bill is not sent: Xero holds Qoblex's bill, at Qoblex's rate and without the split, so a bill IMS valued under the
 * switch would describe a document that does not exist. The alternative (letting such bills through the owner's gate for bills posted outside IMS,
 * with their price variance stated) was rejected: the gate is a one-off for bills from BEFORE the switch, whereas a shadowed bill would be created
 * under it every day, each needing a confirmation and a Xero read against the shared 1,000-a-day budget. So the switch waits for the cut-over that makes
 * IMS the bill writer (P2). Read by the settings command when the switch is turned on; null = no refusal.
 */
export function purchaseFxSwitchOnRefusal(options: { env?: Record<string, string | undefined>; now?: Date } = {}): string | null {
  const now = options.now ?? new Date()
  const verdict = xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: {}, obligationAt: now, now, ...(options.env ? { env: options.env } : {}) })
  if (verdict.kind !== 'shadow') return null
  return 'purchase_event_fx_rates_enabled cannot be turned on while the producer-side hold shadows supplier bills (PURCHASE_INVOICE) to Xero: another '
    + 'system writes the bills (phase P1), so the bills IMS would value under the switch would not be the ones in Xero. Turn it on once IMS is the bill writer (P2).'
}
