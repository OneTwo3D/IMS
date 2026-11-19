/**
 * `npm run storefront:hand-send -- [--natives-off-at <ISO>] [--paid-since <ISO>] [--switch-on-at <ISO>]` — read-only lists for runbook step W (see
 * lib/ops/storefront-held-orders-at-w.ts for what each row means and whether to send). Without `--switch-on-at` the stored switch-on instant is used (no
 * stamp = nothing is listed). `--paid-since` is the instant WooCommerce's native e-mails went off: orders whose store-reported PAID time is on or after it.
 *
 * `npm run storefront:hand-send -- --mark-sent <order number>... --by <name> --yes` records that a confirmation was sent by hand (audited, idempotent; refuses
 * an unpaid order and one IMS already confirmed), so the lists stop showing it. Without --yes it shows what it would do and writes nothing.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })
config({ quiet: true })

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
function instant(name: string): Date | null {
  const raw = arg(name)
  if (raw === undefined) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be an ISO date-time`)
  return new Date(ms)
}

async function main() {
  const { db } = await import('../lib/db')
  const { readStorefrontCustomerEmailEnabledAt } = await import('../lib/domain/storefront-customer-email/switch')
  const { listStorefrontHandSendOrders, renderHandSendList, markStorefrontHandSent } = await import('../lib/ops/storefront-held-orders-at-w')
  const markAt = process.argv.indexOf('--mark-sent')
  if (markAt >= 0) {
    const refs = process.argv.slice(markAt + 1).filter((a) => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--by')
    const by = arg('by')
    if (refs.length === 0) throw new Error('--mark-sent needs at least one order number')
    if (!by || by.trim() === '' || by.startsWith('--')) throw new Error('--mark-sent needs --by <name> (the actor recorded on the audit row)')
    if (!process.argv.includes('--yes')) {
      console.log(`Would mark ${refs.length} order(s) as confirmed by hand by ${by}: ${refs.join(', ')}. Re-run with --yes to record it.`)
    } else {
      for (const r of await markStorefrontHandSent(refs, by.trim())) console.log(`${r.reference}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`)
    }
    await db.$disconnect()
    return
  }
  const nativesOffAt = instant('natives-off-at')
  const paidSince = instant('paid-since')
  const switchOnAt = instant('switch-on-at') ?? await readStorefrontCustomerEmailEnabledAt()
  console.log(renderHandSendList(await listStorefrontHandSendOrders({ nativesOffAt, paidSince, switchOnAt })))
  await db.$disconnect()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
