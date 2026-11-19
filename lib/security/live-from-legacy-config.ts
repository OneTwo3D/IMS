/**
 * THE LEGACY SINGLE-VARIABLE LIVE-FROM CONFIGURATION, DETECTED.
 *
 * Before the per-step switchover phases, `WC_WRITES_LIVE_FROM` governed EVERY WooCommerce write and `MINTSOFT_WRITES_LIVE_FROM` every Mintsoft write. Now the
 * live-from instant is per switchover STEP (M, W, X), and the WooCommerce operations the bridge wrote (order status, tracking, partial shipments, product meta,
 * the WMS-status meta, TrackShip) read `MINTSOFT_WRITES_LIVE_FROM`, the invoice note and invoice document read `XERO_WRITES_LIVE_FROM` (and the Qoblex Xero
 * confirmation), and `WC_WRITES_LIVE_FROM` governs only stock and webhooks. An installation that already set either variable therefore changes behaviour on
 * upgrade without any setting changing. This pure module names the two shapes, for the startup log and for `writers:check`. Never throws.
 */

export type LegacyLiveFromFinding = {
  code: 'legacy-wc-only-live-from' | 'legacy-mintsoft-live-from-with-wc-grant'
  severity: 'fail' | 'warn'
  message: string
}

type Env = Record<string, string | undefined>

function isSet(env: Env, name: string): boolean {
  const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined
  return typeof value === 'string' && value !== ''
}

export const LEGACY_LIVE_FROM_UPGRADE_NOTE = 'See "Upgrading an installation that already sets WC_WRITES_LIVE_FROM or MINTSOFT_WRITES_LIVE_FROM" in docs/installation.md.'

export function legacyLiveFromFindings(env: Env): LegacyLiveFromFinding[] {
  const findings: LegacyLiveFromFinding[] = []
  try {
    if (isSet(env, 'WC_WRITES_LIVE_FROM') && !isSet(env, 'MINTSOFT_WRITES_LIVE_FROM')) {
      findings.push({
        code: 'legacy-wc-only-live-from',
        severity: 'fail',
        message: 'WC_WRITES_LIVE_FROM is set but MINTSOFT_WRITES_LIVE_FROM is not. Before the per-step phases WC_WRITES_LIVE_FROM alone made every WooCommerce write live; it now governs only step W (stock and webhooks). '
          + 'Order completions, tracking, partial shipments, product meta and the WMS-status meta read MINTSOFT_WRITES_LIVE_FROM (step M), and the invoice note and invoice document read XERO_WRITES_LIVE_FROM (step X), so they are NOT live on this configuration. '
          + `${LEGACY_LIVE_FROM_UPGRADE_NOTE}`,
      })
    }
    if (isSet(env, 'MINTSOFT_WRITES_LIVE_FROM') && isSet(env, 'WC_WRITEBACK_ALLOWED_ORIGIN') && !isSet(env, 'WC_WRITES_LIVE_FROM')) {
      findings.push({
        code: 'legacy-mintsoft-live-from-with-wc-grant',
        severity: 'warn',
        message: 'MINTSOFT_WRITES_LIVE_FROM and the WooCommerce grant (WC_WRITEBACK_ALLOWED_ORIGIN) are set but WC_WRITES_LIVE_FROM is not. Before the per-step phases WooCommerce writes were held in this configuration; step M now writes order status, tracking, partial shipments, product meta and the WMS-status meta to WooCommerce from MINTSOFT_WRITES_LIVE_FROM. '
          + `Confirm that the bridge is stopped (step M) before relying on it. ${LEGACY_LIVE_FROM_UPGRADE_NOTE}`,
      })
    }
  } catch {
    // never throws: an unreadable environment reports nothing here; the phase checks report it.
  }
  return findings
}
