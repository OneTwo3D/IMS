import { pathToFileURL } from 'node:url'

import { acknowledgeStockDriftEvents, STOCK_DRIFT_ACK_NOTE_MAX, type StockDriftAckDb } from '@/lib/connectors/woocommerce/stock-drift-ack'

/**
 * `npm run switchover:stock-drift-ack -- --list` shows the unacknowledged stock-drift events; `-- --event <id> [--event <id> ...] --by <name> --note <why> [--yes]`
 * acknowledges the ones a person has reviewed (the reader then no longer counts them; each keeps who, when and why, and an activity-log entry is written).
 * Without `--yes` it prints what it would acknowledge and changes nothing. Exit codes: 0 ok, 3 usage, 5 failed.
 */
type Logger = Pick<typeof console, 'log' | 'error'>
export type StockDriftAckCliOptions = { argv?: string[]; db?: StockDriftAckDb; stdout?: Pick<Logger, 'log'>; stderr?: Pick<Logger, 'error'>; disconnect?: () => Promise<void> }

export async function runStockDriftAckCli(options: StockDriftAckCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const usage = 'Usage: npm run switchover:stock-drift-ack -- --list   |   -- --event <id> [--event <id>...] --by <name> --note <why> [--yes]'
  let list = false
  let yes = false
  let by = ''
  let note = ''
  const ids: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--list') list = true
    else if (arg === '--yes') yes = true
    else if (arg === '--event' || arg === '--by' || arg === '--note') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(usage); return 3 }
      i += 1
      if (arg === '--event') ids.push(value); else if (arg === '--by') by = value; else note = value
    } else { stderr.error(usage); return 3 }
  }
  try {
    const db = (options.db ?? (await import('@/lib/db')).db) as unknown as StockDriftAckDb
    if (list) {
      if (ids.length > 0 || yes) { stderr.error(usage); return 3 }
      const events = await db.wcStockDriftEvent.findMany({ where: { acknowledgedAt: null }, orderBy: { observedAt: 'asc' }, select: { id: true, externalProductId: true, sku: true, fromQuantity: true, toQuantity: true, observedAt: true, acknowledgedAt: true } })
      if (events.length === 0) stdout.log('No unacknowledged stock-drift events.')
      for (const event of events) stdout.log(`${event.id}  product ${event.externalProductId}${event.sku ? ` (${event.sku})` : ''}  ${event.fromQuantity ?? '?'} -> ${event.toQuantity ?? '?'}  seen ${event.observedAt.toISOString()}`)
      return 0
    }
    if (ids.length === 0 || by.trim() === '' || note.trim() === '' || note.length > STOCK_DRIFT_ACK_NOTE_MAX) { stderr.error(usage); return 3 }
    if (!yes) { stdout.log(`Would acknowledge ${ids.length} event(s) as reviewed by ${by}. Nothing changed; add --yes to acknowledge.`); return 0 }
    const result = await acknowledgeStockDriftEvents(db, { ids, by, note })
    if (!result.ok) { stderr.error(result.error); return 5 }
    stdout.log(`Acknowledged ${result.acknowledged} event(s).`)
    return 0
  } catch {
    stderr.error('The acknowledgement could not be recorded.')
    return 5
  } finally {
    if (options.disconnect) await options.disconnect()
    else if (!options.db) { const { db } = await import('@/lib/db'); await db.$disconnect() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStockDriftAckCli().then((code) => process.exit(code), () => process.exit(5))
}
