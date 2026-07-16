/**
 * Find purchase bills that share ONE Xero document — the wreckage of o3d-6l3 (o3d-4i0).
 *
 * Until o3d-6l3 was fixed, every bill raised against a PO was sent to Xero with
 * InvoiceNumber = that PO's own reference, and Xero's POST /Invoices UPSERTS on InvoiceNumber.
 * So the second instalment did not create a bill: it OVERWROTE the first and was handed its
 * InvoiceID. Any PO billed more than once therefore ends with TWO IMS bills pointing at ONE
 * Xero document, while Xero holds a single bill carrying the LAST instalment's value.
 *
 * Two consequences, both silent:
 *   - payables understate the supplier by every instalment except the last;
 *   - PURCHASE_INVOICE_UPDATE posts to /Invoices/{accountingInvoiceId}, so editing EITHER IMS
 *     bill rewrites the same shared document. They stay coupled until repaired.
 *
 * REPORTS ONLY. Repair is a finance decision, not a script's: restoring the missing payables
 * means creating documents in a period that may be closed, and choosing what date and number
 * they carry. A tool that "helpfully" re-posted them could book into a closed period.
 *
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/find-aliased-purchase-bills.ts
 *   NODE_OPTIONS='--import tsx' node scripts/find-aliased-purchase-bills.ts --db <postgres-url>
 *
 * Exits 1 when anything is found, so it can gate a deploy or run from cron.
 */
import { Client } from 'pg'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

type Row = {
  accounting_invoice_id: string
  bills: string
  po_reference: string
  total_base: string
}

async function main() {
  const url = arg('--db') ?? process.env.DATABASE_URL
  if (!url) throw new Error('Pass --db <postgres-url> or run with node --env-file=.env')

  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    // The population at risk: a PO billed once cannot have collided, because there was nothing
    // to overwrite. Reporting it separately turns "0 aliased" into a meaningful all-clear rather
    // than an absence of evidence — 0 aliased out of 0 multi-bill POs says the bug never fired
    // here; 0 out of 200 says something rather stronger.
    const atRisk = await db.query<{ count: string }>(
      `select count(*)::text as count from (
         select "poId" from purchase_invoices group by "poId" having count(*) > 1
       ) x`,
    )

    const aliased = await db.query<Row>(
      `select pi.accounting_invoice_id,
              string_agg(coalesce(pi."invoiceNumber", '(no number)') || ' = ' || pi."totalBase"::text, '  |  '
                         order by pi."createdAt") as bills,
              max(po.reference) as po_reference,
              sum(pi."totalBase")::text as total_base
         from purchase_invoices pi
         join purchase_orders po on po.id = pi."poId"
        where pi.accounting_invoice_id is not null
        group by pi.accounting_invoice_id
       having count(*) > 1
        order by max(po.reference)`,
    )

    console.log(`POs billed more than once (could have collided): ${atRisk.rows[0].count}`)
    console.log(`Aliased Xero documents (two+ IMS bills sharing one): ${aliased.rows.length}`)

    if (!aliased.rows.length) {
      console.log('\nNothing to repair on this instance.')
      return
    }

    console.log('\nEach line below is ONE Xero bill that several IMS bills believe is theirs.')
    console.log('Xero holds the LAST instalment only; the rest of the value is missing from payables.\n')
    for (const r of aliased.rows) {
      console.log(`  PO ${r.po_reference}`)
      console.log(`    Xero document : ${r.accounting_invoice_id}`)
      console.log(`    IMS bills     : ${r.bills}`)
      console.log(`    IMS total     : ${r.total_base}   <- what the supplier is owed`)
      console.log('')
    }
    console.log('REPAIR IS A FINANCE DECISION. The missing bills must be re-posted to restore')
    console.log('payables, but that books documents into a period that may be closed, and someone')
    console.log('has to choose their date and number. Do NOT bulk re-sync blindly.')
    process.exitCode = 1
  } finally {
    await db.end()
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
