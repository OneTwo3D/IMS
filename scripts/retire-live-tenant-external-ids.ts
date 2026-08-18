/**
 * o3d-t74p / o3d-s36z — retire the stranded Xero external ids in the e2e database.
 * (Named for the LIVE tenant it was built to target. That attribution turned out to be wrong —
 * see the warning immediately below. The filename is kept so the PR/issue history still resolves.)
 *
 * !!! READ THIS BEFORE RUNNING — THE ORIGINAL PREMISE WAS DISPROVED (2026-08-10) !!!
 *
 * This script was written on the belief that the 553 ids in the CSV address objects in the LIVE
 * organisation. THEY DO NOT. The org-side audit (audit-xero-live-e2e-footprint.ts, run against
 * One Two Enterprises Ltd dd2af957-3438-4010-8e85-7841c33c8328) resolved every one of them: all
 * 553 return 404 and the overlap with the org's actual E2E footprint is 0 of 553. They are
 * DEMO-tenant ids, from the periods the instance was pointed at Demo Company (UK).
 *
 * That inverts the argument for running this. The instance is connected to Demo RIGHT NOW, so
 * these ids are not stranded pointers to an unreachable org — they are plausibly CURRENT and
 * VALID references into the tenant the instance is actually using. Nulling them would not be
 * retiring dead ids; it would be deleting live back-references, after which the sweep re-creates
 * links and the pollers stop reconciling the documents they belong to.
 *
 * So this script is NOT the cleanup for o3d-t74p. The live-org cleanup is
 * remove-xero-live-e2e-footprint.ts, indexed from the ORG (contact/item prefixes), because the
 * sync log indexes the wrong tenant entirely. This file is kept for two reasons only: it is the
 * evidence trail for how the id set was scoped, and it remains the tool to use IF a future
 * decision is that e2e's Demo-tenant history should be dropped wholesale. Confirm which tenant
 * the ids belong to before passing --apply, because the CSV name says "live" and it is wrong.
 *
 * o3d-s36z (nothing stamps a tenant onto these rows, so nothing can tell which org an id belongs
 * to) is the underlying defect and is UNCHANGED — this incident is precisely its consequence.
 *
 * Both consumers key purely on the id being present, so clearing an id does remove the row from
 * both paths by construction:
 *   • the back-reference sweep selects `externalTransactionId: { not: null }`
 *     (lib/domain/accounting/back-reference.ts:402 — moved out of sync-processor.ts and now shared
 *     with QuickBooks; repairXeroBackReferences is a thin wrapper at sync-processor.ts:1650)
 *   • the payment pollers match documents by `accountingInvoiceId: { in: [...] }`
 *     (lib/connectors/xero/payment-poller.ts:101,177,248)
 *
 * NOTE the sweep has since grown per-row lifecycle columns on accounting_sync_logs
 * (backReferenceCheckedAt, backReferenceFollowUpsPendingAt, backReferenceEvidenceCompactedAt).
 * This script does not clear them. A row whose id is nulled while it still carries a pending
 * follow-up obligation keeps that marker with nothing left to drive it — harmless in e2e, but it
 * is why this must not be pointed at any database that matters.
 *
 * The ids are NOT lost: /root/xero-live-e2e-contamination-20260804.csv is the archive, and it is
 * the only remaining link for the 106 sales-invoice rows whose local order no longer exists.
 *
 * SAFETY
 *   • Dry run by default; --apply is required to write, and writes in a single transaction.
 *   • Refuses to run against anything but the e2e database.
 *   • Refuses to run if this instance is currently connected to a non-Demo tenant — that would
 *     mean the incident is live again and clearing local ids is the wrong response.
 *   • Every statement is bounded by the explicit id list from the CSV. There is no unqualified
 *     UPDATE here, so a row outside that set cannot be touched.
 *
 * USAGE
 *   DATABASE_URL=postgresql://.../onetwo3d_ims_e2e node_modules/.bin/tsx \
 *     scripts/retire-live-tenant-external-ids.ts [--apply]
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const CSV_PATH = arg('csv', '/root/xero-live-e2e-contamination-20260804.csv')!

const E2E_DATABASE = 'onetwo3d_ims_e2e'
const DEMO_TENANT_ID = '5c949ed5-9ac0-4f43-b716-b38ee59fe7cf'

/** Document columns that hold an external accounting id (lib/domain/accounting/back-reference.ts). */
const BACK_REFERENCE_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'sales_orders', column: 'accounting_invoice_id' },
  { table: 'purchase_invoices', column: 'accounting_invoice_id' },
  { table: 'sales_order_refunds', column: 'accounting_credit_note_id' },
  { table: 'supplier_credit_notes', column: 'accounting_credit_note_id' },
]

function readContaminatedIds(path: string): string[] {
  const text = readFileSync(path, 'utf8').trim()
  const [header, ...lines] = text.split(/\r?\n/)
  const idx = header.split(',').indexOf('externalTransactionId')
  if (idx < 0) throw new Error(`${path} has no externalTransactionId column`)
  const ids = lines.map((l) => l.split(',')[idx]).filter(Boolean)
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) {
    console.log(`note: ${ids.length - unique.length} duplicate id(s) in the CSV, de-duplicated`)
  }
  return unique
}

async function guard(db: Client): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.includes(E2E_DATABASE)) {
    throw new Error(`ABORT: DATABASE_URL does not point at ${E2E_DATABASE}. This script is for the e2e instance only.`)
  }

  const tok = await db.query<{ tenantId: string; tenantName: string | null }>(
    `select "tenantId", "tenantName" from accounting_tokens where connector = 'xero'`,
  )
  if (tok.rows.length && tok.rows[0].tenantId !== DEMO_TENANT_ID) {
    throw new Error(
      `ABORT: this instance is connected to "${tok.rows[0].tenantName ?? tok.rows[0].tenantId}", not the Demo org. ` +
        `If that is a live organisation, the incident is ONGOING — disconnect it before clearing anything locally.`,
    )
  }
  console.log(`Connected tenant: ${tok.rows[0]?.tenantName ?? '(none)'} — ok`)
}

async function main() {
  const ids = readContaminatedIds(CSV_PATH)
  console.log(`${ids.length} live-tenant ids loaded from ${CSV_PATH}`)

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    await guard(db)

    // Count exactly what is in scope, and — just as important — prove nothing outside the CSV is.
    const syncLog = await db.query<{ in_scope: string; total: string }>(
      `select
         count(*) filter (where "externalTransactionId" = any($1::text[]))::text as in_scope,
         count(*) filter (where "externalTransactionId" is not null)::text        as total
       from accounting_sync_logs`,
      [ids],
    )
    console.log(`\naccounting_sync_logs: ${syncLog.rows[0].in_scope} in scope of ${syncLog.rows[0].total} with an external id`)
    if (syncLog.rows[0].in_scope !== syncLog.rows[0].total) {
      console.log(
        `  ! ${Number(syncLog.rows[0].total) - Number(syncLog.rows[0].in_scope)} row(s) carry an external id that is NOT in the CSV.\n` +
          `    Those are left alone — but find out what tenant they belong to before trusting them.`,
      )
    }

    const backRefs: Array<{ table: string; column: string; inScope: number; outOfScope: number }> = []
    for (const { table, column } of BACK_REFERENCE_COLUMNS) {
      const res = await db.query<{ in_scope: string; total: string }>(
        `select
           count(*) filter (where "${column}" = any($1::text[]))::text as in_scope,
           count(*) filter (where "${column}" is not null)::text       as total
         from ${table}`,
        [ids],
      )
      const inScope = Number(res.rows[0].in_scope)
      const total = Number(res.rows[0].total)
      backRefs.push({ table, column, inScope, outOfScope: total - inScope })
      console.log(`${table}.${column}: ${inScope} in scope of ${total} set`)
      if (total > inScope) {
        console.log(`  ! ${total - inScope} back-reference(s) point at an id not in the CSV — left alone.`)
      }
    }

    if (!APPLY) {
      console.log(`\n=== DRY RUN — nothing written. Re-run with --apply to clear these. ===`)
      console.log(`Would clear ${syncLog.rows[0].in_scope} sync-log id(s) and ${backRefs.reduce((n, b) => n + b.inScope, 0)} back-reference(s).`)
      return
    }

    await db.query('begin')
    try {
      const cleared = await db.query(
        `update accounting_sync_logs set "externalTransactionId" = null
          where "externalTransactionId" = any($1::text[])`,
        [ids],
      )
      console.log(`\ncleared ${cleared.rowCount} accounting_sync_logs.externalTransactionId`)

      for (const { table, column } of BACK_REFERENCE_COLUMNS) {
        const res = await db.query(
          `update ${table} set "${column}" = null where "${column}" = any($1::text[])`,
          [ids],
        )
        console.log(`cleared ${res.rowCount} ${table}.${column}`)
      }
      await db.query('commit')
      console.log('\ncommitted.')
    } catch (e) {
      await db.query('rollback')
      throw e
    }

    // Verify from the database rather than from the rowcounts we just printed.
    const after = await db.query<{ remaining: string }>(
      `select count(*)::text as remaining from accounting_sync_logs where "externalTransactionId" = any($1::text[])`,
      [ids],
    )
    console.log(`\nverification: ${after.rows[0].remaining} contaminated sync-log id(s) remain (expected 0)`)
    for (const { table, column } of BACK_REFERENCE_COLUMNS) {
      const res = await db.query<{ remaining: string }>(
        `select count(*)::text as remaining from ${table} where "${column}" = any($1::text[])`,
        [ids],
      )
      console.log(`verification: ${res.rows[0].remaining} remaining in ${table}.${column} (expected 0)`)
    }
  } finally {
    await db.end()
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  process.exit(1)
})
