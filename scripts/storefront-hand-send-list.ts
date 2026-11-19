/**
 * `npm run storefront:hand-send -- [--natives-off-at <ISO>] [--paid-since <ISO>] [--switch-on-at <ISO>]` — read-only lists for runbook step W (see
 * lib/ops/storefront-held-orders-at-w.ts for what each row means and whether to send). Without `--switch-on-at` the stored switch-on instant is used (no
 * stamp = nothing is listed). Held-unpaid is always listed; `--natives-off-at` adds the paid orders of the gap; `--paid-since` adds the pre-switch-on orders
 * that were paid since. Nothing here confirms an unpaid order and nothing duplicates an IMS send.
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
  const { listStorefrontHandSendOrders, renderHandSendList } = await import('../lib/ops/storefront-held-orders-at-w')
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
