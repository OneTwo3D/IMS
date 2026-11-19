import { pathToFileURL } from 'node:url'

import { listSwitchoverGaps, takeOverGapOrder, type TakeOverDeps } from '@/lib/connectors/mintsoft/switchover/gaps'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import { PRODUCER_STEP_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * `npm run switchover:gaps -- --step mintsoft [--since <ISO UTC>] [--json]`            lists G_create and G_despatch (read-only).
 * `npm run switchover:gaps -- --step mintsoft --take-over <orderId> [--since ...] [--apply]`   closes ONE gap order: it reads Mintsoft / the storefront
 * first, and writes only with --apply (the default is a dry run). Exit codes: 0 ok (a gap list is not a failure), 3 usage, 5 failed, 1 a take-over refused.
 * S is MINTSOFT_WRITES_LIVE_FROM unless --since is given (a rehearsal). Counts and order references only: no customer data.
 */
type Logger = Pick<typeof console, 'log' | 'error'>
export type SwitchoverGapsCliOptions = {
  argv?: string[]
  env?: Record<string, string | undefined>
  deps?: () => Promise<{ list: Parameters<typeof listSwitchoverGaps>[0]['db']; takeOver: TakeOverDeps; readStorefront?: Parameters<typeof listSwitchoverGaps>[0]['readStorefront'] }>
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
}

async function liveDeps(): Promise<{ list: Parameters<typeof listSwitchoverGaps>[0]['db']; takeOver: TakeOverDeps; readStorefront?: Parameters<typeof listSwitchoverGaps>[0]['readStorefront'] }> {
  const { db } = await import('@/lib/db')
  const { fetchMintsoftOrderParts } = await import('@/lib/connectors/mintsoft/api/orders')
  const { getMintsoftSettings, parseMintsoftPositiveId } = await import('@/lib/connectors/mintsoft/settings/schema')
  const { wcFetch } = await import('@/lib/connectors/woocommerce/api')
  const { scheduleWcOrderCompletion } = await import('@/lib/connectors/woocommerce/sync/order-completion-jobs')
  const readStorefrontOrder = async (id: string) => {
    const result = await wcFetch(`/orders/${id}`, { _fields: 'id,status,meta_data' })
    const data = result.data as { status?: unknown; meta_data?: Array<{ key?: unknown; value?: unknown }> } | null
    if (result.error || !data || typeof data.status !== 'string') return null
    const tracking = (data.meta_data ?? []).find((m) => m.key === '_wc_shipment_tracking_items')
    return { status: data.status, trackingItems: Array.isArray(tracking?.value) ? tracking.value.length : 0 }
  }
  const clientId = parseMintsoftPositiveId((await getMintsoftSettings()).mintsoft_client_id)
  if (clientId == null) throw new Error('mintsoft_client_id is not configured')
  return {
    list: db as never,
    readStorefront: readStorefrontOrder,
    takeOver: {
      db: db as never,
      clientId,
      fetchParts: (number, client) => fetchMintsoftOrderParts(number, client),
      readStorefrontOrder,
      queueCompletion: (tx, input) => scheduleWcOrderCompletion(tx as never, { orderId: input.orderId, shippedAt: input.at, keyPart: input.keyPart }),
    },
  }
}

export async function runSwitchoverGapsCli(options: SwitchoverGapsCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const usage = 'Usage: npm run switchover:gaps -- --step mintsoft [--since <ISO UTC>] [--json] | --take-over <orderId> [--apply]'
  let step: string | undefined
  let since: string | undefined
  let takeOver: string | undefined
  let apply = false
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--apply') apply = true
    else if (arg === '--json') json = true
    else if (arg === '--step' || arg === '--since' || arg === '--take-over') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(usage); return 3 }
      i += 1
      if (arg === '--step') step = value
      else if (arg === '--since') since = value
      else takeOver = value
    } else { stderr.error(`Unknown argument ${arg}. ${usage}`); return 3 }
  }
  if (step !== 'mintsoft') { stderr.error(`Only --step mintsoft is supported. ${usage}`); return 3 }
  if (apply && takeOver === undefined) { stderr.error(`--apply needs --take-over. ${usage}`); return 3 }
  const cutoff = parseProducerCutoff(since ?? env[PRODUCER_STEP_ENV.mintsoft])
  if (!cutoff.ok) { stderr.error(`S is not readable (${PRODUCER_STEP_ENV.mintsoft} or --since must be an ISO UTC instant).`); return 3 }

  try {
    const deps = await (options.deps ?? liveDeps)()
    if (takeOver !== undefined) {
      const result = await takeOverGapOrder(takeOver, cutoff.at, apply, deps.takeOver)
      stdout.log(json ? JSON.stringify(result) : `${apply ? 'APPLY' : 'DRY RUN'}: ${result.outcome}${'why' in result ? ` - ${result.why}` : ''}`)
      return result.outcome === 'refused' ? 1 : 0
    }
    const gaps = await listSwitchoverGaps({ since: cutoff.at, db: deps.list, readStorefront: deps.readStorefront ?? deps.takeOver.readStorefrontOrder })
    if (json) {
      stdout.log(JSON.stringify({ since: cutoff.at.toISOString(), truncated: gaps.truncated, G_create: gaps.create.map((g) => ({ orderId: g.orderId, reference: g.reference, at: g.at.toISOString() })), G_despatch: gaps.despatch.map((g) => ({ orderId: g.orderId, reference: g.reference, at: g.at.toISOString(), unreadable: g.unreadable === true })) }, null, 2))
    } else {
      stdout.log(`Switchover gaps for step mintsoft, S = ${cutoff.at.toISOString()}${gaps.truncated ? ' (LIST CUT AT THE LIMIT)' : ''}`)
      stdout.log(`G_create (paid before S, no Mintsoft link): ${gaps.create.length}`)
      for (const g of gaps.create) stdout.log(`  ${g.reference}  ${g.orderId}  paid ${g.at.toISOString()}`)
      stdout.log(`G_despatch (despatched before S within the window, storefront not completed with tracking): ${gaps.despatch.length}`)
      for (const g of gaps.despatch) stdout.log(`  ${g.reference}  ${g.orderId}  shipped ${g.at.getTime() === 0 ? 'unknown' : g.at.toISOString()}${g.unreadable ? '  (storefront unreadable)' : ''}`)
    }
    return 0
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return 5
  } finally {
    await (options.disconnect ?? (async () => { const { db } = await import('@/lib/db'); await db.$disconnect() }))().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSwitchoverGapsCli().then((code) => { process.exit(code) }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(5) })
}
