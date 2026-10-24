import assert from 'node:assert/strict'
import test from 'node:test'

import type { ImsRead, ImsReadOptions } from '../../lib/reconciliation-pack/ims-readers.ts'
import { createWmsReadSession, readWms } from '../../lib/reconciliation-pack/wms-source.ts'
import { wmsSkuListPort } from '../../lib/reconciliation-pack/wms-skus.ts'
import { PROBE_WH5, PROBE_WH6, binding, binding6, fakeWms, noSleep, toStockRow } from './wms-fixtures.ts'

/**
 * R14's warehouse-system leg: the SAME census R1 reads, read once per run and shared. Mutations are listed in the PR.
 */

const data = () => ({ stock: { '5': PROBE_WH5.map(toStockRow), '6': PROBE_WH6.map(toStockRow) } })
const imsWith = (bindings: unknown[] | 'fail' | 'bad'): { calls: ImsReadOptions[]; ims: (o: ImsReadOptions) => Promise<ImsRead> } => {
  const calls: ImsReadOptions[] = []
  return {
    calls,
    ims: async (options) => {
      calls.push(options)
      if (bindings === 'fail') return { ok: false, reason: 'READ_INCOMPLETE' }
      return { ok: true, snapshotId: '1:2:', sections: { wmsBindings: bindings === 'bad' ? { ok: false, reason: 'BAD_KEY' } : { ok: true, value: bindings } } } as ImsRead
    },
  }
}
const requests = (port: ReturnType<typeof fakeWms>) => port.calls.length

// [mutation: the session's memo removed so each caller reads again]
test('one read per run: R1\'s read and the SKU port\'s census are ONE set of requests, and the port adds none', async () => {
  const alone = fakeWms(data())
  const sessionAlone = createWmsReadSession(alone, { sleep: noSleep })
  await sessionAlone.read(['5', '6'])
  const baseline = requests(alone)
  assert.ok(baseline >= 8)
  const shared = fakeWms(data())
  const session = createWmsReadSession(shared, { sleep: noSleep })
  const first = await session.read(['5', '6'])
  assert.ok(first.ok)
  const port = wmsSkuListPort({ session, ims: imsWith([binding(), binding6()]).ims })
  const answer = await port()
  assert.equal(requests(shared), baseline, 'R14 made no request of its own')
  assert.ok(answer.ok)
  // the same SKUs as the census, bundles kept
  const census = first.ok ? first.value.census.map((r) => r.sku).sort() : []
  assert.deepEqual(answer.ok ? [...answer.skus].sort() : [], census)
  assert.ok(answer.ok && answer.skus.includes('6878843248-24'), 'a bundle counts as present')
  // a second ask is the same memo too
  await port()
  assert.equal(requests(shared), baseline)
})

// [mutation: a failed read retried by the second caller / the failure's reason replaced]
test('a failed read is shared: the SKU port gets the source\'s own closed reason and makes no second attempt', async () => {
  const bad = fakeWms(data(), (call) => (call.kind === 'page' && call.pageNo === 1 ? { ok: false, reason: 'VENDOR_READ_UNSTABLE' } : undefined))
  const session = createWmsReadSession(bad, { sleep: noSleep })
  const first = await session.read(['5', '6'])
  assert.deepEqual(first, { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  const spent = requests(bad)
  const answer = await wmsSkuListPort({ session, ims: imsWith([binding(), binding6()]).ims })()
  assert.deepEqual(answer, { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
  assert.equal(requests(bad), spent)
})

// [mutation: the warehouse-list comparison removed]
test('a different warehouse list than the one read is BASIS_MOVED, never a second read', async () => {
  const port = fakeWms(data())
  const session = createWmsReadSession(port, { sleep: noSleep })
  await session.read(['5', '6'])
  const spent = requests(port)
  const answer = await wmsSkuListPort({ session, ims: imsWith([binding6()]).ims })()
  assert.deepEqual(answer, { ok: false, reason: 'BASIS_MOVED' })
  assert.equal(requests(port), spent)
})

// [mutation: the census-only path reads the stock lists / reads twice]
test('with no bound warehouse in the comparison the census alone is read ONCE (two scans, no stock list) and shared', async () => {
  const port = fakeWms(data())
  const session = createWmsReadSession(port, { sleep: noSleep })
  const ims = imsWith([binding({ active: false }), binding6({ stockSyncMode: 'DISABLED' })])
  const sku = wmsSkuListPort({ session, ims: ims.ims })
  const a = await sku()
  assert.ok(a.ok && a.skus.length === 12)
  assert.ok(port.calls.every((call) => call.kind === 'page'), 'no stock list was asked for')
  const spent = requests(port)
  await sku()
  assert.equal(requests(port), spent, 'the second ask reads nothing')
  assert.deepEqual(ims.calls.map((c) => c.sections), [['wmsBindings'], ['wmsBindings']])
})

// [mutation: the census proofs weakened in the census-only read: no empty page after the short one, or no second scan]
test('the census-only read keeps the scan proofs: a truncated or unstable list is a closed reason, never a shorter list', async () => {
  const noBound = [binding({ active: false })]
  const unstable = fakeWms(data(), (call, n) => (call.kind === 'page' && n === 3 && call.pageNo === 1 ? { ok: true, value: [] } : undefined))
  const a = await wmsSkuListPort({ session: createWmsReadSession(unstable, { sleep: noSleep }), ims: imsWith(noBound).ims })()
  assert.equal(a.ok, false)
  const extra = fakeWms(data(), (call) => (call.kind === 'page' && call.pageNo === 2 ? { ok: true, value: [{ id: '999', sku: 'EXTRA', bundle: false }] } : undefined))
  const b = await wmsSkuListPort({ session: createWmsReadSession(extra, { sleep: noSleep }), ims: imsWith(noBound).ims })()
  assert.deepEqual(b, { ok: false, reason: 'VENDOR_READ_UNSTABLE' })
})

test('the IMS bindings unreadable, or not exactly readable, is the leg\'s closed reason and the vendor is not touched', async () => {
  for (const [bindings, reason] of [['fail', 'READ_INCOMPLETE'], ['bad', 'BAD_KEY']] as const) {
    const port = fakeWms(data())
    const answer = await wmsSkuListPort({ session: createWmsReadSession(port, { sleep: noSleep }), ims: imsWith(bindings).ims })()
    assert.deepEqual(answer, { ok: false, reason })
    assert.equal(requests(port), 0)
  }
  const odd = await wmsSkuListPort({ session: createWmsReadSession(fakeWms(data()), { sleep: noSleep }), ims: imsWith([{ connector: 'mintsoft' }]).ims })()
  assert.equal(odd.ok, false)
})

test('readWms stays the one reader: the session over the same port gives the same result', async () => {
  const direct = await readWms(fakeWms(data()), ['5', '6'], { sleep: noSleep })
  const viaSession = await createWmsReadSession(fakeWms(data()), { sleep: noSleep }).read(['5', '6'])
  assert.deepEqual(viaSession, direct)
})
