import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * SIXTEEN CLAIMERS AND A RE-QUEUE RACE FOR WOOCOMMERCE INVOICE NOTES ACROSS THE WOOCOMMERCE INSTANT.
 *
 * Xero went live earlier than WooCommerce, so a note created between the two instants belongs to its former writer. Sixteen workers
 * race to claim each such note, while the same-statement re-queue (the clause the every-run reset of FAILED rows carries) tries to make a
 * FAILED one claimable again. The claim is a compare-and-set in PostgreSQL, so no double can show it. Invariants: a pre-instant note is
 * claimed by NOBODY and never leaves FAILED/PENDING untouched; a post-instant note is claimed by EXACTLY ONE worker.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  note-floored-by-xero      the claim floors the note by the Xero instant: the between-instants note is claimed (arm 1 red)
 *  b  claim-ignores-the-floor   the claim statement drops the clause: arm 1 red
 *  c  requeue-ignores-the-floor the re-queue clause is dropped from the reset: arm 2 red
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM']
const DAY = 86_400_000
const XERO_AT = new Date(Date.now() - 3 * DAY)
const WOO_AT = new Date(Date.now() - DAY)
const BETWEEN = new Date(Date.now() - 2 * DAY)
const AFTER = new Date(Date.now() - 60_000)
const iso = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z')
const BOTH = {
  PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero,woocommerce', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: iso(XERO_AT),
  WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: iso(WOO_AT),
}
const WORKERS = 16

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, processor, seam] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/accounting/xero-producer-seam.ts'),
  ])
  return { db, processor, seam }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}

const seed = (d: Deps, referenceId: string, createdAt: Date, status = 'PENDING') => d.db.accountingSyncLog.create({
  data: {
    connector: 'xero', type: 'WC_INVOICE_NOTE', status, referenceType: 'SalesOrder', referenceId,
    payload: { referenceId, date: '2026-06-01' }, attemptStampingCustodyAt: new Date(), createdAt,
  } as never,
  select: { id: true },
})

const claimers = (d: Deps, row: { id: string }) => Array.from({ length: WORKERS }, () => d.processor.claimAccountingSyncLog(
  { id: row.id, type: 'WC_INVOICE_NOTE' as never, referenceType: 'SalesOrder', referenceId: 'x', attemptRevision: 0 },
  new Date(), new Date(Date.now() - 15 * 60_000), { id: row.id, attemptRevision: 1 },
))

test('[note floor] sixteen claimers: a note created between the Xero and WooCommerce instants is claimed by nobody; one created after is claimed by exactly one', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const d = await loadDeps()
  const tag = `wc${randomUUID().slice(0, 8)}`
  t.after(async () => { await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: tag } } }) })
  const pre = await seed(d, `${tag}-pre`, BETWEEN)
  const post = await seed(d, `${tag}-post`, AFTER)
  await withEnv(BOTH, async () => {
    const [preResults, postResults] = await Promise.all([Promise.all(claimers(d, pre)), Promise.all(claimers(d, post))])
    const preClaimed = preResults.filter((result) => result.outcome === 'claimed').length
    const postClaimed = postResults.filter((result) => result.outcome === 'claimed').length
    console.log(`# claimed: pre=${preClaimed} post=${postClaimed}`)
    assert.equal(preClaimed, 0, 'a pre-instant note is claimed by nobody')
    assert.equal(postClaimed, 1, 'a post-instant note is claimed by exactly one worker')
    const row = await d.db.accountingSyncLog.findUnique({ where: { id: pre.id }, select: { status: true, attemptRevision: true } })
    assert.deepEqual([row?.status, row?.attemptRevision], ['PENDING', 0], 'and it was not touched')
  })
})

test('[note floor] the re-queue racing the claimers: a FAILED pre-instant note stays FAILED and is claimed by nobody; a FAILED post-instant note is re-queued and then claimed once', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const d = await loadDeps()
  const tag = `wc${randomUUID().slice(0, 8)}`
  t.after(async () => { await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: tag } } }) })
  const pre = await seed(d, `${tag}-pre`, BETWEEN, 'FAILED')
  const post = await seed(d, `${tag}-post`, AFTER, 'FAILED')
  await withEnv(BOTH, async () => {
    const floor = d.seam.xeroCutoffFloor()
    const requeue = () => d.db.accountingSyncLog.updateMany({
      where: { id: { in: [pre.id, post.id] }, status: 'FAILED', ...d.seam.xeroNotBeforeCutoffWhere(floor) },
      data: { status: 'PENDING' },
    })
    const [requeued] = await Promise.all([requeue(), requeue(), ...claimers(d, pre), ...claimers(d, post)])
    console.log(`# requeued=${requeued.count}`)
    const preRow = await d.db.accountingSyncLog.findUnique({ where: { id: pre.id }, select: { status: true, attemptRevision: true } })
    assert.deepEqual([preRow?.status, preRow?.attemptRevision], ['FAILED', 0], 'the pre-instant note never left FAILED and was never claimed')
    // The post-instant note was re-queued by one of the two resets (the other found it PENDING) and the claimers may have won it in between.
    const postRow = await d.db.accountingSyncLog.findUnique({ where: { id: post.id }, select: { status: true } })
    assert.notEqual(postRow?.status, 'FAILED', 'CONTROL: the post-instant note was re-queued by the same statement')
    const second = await Promise.all(claimers(d, post))
    assert.ok(second.filter((result) => result.outcome === 'claimed').length <= 1, 'never claimed twice')
  })
})
