import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { runRetireHeldBacklogCli } from '../scripts/retire-held-backlog'
import type { RetirementApplyResult, RetirementItem, RetirementPlan, RetirementScope } from '../lib/domain/outbound-shadow/retire-held-backlog'
import { PRODUCER_CUTOFF_ENV, RETIRE_HELD_BACKLOG_EXIT_CODES, renderRetireExitCodeTable } from '../lib/security/producer-disposition-constants'

/**
 * `npm run retire:held-backlog`: a DRY RUN by default; `--apply` needs the database to be named and to be the connected one; the exit codes are
 * the single-sourced table. The plan and apply are injected: what they DO to rows is tests/db/writer-cutoff.test.ts.
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  j  apply-by-default     a missing --apply applies: the dry-run arm goes red
 *  k  confirm-not-compared the database name is accepted without being compared with the connected one: the refusal arm goes red
 */

const NOW = new Date('2026-12-02T12:00:00Z')
const item = (disposition: 'SHADOW' | 'PARK' | 'SKIP', destination: 'xero' | 'mintsoft' | 'woocommerce' = 'xero', id = 'r1'): RetirementItem => ({
  destination, kind: destination === 'xero' ? 'xero_sync_log' : 'outbox_job', id, subject: 'STOCK_RECEIPT CogsEntry c1', createdAt: new Date('2026-09-01T00:00:00Z'),
  status: 'PENDING', classification: { disposition, reason: 'because' },
})

function harness(items: RetirementItem[] = [item('SHADOW'), item('PARK', 'xero', 'r2')], overrides: { truncated?: RetirementPlan['truncated']; unscoped?: RetirementPlan['unscoped']; counts?: Partial<RetirementApplyResult['counts']>; identity?: string | Error } = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls = { plan: 0, apply: 0, scope: null as RetirementScope | null }
  const run = (argv: string[], env: Record<string, string | undefined> = {}) => runRetireHeldBacklogCli({
    argv, env,
    stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) },
    plan: async (scope) => { calls.plan += 1; calls.scope = scope; return { generatedAt: NOW, items, truncated: overrides.truncated ?? [], unscoped: overrides.unscoped ?? [] } },
    apply: async (plan) => {
      calls.apply += 1
      return { outcomes: [], counts: { shadowed: plan.items.length, parked: 0, left_alone: 0, changed_since_plan: 0, ...overrides.counts } }
    },
    serverIdentity: async () => { if (overrides.identity instanceof Error) throw overrides.identity; return overrides.identity ?? IDENTITY },
    disconnect: async () => undefined,
  })
  return { run, out, err, calls }
}
const IDENTITY = 'ims_scratch@7697665522638207492'
const code = (name: string) => RETIRE_HELD_BACKLOG_EXIT_CODES.find((row) => row.name === name)!.code

test('a dry run is the default: it plans, prints what each row would become, applies NOTHING, and exits 0', async () => {
  const h = harness()
  assert.equal(await h.run(['--cutoff', '2026-12-01T00:00:00Z']), code('ok'))
  assert.equal(h.calls.plan, 1)
  assert.equal(h.calls.apply, 0, 'no --apply, no write')
  const text = h.out.join('\n')
  assert.match(text, /^DRY RUN \(nothing is changed\)/)
  assert.match(text, /xero: queued before 2026-12-01T00:00:00\.000Z/)
  assert.match(text, /SHADOW .*xero xero_sync_log r1/)
  assert.match(text, /PARK .*xero xero_sync_log r2/)
})

test('--apply needs --confirm-database, and it must equal the connected database; a wrong name changes nothing and exits apply-refused', async () => {
  const noConfirm = harness()
  assert.equal(await noConfirm.run(['--apply', '--cutoff', '2026-12-01T00:00:00Z']), code('usage'))
  assert.equal(noConfirm.calls.plan + noConfirm.calls.apply, 0, 'nothing was even read')
  const wrong = harness()
  assert.equal(await wrong.run(['--apply', '--confirm-database', 'ims_scratch', '--cutoff', '2026-12-01T00:00:00Z']), code('apply-refused'))
  assert.equal(wrong.calls.apply, 0)
  assert.equal(wrong.calls.plan, 0, 'refused before reading')
  assert.match(wrong.err.join('\n'), /REFUSING to apply/)
  const right = harness()
  assert.equal(await right.run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('ok'))
  assert.equal(right.calls.apply, 1)
  assert.match(right.out.join('\n'), /^APPLY/)
  const stray = harness()
  assert.equal(await stray.run(['--confirm-database', IDENTITY]), code('usage'), 'a confirmation without --apply is a mistake, not a dry run')
})

test('which rows: an explicit --cutoff applies to every selected destination; otherwise each destination\'s own readable variable; nothing selected exits nothing-in-scope', async () => {
  const h = harness()
  await h.run(['--destination', 'xero', '--cutoff', '2026-11-01T00:00:00Z'], { [PRODUCER_CUTOFF_ENV.xero]: '2026-12-01T00:00:00Z' })
  assert.equal(h.calls.scope?.cutoffs.xero?.toISOString(), '2026-11-01T00:00:00.000Z', 'explicit wins')
  assert.deepEqual(h.calls.scope?.destinations, ['xero'])
  const own = harness()
  await own.run([], { [PRODUCER_CUTOFF_ENV.woocommerce]: '2026-12-01T00:00:00Z', [PRODUCER_CUTOFF_ENV.mintsoft]: 'garbage' })
  assert.equal(own.calls.scope?.cutoffs.woocommerce?.toISOString(), '2026-12-01T00:00:00.000Z')
  assert.equal(own.calls.scope?.cutoffs.mintsoft, undefined, 'an unreadable variable selects nothing')
  assert.equal(own.calls.scope?.allQueued, false)
  const none = harness([], { unscoped: ['xero', 'mintsoft', 'woocommerce'] })
  assert.equal(await none.run([]), code('nothing-in-scope'))
  const all = harness()
  await all.run(['--all-queued'])
  assert.equal(all.calls.scope?.allQueued, true)
})

test('arguments are validated before anything is read: unknown flags, a flag missing its value, a bad destination, a cut-off that is not UTC-with-Z, a bad limit', async () => {
  for (const argv of [['--frobnicate'], ['--cutoff'], ['--cutoff', '2026-12-01'], ['--cutoff', '2026-12-01T00:00:00+01:00'], ['--destination', 'qoblex'], ['--limit', '0'], ['--limit', 'many'], ['--destination']]) {
    const h = harness()
    assert.equal(await h.run(argv), code('usage'), JSON.stringify(argv))
    assert.equal(h.calls.plan, 0, `${JSON.stringify(argv)} read nothing`)
    assert.ok(h.err.length > 0)
  }
})

test('incomplete: a truncated list, or an apply that skipped or lost a row, exits 1 so the operator runs it again; a clean apply exits 0', async () => {
  assert.equal(await harness(undefined, { truncated: [{ destination: 'xero', kind: 'xero_sync_log' }] }).run(['--cutoff', '2026-12-01T00:00:00Z']), code('incomplete'))
  assert.equal(await harness(undefined, { counts: { changed_since_plan: 1 } }).run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('incomplete'))
  assert.equal(await harness(undefined, { counts: { left_alone: 1 } }).run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('incomplete'))
  assert.equal(await harness().run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('ok'))
  const json = harness()
  await json.run(['--json', '--cutoff', '2026-12-01T00:00:00Z'])
  const parsed = JSON.parse(json.out.join('\n')) as { mode: string; items: Array<{ disposition: string }>; tally: Record<string, number> }
  assert.equal(parsed.mode, 'dry-run')
  assert.deepEqual(parsed.tally, { 'xero xero_sync_log SHADOW': 1, 'xero xero_sync_log PARK': 1 })
})

test('the exit-code table is documented once: the docs carry exactly the rows of the code table, and the codes are unique', () => {
  const doc = readFileSync(join(__dirname, '..', 'docs/installation.md'), 'utf8')
  const open = '<!-- producer-disposition:retirement -->'
  const close = '<!-- /producer-disposition:retirement -->'
  const body = doc.slice(doc.indexOf(open) + open.length, doc.indexOf(close))
  const rows = body.split('\n').filter((line) => /^\| \d+ \|/.test(line))
  console.log(`precondition (retire exit codes): ${rows.length} rows in the docs table, ${RETIRE_HELD_BACKLOG_EXIT_CODES.length} in the code table`)
  assert.equal(rows.length, RETIRE_HELD_BACKLOG_EXIT_CODES.length)
  assert.ok(body.includes(renderRetireExitCodeTable()))
  assert.equal(new Set(RETIRE_HELD_BACKLOG_EXIT_CODES.map((row) => row.code)).size, RETIRE_HELD_BACKLOG_EXIT_CODES.length)
  assert.match(body, /It changes nothing unless it is also given `--apply --confirm-database <identity>`/)
})

test('--all-queued reports that a configured cut-off is ignored, and the JSON carries the effective (null) cut-offs', async () => {
  const h = harness()
  await h.run(['--all-queued'], { [PRODUCER_CUTOFF_ENV.xero]: '2026-12-01T00:00:00Z' })
  assert.match(h.out.join('\n'), /xero: every queued row \(--all-queued; the configured cut-off 2026-12-01T00:00:00\.000Z is ignored\)/)
  const j = harness()
  await j.run(['--all-queued', '--json'], { [PRODUCER_CUTOFF_ENV.xero]: '2026-12-01T00:00:00Z' })
  const parsed = JSON.parse(j.out.join('\n')) as { cutoffs: Record<string, string | null>; configuredCutoffsIgnored: boolean }
  assert.equal(parsed.cutoffs.xero, null)
  assert.equal(parsed.configuredCutoffsIgnored, true)
})

test('THE CONFIRMATION IS A SERVER IDENTITY: the dry run prints it; the same database NAME on another cluster is refused; an unreadable identity refuses; nothing is applied in either case', async () => {
  const dry = harness()
  await dry.run(['--cutoff', '2026-12-01T00:00:00Z'])
  assert.match(dry.out.join('\n'), /Server identity \(pass it as --confirm-database to apply to THIS server\): ims_scratch@7697665522638207492/)
  // A live cluster that happens to name its database the same: the NAME matches, the cluster does not.
  const other = harness(undefined, { identity: 'ims_scratch@1111111111111111111' })
  assert.equal(await other.run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('apply-refused'))
  assert.equal(other.calls.apply + other.calls.plan, 0)
  const nameOnly = harness()
  assert.equal(await nameOnly.run(['--apply', '--confirm-database', 'ims_scratch', '--cutoff', '2026-12-01T00:00:00Z']), code('apply-refused'), 'a bare database name no longer confirms anything')
  const unreadable = harness(undefined, { identity: new Error('the identity of the connected server could not be read') })
  assert.equal(await unreadable.run(['--apply', '--confirm-database', IDENTITY, '--cutoff', '2026-12-01T00:00:00Z']), code('apply-refused'))
  assert.equal(unreadable.calls.apply, 0)
  const json = harness()
  await json.run(['--json', '--cutoff', '2026-12-01T00:00:00Z'])
  assert.equal((JSON.parse(json.out.join('\n')) as { serverIdentity: string }).serverIdentity, IDENTITY)
})
