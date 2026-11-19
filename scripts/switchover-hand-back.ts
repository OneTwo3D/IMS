import { pathToFileURL } from 'node:url'

import { listHandBackCandidates, runHandBack, type HandBackDeps, type HandBackCandidate } from '@/lib/connectors/mintsoft/switchover/hand-back'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import { PRODUCER_STEP_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * `npm run switchover:hand-back [-- --since <ISO UTC>] [-- --apply] [-- --json]`  (rollback of step M, see lib/connectors/mintsoft/switchover/hand-back.ts)
 * Writes `_mintsoft_order_id` and `_mintsoft_order_number` onto the open WooCommerce orders IMS created in Mintsoft, so the resumed bridge adopts them.
 * DRY RUN by default: it reads and reports, writes nothing. `--apply` writes. S is MINTSOFT_WRITES_LIVE_FROM unless --since is given.
 * Exit codes: 0 done, 1 something needs a person (a conflict, an unreadable or held order, a failed write), 3 usage, 5 failed.
 */
export type HandBackCliOptions = {
  argv?: string[]
  env?: Record<string, string | undefined>
  load?: (since: Date) => Promise<{ candidates: HandBackCandidate[]; deps: HandBackDeps }>
  stdout?: Pick<typeof console, 'log'>
  stderr?: Pick<typeof console, 'error'>
  disconnect?: () => Promise<void>
}

async function liveLoad(since: Date): Promise<{ candidates: HandBackCandidate[]; deps: HandBackDeps }> {
  const { db } = await import('@/lib/db')
  const { wcFetch, wcPut } = await import('@/lib/connectors/woocommerce/api')
  return {
    candidates: await listHandBackCandidates({ since, db: db as never }),
    deps: {
      readOrder: async (id) => {
        const result = await wcFetch(`/orders/${id}`, { _fields: 'id,status,meta_data' })
        const data = result.data as { status?: unknown; meta_data?: Array<{ key?: unknown; value?: unknown }> } | null
        if (result.error || !data || typeof data.status !== 'string') return null
        const metas: Record<string, string | null> = {}
        for (const meta of data.meta_data ?? []) if (typeof meta.key === 'string') metas[meta.key] = meta.value === null || meta.value === undefined ? null : String(meta.value)
        return { status: data.status, metas }
      },
      writeMetas: async (id, metas) => {
        const result = await wcPut(`/orders/${id}`, { meta_data: Object.entries(metas).map(([key, value]) => ({ key, value })) })
        return { ok: !result.error, held: result.held }
      },
    },
  }
}

export async function runHandBackCli(options: HandBackCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const usage = 'Usage: npm run switchover:hand-back [-- --since <ISO UTC>] [-- --apply] [-- --json]'
  let since: string | undefined
  let apply = false
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--apply') apply = true
    else if (arg === '--json') json = true
    else if (arg === '--since') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(usage); return 3 }
      since = value
      i += 1
    } else { stderr.error(`Unknown argument ${arg}. ${usage}`); return 3 }
  }
  const cutoff = parseProducerCutoff(since ?? env[PRODUCER_STEP_ENV.mintsoft])
  if (!cutoff.ok) { stderr.error(`S is not readable (${PRODUCER_STEP_ENV.mintsoft} or --since must be an ISO UTC instant).`); return 3 }
  try {
    const { candidates, deps } = await (options.load ?? liveLoad)(cutoff.at)
    const { counts, results } = await runHandBack(candidates, apply, deps)
    if (json) stdout.log(JSON.stringify({ apply, since: cutoff.at.toISOString(), candidates: candidates.length, counts, results }, null, 2))
    else {
      stdout.log(`${apply ? 'APPLY' : 'DRY RUN'}: hand-back of ${candidates.length} open order(s) IMS created since ${cutoff.at.toISOString()}`)
      for (const [name, count] of Object.entries(counts)) if (count > 0) stdout.log(`  ${name}: ${count}`)
      for (const r of results) if (!['written', 'would-write', 'already-set', 'closed'].includes(r.outcome)) stdout.log(`  needs a person: ${r.reference} (${r.outcome})`)
      if (counts.held > 0) stdout.log('  The producer-side hold kept the write: run this while the step-M live-from and grant are still set and IMS\'s other writers are stopped.')
    }
    return counts.conflict + counts.unreadable + counts.held + counts.failed > 0 ? 1 : 0
  } catch (error) {
    stderr.error(error instanceof Error ? error.message : String(error))
    return 5
  } finally {
    await (options.disconnect ?? (async () => { const { db } = await import('@/lib/db'); await db.$disconnect() }))().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHandBackCli().then((code) => { process.exit(code) }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(5) })
}
