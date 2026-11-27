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
 * Whether the producer-side hold shadows a supplier bill (PURCHASE_INVOICE) dated `at`, judged on `env` (the application's own environment by default).
 *
 * THE ASSUMPTION: a hold that is NOT enforced (the variable empty, or Xero not among its destinations) means IMS writes the bills itself (the verdict is
 * `legacy` or `live`, so nothing is shadowed). That is how the hold is designed: an installation that does not enforce it sends its postings.
 */
export function purchaseFxBillWriterShadowed(at: Date, env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  return xeroProducerSeamVerdict({ connector: 'xero', type: 'PURCHASE_INVOICE', payload: {}, obligationAt: at, now, env }).kind === 'shadow'
}

/**
 * THE TURN-ON CHECK (the settings command's `purchase-fx-bill-writer` interlock). Judged on the INSTALLATION's environment: the env file the application
 * runs with (`--env-file`, read with the first-load `readEnvFile`), whose values win over this shell's; a shell that only happens to carry (or lack) the
 * variable is not the installation. Refused when the hold's variable is in neither (nothing says whether the hold is enforced), and when, so judged, the
 * hold shadows supplier bills now. Null = no refusal.
 *
 * The check runs only when the switch is turned on. The release that enables the interlock must therefore also check the STORED value: a `true` stored
 * before (by a database edit or a restore) is not turned on again, so it would never meet this check.
 */
export function purchaseFxSwitchOnRefusal(options: {
  processEnv?: Record<string, string | undefined>
  installationEnv?: Record<string, string> | null
  now?: Date
} = {}): string | null {
  const processEnv = options.processEnv ?? process.env
  const installationEnv = options.installationEnv ?? null
  const inFile = installationEnv ? Object.prototype.hasOwnProperty.call(installationEnv, HOLD_ENV) : false
  const inShell = Object.prototype.hasOwnProperty.call(processEnv, HOLD_ENV) && processEnv[HOLD_ENV] !== undefined
  if (!inFile && !inShell) {
    return `purchase_event_fx_rates_enabled cannot be turned on: ${HOLD_ENV} is in neither the installation env file (pass it with --env-file) nor this shell, so `
      + 'it is not known whether the producer-side hold shadows supplier bills. Run with --env-file <the env file the application uses>. (An empty value means '
      + 'the hold is not enforced, which this check takes as IMS writing the bills.)'
  }
  const env = { ...processEnv, ...(installationEnv ?? {}) }
  if (!purchaseFxBillWriterShadowed(options.now ?? new Date(), env, options.now ?? new Date())) return null
  return 'purchase_event_fx_rates_enabled cannot be turned on while the producer-side hold shadows supplier bills (PURCHASE_INVOICE) to Xero: another '
    + 'system writes the bills (phase P1), so the bills IMS would value under the switch would not be the ones in Xero. Turn it on once IMS is the bill writer (P2).'
}
