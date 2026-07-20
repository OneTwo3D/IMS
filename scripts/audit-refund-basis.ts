/**
 * Refund BASIS audit — the deploy gate for any net-basis refund change (o3d-vbc / o3d-w00).
 *
 * Read-only. Reports every refund whose stored total cannot be shown to be NET while a net-basis change
 * would read it as such. Run it against an instance BEFORE enabling that change.
 *
 * A clean run means every scanned refund on a taxable order PASSED the defined arithmetic reconstruction
 * checks — not that no gross row can exist. Basis is not recorded in the schema, so it is inferred; see
 * lib/domain/sales/refund-basis-audit.ts for exactly what is and is not proven (o3d-vbc).
 *
 *   runuser -u ims -- env HOME=/tmp npx tsx scripts/audit-refund-basis.ts
 *
 * Exits 1 when anything is flagged, so it can gate a deploy.
 */

import { runRefundBasisAuditReport } from '@/lib/domain/sales/refund-basis-audit'

async function main() {
  const report = await runRefundBasisAuditReport()

  console.log(`Refund basis audit @ ${report.checkedAt}`)
  console.log(
    `  findings: ${report.summary.total} ` +
      `(critical ${report.summary.critical}, warning ${report.summary.warning}, info ${report.summary.info})`,
  )

  if (report.findings.length === 0) {
    console.log(
      '\n✓ Every scanned refund on a taxable order passed the arithmetic reconstruction checks.\n' +
        '  This does NOT prove no gross row exists — basis is not recorded in the schema, so it is\n' +
        '  inferred. Review the checks in refund-basis-audit.ts before relying on this for a change.',
    )
    return
  }

  for (const finding of report.findings) {
    console.log(`\n[${finding.severity}] ${finding.code}`)
    console.log(`  ${finding.message}`)
    if (finding.orderId) console.log(`  orderId=${finding.orderId} refundId=${finding.refundId ?? '-'}`)
    console.log(`  ${JSON.stringify(finding.details)}`)
  }

  console.log(
    '\n✗ Resolve these before enabling a net-basis refund change (o3d-vbc).\n' +
      '  critical = reconstructed as GROSS, or an unlinked manual refund on a tax-inclusive order.\n' +
      '  warning  = basis UNRESOLVED. Do NOT blind-backfill these: an unlinked Woo refund is either\n' +
      '             monetary-only (gross) or shipping-only (already net), and "correcting" the latter\n' +
      '             would corrupt it. Resolve each against its Woo payload / source first.',
  )
  process.exitCode = 1
}

main().catch((error) => {
  console.error('Refund basis audit failed:', error)
  process.exitCode = 1
})
