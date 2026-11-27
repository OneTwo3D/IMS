/**
 * Per-event FX rates for purchasing, MED-C: the owner's gate for bills that reached Xero outside IMS (lib/domain/purchasing/purchase-fx-non-ims-bills.ts).
 *
 * Usage:
 *   tsx scripts/purchase-fx-non-ims-bills.ts [--bill <invoice id> ...] [--max-reads <n>]
 *       DRY RUN (the default): each bill (and its Xero bill, read once, read-only), why IMS has no transit row for it, the basis assumed (quantity, goods
 *       value in transit, the Xero rate, the account), the goods not received yet that a confirmation also covers, and the journal it would post now,
 *       plus a digest of the whole list. Writes nothing. --bill also shows a bill the default list leaves out (a delete pending, declined and marked handled).
 *   tsx scripts/purchase-fx-non-ims-bills.ts --yes --confirm-admin --by <name> --reason "<text>" (--all | --bill <id> ...) (--digest <hex> | --expect <id>=<amount> ...)
 *       confirm: recorded and audited, the journal recomputed under each order's lock and refused unless it is what the dry run showed, then queued
 *       through the normal accounting queue (and so to Xero only as the producer-side hold allows). Idempotent: a second run confirms and posts nothing.
 *
 * Refused while purchase_event_fx_rates_enabled (or its interlock) or Xero sync is off: the list is then shown without reading Xero, "not confirmable yet".
 * Both --yes and --confirm-admin are required to write: the command has no session, so it assumes ADMIN authority from shell access and says so in the
 * audit entry. Xero is read in BOTH runs (the dry run and the confirmation), at most --max-reads bills each (default 50), only the named ones when
 * --bill is given, stopping at the first rate-limited or unsent read. The Xero client's limiter here is per process and cannot see the application's own
 * calls against the organisation's 1,000-a-day allowance, so keep runs small. The digest covers the whole default list (with --all only).
 * Never key these journals into Xero by hand as well.
 * Exit codes: 0 ok, 3 refused input, 5 failed (some orders not confirmed).
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported: that module builds its pg Pool from process.env.DATABASE_URL at IMPORT time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

const FLAGS = new Set(['--yes', '--confirm-admin', '--all'])
const VALUED = new Set(['--by', '--reason', '--bill', '--expect', '--digest', '--max-reads'])

export type ParsedArgs = { yes: boolean; confirmAdmin: boolean; all: boolean; by?: string; reason?: string; bills: string[]; expect: Map<string, string>; digest?: string; maxReads?: number }

/** Strict: an unknown flag, a value that is missing or starts with --, an empty --bill, or a malformed --expect is an error (nothing runs). */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs | { error: string } {
  const out: ParsedArgs = { yes: false, confirmAdmin: false, all: false, bills: [], expect: new Map() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (FLAGS.has(arg)) {
      if (arg === '--yes') out.yes = true
      else if (arg === '--confirm-admin') out.confirmAdmin = true
      else out.all = true
      continue
    }
    if (!VALUED.has(arg)) return { error: `Unknown argument ${JSON.stringify(arg)}.` }
    const value = argv[i + 1]
    i += 1
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value${value ? ` (not ${JSON.stringify(value)})` : ''}.` }
    if (!value.trim()) return { error: `${arg} needs a non-empty value.` }
    if (arg === '--by') out.by = value
    else if (arg === '--reason') out.reason = value
    else if (arg === '--bill') out.bills.push(value.trim())
    else if (arg === '--digest') out.digest = value.trim()
    else if (arg === '--max-reads') {
      if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 500) return { error: `--max-reads takes a whole number from 1 to 500, not ${JSON.stringify(value)}.` }
      out.maxReads = Number(value)
    } else {
      const match = value.match(/^([^=\s]+)=(-?\d+(\.\d{1,2})?)$/)
      if (!match) return { error: `--expect takes <bill id>=<amount> (as the dry run prints it), not ${JSON.stringify(value)}.` }
      out.expect.set(match[1]!, match[2]!)
    }
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) { console.error(`${args.error} Nothing was written.`); return 3 }
  if (args.yes !== args.confirmAdmin) { console.error('Both --yes and --confirm-admin are needed to confirm; without both this is a dry run. Nothing was written.'); return 3 }
  const write = args.yes && args.confirmAdmin
  if (!write && (args.all || args.by || args.reason || args.expect.size > 0 || args.digest)) {
    console.error('--all, --by, --reason, --expect and --digest belong to a confirmation (--yes --confirm-admin). Nothing was written.')
    return 3
  }
  const mod = await import('../lib/domain/purchasing/purchase-fx-non-ims-bills')
  if (!write) {
    const list = await mod.listNonImsBills({ named: args.bills, maxReads: args.maxReads })
    console.log(`DRY RUN. ${list.candidates.length} bill(s) posted to Xero outside IMS; ${list.xeroReads} Xero read(s) made.${list.confirmable ? '' : ` ${list.notConfirmableReason!.toUpperCase()}.`}`)
    for (const c of list.candidates) {
      console.log(`  ${c.poReference} (${c.currency}) bill ${c.invoiceNumber ?? c.invoiceId} [${c.invoiceId}], Xero ${c.accountingInvoiceId ?? '(not linked)'}${c.basis.xeroStatus ? ` (${c.basis.xeroStatus})` : ''}`)
      console.log(`    no transit row: ${c.noTransitRowReason}${c.exclusion ? `; left out unless named: ${c.exclusion}` : ''}`)
      console.log(`    basis: ${c.basis.qty} units, goods ${c.currency} ${c.basis.stockForeign} at ${c.basis.rate ?? '?'} = ${c.basis.stockTransitBase ?? '?'} in transit on ${c.basis.account ?? '?'}`
        + `${c.basis.xeroTransitBase ? ` (the Xero bill has ${c.basis.xeroTransitBase} there; its price difference ${c.basis.priceDifferenceBase} stays on transit)` : ''}`)
      console.log(`    not received yet: ${c.notReceived.qty} units${c.notReceived.base ? ` (${c.notReceived.base} in base)` : ''}: a confirmation covers them too, their receipts adjust the journal later`)
      console.log(c.problem ? `    NOT CONFIRMABLE: ${c.problem}` : `    journal now: ${c.proposedTransitDelta} on Stock in Transit   (--expect ${c.invoiceId}=${c.proposedTransitDelta})`)
    }
    if (args.bills.length === 0) console.log(`Digest of every confirmable bill above (the default list): ${list.digest} (confirm all of them with --all --digest ${list.digest})`)
    return 0
  }
  try {
    const done = await mod.confirmNonImsBills({ by: args.by ?? '', reason: args.reason ?? '', all: args.all, invoiceIds: args.bills, expect: args.expect, digest: args.digest, maxReads: args.maxReads })
    console.log(`Confirmed ${done.confirmed.length} bill(s); ${done.journals.length} journal(s) queued${done.notQueued ? `, ${done.notQueued} declined (reported on Sync > Exceptions)` : ''}${done.shadowed ? `, ${done.shadowed} settled as a shadow` : ''}; ${done.xeroReads} Xero read(s) made.`)
    for (const f of done.failed) console.error(`  ${f.poReference}: NOT confirmed (rolled back): ${f.error}`)
    for (const f of done.reportFailed) console.error(`  ${f.poReference}: confirmed and committed, but reporting its declined journal to Sync > Exceptions failed: ${f.error}`)
    return done.failed.length > 0 || done.reportFailed.length > 0 ? 5 : 0
  } catch (error) {
    if (error instanceof mod.NonImsBillsConfirmRefused) { console.error(error.message); return 3 }
    throw error
  }
}

if (process.argv[1]?.endsWith('purchase-fx-non-ims-bills.ts')) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(5) },
  )
}
