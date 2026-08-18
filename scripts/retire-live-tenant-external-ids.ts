/**
 * o3d-t74p / o3d-s36z — retire the stranded Xero external ids in the e2e database.
 * (Named for the LIVE tenant it was built to target. That attribution turned out to be wrong —
 * see the warning immediately below. The filename is kept so the PR/issue history still resolves.)
 *
 * !!! THIS OPERATION IS DISABLED. ITS PREMISE WAS DISPROVED (2026-08-10) !!!
 *
 * This script was written on the belief that the 553 ids in the CSV address objects in the LIVE
 * organisation. THEY DO NOT. They are DEMO-tenant ids, from the periods the instance was pointed
 * at Demo Company (UK). See "WHAT THE 404 EVIDENCE ACTUALLY SUPPORTS" below for exactly how far
 * that is established and how far it is not.
 *
 * That inverts the argument for running this. The instance is connected to Demo RIGHT NOW, so
 * these ids are not stranded pointers to an unreachable org — they are plausibly CURRENT and
 * VALID references into the tenant the instance is actually using. Nulling them would not be
 * retiring dead ids; it would be deleting live back-references, after which the sweep re-creates
 * links and the pollers stop reconciling the documents they belong to.
 *
 * So --apply now REFUSES. A prominent warning in a header is not a control: the previous guard
 * failed open in three ways at once (it positively permitted the connected Demo tenant, it
 * permitted ZERO token rows, and its "e2e database" check was a substring match on DATABASE_URL
 * that a username or query parameter can satisfy while connected elsewhere). The refusal can only
 * be lifted by a deliberate, documented override — see SAFETY below — and every check in it is
 * positive: it requires proof of the expected state, never the absence of a wrong one.
 *
 * WHAT THE 404 EVIDENCE ACTUALLY SUPPORTS
 * ---------------------------------------
 * The 2026-08-10 reconciliation (xero-live-reconciliation-20260810.csv) resolved all 553 ids
 * against the live org and none of them came back PRESENT. But "not present" was reached by four
 * different routes of very different strength, and only one of them is an HTTP 404:
 *
 *    14 payments      per-id GET Payments/{id} -> HTTP 404.        CONFIRMED ABSENT.
 *   234 invoices      absent from a batched GET Invoices?IDs=.     Absent from a collection read,
 *    54 credit notes  absent from a batched/per-id CreditNotes read.  not a per-id 404 — and a
 *                                                                  FAILED batch produced the same
 *                                                                  "NOT_FOUND" as a successful one.
 *   251 journals      never fetched by id at all. The sweep paged  NOT ESTABLISHED. This only ever
 *                     ManualJournals and stopped at the first      meant "not seen in the pages
 *                     page shorter than 100.                       that were read".
 *
 * So "all 553 returned 404" is true of 14 ids. The INDEPENDENT cross-check is stronger and is what
 * the Demo attribution actually rests on: audit-xero-live-e2e-footprint.ts indexes the org by the
 * fixtures' own contact/item naming and finds 0 of 553 CSV ids among the 370 objects it holds —
 * a different index reaching the same conclusion. That cross-check does NOT cover manual journals,
 * which carry no contact and are not in the footprint at all. The journal bucket is UNKNOWN, not
 * absent, and audit-xero-live-contamination.ts now reports it that way.
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
 *   • Dry run is the ONLY mode available by default. --apply refuses outright.
 *   • Lifting the refusal requires ALL of, together:
 *       --i-have-read-o3d-t74p-and-authorize-demo-history-retirement
 *       --authorization <file> containing token/tenantId/database/ids/authorizedBy/authorizedAt
 *       `select current_database()` equal to the expected database EXACTLY (not a URL substring)
 *       EXACTLY ONE Xero token row, positively matching the authorised tenant
 *       an id count equal to the one the authorization was signed off for
 *     The refusal and every one of those checks are pure functions in
 *     scripts/lib/xero-live-safety.ts, covered by tests/scripts/xero-live-safety.test.ts.
 *   • Writes happen in a single transaction, bounded by the explicit id list from the CSV.
 *     There is no unqualified UPDATE here, so a row outside that set cannot be touched.
 *
 * USAGE
 *   DATABASE_URL=postgresql://.../onetwo3d_ims_e2e node_modules/.bin/tsx \
 *     scripts/retire-live-tenant-external-ids.ts                       # dry run (the only mode)
 */
import { Client } from 'pg'
import { existsSync, readFileSync } from 'node:fs'

import {
  assertRetirementAuthorized,
  parseRetirementAuthorization,
  RETIREMENT_OVERRIDE_FLAG,
  type RetirementAuthorization,
} from './lib/xero-live-safety'

const APPLY = process.argv.includes('--apply')

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const CSV_PATH = arg('csv', '/root/xero-live-e2e-contamination-20260804.csv')!
const OVERRIDE_PRESENT = process.argv.includes(RETIREMENT_OVERRIDE_FLAG)
const AUTHORIZATION_PATH = arg('authorization')

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

/**
 * Even the read-only report is confined to the e2e database. Not because counting rows is
 * dangerous, but because "would clear 553 ids" printed against production is a sentence nobody
 * should ever read. This replaces the old `DATABASE_URL.includes(...)` substring check, which a
 * username or query parameter could satisfy while connected elsewhere.
 */
async function assertE2eDatabase(db: Client): Promise<string> {
  const res = await db.query<{ current_database: string }>('select current_database()')
  const name = res.rows[0]?.current_database
  if (name !== E2E_DATABASE) {
    throw new Error(`ABORT: connected to database ${JSON.stringify(name ?? null)}, not ${E2E_DATABASE}. This script is for the e2e instance only.`)
  }
  return name
}

/**
 * The apply-path refusal. Read-only reporting never reaches this — it is called only when the
 * operator asked to WRITE, and its default answer is no.
 */
async function assertAuthorizedToWrite(db: Client, idCount: number): Promise<void> {
  let authorization: RetirementAuthorization | null = null
  if (AUTHORIZATION_PATH) {
    if (!existsSync(AUTHORIZATION_PATH)) throw new Error(`REFUSED: no authorization file at ${AUTHORIZATION_PATH}`)
    authorization = parseRetirementAuthorization(readFileSync(AUTHORIZATION_PATH, 'utf8'))
  }

  // Ask the SERVER what database this is. DATABASE_URL is a request, not an identity: a username,
  // a password or a query value containing "onetwo3d_ims_e2e" satisfies a substring check while the
  // session is connected to something else entirely.
  const dbName = await db.query<{ current_database: string }>('select current_database()')
  const tok = await db.query<{ tenantId: string; tenantName: string | null }>(
    `select "tenantId", "tenantName" from accounting_tokens where connector = 'xero'`,
  )

  assertRetirementAuthorized({
    overrideFlagPresent: OVERRIDE_PRESENT,
    authorization,
    currentDatabase: dbName.rows[0]?.current_database ?? null,
    expectedDatabase: E2E_DATABASE,
    tenantRows: tok.rows,
    expectedTenantId: DEMO_TENANT_ID,
    idCount,
  })

  console.log(
    `\nAUTHORIZED: ${authorization!.authorizedBy} on ${authorization!.authorizedAt} — ` +
      `database ${dbName.rows[0].current_database}, tenant ${tok.rows[0].tenantName ?? tok.rows[0].tenantId}, ${idCount} id(s).`,
  )
}

async function main() {
  const ids = readContaminatedIds(CSV_PATH)
  console.log(`${ids.length} live-tenant ids loaded from ${CSV_PATH}`)

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    // The report below is read-only, but it is still confined to the e2e database. The write path
    // is gated separately and far more strictly, immediately before the first UPDATE.
    console.log(`Connected database: ${await assertE2eDatabase(db)} — ok`)

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
      console.log(`\n=== DRY RUN — nothing written. ===`)
      console.log(`--apply is REFUSED: the premise for this operation was disproved (see the header).`)
      console.log(`Would clear ${syncLog.rows[0].in_scope} sync-log id(s) and ${backRefs.reduce((n, b) => n + b.inScope, 0)} back-reference(s).`)
      return
    }

    await assertAuthorizedToWrite(db, ids.length)

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
