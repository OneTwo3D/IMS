import { businessDateYmd } from '@/lib/business-date'
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
const HOLD_ENV = 'PRODUCER_HOLD_ENFORCED_DESTINATIONS'

/**
 * Whether the producer-side hold shadows a supplier bill (PURCHASE_INVOICE) dated `ymd`, judged on `env` (the application's own environment by default)
 * EXACTLY as the producer judges the bill's posting: from its payload date, which the seam reads as the START of that day in UTC (xeroObligationAt), so
 * a bill dated on a live-from day whose instant is after midnight is shadowed, as its posting is (#1164 HIGH-1).
 *
 * THE ASSUMPTION: a hold that is NOT enforced (the variable empty, or Xero not among its destinations) means IMS writes the bills itself (the verdict is
 * `legacy` or `live`, so nothing is shadowed). That is how the hold is designed: an installation that does not enforce it sends its postings.
 */
export function purchaseFxBillWriterShadowed(ymd: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  return xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: { date: ymd.slice(0, 10) }, now, env }).kind === 'shadow'
}

/** Whether an exchange-rate difference journal (PURCHASE_FX_VARIANCE) dated `ymd` would be shadowed now, judged as its producer judges it. */
export function purchaseFxJournalShadowed(ymd: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  return xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_FX_VARIANCE', payload: { date: ymd.slice(0, 10) }, now, env }).kind === 'shadow'
}

/**
 * THE TURN-ON CHECK (the settings command's `purchase-fx-bill-writer` interlock). Judged on the INSTALLATION's environment ONLY: the env file the
 * application's service runs with (`--env-file`, read with the first-load `readEnvFile`), which is mandatory, and which must itself carry the hold's
 * variable. A shell that only happens to carry (or lack) it is not the installation, so the shell is not consulted. That file must be the single source the
 * service takes its environment from: a variable the service gets from anywhere else (a unit drop-in, a second file) is not seen here. Null = no refusal.
 *
 * The check runs only when the switch is turned on. The release that enables the interlock must therefore also check the STORED value: a `true` stored
 * before (by a database edit or a restore) is not turned on again, so it would never meet this check.
 */
export function purchaseFxSwitchOnRefusal(options: {
  /** The installation env file's values; null = no --env-file was given. */
  installationEnv?: Record<string, string> | null
  now?: Date
} = {}): string | null {
  const installationEnv = options.installationEnv ?? null
  if (!installationEnv) {
    return 'purchase_event_fx_rates_enabled cannot be turned on without --env-file <the env file the application\'s service runs with>: the bill-writer check is judged '
      + 'on the installation\'s own environment, not on this shell.'
  }
  if (!Object.prototype.hasOwnProperty.call(installationEnv, HOLD_ENV)) {
    return `purchase_event_fx_rates_enabled cannot be turned on: the installation env file does not set ${HOLD_ENV}, so it is not known whether the producer-side hold `
      + 'shadows supplier bills. Set it there (an empty value means the hold is not enforced, which this check takes as IMS writing the bills).'
  }
  const now = options.now ?? new Date()
  if (!purchaseFxBillWriterShadowed(businessDateYmd(now), installationEnv, now)) return null
  return 'purchase_event_fx_rates_enabled cannot be turned on while the producer-side hold shadows supplier bills (PURCHASE_INVOICE) to Xero: another '
    + 'system writes the bills (phase P1), so the bills IMS would value under the switch would not be the ones in Xero. Turn it on once IMS is the bill writer (P2).'
}
