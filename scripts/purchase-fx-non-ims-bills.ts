/**
 * Per-event FX rates for purchasing, MED-C: the owner's gate for bills that reached Xero outside IMS (lib/domain/purchasing/purchase-fx-non-ims-bills.ts).
 *
 * Usage:
 *   tsx scripts/purchase-fx-non-ims-bills.ts
 *       DRY RUN (the default): list the bills and the one-off exchange-rate journal each would post now; writes nothing.
 *   tsx scripts/purchase-fx-non-ims-bills.ts --yes --confirm-admin --by <name> --reason "<text>" [--bill <invoice id> ...]
 *       confirm them (all listed, or the named bills): recorded and audited, and their journals queued through the normal accounting queue (and so to
 *       Xero only while Xero sync is on, and only as the producer-side hold allows). Idempotent: a second run confirms and queues nothing.
 *
 * Refused while purchase_event_fx_rates_enabled (or its interlock) is off. Both --yes and --confirm-admin are required to write: the command has no session,
 * so it assumes ADMIN authority from shell access and says so in the audit entry. Never key these journals into Xero by hand as well.
 * Exit codes: 0 ok, 3 refused input, 5 failed.
 */
import { config } from 'dotenv'

// .env MUST load before lib/db is imported: that module builds its pg Pool from process.env.DATABASE_URL at IMPORT time.
config({ path: '.env.local', quiet: true })
config({ quiet: true })

function valueOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
function valuesOf(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((arg, i) => { if (arg === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!) })
  return out
}

async function main(): Promise<number> {
  const mod = await import('../lib/domain/purchasing/purchase-fx-non-ims-bills')
  const write = process.argv.includes('--yes') && process.argv.includes('--confirm-admin')
  if (process.argv.includes('--yes') !== process.argv.includes('--confirm-admin')) {
    console.error('Both --yes and --confirm-admin are needed to confirm; without both this is a dry run. Nothing was written.')
    return 3
  }
  const listed = await mod.listNonImsBills()
  console.log(`${write ? '' : 'DRY RUN (pass --yes --confirm-admin --by <name> --reason "<text>" to confirm). '}${listed.length} bill(s) posted to Xero outside IMS await confirmation:`)
  for (const bill of listed) console.log(`  ${bill.poReference} (${bill.currency}) bill ${bill.invoiceNumber ?? bill.invoiceId} [${bill.invoiceId}]: journal now ${bill.proposedTransitDelta} on Stock in Transit`)
  if (!write) return 0
  try {
    const done = await mod.confirmNonImsBills({ by: valueOf('by') ?? '', reason: valueOf('reason') ?? '', invoiceIds: valuesOf('bill') })
    console.log(`Confirmed ${done.confirmed.length} bill(s); ${done.journals.length} journal(s) queued${done.notQueued ? `, ${done.notQueued} declined (reported on Sync > Exceptions)` : ''}${done.shadowed ? `, ${done.shadowed} settled as a shadow` : ''}.`)
    return 0
  } catch (error) {
    if (error instanceof mod.NonImsBillsConfirmRefused) { console.error(error.message); return 3 }
    throw error
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(5) },
)
