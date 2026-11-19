/**
 * `npm run storefront:hand-send -- [--natives-off-at <ISO>] [--switch-on-at <ISO>]` — read-only list for runbook step W: storefront orders whose confirmation
 * nobody sends (open unpaid held orders, and orders placed between natives-off and the switch-on). See lib/ops/storefront-held-orders-at-w.ts.
 * Without `--switch-on-at` the stored switch-on instant is used; without `--natives-off-at` only the held list is printed.
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
  const switchOnAt = instant('switch-on-at') ?? await readStorefrontCustomerEmailEnabledAt()
  console.log(renderHandSendList(await listStorefrontHandSendOrders({ nativesOffAt, switchOnAt })))
  await db.$disconnect()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
