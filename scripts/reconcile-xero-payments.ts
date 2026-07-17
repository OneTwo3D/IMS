#!/usr/bin/env tsx
/**
 * On-demand Xero payment reconciliation (o3d-2s8).
 *
 * The daily cron runs this in report mode automatically; this script is for running it NOW — most
 * importantly to answer the o3d-1d9 question (were orders wrongly advanced to PROCESSING /
 * auto-allocated while the pre-#494 poller marked unpaid invoices paid) by reading the true Xero
 * status of every locally-linked document.
 *
 *   npx tsx --env-file=.env scripts/reconcile-xero-payments.ts            # report only (safe)
 *   npx tsx --env-file=.env scripts/reconcile-xero-payments.ts --apply    # also collect missed payments
 *
 * --apply mirrors the poller's forward pass for genuinely-missed payments (paidAt + status advance +
 * auto-allocation); suspect advances are ALWAYS report-only — telling a wrongful advance apart from a
 * legitimate later reversal is a human's call.
 */
import { reconcileXeroPayments } from '../lib/connectors/xero/payment-reconcile.ts'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  console.log(`Xero payment reconcile — ${apply ? 'APPLY (will mark missed payments paid)' : 'REPORT ONLY'}\n`)

  const r = await reconcileXeroPayments({ apply })

  console.log(`checked:          ${r.checked} locally-linked document(s)`)
  console.log(`missed payments:  ${r.missedPayments.length}${apply ? ` (${r.missedPayments.filter((m) => m.applied).length} applied)` : ''}`)
  console.log(`suspect advances: ${r.suspectAdvances.length}  (IMS treats as paid/advanced, Xero says not PAID — REVIEW)`)
  console.log(`not found in Xero:${r.unknown.length}`)
  console.log(`errors:           ${r.errors.length}`)

  if (r.missedPayments.length) {
    console.log('\n--- MISSED PAYMENTS (Xero PAID, IMS unpaid) ---')
    for (const m of r.missedPayments) console.log(`  ${m.applied ? '[applied]' : '[report]'} ${m.label} — paid ${m.paidDate}`)
  }
  if (r.suspectAdvances.length) {
    console.log('\n--- SUSPECT ADVANCES (the o3d-1d9 question — review each) ---')
    for (const s of r.suspectAdvances) console.log(`  ${s.label} — Xero status ${s.xeroStatus}`)
  }
  if (r.unknown.length) {
    console.log('\n--- NOT FOUND IN XERO (stale/mis-mapped accountingInvoiceId?) ---')
    for (const u of r.unknown) console.log(`  ${u.label} — accountingInvoiceId ${u.accountingInvoiceId}`)
  }
  if (r.errors.length) {
    console.log('\n--- ERRORS ---')
    for (const e of r.errors) console.log(`  ${e}`)
  }

  process.exit(r.errors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
