/**
 * WooCommerce order-currency exposure audit (o3d-batch-ret r14, Codex HIGH).
 *
 * Read-only. Reports WooCommerce-linked sales orders whose stored currency the evidence disagrees
 * with — including the ones the pre-r13 `wcOrder.currency || 'GBP'` fallback invented, as far as
 * they can be identified at all. Read the header of
 * `lib/connectors/woocommerce/sync/order-currency-audit.ts` before acting on the output: an
 * invented GBP and a genuine GBP are identical in the order row, so this reports OUTSIDE evidence,
 * not a list of fallback orders.
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/audit-wc-order-currency.ts
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/audit-wc-order-currency.ts --live --limit 200
 *
 * `--live` adds a GET of each order from WooCommerce (reads only; the audit never writes to the
 * store or to IMS). `--delay <ms>` spaces those reads out. `--json` prints the raw report.
 *
 * Exits 1 when anything is flagged, so it can gate a deploy.
 */

import {
  runWcOrderCurrencyAudit,
  type WcOrderCurrencyVerdict,
} from '@/lib/connectors/woocommerce/sync/order-currency-audit'

const VERDICT_EXPLANATION: Record<WcOrderCurrencyVerdict, string> = {
  non_canonical_stored_code:
    'the stored code is not a canonical AAA — current code cannot have written it, and the FX '
    + 'lookup and accounting payload can read it differently from each other',
  fallback_invented:
    'every archived WooCommerce delivery for this order states NO usable currency, yet a code is '
    + 'stored — this is the pre-r13 fallback, positively identified',
  disagrees_with_archived_payload:
    'the archived deliveries state a currency and it is not the one stored',
  disagrees_with_live:
    'the live WooCommerce order states a different currency (not by itself proof of invention — a '
    + 'currency can have been changed in the store since import)',
  live_states_nothing:
    'the live order STILL states no usable currency — the exact condition the fallback fired on',
  live_unreadable: 'the live order could not be read; nothing was judged',
  agrees: 'evidence agrees with what IMS stored',
  no_evidence: 'no archived delivery and no live read — nothing to judge it against',
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const live = process.argv.includes('--live')
  const asJson = process.argv.includes('--json')
  const limit = Number(arg('--limit') ?? '') || undefined
  const liveDelayMs = Number(arg('--delay') ?? '') || 0

  const report = await runWcOrderCurrencyAudit({ live, limit, liveDelayMs })

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`WooCommerce order currency audit @ ${report.checkedAt}`)
    console.log(`  orders scanned:            ${report.scanned}`)
    console.log(`  live WooCommerce read:     ${report.liveRead ? 'yes' : 'NO (--live not passed)'}`)
    console.log(
      `  archived deliveries:       ${report.archive.orderPayloadsScanned} payload(s) covering `
        + `${report.archive.ordersWithArchivedPayload} order(s)`,
    )
    console.log('  verdicts:')
    for (const [verdict, count] of Object.entries(report.summary)) {
      if (count > 0) console.log(`    ${verdict.padEnd(32)} ${count}`)
    }

    for (const finding of report.findings) {
      console.log(`\n[${finding.verdict}] order ${finding.orderNumber ?? finding.orderId} (WC ${finding.externalOrderId})`)
      console.log(`  ${VERDICT_EXPLANATION[finding.verdict]}`)
      console.log(
        `  stored=${JSON.stringify(finding.storedCurrency)} live=${finding.liveCurrency ?? '-'} `
          + `archived=[${finding.archivedCurrencies.join(', ')}] `
          + `payloads=${finding.archivedPayloads} (${finding.archivedPayloadsStatingNoCurrency} stated none)`,
      )
      console.log(
        `  money: invoiced=${finding.monetary.invoicedAt ?? '-'} `
          + `xeroInvoice=${finding.monetary.accountingInvoiceId ?? '-'} `
          + `paid=${finding.monetary.paidAt ?? '-'} `
          + `payments=${finding.monetary.payments} refunds=${finding.monetary.refunds} `
          + `→ ${finding.monetary.uncommitted ? 'UNCOMMITTED' : 'COMMITTED — do not touch unattended'}`,
      )
    }
  }

  if (report.findings.length === 0) {
    if (!asJson) {
      console.log(
        `\n✓ Nothing flagged${report.liveRead ? '' : ' — but WITHOUT --live this only used the stored shape and the archived deliveries'}.`,
      )
    }
    return
  }

  if (!asJson) {
    console.log(
      '\n✗ These orders need a decision before anything is corrected.\n'
        + '  Nothing is rewritten by this script, deliberately: `currency` selects the FX rate, the\n'
        + '  ledger an invoice posts to and the bank account a payment settles into, and the order\n'
        + '  totals were converted at the invented rate too — so a code-only rewrite leaves the *Base\n'
        + '  figures wrong in a new way. Correct only the UNCOMMITTED subset, in its own reviewed\n'
        + '  change, with this output read first.',
    )
  }
  process.exitCode = 1
}

main().catch((error) => {
  console.error('WooCommerce order currency audit failed:', error)
  process.exitCode = 1
})
