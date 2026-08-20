import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

/**
 * o3d-xl63 ROUND 3, FINDING 3 — THE EVIDENCE MUST NOT DEPEND ON THE THING THAT FAILED.
 *
 * When `persistAfterRemoteWrite` gives up, Xero is holding a document whose id exists nowhere but in
 * this process's memory. Round 2 let that fall through to the loop's ordinary failure handling, whose
 * first act is `db.$transaction(...)` — a connection from the pool that has just spent the entire
 * deadline refusing to hand one out. So the record of what went unrecorded needed exactly the
 * resource whose absence created the problem, and in the case that matters it could not be written at
 * all; worse, its own failure propagated out of the sweep.
 *
 * THESE RUN IN A CHILD PROCESS, ON PURPOSE. The first record is a synchronous write to FILE
 * DESCRIPTOR 2 — chosen because it has no pool, no queue and no async flush for a dying process to
 * lose — and the only honest way to show that a line reached fd 2 is to read another process's
 * stderr. The database is doubled inside the child so "the pool is exhausted" can be the whole of the
 * scenario: every `$transaction` fails to start with the real production error (P2028), exactly as
 * measured in tests/db/post-remote-persist.test.ts.
 *
 * The doubled `accountingSyncLog.updateMany` also writes a marker to fd 2, so the ORDER of the two
 * — evidence first, database attempt second — is observable in one stream rather than inferred.
 */

const REPO_ROOT = new URL('../../', import.meta.url).pathname

/**
 * Drive `persistPostedXeroDocument` against a database that cannot start a transaction.
 *
 * `fallbackBehaviour` decides what the single-statement recovery write does: land it, find the claim
 * already gone, or fail as well.
 */
function runGiveUpScenario(fallbackBehaviour: 'succeeds' | 'claim-lost' | 'fails'): { stdout: string; stderr: string } {
  const code = `
    const { writeSync } = await import('node:fs')
    const { mock } = await import('node:test')
    const P2028 = Object.assign(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
      { code: 'P2028', name: 'PrismaClientKnownRequestError' },
    )
    let transactionAttempts = 0
    mock.module('@/lib/db', {
      namedExports: {
        db: {
          // The exhausted pool: an interactive transaction never starts. THIS is what production
          // raises — not pg-pool's 'timeout exceeded when trying to connect'.
          $transaction: async () => { transactionAttempts += 1; throw P2028 },
          accountingSyncLog: {
            updateMany: async (args) => {
              writeSync(2, 'FALLBACK-WRITE ' + JSON.stringify(args) + '\\n')
              if (${JSON.stringify(fallbackBehaviour)} === 'fails') throw new Error('timeout exceeded when trying to connect')
              return { count: ${JSON.stringify(fallbackBehaviour)} === 'claim-lost' ? 0 : 1 }
            },
          },
        },
        POST_REMOTE_PERSIST_TX_OPTIONS: { maxWait: 11000, timeout: 15000 },
      },
    })
    // Under \`node -e\` tsx emits CJS, so the namespace arrives wrapped; unwrap rather than assume.
    const ns = await import('@/lib/connectors/xero/sync-processor')
    const mod = ns.persistPostedXeroDocument ? ns : ns.default
    const recorded = await mod.persistPostedXeroDocument({
      entry: { id: 'log-77', type: 'INVOICE_PAYMENT', referenceType: 'SalesInvoice', referenceId: 'inv-77' },
      payload: {},
      externalId: 'PAY-77',
      // 15-minute claim, taken 14m59.7s ago: 300ms of spendable life left, so the re-drive gives up
      // in milliseconds instead of minutes and the test does not have to wait out a real deadline.
      claimedAt: new Date(Date.now() - (15 * 60 * 1000 - 60000 - 300)),
    })
    console.log(JSON.stringify({ recorded, transactionAttempts }))
    process.exit(0)
  `
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  assert.equal(child.status, 0, `the give-up path must not crash the sweep. stderr:\n${child.stderr}`)
  return { stdout: child.stdout, stderr: child.stderr }
}

test('r3 #3: the id of the document Xero holds reaches fd 2 BEFORE anything touches the database', () => {
  const { stdout, stderr } = runGiveUpScenario('succeeds')

  const result = JSON.parse(stdout.trim().split('\n').pop()!)
  assert.equal(result.recorded, false, 'the caller is told the row was not recorded normally')
  assert.ok(result.transactionAttempts > 1,
    `the persist was re-driven across the failure before giving up (attempts: ${result.transactionAttempts})`)

  const evidenceAt = stderr.indexOf('[UNRECORDED-REMOTE-WRITE]')
  const fallbackAt = stderr.indexOf('FALLBACK-WRITE')
  assert.ok(evidenceAt >= 0, `the unrecorded-write record must reach stderr. Got:\n${stderr}`)
  assert.ok(fallbackAt >= 0, 'and the database write must still be attempted afterwards')
  assert.ok(evidenceAt < fallbackAt,
    'EVIDENCE FIRST: the database attempt may fail, so it must never be what the record depends on')

  const first = JSON.parse(stderr.slice(evidenceAt + '[UNRECORDED-REMOTE-WRITE]'.length).split('\n')[0])
  assert.equal(first.externalId, 'PAY-77', 'and it carries the id itself, not a pointer to a row that lacks it')
  assert.equal(first.detail.syncLogId, 'log-77')
  assert.equal(first.recorded, false, 'stated honestly: at this point nothing durable holds it')
})

test('r3 #3: the database attempt is ONE claim-guarded statement, not another transaction', () => {
  const { stdout, stderr } = runGiveUpScenario('succeeds')
  const result = JSON.parse(stdout.trim().split('\n').pop()!)

  const fallbackLine = stderr.split('\n').find((line) => line.startsWith('FALLBACK-WRITE'))!
  const args = JSON.parse(fallbackLine.slice('FALLBACK-WRITE '.length))

  // A single statement waits on the POOL's bound; an interactive transaction is cut off after
  // Prisma's much shorter maxWait. On a pool this contended that difference is the whole chance.
  assert.equal(result.transactionAttempts > 1, true, 'the transaction path was the one that failed')
  assert.equal(args.where.id, 'log-77')
  assert.equal(args.where.status, 'PROCESSING')
  assert.ok(args.where.processingStartedAt, 'guarded by THIS worker\'s claim, so a reclaim cannot be trampled')
  assert.equal(args.where.externalTransactionId, null, 'and it will not overwrite an id someone else recorded')

  // The smallest write that removes the duplicate: record the id and hand the row back. The next run
  // takes the externalTransactionId short-circuit and posts nothing.
  assert.equal(args.data.externalTransactionId, 'PAY-77')
  assert.equal(args.data.status, 'PENDING')
  assert.equal(args.data.processingStartedAt, null)
  assert.match(args.data.errorMessage, /Do not re-queue it/,
    'and the row tells the operator what NOT to do, since re-queueing is what makes the second payment')

  const lines = stderr.split('\n').filter((line) => line.includes('[UNRECORDED-REMOTE-WRITE]'))
  const last = JSON.parse(lines[lines.length - 1].slice(lines[lines.length - 1].indexOf('{')))
  assert.equal(last.recorded, true, 'and the outcome is reported too, so a durable record is not assumed')
})

test('r3 #3: when the evidence genuinely cannot be written, it says so instead of pretending', () => {
  const { stdout, stderr } = runGiveUpScenario('fails')
  const result = JSON.parse(stdout.trim().split('\n').pop()!)
  assert.equal(result.recorded, false)

  const lines = stderr.split('\n').filter((line) => line.includes('[UNRECORDED-REMOTE-WRITE]'))
  const last = JSON.parse(lines[lines.length - 1].slice(lines[lines.length - 1].indexOf('{')))
  assert.equal(last.recorded, false, 'no durable record exists and the line does not claim one does')
  assert.match(last.reason, /THIS LINE IS THE ONLY RECORD/,
    'the operator is told the log line is all there is, which is the difference between a gap and a silence')
  assert.match(last.reason, /PAY-77/, 'and it still names the document Xero is holding')
})

test('r3 #3: a claim lost while the pool was down is reported, not silently overwritten', () => {
  const { stderr } = runGiveUpScenario('claim-lost')
  const lines = stderr.split('\n').filter((line) => line.includes('[UNRECORDED-REMOTE-WRITE]'))
  const last = JSON.parse(lines[lines.length - 1].slice(lines[lines.length - 1].indexOf('{')))
  assert.equal(last.recorded, false)
  assert.match(last.reason, /another worker owns it/,
    'the guarded write matched nothing, and that outcome is distinguishable from having recorded the id')
})
