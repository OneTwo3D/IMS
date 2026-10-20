import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DECLARATIONS } from '../../scripts/shadow-reader-declarations.ts'
import {
  MIN_FILES,
  MIN_SITES_BY_FAMILY,
  NEUTRAL_FORMS,
  reconcile,
  scanSource,
  scanTree,
  type Declaration,
} from '../../scripts/shadow-reader-census.ts'

/**
 * THE SHADOW-READER CENSUS AND PROOF THAT IT CAN FAIL.
 *
 * Part 1 runs it over the real tree and prints its precondition (a scan that reached nothing cannot pass). Part 2 drives the detectors
 * with fixtures: a new reader of each family in a new function, in an old function (count moved), a declaration for a site that is gone,
 * a malformed declaration. Part 3 pins the open findings and the documentation.
 *
 * Named mutations (shown red in the PR, restored from a copy): (a) delete one declaration -> UNDECLARED; (b) add a second reader to a
 * declared function -> MOVED; (c) rename a declared function -> STALE and UNDECLARED; (d) change a neutral declaration's form to a word
 * outside the closed set -> malformed.
 */

const ROOT = process.cwd()
const scan = scanTree(ROOT)

test('PRECONDITION: the scan reached the tree and every family', () => {
  const byFamily: Record<string, number> = {}
  for (const site of scan.sites) byFamily[site.family] = (byFamily[site.family] ?? 0) + 1
  console.log(`# files=${scan.filesScanned} sites=${scan.sites.length} ${JSON.stringify(byFamily)} declared=${DECLARATIONS.length}`)
  assert.ok(scan.filesScanned >= MIN_FILES, `only ${scan.filesScanned} files scanned`)
  for (const [family, floor] of Object.entries(MIN_SITES_BY_FAMILY)) {
    assert.ok((byFamily[family] ?? 0) >= floor, `${family}: ${byFamily[family] ?? 0} sites, floor ${floor}`)
  }
})

test('EVERY READER SITE IS CLASSIFIED, NONE IS STALE, NO COUNT MOVED, NO DECLARATION IS MALFORMED', () => {
  const report = reconcile(scan.sites, DECLARATIONS)
  assert.deepEqual(report.malformed, [])
  assert.deepEqual(report.undeclared.map((site) => `${site.key} x${site.count} ${site.file}:${site.line}`), [])
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.moved, [])
})


test('A NEW READER OF EACH FAMILY IN A NEW FUNCTION IS UNDECLARED', () => {
  const fixtures: Array<[string, string]> = [
    ['ledger', 'db.accountingSyncLog.findMany({ where: { status: "PENDING" } })'],
    ['ledger', 'db.$queryRaw`SELECT id FROM accounting_sync_logs WHERE status = \'PENDING\'`'],
    ['outbox', 'db.integrationOutbox.count({ where: { status: "PENDING" } })'],
    ['pushLink', 'db.wmsOrderPushLink.findUnique({ where: { orderId } })'],
    ['pushLink', 'db.salesOrder.findMany({ where: { wmsOrderPush: null } })'],
    ['wmsLink', 'db.wmsProductLink.findFirst({ where: { productId } })'],
    ['stockState', 'db.stockSyncState.findMany({})'],
    ['shopLog', 'db.shoppingSyncLog.findFirst({})'],
    ['shadowRecord', 'db.$queryRaw`SELECT count(*) FROM outbound_shadow_writes`'],
    ['batchStamp', 'order.revenueDeferredDate != null'],
  ]
  for (const [family, body] of fixtures) {
    const sites = scanSource(`export async function brandNewReader(orderId: string, productId: string, order: { revenueDeferredDate: Date | null }) { return ${body} }`, 'lib/fixture-new-reader.ts')
    assert.ok(sites.some((site) => site.family === family), `${family}: not found in ${body}`)
    const report = reconcile(sites, DECLARATIONS)
    assert.ok(report.undeclared.some((site) => site.family === family), `${family}: a new reader must be undeclared`)
  }
})

test('A WRITE IS NOT A READER, A NESTED TEMPLATE IS ONE SITE, A DATA-KEY STAMP WRITE IS NOT A READ', () => {
  const sites = scanSource(`
    export async function writes(tx: any, id: string) {
      await tx.accountingSyncLog.updateMany({ where: { id }, data: { status: 'PENDING' } })
      await tx.integrationOutbox.create({ data: { status: 'PENDING' } })
      await tx.salesOrder.update({ where: { id }, data: { revenueDeferredDate: new Date(), revenueDeferredBatchRef: 'x' } })
    }
    export async function raw(tx: any) {
      return tx.$queryRaw\`SELECT * FROM accounting_sync_logs WHERE id IN (SELECT id FROM accounting_sync_logs)\`
    }`, 'lib/fixture-writes.ts')
  assert.deepEqual(sites.map((site) => `${site.key} x${site.count}`), ['ledger::lib/fixture-writes.ts::raw x1'])
})

test('A SECOND READER IN A DECLARED FUNCTION MOVES ITS COUNT; A GONE FUNCTION IS STALE', () => {
  const first = DECLARATIONS[0]!
  const [family, file, fn] = first.key.split('::') as [string, string, string]
  const moved = reconcile([{ key: first.key, family: family as never, file, fn, count: first.count + 1, line: 1 }], [first])
  assert.deepEqual(moved.moved.map((m) => m.key), [first.key])
  const stale = reconcile([], [first])
  assert.deepEqual(stale.stale, [first.key])
})

test('A MALFORMED DECLARATION IS RED: neutral without a closed form, a form on a non-neutral, a short reason, a duplicate', () => {
  const base: Declaration = { key: 'ledger::lib/x.ts::f', count: 1, class: 'SHADOW_NEUTRAL', form: 'status-excludes', reason: 'a long enough reason for this site' }
  const site = { key: base.key, family: 'ledger' as const, file: 'lib/x.ts', fn: 'f', count: 1, line: 1 }
  assert.deepEqual(reconcile([site], [base]).malformed, [])
  assert.equal(reconcile([site], [{ ...base, form: undefined }]).malformed.length, 1)
  assert.equal(reconcile([site], [{ ...base, form: 'it-is-fine' as never }]).malformed.length, 1)
  assert.equal(reconcile([site], [{ ...base, class: 'FIXED' }]).malformed.length, 1)
  assert.equal(reconcile([site], [{ ...base, reason: 'short' }]).malformed.length, 1)
  assert.equal(reconcile([site], [base, base]).malformed.length, 1)
})

test('EVERY NEUTRAL DECLARATION NAMES A CLOSED FORM; THE CLASSES ARE COUNTED', () => {
  const neutral = DECLARATIONS.filter((d) => d.class === 'SHADOW_NEUTRAL')
  assert.ok(neutral.length > 100)
  for (const d of neutral) assert.ok((NEUTRAL_FORMS as readonly string[]).includes(d.form ?? ''), d.key)
  const counts: Record<string, number> = {}
  for (const d of DECLARATIONS) counts[d.class] = (counts[d.class] ?? 0) + 1
  console.log(`# classes ${JSON.stringify(counts)}`)
})

test('THE OPEN FINDINGS ARE PINNED AND DOCUMENTED: closing or adding one moves this number and the documentation', () => {
  const open = DECLARATIONS.filter((d) => d.class === 'OPEN_FINDING')
  assert.equal(open.length, 13, open.map((d) => d.key).join('\n'))
  const docs = readFileSync('docs/installation.md', 'utf8')
  assert.match(docs, /### Readers of sync rows under a shadow/)
  assert.match(docs, /npm run check:shadow-readers/)
  // Every open finding is listed in the documentation by its function name.
  for (const d of open) {
    const fn = d.key.split('::')[2]!
    assert.ok(docs.includes(`\`${fn}\``), `docs/installation.md does not list the open finding ${d.key}`)
  }
})
