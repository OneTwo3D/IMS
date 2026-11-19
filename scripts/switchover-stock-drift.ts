import { pathToFileURL } from 'node:url'

import { observeWcStockDrift } from '@/lib/connectors/woocommerce/stock-drift'

/**
 * `npm run switchover:stock-drift` runs the WooCommerce stock-drift observer once (step W): it READS the store's stock and records the changes that no order,
 * refund or IMS push explains (see lib/connectors/woocommerce/stock-drift.ts). Run it hourly from the host's scheduler once the owner has stopped the Qoblex
 * stock push. It writes only the observer's own tables and never writes to WooCommerce. Exit codes: 0 the run was complete (drift found or not: the count is
 * printed and `writers:check` judges it), 5 the run could not read the whole catalogue.
 */
export async function runStockDriftCli(options: { observe?: typeof observeWcStockDrift; stdout?: Pick<typeof console, 'log'>; stderr?: Pick<typeof console, 'error'>; disconnect?: () => Promise<void> } = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  try {
    const result = await (options.observe ?? observeWcStockDrift)()
    if (!result.ok) { stderr.error(`Stock drift run not complete: ${result.error ?? 'unknown'}`); return 5 }
    stdout.log(`Stock drift run complete: ${result.productsSeen} products read, ${result.driftFound} unexplained change(s).`)
    return 0
  } finally {
    await (options.disconnect ?? (async () => { const { db } = await import('@/lib/db'); await db.$disconnect() }))().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStockDriftCli().then((code) => { process.exit(code) }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(5) })
}
